// Request handling, independent of AWS (the Lambda entry points in index.ts wire in DynamoDB, the API Gateway
// management API and fetch). Never logs tokens, tickets or message text.
import { ARTICLE_ID_RE, parseFacility, parseNpc, publicView, SchemaError, sourceVersions, type Publication, type WikiArticle } from './catalog.js';
import { buildPrompt, DRAFT_TOOL, DraftError, parseDraft, type LlmProvider } from './draft.js';
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

export interface CatalogStore {
  get(id: string): Promise<{ publication: Publication; versions: string } | null>;
  put(id: string, publication: Publication, versions: string): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Publication[]>;
}

export interface Budget {
  /** Counts one use of `key`; false (and nothing counted) when `limit` uses were already made. */
  take(key: string, limit: number, ttlSec: number): Promise<boolean>;
}

export interface Deps {
  /** The wiki's origin (https://host): the only page allowed to ask for tickets and to connect. */
  wikiOrigin: string;
  verifier: TokenVerifier;
  tickets: TicketStore;
  connections: ConnectionStore;
  catalog: CatalogStore;
  /** GET <wiki>/api/me with the user's token: the wiki decides whether the account is active and its role. */
  fetchMe: (token: string) => Promise<{ status: number; body: unknown }>;
  /** GET <wiki>/api/articles/<id> with the user's token: the wiki decides what the user may read. */
  fetchArticle: (token: string, id: string) => Promise<{ status: number; body: unknown }>;
  /** POST <wiki>/api/articles with the user's token: the wiki decides what the user may create. */
  createArticle: (token: string, input: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  llm: LlmProvider;
  budget: Budget;
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

export interface HttpRequest {
  authorization?: string;
  origin?: string;
  body?: string;
}

/**
 * Every HTTP route: the wiki's page only, a valid access token, and an account the wiki accepts. The wiki is the
 * authority on accounts (disabled users, revoked tokens, roles). Returns the identity and the token (used for this
 * request's calls to the wiki only, never stored), or the error response.
 */
async function authenticate(d: Deps, req: HttpRequest): Promise<{ identity: Identity; token: string } | HttpResult> {
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
  const me = await d.fetchMe(token);
  const body = me.body as { username?: unknown; role?: unknown } | null;
  if (me.status === 401) return { status: 401, body: { error: 'unauthorized' } };
  if (me.status !== 200 || typeof body?.username !== 'string' || typeof body.role !== 'string' || !ROLES.has(body.role)) {
    d.log({ msg: 'wiki account check failed', status: me.status });
    return { status: me.status === 403 ? 403 : 502, body: { error: me.status === 403 ? 'forbidden' : 'wiki_unavailable' } };
  }
  return { identity: { sub, username: body.username, role: body.role as Identity['role'] }, token };
}
const failed = (r: Awaited<ReturnType<typeof authenticate>>): r is HttpResult => 'status' in r;

/** POST /ticket with "Authorization: Bearer <access token>" from the wiki's page. */
export async function handleTicket(d: Deps, req: HttpRequest): Promise<HttpResult> {
  const auth = await authenticate(d, req);
  if (failed(auth)) return auth;
  const { identity } = auth;
  const { ticket, expiresAt } = await issueTicket(d.tickets, identity, d.now());
  d.log({ msg: 'connection pass issued', sub: identity.sub });
  return { status: 200, body: { ticket, expiresAt, maxConnectionSec: MAX_CONNECTION_SEC } };
}

function facilityIdFrom(body: string | undefined): string | null {
  try {
    const id = (JSON.parse(body ?? '') as { facilityId?: unknown }).facilityId;
    return typeof id === 'string' && ARTICLE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function readArticle(d: Deps, token: string, id: string): Promise<{ article: WikiArticle } | { error: HttpResult }> {
  const r = await d.fetchArticle(token, id);
  const notFound = (why: string) => ({ error: { status: 400, body: { error: 'article_not_found', message: `${id}: ${why}` } } });
  if (r.status === 404 || r.status === 403) return notFound('not found (or not readable for you)');
  if (r.status !== 200 || !r.body || typeof r.body !== 'object') return { error: { status: 502, body: { error: 'wiki_unavailable' } } };
  const a = r.body as WikiArticle;
  return a.deleted ? notFound('deleted') : { article: a };
}

/**
 * POST /publish { facilityId }: admins (DMs) only. Reads the facility article and its NPC articles with the DM's
 * own token (latest versions; the wiki's status is not considered), validates them and stores the snapshot that
 * conversations will use. Publishing unchanged article versions again changes nothing.
 */
export async function handlePublish(d: Deps, req: HttpRequest): Promise<HttpResult> {
  const auth = await authenticate(d, req);
  if (failed(auth)) return auth;
  if (auth.identity.role !== 'admin') return { status: 403, body: { error: 'admins_only' } };
  const id = facilityIdFrom(req.body);
  if (!id) return { status: 400, body: { error: 'bad_request', message: 'facilityId must be an article id' } };
  const fa = await readArticle(d, auth.token, id);
  if ('error' in fa) return fa.error;
  try {
    const facility = parseFacility(fa.article);
    const npcs = [];
    for (const npcId of facility.npcs) {
      const na = await readArticle(d, auth.token, npcId);
      if ('error' in na) return na.error;
      npcs.push(parseNpc(na.article));
    }
    const versions = sourceVersions(facility, npcs);
    const current = await d.catalog.get(id);
    if (current?.versions === versions) return { status: 200, body: { result: 'unchanged', facility: publicView(current.publication) } };
    const publication: Publication = { facility, npcs, publishedBy: auth.identity.username, publishedAt: d.now() };
    await d.catalog.put(id, publication, versions);
    d.log({ msg: 'published', facility: id, by: auth.identity.sub, versions });
    return { status: 200, body: { result: current ? 'updated' : 'published', facility: publicView(publication) } };
  } catch (e) {
    if (e instanceof SchemaError) return { status: 400, body: { error: 'invalid_article', message: e.message } };
    throw e;
  }
}

/** POST /unpublish { facilityId }: admins only. Conversations stop using the facility. */
export async function handleUnpublish(d: Deps, req: HttpRequest): Promise<HttpResult> {
  const auth = await authenticate(d, req);
  if (failed(auth)) return auth;
  if (auth.identity.role !== 'admin') return { status: 403, body: { error: 'admins_only' } };
  const id = facilityIdFrom(req.body);
  if (!id) return { status: 400, body: { error: 'bad_request', message: 'facilityId must be an article id' } };
  const existed = !!(await d.catalog.get(id));
  await d.catalog.delete(id);
  d.log({ msg: 'unpublished', facility: id, by: auth.identity.sub });
  return { status: 200, body: { result: existed ? 'unpublished' : 'not_published' } };
}

/** GET /facilities: every signed-in user; the public view only (no persona, knowledge or secrets). */
export async function handleList(d: Deps, req: HttpRequest): Promise<HttpResult> {
  const auth = await authenticate(d, req);
  if (failed(auth)) return auth;
  const items = (await d.catalog.list()).map(publicView).sort((a, b) => a.title.localeCompare(b.title));
  return { status: 200, body: { items } };
}

/** Drafts per DM and UTC day (each one is a Bedrock call). */
export const DRAFTS_PER_DAY = 20;

/**
 * POST /draft { articleId }: admins only. Reads the article with the DM's own token and asks the model for an NPC
 * draft. Returns the draft only: nothing is written to the wiki (see /adopt).
 */
export async function handleDraft(d: Deps, req: HttpRequest): Promise<HttpResult> {
  const auth = await authenticate(d, req);
  if (failed(auth)) return auth;
  if (auth.identity.role !== 'admin') return { status: 403, body: { error: 'admins_only' } };
  let id: unknown;
  try {
    id = (JSON.parse(req.body ?? '') as { articleId?: unknown }).articleId;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'string' || !ARTICLE_ID_RE.test(id)) return { status: 400, body: { error: 'bad_request', message: 'articleId must be an article id' } };
  const read = await readArticle(d, auth.token, id);
  if ('error' in read) return read.error;
  const day = new Date(d.now() * 1000).toISOString().slice(0, 10);
  if (!(await d.budget.take(`budget#draft#${auth.identity.sub}#${day}`, DRAFTS_PER_DAY, 2 * 86400))) {
    return { status: 429, body: { error: 'budget_exceeded', message: `up to ${DRAFTS_PER_DAY} drafts per day` } };
  }
  const article = { title: read.article.title, body: read.article.body ?? '' };
  const { system, user } = buildPrompt(article);
  try {
    const r = await d.llm.draft({ system, user, tool: DRAFT_TOOL, maxTokens: 2000 });
    const draft = parseDraft(r.input, `${article.title}\n${article.body}`);
    d.log({ msg: 'draft', by: auth.identity.sub, article: id, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    return { status: 200, body: { draft, source: { id, title: article.title, version: read.article.version } } };
  } catch (e) {
    if (e instanceof DraftError) {
      d.log({ msg: 'draft rejected', by: auth.identity.sub, article: id, reason: e.message });
      return { status: 502, body: { error: 'draft_invalid', message: 'the model returned an unusable draft; try again' } };
    }
    throw e;
  }
}

/**
 * POST /adopt { id, title, sourceArticleId?, npc, background? }: admins only. Validates the edited draft with the
 * same rules as publishing, then creates the NPC article in the wiki with the DM's own token: type NPC, status
 * draft, readable and editable by admins only. It is not published to conversations (that stays a DM action).
 */
export async function handleAdopt(d: Deps, req: HttpRequest): Promise<HttpResult> {
  const auth = await authenticate(d, req);
  if (failed(auth)) return auth;
  if (auth.identity.role !== 'admin') return { status: 403, body: { error: 'admins_only' } };
  let x: { id?: unknown; title?: unknown; sourceArticleId?: unknown; npc?: unknown; background?: unknown };
  try {
    x = JSON.parse(req.body ?? '');
  } catch {
    return { status: 400, body: { error: 'bad_request', message: 'invalid JSON' } };
  }
  if (typeof x.id !== 'string' || !ARTICLE_ID_RE.test(x.id)) return { status: 400, body: { error: 'bad_request', message: 'id must be an article id (a-z, 0-9, -)' } };
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 200) return { status: 400, body: { error: 'bad_request', message: 'title is required' } };
  const source = typeof x.sourceArticleId === 'string' && ARTICLE_ID_RE.test(x.sourceArticleId) ? x.sourceArticleId : null;
  const background = typeof x.background === 'string' ? x.background.slice(0, 7000) : '';
  const body = [background.trim(), source ? `下書きの元にした記事: [${source}](/wiki/${source})` : ''].filter(Boolean).join('\n\n');
  const candidate: WikiArticle = { id: x.id, type: 'NPC', title: x.title.trim(), version: 0, readScope: 'admin', extra: { persona_chat: x.npc as never }, body };
  let npc;
  try {
    npc = parseNpc(candidate);
  } catch (e) {
    if (e instanceof SchemaError) return { status: 400, body: { error: 'invalid_npc', message: e.message } };
    throw e;
  }
  // Exactly the validated fields, nothing else from the request.
  const personaChat = { name: npc.name, role: npc.role, persona: npc.persona, voice: npc.voice, knowledge: npc.knowledge, secrets: npc.secrets, greeting: npc.greeting };
  const r = await d.createArticle(auth.token, { id: npc.id, type: 'NPC', title: candidate.title, status: 'draft', readScope: 'admin', writeScope: 'admin', body, extra: { persona_chat: personaChat }, tags: ['persona-chat'] });
  if (r.status === 409) return { status: 409, body: { error: 'exists', message: `${npc.id}: an article with this id already exists` } };
  if (r.status !== 201 && r.status !== 200) {
    const msg = (r.body as { error?: { message?: unknown } } | null)?.error?.message;
    return { status: r.status === 400 || r.status === 403 ? r.status : 502, body: { error: 'wiki_rejected', message: typeof msg === 'string' ? msg.slice(0, 300) : `HTTP ${r.status}` } };
  }
  d.log({ msg: 'adopted', by: auth.identity.sub, npc: npc.id, source });
  return { status: 201, body: { id: npc.id } };
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
