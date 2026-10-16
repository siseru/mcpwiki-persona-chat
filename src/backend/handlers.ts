// Request handling, independent of AWS (the Lambda entry points in index.ts wire in DynamoDB, the API Gateway
// management API and fetch). Never logs tokens, tickets or message text.
import { AuthError, type TokenVerifier } from './jwt.js';
import { issueTicket, MAX_CONNECTION_SEC, redeemTicket, type Identity, type TicketStore } from './tickets.js';

export interface Connection extends Identity {
  connectedAt: number;
}

export interface ConnectionStore {
  put(id: string, c: Connection, expiresAt: number): Promise<void>;
  get(id: string): Promise<Connection | null>;
  delete(id: string): Promise<void>;
}

export interface Deps {
  /** The wiki's origin (https://host): the only page allowed to ask for tickets and to connect. */
  wikiOrigin: string;
  verifier: TokenVerifier;
  tickets: TicketStore;
  connections: ConnectionStore;
  /** GET <wiki>/api/me with the user's token: the wiki decides whether the account is active and its role. */
  fetchMe: (token: string) => Promise<{ status: number; body: unknown }>;
  send: (connectionId: string, data: unknown) => Promise<void>;
  close: (connectionId: string) => Promise<void>;
  now: () => number; // epoch seconds
  log: (entry: Record<string, unknown>) => void;
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

const ROLES = new Set(['admin', 'editor', 'viewer']);
const MAX_MESSAGE_BYTES = 4096;

/** POST /ticket with "Authorization: Bearer <access token>" from the wiki's page. */
export async function handleTicket(d: Deps, req: { authorization?: string; origin?: string }): Promise<HttpResult> {
  if (req.origin !== d.wikiOrigin) return { status: 403, body: { error: 'origin_not_allowed' } };
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(req.authorization ?? '');
  if (!m) return { status: 401, body: { error: 'unauthorized' } };
  const token = m[1]!;
  let sub: string;
  try {
    sub = (await d.verifier.verify(token)).sub;
  } catch (e) {
    if (e instanceof AuthError) return { status: 401, body: { error: 'unauthorized' } };
    throw e;
  }
  // The wiki is the authority on accounts: disabled users, revoked tokens and roles are decided there.
  const me = await d.fetchMe(token);
  const body = me.body as { username?: unknown; role?: unknown } | null;
  if (me.status === 401) return { status: 401, body: { error: 'unauthorized' } };
  if (me.status !== 200 || typeof body?.username !== 'string' || typeof body.role !== 'string' || !ROLES.has(body.role)) {
    d.log({ msg: 'wiki account check failed', status: me.status });
    return { status: me.status === 403 ? 403 : 502, body: { error: me.status === 403 ? 'forbidden' : 'wiki_unavailable' } };
  }
  const identity: Identity = { sub, username: body.username, role: body.role as Identity['role'] };
  const { ticket, expiresAt } = await issueTicket(d.tickets, identity, d.now());
  d.log({ msg: 'connection pass issued', sub });
  return { status: 200, body: { ticket, expiresAt, maxConnectionSec: MAX_CONNECTION_SEC } };
}

/** $connect authorizer: consumes the ticket. Returns the identity to pass on, or null to refuse. */
export async function handleAuthorize(d: Deps, req: { ticket?: string; origin?: string }): Promise<Identity | null> {
  if (req.origin !== d.wikiOrigin) return null;
  return redeemTicket(d.tickets, req.ticket, d.now());
}

export async function handleConnect(d: Deps, connectionId: string, identity: Identity): Promise<void> {
  const now = d.now();
  // Kept a little longer than API Gateway's 2 h limit; removed on $disconnect anyway.
  await d.connections.put(connectionId, { ...identity, connectedAt: now }, now + 2 * 3600 + 300);
  d.log({ msg: 'connected', sub: identity.sub, connectionId });
}

export async function handleDisconnect(d: Deps, connectionId: string): Promise<void> {
  await d.connections.delete(connectionId);
  d.log({ msg: 'disconnected', connectionId });
}

/** $default route: { "type": "ping", "t": <client time> } -> { "type": "pong", ... }. */
export async function handleMessage(d: Deps, connectionId: string, raw: string | undefined): Promise<void> {
  const c = await d.connections.get(connectionId);
  if (!c) return d.close(connectionId);
  if (d.now() - c.connectedAt > MAX_CONNECTION_SEC) {
    // Ask the client to fetch a new ticket (the wiki re-checks the account), then close.
    await d.send(connectionId, { type: 'reauth' });
    return d.close(connectionId);
  }
  let msg: { type?: unknown; t?: unknown } | null = null;
  if (raw && Buffer.byteLength(raw) <= MAX_MESSAGE_BYTES) {
    try {
      msg = JSON.parse(raw);
    } catch {
      msg = null;
    }
  }
  if (msg?.type === 'ping') {
    const t = typeof msg.t === 'number' && Number.isFinite(msg.t) ? msg.t : null;
    return d.send(connectionId, { type: 'pong', t, serverTime: d.now(), username: c.username, role: c.role });
  }
  return d.send(connectionId, { type: 'error', code: 'unsupported_message' });
}
