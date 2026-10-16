// Lambda entry points (bundled by scripts/build.mjs into dist/backend/index.mjs; the AWS SDK comes from the
// Lambda runtime). Configuration: WIKI_ORIGIN, ISSUER, CLIENT_ID, TABLE.
import { ApiGatewayManagementApiClient, DeleteConnectionCommand, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { handleAuthorize, handleConnect, handleDisconnect, handleMessage, handleTicket, type Connection, type ConnectionStore, type Deps } from './handlers.js';
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

const verifier = new TokenVerifier({
  issuer: ISSUER,
  clientId: env('CLIENT_ID'),
  fetchJwks: async () => {
    const r = await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`jwks: ${r.status}`);
    return (await r.json()) as { keys: [] };
  },
});

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
  fetchMe: async (token) => {
    const r = await fetch(`${WIKI_ORIGIN}/api/me`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
  },
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

/** HTTP API (payload 2.0): POST /ticket. */
export async function ticket(event: { headers?: Record<string, string | undefined> }) {
  const h = lower(event.headers);
  const r = await handleTicket(deps(), { authorization: h.authorization, origin: h.origin });
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
