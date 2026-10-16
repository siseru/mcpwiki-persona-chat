// Lambda entry points (bundled by scripts/build.mjs into dist/backend/index.mjs; the AWS SDK comes from the
// Lambda runtime). Configuration: WIKI_ORIGIN, ISSUER, CLIENT_ID, TABLE (tickets, connections, budgets), CATALOG
// (publications), MODEL_ID (Bedrock inference profile for drafts).
import { ApiGatewayManagementApiClient, DeleteConnectionCommand, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { Publication } from './catalog.js';
import type { ChatProvider, Turn } from './chat.js';
import { DraftError, type LlmProvider } from './draft.js';
import { handleAdopt, handleAuthorize, handleConnect, handleDisconnect, handleDraft, handleList, handleMessage, handlePublish, handleTicket, handleUnpublish, type Budget, type CatalogStore, type ConversationStore, type Connection, type ConnectionStore, type Deps, type HttpRequest, type HttpResult } from './handlers.js';
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

const budget: Budget = {
  async take(key, limit, ttlSec) {
    try {
      await db.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: key } },
          UpdateExpression: 'ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)',
          ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':limit': { N: String(limit) }, ':ttl': { N: String(Math.floor(Date.now() / 1000) + ttlSec) } },
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  },
};

const conversations: ConversationStore = {
  async get(id) {
    const r = await db.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `conv#${id}` } }, ConsistentRead: true }));
    return r.Item?.turns?.S ? (JSON.parse(r.Item.turns.S) as Turn[]) : [];
  },
  async put(id, turns, expiresAt) {
    await db.send(new PutItemCommand({ TableName: TABLE, Item: { pk: { S: `conv#${id}` }, turns: { S: JSON.stringify(turns.slice(-40)) }, ttl: { N: String(expiresAt) } } }));
  },
};

const bedrock = new BedrockRuntimeClient({});
const chat: ChatProvider = {
  async chat({ system, messages, maxTokens, onDelta }) {
    const r = await bedrock.send(
      new ConverseStreamCommand({
        modelId: env('MODEL_ID'),
        system: [{ text: system }],
        // Bedrock wants the conversation to start with the user: a leading greeting becomes context instead.
        messages: (messages[0]?.role === 'assistant' ? messages.slice(1) : messages).map((m) => ({ role: m.role, content: [{ text: m.text }] })),
        inferenceConfig: { maxTokens },
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const ev of r.stream ?? []) {
      const delta = ev.contentBlockDelta?.delta?.text;
      if (delta) {
        text += delta;
        await onDelta(delta);
      }
      if (ev.metadata?.usage) ({ inputTokens = 0, outputTokens = 0 } = ev.metadata.usage);
    }
    return { text, inputTokens, outputTokens };
  },
};
const llm: LlmProvider = {
  async draft({ system, user, tool, maxTokens }) {
    const r = await bedrock.send(
      new ConverseCommand({
        modelId: env('MODEL_ID'),
        system: [{ text: system }],
        messages: [{ role: 'user', content: [{ text: user }] }],
        // No temperature: current Claude models on Bedrock reject it ("deprecated for this model").
        inferenceConfig: { maxTokens },
        toolConfig: { tools: [{ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.schema as never } } }], toolChoice: { tool: { name: tool.name } } },
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
    const use = r.output?.message?.content?.find((c) => c.toolUse?.name === tool.name)?.toolUse;
    if (!use) throw new DraftError('the model did not call the tool');
    return { input: use.input, inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 };
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

/** Calls the wiki's API with the user's own token (the wiki applies its own permissions). */
async function wikiSend(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${WIKI_ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}
const wikiGet = (token: string, path: string) => wikiSend(token, 'GET', path);

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
  createArticle: (token, input) => wikiSend(token, 'POST', '/api/articles', input),
  llm,
  chat,
  conversations,
  budget,
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
  'POST /draft': handleDraft,
  'POST /adopt': handleAdopt,
};

/** HTTP API (payload 2.0): the routes above. */
export async function http(event: { routeKey?: string; headers?: Record<string, string | undefined>; body?: string; isBase64Encoded?: boolean }) {
  const h = lower(event.headers);
  const route = ROUTES[event.routeKey ?? ''];
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const r = route ? await route(deps(), { authorization: h.authorization, origin: h.origin, body: body && body.length <= 32_768 ? body : undefined }) : { status: 404, body: { error: 'not_found' } };
  return { statusCode: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(r.body) };
}

/** WebSocket $connect REQUEST authorizer (identity source: the "ticket" query parameter). */
export async function authorize(event: { methodArn: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> }) {
  const identity = await handleAuthorize(deps(), { ticket: event.queryStringParameters?.ticket, origin: lower(event.headers).origin });
  if (!identity) throw new Error('Unauthorized'); // API Gateway answers 401
  return {
    principalId: identity.sub,
    policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }] },
    // Authorizer context values must be strings.
    context: { sub: identity.sub, username: identity.username, role: identity.role, session: identity.session ? JSON.stringify(identity.session) : '' },
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
    await handleConnect(d, ctx.connectionId, { sub: a.sub!, username: a.username!, role: a.role as Identity['role'], ...(a.session ? { session: JSON.parse(a.session) } : {}) });
  } else if (ctx.routeKey === '$disconnect') {
    await handleDisconnect(d, ctx.connectionId);
  } else {
    await handleMessage(d, ctx.connectionId, event.body);
  }
  return { statusCode: 200 };
}
