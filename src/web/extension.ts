// The persona-chat bundle, loaded by MCPWiki's extension host (MCPWiki docs/extensions.md, contract 1).
// For now it proves the integration: it shows that it was loaded below articles, and its page runs a connection
// test (ticket over HTTPS, then WebSocket ping / pong).
// It runs in the wiki's origin: build the DOM with textContent only and never store or log tokens. The access token
// goes to the extension's own ticket endpoint only.

interface HostArticle {
  id: string;
  type: string;
  title: string;
}
interface HostContext {
  contract: number;
  me: { username: string; role: 'admin' | 'editor' | 'viewer' };
  article?: HostArticle;
  navigate(path: string): void;
  signal: AbortSignal;
  getAccessToken(): Promise<string | null>;
}
interface Host {
  contracts: number[];
  register(mod: {
    id: string;
    contract: number;
    title?: string;
    articleSlot?(ctx: HostContext, el: HTMLElement): void;
    page?(ctx: HostContext, el: HTMLElement, subpath: string): void;
  }): void;
}

export const EXTENSION_ID = 'persona-chat';
export const CONTRACT = 1;
/** Replaced by scripts/build.mjs with the bundle's content hash (the version shown to users). */
const BUILD = '__BUILD__';

const text = (tag: string, value: string, cls?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = value;
  return el;
};

/** Endpoints, deployed next to the bundle (they are only known after the stack is deployed). */
interface Endpoints {
  apiUrl: string;
  ticketUrl: string;
  socketUrl: string;
}
let endpointsCache: Promise<Endpoints> | undefined;
function endpoints(): Promise<Endpoints> {
  endpointsCache ??= fetch(`/ext/${EXTENSION_ID}/config.json`, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`config.json: ${r.status}`);
    return r.json() as Promise<Endpoints>;
  });
  return endpointsCache;
}

interface PublicFacility {
  id: string;
  title: string;
  type: string;
  capacity: number;
  hours: string;
  npcs: { id: string; name: string; role: string }[];
}

/** Calls the extension's own API with the user's token (and only that API). */
async function api<T>(ctx: HostContext, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const { apiUrl } = await endpoints();
  const token = await ctx.getAccessToken();
  if (!token) throw new Error('サインインしていません。');
  const r = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctx.signal,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

const FACILITY_TYPES = ['Facility', 'Organization'];
const describe = (f: PublicFacility) =>
  `定員 ${f.capacity} 人${f.hours ? `・営業 ${f.hours}` : ''}・NPC: ${f.npcs.map((n) => `${n.name}（${n.role}）`).join('、')}`;

/** Below a facility article: whether it is published; for DMs (admins), publish / update / unpublish. */
async function facilitySlot(ctx: HostContext, el: HTMLElement) {
  const article = ctx.article!;
  const box = document.createElement('div');
  const status = text('p', '会話の場: 確認しています…', 'muted');
  box.append(status);
  el.append(box);
  const refresh = async () => {
    const r = await api<{ items: PublicFacility[] }>(ctx, 'GET', '/facilities');
    const f = r.status === 200 ? r.body.items.find((x) => x.id === article.id) : undefined;
    status.textContent = r.status !== 200 ? `会話の場: 状態を取得できませんでした（HTTP ${r.status}）。` : f ? `会話の場として公開中: ${describe(f)}` : '会話の場としては、まだ公開されていません。';
    return !!f;
  };
  const published = await refresh();
  if (ctx.me.role !== 'admin') {
    if (!published) box.remove(); // nothing to say to players about unpublished places
    return;
  }
  const message = text('p', '', 'muted');
  const action = async (path: '/publish' | '/unpublish', label: string) => {
    message.textContent = `${label}しています…`;
    const r = await api<{ result?: string; message?: string; error?: string }>(ctx, 'POST', path, { facilityId: article.id });
    const results: Record<string, string> = { published: '公開しました。', updated: '最新の記事で更新しました。', unchanged: '記事に変更がないので、そのままです。', unpublished: '公開をやめました。', not_published: '公開されていませんでした。' };
    message.textContent = r.status === 200 ? (results[r.body.result ?? ''] ?? '完了しました。') : `失敗しました: ${r.body.message ?? r.body.error ?? `HTTP ${r.status}`}`;
    await refresh();
  };
  const publish = text('button', '公開する／更新する') as HTMLButtonElement;
  publish.addEventListener('click', () => void action('/publish', '公開'));
  const unpublish = text('button', '公開をやめる') as HTMLButtonElement;
  unpublish.className = 'secondary';
  unpublish.addEventListener('click', () => void action('/unpublish', '公開の取り消しを'));
  box.append(text('p', 'DM 向け: 公開すると、この記事と NPC の記事の今の内容が会話に使われます。記事を直したら、もう一度公開してください。', 'muted'), publish, unpublish, message);
}

interface DraftField {
  value: string;
  basis: { kind: 'article'; quote: string } | { kind: 'invented' };
}
interface Draft {
  name: DraftField;
  role: DraftField;
  persona: DraftField;
  voice: DraftField;
  greeting: DraftField;
  knowledge: DraftField[];
  secrets: (DraftField & { reveal: { afterVisits: number } })[];
}

const basisNote = (f: DraftField) =>
  text('small', f.basis.kind === 'article' ? `記事に基づく:「${f.basis.quote}」` : '補った設定（記事にはありません）', f.basis.kind === 'article' ? 'muted' : 'invented');

function input(label: string, value: string, opts: { multiline?: boolean; note?: HTMLElement } = {}) {
  const box = document.createElement('label');
  box.className = 'field';
  const el = document.createElement(opts.multiline ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
  el.value = value;
  if (opts.multiline) (el as HTMLTextAreaElement).rows = 3;
  box.append(text('span', label), el);
  if (opts.note) box.append(opts.note);
  return { box, get: () => el.value.trim() };
}

/**
 * For DMs (admins), below any article that is not an NPC: ask for an NPC draft based on it, edit it, adopt it.
 * Adopting creates an admin-only NPC article (status draft) in the wiki; publishing stays a separate step.
 */
function draftPanel(ctx: HostContext, el: HTMLElement) {
  const article = ctx.article!;
  const box = document.createElement('div');
  const message = text('p', '', 'muted');
  const start = text('button', 'この記事から NPC の下書きを作る') as HTMLButtonElement;
  start.className = 'secondary';
  box.append(start, message);
  el.append(box);
  start.addEventListener('click', async () => {
    start.disabled = true;
    message.textContent = '下書きを作っています（10〜20 秒ほどかかります）…';
    try {
      const r = await api<{ draft?: Draft; message?: string; error?: string }>(ctx, 'POST', '/draft', { articleId: article.id });
      if (r.status !== 200 || !r.body.draft) return void (message.textContent = `作れませんでした: ${r.body.message ?? r.body.error ?? `HTTP ${r.status}`}`);
      message.textContent = '下書きです。直してから「採用」を押すと、管理者だけが読める NPC の記事（下書き）ができます。会話の場には、自動では出ません。';
      box.append(draftForm(ctx, r.body.draft));
    } finally {
      start.disabled = false;
    }
  });
}

function draftForm(ctx: HostContext, d: Draft): HTMLElement {
  const form = document.createElement('div');
  form.className = 'npc-draft';
  const id = input('新しい記事の ID（英小文字・数字・-）', '');
  const title = input('記事のタイトル', d.name.value);
  const name = input('名前', d.name.value, { note: basisNote(d.name) });
  const role = input('役割', d.role.value, { note: basisNote(d.role) });
  const persona = input('人格', d.persona.value, { multiline: true, note: basisNote(d.persona) });
  const voice = input('口調', d.voice.value, { note: basisNote(d.voice) });
  const greeting = input('挨拶', d.greeting.value, { note: basisNote(d.greeting) });
  const knowledgeNotes = document.createElement('div');
  for (const k of d.knowledge) knowledgeNotes.append(document.createElement('br'), basisNote(k));
  const knowledge = input('知っていること（1 行に 1 つ）', d.knowledge.map((k) => k.value).join('\n'), { multiline: true, note: knowledgeNotes });
  const background = input('背景（記事の本文になります）', '', { multiline: true });
  const secrets = d.secrets.map((s, i) => {
    const keep = document.createElement('input');
    keep.type = 'checkbox';
    const visits = document.createElement('input');
    visits.type = 'number';
    visits.min = '1';
    visits.max = '100';
    visits.value = String(s.reveal.afterVisits);
    const t = input(`秘密の候補 ${i + 1}（採用するものだけ「残す」に印を付けます）`, s.value, { multiline: true, note: basisNote(s) });
    const row = document.createElement('div');
    row.className = 'secret';
    const keepLabel = document.createElement('label');
    keepLabel.append(keep, ' 残す');
    const visitsLabel = document.createElement('label');
    visitsLabel.append('話すのは、訪問 ', visits, ' 回目から');
    row.append(t.box, keepLabel, ' ', visitsLabel);
    return { row, get: () => (keep.checked ? { text: t.get(), reveal: { afterVisits: Number(visits.value) } } : null) };
  });
  const adopt = text('button', '採用して NPC の記事を作る') as HTMLButtonElement;
  const result = text('p', '', 'muted');
  adopt.addEventListener('click', async () => {
    adopt.disabled = true;
    result.textContent = '記事を作っています…';
    try {
      const npc = {
        name: name.get(), role: role.get(), persona: persona.get(), voice: voice.get(), greeting: greeting.get(),
        knowledge: knowledge.get().split('\n').map((s) => s.trim()).filter(Boolean),
        secrets: secrets.map((s) => s.get()).filter((s): s is NonNullable<typeof s> => !!s && !!s.text),
      };
      const r = await api<{ id?: string; message?: string; error?: string }>(ctx, 'POST', '/adopt', { id: id.get(), title: title.get(), sourceArticleId: ctx.article!.id, npc, background: background.get() });
      if (r.status !== 201) return void (result.textContent = `作れませんでした: ${r.body.message ?? r.body.error ?? `HTTP ${r.status}`}`);
      result.textContent = '';
      const a = text('a', `NPC の記事「${title.get()}」を作りました（下書き・管理者のみ）。`);
      a.setAttribute('href', `/wiki/${r.body.id}`);
      result.append(a, ' 施設の記事の npcs に入れて公開すると、会話に出ます。');
    } finally {
      adopt.disabled = false;
    }
  });
  form.append(id.box, title.box, name.box, role.box, persona.box, voice.box, greeting.box, knowledge.box, ...secrets.map((s) => s.row), background.box, adopt, result);
  return form;
}

/** The list of published facilities, for everyone. */
async function facilityList(ctx: HostContext, el: HTMLElement) {
  const r = await api<{ items: PublicFacility[] }>(ctx, 'GET', '/facilities');
  if (r.status !== 200) return void el.append(text('p', `会話の場の一覧を取得できませんでした（HTTP ${r.status}）。`, 'error'));
  if (!r.body.items.length) return void el.append(text('p', 'まだ公開された会話の場はありません。', 'muted'));
  const ul = document.createElement('ul');
  for (const f of r.body.items) {
    const li = document.createElement('li');
    const a = text('a', f.title);
    a.setAttribute('href', `/wiki/${f.id}`);
    li.append(a, ` — ${describe(f)}`);
    ul.append(li);
  }
  el.append(ul);
}

/**
 * Ticket over HTTPS, then WebSocket; one ping. Shows how long each step took: getting the ticket, opening the
 * socket (TLS + upgrade + authorizer + $connect) and the ping round trip on the open socket.
 */
async function connectionTest(ctx: HostContext, out: HTMLElement): Promise<void> {
  const line = (s: string, cls?: string) => out.append(text('li', s, cls));
  out.replaceChildren();
  const ms = (from: number) => `${Math.round(performance.now() - from)} ms`;
  try {
    const t0 = performance.now();
    const { ticketUrl, socketUrl } = await endpoints();
    const token = await ctx.getAccessToken();
    if (!token) return line('サインインしていません。', 'error');
    const r = await fetch(ticketUrl, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: ctx.signal });
    if (!r.ok) return line(`チケットを発行できませんでした（HTTP ${r.status}）。`, 'error');
    const { ticket, maxConnectionSec } = (await r.json()) as { ticket: string; maxConnectionSec: number };
    line(`チケットを受け取りました（${ms(t0)}、接続は最長 ${Math.round(maxConnectionSec / 60)} 分）。`);
    const t1 = performance.now();
    const socket = new WebSocket(`${socketUrl}?ticket=${encodeURIComponent(ticket)}`);
    ctx.signal.addEventListener('abort', () => socket.close());
    let t2 = 0;
    await new Promise<void>((resolve) => {
      socket.addEventListener('open', () => {
        line(`WebSocket に接続しました（${ms(t1)}）。ping を送ります。`);
        t2 = performance.now();
        socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      });
      socket.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; username?: string; role?: string };
        if (m.type === 'pong') line(`pong を受け取りました: ${m.username}（${m.role}）・ping の往復 ${ms(t2)}`, 'ok');
        else line(`応答: ${m.type}`);
        socket.close();
      });
      socket.addEventListener('close', (ev) => (line(`切断しました（コード ${ev.code}）。`, 'muted'), resolve()));
      socket.addEventListener('error', () => line('WebSocket に接続できませんでした。', 'error'));
    });
  } catch (e) {
    if (!ctx.signal.aborted) line(`失敗しました: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

const host = (globalThis as { mcpwikiHost?: Host }).mcpwikiHost;
if (host?.contracts.includes(CONTRACT)) {
  host.register({
    id: EXTENSION_ID,
    contract: CONTRACT,
    title: 'Persona Chat',
    async articleSlot(ctx, el) {
      if (!ctx.article) return;
      if (FACILITY_TYPES.includes(ctx.article.type)) await facilitySlot(ctx, el);
      if (ctx.me.role === 'admin' && ctx.article.type !== 'NPC') draftPanel(ctx, el);
    },
    page(ctx, el, subpath) {
      const out = document.createElement('ul');
      const button = text('button', '接続テスト') as HTMLButtonElement;
      // One test at a time, so the lines of two runs never mix.
      button.addEventListener('click', () => {
        button.disabled = true;
        void connectionTest(ctx, out).finally(() => (button.disabled = false));
      });
      const list = document.createElement('div');
      el.append(
        text('h1', 'Persona Chat'),
        text('h2', '会話の場'),
        list,
        text('h2', '接続テスト'),
        text('p', `契約 v${ctx.contract}、版 ${BUILD}・利用者: ${ctx.me.username}（${ctx.me.role}）・パス: ${subpath}`, 'muted'),
        button,
        out,
      );
      void facilityList(ctx, list);
    },
  });
}
