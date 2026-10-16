// Lambda entry points (bundled by scripts/build.mjs into dist/backend/index.mjs; the AWS SDK comes from the
// Lambda runtime). Configuration: WIKI_ORIGIN, ISSUER, CLIENT_ID, TABLE (tickets, connections), CATALOG (publications).
import { ApiGatewayManagementApiClient, DeleteConnectionCommand, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import type { Publication } from './catalog.js';
import { handleAuthorize, handleConnect, handleDisconnect, handleList, handleMessage, handlePublish, handleTicket, handleUnpublish, type CatalogStore, type Connection, type ConnectionStore, type Deps, type HttpRequest, type HttpResult } from './handlers.js';
import { TokenVerifier } from './jwt.js';
import type { Identity, TicketStore } from './tickets.js';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing environment variable ${k}`);
  return v;
};
const WIKI_ORIGIN = env('WIKI_ORIGIN');
const ISSUER = env('ISSUER');
const TABLE = env('TABLE');
const CATALOG = env('CATALOG');
const db = new DynamoDBClient({});

const tickets: TicketStore = {
  async put(hash, identity, expiresAt) {
    await db.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: { pk: { S: `ticket#${hash}` }, identity: { S: JSON.stringify(identity) }, expiresAt: { N: String(expiresAt) }, ttl: { N: String(expiresAt + 60) } },
      }),
    );
  },
  async take(hash, now) {
    try {
      const r = await db.send(
        new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: `ticket#${hash}` } }, ConditionExpression: 'attribute_exists(pk)', ReturnValues: 'ALL_OLD' }),
      );
      const a = r.Attributes;
      if (!a || Number(a.expiresAt?.N) <= now) return null;
      return JSON.parse(a.identity!.S!) as Identity;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return null; // unknown or already used
      throw e;
    }
  },
};

const connections: ConnectionStore = {
  async put(id, c, expiresAt) {
    await db.send(new PutItemCommand({ TableName: TABLE, Item: { pk: { S: `conn#${id}` }, connection: { S: JSON.stringify(c) }, ttl: { N: String(expiresAt) } } }));
  },
  async get(id) {
    const r = await db.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `conn#${id}` } }, ConsistentRead: true }));
    return r.Item?.connection?.S ? (JSON.parse(r.Item.connection.S) as Connection) : null;
  },
  async delete(id) {
    await db.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: `conn#${id}` } } }));
  },
};

const catalog: CatalogStore = {
  async get(id) {
    const r = await db.send(new GetItemCommand({ TableName: CATALOG, Key: { id: { S: id } }, ConsistentRead: true }));
    return r.Item?.publication?.S ? { publication: JSON.parse(r.Item.publication.S) as Publication, versions: r.Item.versions?.S ?? '' } : null;
  },
  async put(id, publication, versions) {
    await db.send(new PutItemCommand({ TableName: CATALOG, Item: { id: { S: id }, publication: { S: JSON.stringify(publication) }, versions: { S: versions } } }));
  },
  async delete(id) {
    await db.send(new DeleteItemCommand({ TableName: CATALOG, Key: { id: { S: id } } }));
  },
  async list() {
    // A handful of facilities per wiki: a scan is fine (paginated for completeness).
    const out: Publication[] = [];
    let start: Record<string, never> | undefined;
    do {
      const r = await db.send(new ScanCommand({ TableName: CATALOG, ProjectionExpression: 'publication', ExclusiveStartKey: start }));
      for (const it of r.Items ?? []) if (it.publication?.S) out.push(JSON.parse(it.publication.S) as Publication);
      start = r.LastEvaluatedKey as typeof start;
    } while (start);
    return out;
  },
};

const verifier = new TokenVerifier({
  issuer: ISSUER,
  clientId: env('CLIENT_ID'),
  fetchJwks: async () => {
    const r = await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`jwks: ${r.status}`);
    return (await r.json()) as { keys: [] };
  },
});

/** GET on the wiki's API with the user's own token (the wiki applies its own permissions). */
async function wikiGet(token: string, path: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${WIKI_ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}

const managers = new Map<string, ApiGatewayManagementApiClient>();
const manager = (ctx: { domainName: string; stage: string }) => {
  const endpoint = `https://${ctx.domainName}/${ctx.stage}`;
  let m = managers.get(endpoint);
  if (!m) managers.set(endpoint, (m = new ApiGatewayManagementApiClient({ endpoint })));
  return m;
};

const deps = (ws?: { domainName: string; stage: string }): Deps => ({
  wikiOrigin: WIKI_ORIGIN,
  verifier,
  tickets,
  connections,
  catalog,
  fetchMe: (token) => wikiGet(token, '/api/me'),
  fetchArticle: (token, id) => wikiGet(token, `/api/articles/${encodeURIComponent(id)}`),
  send: async (connectionId, data) => {
    try {
      await manager(ws!).send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(data)) }));
    } catch (e) {
      if (!(e instanceof GoneException)) throw e;
      await connections.delete(connectionId);
    }
  },
  close: async (connectionId) => {
    try {
      await manager(ws!).send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (e) {
      if (!(e instanceof GoneException)) throw e;
    }
  },
  now: () => Math.floor(Date.now() / 1000),
  log: (entry) => console.log(JSON.stringify(entry)),
});

const lower = (h: Record<string, string | undefined> | undefined) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

const ROUTES: Record<string, (d: Deps, req: HttpRequest) => Promise<HttpResult>> = {
  'POST /ticket': handleTicket,
  'POST /publish': handlePublish,
  'POST /unpublish': handleUnpublish,
  'GET /facilities': handleList,
};

/** HTTP API (payload 2.0): the routes above. */
export async function http(event: { routeKey?: string; headers?: Record<string, string | undefined>; body?: string; isBase64Encoded?: boolean }) {
  const h = lower(event.headers);
  const route = ROUTES[event.routeKey ?? ''];
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const r = route ? await route(deps(), { authorization: h.authorization, origin: h.origin, body: body && body.length <= 4096 ? body : undefined }) : { status: 404, body: { error: 'not_found' } };
  return { statusCode: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(r.body) };
}

/** WebSocket $connect REQUEST authorizer (identity source: the "ticket" query parameter). */
export async function authorize(event: { methodArn: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> }) {
  const identity = await handleAuthorize(deps(), { ticket: event.queryStringParameters?.ticket, origin: lower(event.headers).origin });
  if (!identity) throw new Error('Unauthorized'); // API Gateway answers 401
  return {
    principalId: identity.sub,
    policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }] },
    context: { sub: identity.sub, username: identity.username, role: identity.role },
  };
}

interface WsEvent {
  body?: string;
  requestContext: { connectionId: string; domainName: string; stage: string; routeKey: string; authorizer?: Record<string, string> };
}

/** WebSocket routes: $connect, $disconnect and $default. */
export async function ws(event: WsEvent) {
  const ctx = event.requestContext;
  const d = deps(ctx);
  if (ctx.routeKey === '$connect') {
    const a = ctx.authorizer ?? {};
    await handleConnect(d, ctx.connectionId, { sub: a.sub!, username: a.username!, role: a.role as Identity['role'] });
  } else if (ctx.routeKey === '$disconnect') {
    await handleDisconnect(d, ctx.connectionId);
  } else {
    await handleMessage(d, ctx.connectionId, event.body);
  }
  return { statusCode: 200 };
}
