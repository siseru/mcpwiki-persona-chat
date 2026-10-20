// Lambda entry points (bundled by scripts/build.mjs into dist/backend/index.mjs; the AWS SDK comes from the
// Lambda runtime). Configuration: WIKI_ORIGIN, ISSUER, CLIENT_ID, TABLE (tickets, connections, budgets), CATALOG
// (publications), MODEL_ID (Bedrock inference profile for drafts).
import { ApiGatewayManagementApiClient, DeleteConnectionCommand, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { randomUUID } from 'node:crypto';
// Bundled (not the runtime's copy): custom namespace variables (extractionConfig) need client 3.1148+.
import { BedrockAgentCoreClient, CreateEventCommand, ListMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Publication } from './catalog.js';
import type { ChatProvider } from './chat.js';
import { namespaceOf, type MemoryProvider } from './memory.js';
import type { JoinResult, Member, RoomLine, RoomStore } from './rooms.js';
import { DraftError, type LlmProvider } from './draft.js';
import { handleAdopt, handleAuthorize, handleConnect, handleDisconnect, handleDraft, handleList, handleMessage, handlePublish, handleRoomJob, handleTicket, handleUnpublish, type Budget, type CatalogStore, type HistoryStore, type Job, type Connection, type ConnectionStore, type Deps, type HttpRequest, type HttpResult } from './handlers.js';
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

const history: HistoryStore = {
  async get(facilityId) {
    const r = await db.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `history#${facilityId}` } }, ConsistentRead: true }));
    return r.Item?.lines?.S ? (JSON.parse(r.Item.lines.S) as RoomLine[]) : [];
  },
  async put(facilityId, lines, expiresAt) {
    await db.send(new PutItemCommand({ TableName: TABLE, Item: { pk: { S: `history#${facilityId}` }, lines: { S: JSON.stringify(lines) }, ttl: { N: String(expiresAt) } } }));
  },
};

/**
 * One item per room: pk room#<facility>, a map of members (connection id -> JSON) and their count. Joining is a
 * conditional update (count below capacity, not yet a member), so two people can never take the last place.
 */
const rooms: RoomStore = {
  async join(facilityId, m, capacity, staleBefore) {
    const pk = { S: `room#${facilityId}` };
    // The members map must exist before a member can be set inside it.
    await db.send(new PutItemCommand({ TableName: TABLE, Item: { pk, members: { M: {} }, n: { N: '0' } }, ConditionExpression: 'attribute_not_exists(pk)' })).catch((e) => {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
    });
    const tryJoin = async (): Promise<boolean> => {
      try {
        await db.send(
          new UpdateItemCommand({
            TableName: TABLE,
            Key: { pk },
            UpdateExpression: 'SET members.#c = :m ADD n :one',
            ConditionExpression: 'n < :cap AND attribute_not_exists(members.#c)',
            ExpressionAttributeNames: { '#c': m.connectionId },
            ExpressionAttributeValues: { ':m': { S: JSON.stringify(m) }, ':one': { N: '1' }, ':cap': { N: String(capacity) } },
          }),
        );
        return true;
      } catch (e) {
        if (e instanceof ConditionalCheckFailedException) return false;
        throw e;
      }
    };
    if (await tryJoin()) return 'joined' satisfies JoinResult;
    const current = await this.members(facilityId);
    if (current.some((x) => x.connectionId === m.connectionId)) return 'already';
    // Full: drop members without a heartbeat (lost $disconnect), each only if unchanged since read, then retry once.
    for (const x of current.filter((x) => x.lastSeen < staleBefore)) await removeMember(facilityId, x.connectionId, JSON.stringify(x));
    return (await tryJoin()) ? 'joined' : 'full';
  },
  async leave(facilityId, connectionId) {
    const r = await db.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `room#${facilityId}` } }, ConsistentRead: true }));
    const raw = r.Item?.members?.M?.[connectionId]?.S;
    if (!raw) return null;
    return (await removeMember(facilityId, connectionId)) ? (JSON.parse(raw) as Member) : null;
  },
  async members(facilityId) {
    const r = await db.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `room#${facilityId}` } }, ConsistentRead: true }));
    return Object.values(r.Item?.members?.M ?? {}).map((v) => JSON.parse(v.S!) as Member);
  },
  async touch(facilityId, connectionId, now) {
    const r = await db.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `room#${facilityId}` } }, ConsistentRead: true }));
    const raw = r.Item?.members?.M?.[connectionId]?.S;
    if (!raw) return;
    await db
      .send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: `room#${facilityId}` } },
          UpdateExpression: 'SET members.#c = :m',
          ConditionExpression: 'attribute_exists(members.#c)',
          ExpressionAttributeNames: { '#c': connectionId },
          ExpressionAttributeValues: { ':m': { S: JSON.stringify({ ...(JSON.parse(raw) as Member), lastSeen: now }) } },
        }),
      )
      .catch((e) => {
        if (!(e instanceof ConditionalCheckFailedException)) throw e; // left meanwhile
      });
  },
};

/** Removes one member (optionally only if its stored JSON is still `expected`); true if it was removed. */
async function removeMember(facilityId: string, connectionId: string, expected?: string): Promise<boolean> {
  try {
    await db.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: { pk: { S: `room#${facilityId}` } },
        UpdateExpression: 'REMOVE members.#c ADD n :minus',
        ConditionExpression: expected ? 'members.#c = :expected' : 'attribute_exists(members.#c)',
        ExpressionAttributeNames: { '#c': connectionId },
        ExpressionAttributeValues: { ':minus': { N: '-1' }, ...(expected ? { ':expected': { S: expected } } : {}) },
      }),
    );
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return false;
    throw e;
  }
}

const sqs = new SQSClient({});
const enqueue = async (job: Job) => {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: env('QUEUE_URL'),
      MessageBody: JSON.stringify(job),
      MessageGroupId: job.facilityId, // one room at a time, in order
      MessageDeduplicationId: randomUUID(),
    }),
  );
};

const agentcore = new BedrockAgentCoreClient({});
const memory: MemoryProvider = {
  async record(key, turns) {
    await agentcore.send(
      new CreateEventCommand({
        memoryId: env('MEMORY_ID'),
        actorId: key.actorId,
        sessionId: key.sessionId,
        eventTimestamp: new Date(),
        payload: turns.map((t) => ({ conversational: { role: t.role === 'user' ? 'USER' : 'ASSISTANT', content: { text: t.text } } })),
        // Resolves the strategy's namespace template /npc/{npc}/pc/{pc}/ (values validated by AgentCore too).
        extractionConfig: { namespaceVariables: { npc: key.npcId, pc: key.pcId } },
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  },
  async recall(key, max) {
    const r = await agentcore.send(new ListMemoryRecordsCommand({ memoryId: env('MEMORY_ID'), namespace: namespaceOf(key), maxResults: max }), { abortSignal: AbortSignal.timeout(5000) });
    return (r.memoryRecordSummaries ?? []).map((m) => m.content?.text ?? '').filter(Boolean);
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
    let truncated = false;
    for await (const ev of r.stream ?? []) {
      if (ev.messageStop?.stopReason === 'max_tokens') truncated = true;
      const delta = ev.contentBlockDelta?.delta?.text;
      if (delta) {
        text += delta;
        await onDelta(delta);
      }
      if (ev.metadata?.usage) ({ inputTokens = 0, outputTokens = 0 } = ev.metadata.usage);
    }
    return { text, inputTokens, outputTokens, truncated };
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

// The room worker is not invoked by API Gateway, so the management endpoint comes from the configuration.
let managerClient: ApiGatewayManagementApiClient | undefined;
const manager = () => (managerClient ??= new ApiGatewayManagementApiClient({ endpoint: env('SOCKET_ENDPOINT') }));

const deps = (): Deps => ({
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
  history,
  rooms,
  enqueue,
  memory,
  budget,
  send: async (connectionId, data) => {
    try {
      await manager().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(data)) }));
      return true;
    } catch (e) {
      if (!(e instanceof GoneException)) throw e;
      await connections.delete(connectionId);
      return false;
    }
  },
  close: async (connectionId) => {
    try {
      await manager().send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
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
  const d = deps();
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

/** The room worker (SQS FIFO, batch size 1): one job at a time per room. */
export async function worker(event: { Records: { body: string }[] }) {
  const d = deps();
  for (const r of event.Records) await handleRoomJob(d, JSON.parse(r.body) as Job);
}
