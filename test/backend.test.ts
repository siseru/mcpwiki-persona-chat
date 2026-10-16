import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { handleAuthorize, handleMessage, handleTicket, type Connection, type ConnectionStore, type Deps } from '../src/backend/handlers.js';
import { AuthError, TokenVerifier } from '../src/backend/jwt.js';
import { MAX_CONNECTION_SEC, MemoryTicketStore, TICKET_TTL_SEC, ticketHash } from '../src/backend/tickets.js';

const ISSUER = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TEST12345';
const CLIENT = 'webclient0123456789abcdef';
const ORIGIN = 'https://wiki-dev.example.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
let clock = 1_800_000_000;

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1', ...header });
  const p = b64({ sub: 'sub-alice', username: 'alice', client_id: CLIENT, token_use: 'access', iss: ISSUER, iat: clock - 10, exp: clock + 3600, scope: 'openid', ...claims });
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}

function setup(me: { status: number; body: unknown } = { status: 200, body: { username: 'alice', role: 'editor' } }) {
  const tickets = new MemoryTicketStore();
  const conns = new Map<string, Connection>();
  const connections: ConnectionStore = {
    put: async (id, c) => void conns.set(id, c),
    get: async (id) => conns.get(id) ?? null,
    delete: async (id) => void conns.delete(id),
  };
  const sent: { id: string; data: any }[] = [];
  const closed: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const meCalls: string[] = [];
  const d: Deps = {
    wikiOrigin: ORIGIN,
    verifier: new TokenVerifier({ issuer: ISSUER, clientId: CLIENT, fetchJwks: async () => ({ keys: [jwk] }), now: () => clock }),
    tickets,
    connections,
    fetchMe: async (t) => (meCalls.push(t), me),
    send: async (id, data) => void sent.push({ id, data }),
    close: async (id) => void closed.push(id),
    now: () => clock,
    log: (e) => void logs.push(e),
  };
  return { d, tickets, conns, sent, closed, logs, meCalls };
}

test('access tokens are verified with the wiki rules', async () => {
  const { d } = setup();
  assert.equal((await d.verifier.verify(token())).sub, 'sub-alice');
  const bad: [string, string][] = [
    ['expired', token({ exp: clock - 120 })],
    ['not yet valid', token({ iat: clock + 600 })],
    ['other issuer', token({ iss: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_OTHER' })],
    ['id token', token({ token_use: 'id' })],
    ['other client', token({ client_id: 'cliclient0123456789abcdef' })],
    ['direct sign-in API', token({ scope: 'aws.cognito.signin.user.admin' })],
    ['HS256', token({}, { alg: 'HS256' })],
    ['unknown key', token({}, { kid: 'k2' })],
    ['tampered', token().replace(/\.([^.]+)\./, (_m, p: string) => `.${b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'sub-admin' })}.`)],
    ['garbage', 'a.b.c'],
  ];
  for (const [what, t] of bad) await assert.rejects(d.verifier.verify(t), AuthError, what);
});

test('a ticket is issued only from the wiki page, with a valid token, for an account the wiki accepts', async () => {
  const ok = setup();
  const r = await handleTicket(ok.d, { authorization: `Bearer ${token()}`, origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.match(String(r.body.ticket), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.body.expiresAt, clock + TICKET_TTL_SEC);
  // Only the hash is stored; the identity comes from the wiki's answer.
  assert.deepEqual([...ok.tickets.items.keys()], [ticketHash(String(r.body.ticket))]);
  assert.deepEqual([...ok.tickets.items.values()][0]!.identity, { sub: 'sub-alice', username: 'alice', role: 'editor' });
  assert.ok(!JSON.stringify(ok.logs).includes(String(r.body.ticket)));
  assert.ok(!JSON.stringify(ok.logs).includes(token().split('.')[2]!));

  const cases: [string, ReturnType<typeof setup>, { authorization?: string; origin?: string }, number][] = [
    ['other origin', setup(), { authorization: `Bearer ${token()}`, origin: 'https://evil.example' }, 403],
    ['no origin', setup(), { authorization: `Bearer ${token()}` }, 403],
    ['no token', setup(), { origin: ORIGIN }, 401],
    ['bad token', setup(), { authorization: `Bearer ${token({ exp: clock - 999 })}`, origin: ORIGIN }, 401],
    ['wiki: disabled / revoked', setup({ status: 401, body: { error: {} } }), { authorization: `Bearer ${token()}`, origin: ORIGIN }, 401],
    ['wiki: no role', setup({ status: 403, body: { error: {} } }), { authorization: `Bearer ${token()}`, origin: ORIGIN }, 403],
    ['wiki down', setup({ status: 503, body: null }), { authorization: `Bearer ${token()}`, origin: ORIGIN }, 502],
    ['wiki: odd role', setup({ status: 200, body: { username: 'alice', role: 'owner' } }), { authorization: `Bearer ${token()}`, origin: ORIGIN }, 502],
  ];
  for (const [what, s, req, status] of cases) {
    assert.equal((await handleTicket(s.d, req)).status, status, what);
    assert.equal(s.tickets.items.size, 0, what);
  }
  // An invalid token never reaches the wiki.
  const s = setup();
  await handleTicket(s.d, { authorization: `Bearer ${token({ iss: 'x' })}`, origin: ORIGIN });
  assert.deepEqual(s.meCalls, []);
});

test('a ticket opens one connection, once, within 30 seconds, from the wiki page only', async () => {
  const s = setup();
  const issue = async () => String((await handleTicket(s.d, { authorization: `Bearer ${token()}`, origin: ORIGIN })).body.ticket);
  const t1 = await issue();
  assert.equal(await handleAuthorize(s.d, { ticket: t1, origin: 'https://evil.example' }), null);
  assert.deepEqual(await handleAuthorize(s.d, { ticket: t1, origin: ORIGIN }), { sub: 'sub-alice', username: 'alice', role: 'editor' });
  assert.equal(await handleAuthorize(s.d, { ticket: t1, origin: ORIGIN }), null, 'single use');
  const t2 = await issue();
  clock += TICKET_TTL_SEC + 1;
  assert.equal(await handleAuthorize(s.d, { ticket: t2, origin: ORIGIN }), null, 'expired');
  for (const bad of [undefined, '', 'x', 'a'.repeat(44), '../../etc']) assert.equal(await handleAuthorize(s.d, { ticket: bad, origin: ORIGIN }), null);
});

test('ping gets a pong; stale or unknown connections are told to reconnect or closed', async () => {
  const s = setup();
  s.conns.set('c1', { sub: 'sub-alice', username: 'alice', role: 'editor', connectedAt: clock });
  await handleMessage(s.d, 'c1', JSON.stringify({ type: 'ping', t: 123 }));
  assert.deepEqual(s.sent.pop(), { id: 'c1', data: { type: 'pong', t: 123, serverTime: clock, username: 'alice', role: 'editor' } });
  await handleMessage(s.d, 'c1', 'not json');
  assert.equal(s.sent.pop()!.data.type, 'error');
  await handleMessage(s.d, 'c1', JSON.stringify({ type: 'ping', pad: 'x'.repeat(5000) }));
  assert.equal(s.sent.pop()!.data.type, 'error');
  await handleMessage(s.d, 'nobody', JSON.stringify({ type: 'ping' }));
  assert.deepEqual(s.closed, ['nobody']);
  clock += MAX_CONNECTION_SEC + 1;
  await handleMessage(s.d, 'c1', JSON.stringify({ type: 'ping' }));
  assert.deepEqual(s.sent.pop(), { id: 'c1', data: { type: 'reauth' } });
  assert.deepEqual(s.closed, ['nobody', 'c1']);
});
