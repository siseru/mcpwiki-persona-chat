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

// ------------------------------------------------------------------ conversations (Task 8)

interface Summary {
  id: string;
  type: string;
  title: string;
  version: number;
}

/** The user's own articles, through the wiki's API (same origin, the user's own token). */
async function myArticles(ctx: HostContext): Promise<Summary[]> {
  const token = await ctx.getAccessToken();
  const r = await fetch('/api/articles?mine=1&limit=200', { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: ctx.signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { items: Summary[] }).items;
}

/** Article types this extension gives a meaning to: never offered for conversion into a PC. */
const RESERVED_TYPES = ['PC', 'NPC', 'Facility', 'Organization'];

/** Turns one of the user's own articles into a PC (the type only; the wiki checks that the user may edit it). */
async function makePC(ctx: HostContext, a: Summary): Promise<string | null> {
  const token = await ctx.getAccessToken();
  const r = await fetch(`/api/articles/${encodeURIComponent(a.id)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ version: a.version, type: 'PC' }),
    signal: ctx.signal,
  });
  if (r.ok) return null;
  const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? `HTTP ${r.status}`;
}

/** Creates a PC article owned by the user (the wiki's editor has no field for the article type). */
async function createPC(ctx: HostContext, name: string, intro: string): Promise<{ id?: string; error?: string }> {
  const token = await ctx.getAccessToken();
  const r = await fetch('/api/articles', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ type: 'PC', title: name, body: intro, tags: ['persona-chat'], readScope: 'all', writeScope: 'owner' }),
    signal: ctx.signal,
  });
  const body = (await r.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (r.status === 403) return { error: 'PC を作るには、Wiki の投稿者（editor）以上の権限が必要です。' };
  return r.ok ? { id: body.id } : { error: body.error?.message ?? `HTTP ${r.status}` };
}

const CHAT_ERRORS: Record<string, string> = {
  too_fast: '少し待ってから話しかけてください（3 秒に 1 回まで）。',
  budget_exceeded: '今日は話せる回数の上限に達しました。',
  model_unavailable: '返事を作れませんでした。もう一度話しかけてください。',
  bad_text: '1〜500 文字で話しかけてください。',
  not_published: 'この場は、今は公開されていません。',
  no_session: '入り直してください。',
};

function select(label: string, options: { value: string; text: string }[]) {
  const box = css(document.createElement('label'), { display: 'block', margin: '0 0 0.6rem' });
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.text;
    sel.append(opt);
  }
  css(sel, { marginLeft: '0.5rem' });
  box.append(text('span', label), sel);
  return { box, get: () => sel.value };
}

/** Choose (or create) a PC and an NPC, then talk. */
async function enterPanel(ctx: HostContext, el: HTMLElement, f: PublicFacility) {
  el.replaceChildren();
  let mine: Summary[];
  try {
    mine = await myArticles(ctx);
  } catch (e) {
    return void el.append(text('p', `PC の一覧を取得できませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error'));
  }
  const pcs = mine.filter((a) => a.type === 'PC');
  // Articles written in the wiki's editor have its default type: offer to turn one of them into the PC.
  const convertible = mine.filter((a) => !RESERVED_TYPES.includes(a.type));
  if (!pcs.length && convertible.length) {
    const pick = select('自分の記事から PC を選ぶ:', convertible.map((a) => ({ value: a.id, text: a.title })));
    const use = text('button', 'この記事を PC にする') as HTMLButtonElement;
    const note = text('p', '記事の種類（type）を PC に変えます。本文などは変わりません。', 'muted');
    use.addEventListener('click', async () => {
      use.disabled = true;
      const err = await makePC(ctx, convertible.find((a) => a.id === pick.get())!);
      use.disabled = false;
      if (err) return void (note.textContent = `変えられませんでした: ${err}`);
      void enterPanel(ctx, el, f);
    });
    el.append(text('p', 'この場に入るには、あなたの PC（プレイヤーキャラクター）の記事が必要です。'), pick.box, use, note, text('p', 'または、新しく作ります:', 'muted'));
  }
  // A new PC can always be made (a player may have several characters).
  const createForm = () => {
    const box = document.createElement('div');
    const name = input('PC の名前', '');
    const intro = input('PC の紹介（記事の本文になります。ほかの利用者も読めます）', '', { multiline: true, rows: 3 });
    const make = text('button', 'PC の記事を作る') as HTMLButtonElement;
    const msg = text('p', '', 'muted');
    make.addEventListener('click', async () => {
      if (!name.get()) return void (msg.textContent = '名前を入れてください。');
      make.disabled = true;
      const r = await createPC(ctx, name.get(), intro.get());
      make.disabled = false;
      if (r.error) return void (msg.textContent = `作れませんでした: ${r.error}`);
      void enterPanel(ctx, el, f);
    });
    box.append(name.box, intro.box, make, msg);
    return box;
  };
  if (!pcs.length) {
    if (!convertible.length) el.append(text('p', 'この場に入るには、あなたの PC（プレイヤーキャラクター）の記事が必要です。'));
    return void el.append(createForm());
  }
  const pc = select('PC:', pcs.map((p) => ({ value: p.id, text: p.title })));
  const npc = select('話す相手:', f.npcs.map((n) => ({ value: n.id, text: `${n.name}（${n.role}）` })));
  const go = text('button', '入る') as HTMLButtonElement;
  const msg = text('p', '', 'muted');
  go.addEventListener('click', async () => {
    go.disabled = true;
    msg.textContent = '入っています…';
    try {
      const { ticketUrl, socketUrl } = await endpoints();
      const token = await ctx.getAccessToken();
      const r = await fetch(ticketUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ facilityId: f.id, npcId: npc.get(), pcId: pc.get() }), signal: ctx.signal });
      const body = (await r.json().catch(() => ({}))) as { ticket?: string; message?: string; error?: string };
      if (!r.ok || !body.ticket) return void (msg.textContent = `入れませんでした: ${body.message ?? body.error ?? `HTTP ${r.status}`}`);
      chat(ctx, el, new WebSocket(`${socketUrl}?ticket=${encodeURIComponent(body.ticket)}`), pcs.find((p) => p.id === pc.get())!.title);
    } finally {
      go.disabled = false;
    }
  });
  const more = document.createElement('details');
  more.append(css(text('summary', '新しい PC を作る'), { cursor: 'pointer', margin: '0.8rem 0 0.4rem' }), createForm());
  el.append(pc.box, npc.box, go, msg, more);
}

/** The room: who is present, the shared lines, and talking to the NPC or to everybody. */
function chat(ctx: HostContext, el: HTMLElement, socket: WebSocket, pcName: string) {
  el.replaceChildren();
  const status = text('p', '接続しています…', 'muted');
  const present = text('p', '', 'muted');
  const log = css(document.createElement('div'), { border: '1px solid currentColor', borderRadius: '6px', padding: '0.6rem', minHeight: '8rem', maxHeight: '24rem', overflowY: 'auto', margin: '0 0 0.6rem' });
  const say = input(`${pcName} として話す（Enter で送信、Shift+Enter で改行）`, '', { multiline: true, rows: 2 });
  const area = say.box.querySelector('textarea')!;
  const toNpc = document.createElement('input');
  toNpc.type = 'radio';
  toNpc.name = 'pc-to';
  toNpc.checked = true;
  const toAll = document.createElement('input');
  toAll.type = 'radio';
  toAll.name = 'pc-to';
  const target = document.createElement('div');
  const npcLabel = document.createElement('label');
  const allLabel = document.createElement('label');
  npcLabel.append(toNpc, ' NPC に話す');
  allLabel.append(toAll, ' みんなに話す（NPC は名前を呼ばれたときだけ答えます）');
  target.append(npcLabel, '　', allLabel);
  const send = text('button', '話す') as HTMLButtonElement;
  const leave = text('button', '出る') as HTMLButtonElement;
  leave.className = 'secondary';
  let current: HTMLElement | null = null;
  const line = (kind: string, who: string, words: string) => {
    const p = css(document.createElement('p'), { margin: '0 0 0.5rem' });
    if (kind === 'system') p.append(text('em', words, 'muted'));
    else p.append(text('strong', `${who}: `), text('span', words));
    log.append(p);
    log.scrollTop = log.scrollHeight;
    return p.lastElementChild as HTMLElement;
  };
  const showPresent = (names: string[] | undefined) => names && (present.textContent = `この場にいる PC: ${names.join('、')}`);
  const submit = () => {
    const words = say.get();
    if (!words || socket.readyState !== WebSocket.OPEN) return;
    // The line comes back from the room (in order with everybody else's), so it is not shown here.
    socket.send(JSON.stringify({ type: 'say', text: words, to: toAll.checked ? 'all' : 'npc' }));
    area.value = '';
  };
  send.addEventListener('click', submit);
  area.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submit();
    }
  });
  leave.addEventListener('click', () => socket.close());
  // Heartbeat: a PC without one for 3 minutes counts as gone (its place in the room is freed).
  const heartbeat = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'ping', t: Date.now() })), 60_000);
  const stop = () => (clearInterval(heartbeat), socket.close());
  ctx.signal.addEventListener('abort', stop);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello' })));
  socket.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data)) as {
      type: string; kind?: string; speaker?: string; text?: string; code?: string; capacity?: number; facility?: string;
      present?: string[]; history?: { kind: string; speaker: string; text: string }[];
    };
    if (m.type === 'room') {
      status.textContent = `${m.facility}（定員 ${m.capacity} 人）にいます。`;
      showPresent(m.present);
      for (const l of m.history ?? []) line(l.kind, l.speaker, l.text);
    } else if (m.type === 'line') {
      line(m.kind ?? 'pc', m.speaker ?? '', m.text ?? '');
      showPresent(m.present);
    } else if (m.type === 'start') {
      current = line('npc', m.speaker ?? 'NPC', '');
    } else if (m.type === 'delta' && current) {
      current.textContent += m.text ?? '';
      log.scrollTop = log.scrollHeight;
    } else if (m.type === 'done') {
      if (current) current.textContent = m.text ?? current.textContent;
      current = null;
    } else if (m.type === 'reauth') {
      status.textContent = '長い時間がたったので、いったん切断します。もう一度「入る」を押してください。';
    } else if (m.type === 'error') {
      if (current) (current.textContent ||= '……'), (current = null);
      status.textContent = m.code === 'room_full' ? `満室です（定員 ${m.capacity} 人）。あとでもう一度どうぞ。` : (CHAT_ERRORS[m.code ?? ''] ?? `エラー: ${m.code}`);
    }
  });
  socket.addEventListener('close', () => {
    clearInterval(heartbeat);
    send.disabled = true;
    status.textContent = `${status.textContent ?? ''}（退出しました）`;
  });
  el.append(status, present, log, target, say.box, send, ' ', leave);
}

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
  if (published) {
    const room = document.createElement('div');
    const enter = text('button', 'この場に入る') as HTMLButtonElement;
    enter.addEventListener('click', async () => {
      const r = await api<{ items: PublicFacility[] }>(ctx, 'GET', '/facilities');
      const f = r.body.items?.find((x) => x.id === article.id);
      if (f) void enterPanel(ctx, room, f);
    });
    room.append(enter);
    box.append(room);
  }
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

/** Markdown links read as their text in a quote: "[ミナト](/wiki/minato)" -> "ミナト". */
const plainQuote = (q: string) => q.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');

/**
 * Layout through the CSSOM: the wiki's CSP allows no inline style attributes or <style> elements, and the wiki's
 * stylesheet knows nothing about this form.
 */
const css = (el: HTMLElement, s: Partial<CSSStyleDeclaration>) => (Object.assign(el.style, s), el);

const basisNote = (f: DraftField) =>
  css(text('small', f.basis.kind === 'article' ? `記事に基づく:「${plainQuote(f.basis.quote)}」` : '補った設定（記事にはありません）', 'muted'), {
    display: 'block',
    marginTop: '0.2rem',
    ...(f.basis.kind === 'invented' ? { fontStyle: 'italic' } : {}),
  });

function input(label: string, value: string, opts: { multiline?: boolean; rows?: number; note?: HTMLElement } = {}) {
  const box = css(document.createElement('label'), { display: 'block', margin: '0 0 0.9rem' });
  const el = document.createElement(opts.multiline ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
  el.value = value;
  css(el, { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: '0.25rem' });
  // The wiki's stylesheet gives every textarea the editor's large minimum height: size these by rows instead.
  if (opts.multiline) css(el, { minHeight: '0', height: `${(opts.rows ?? 3) * 1.6 + 1}em`, resize: 'vertical' });
  box.append(css(text('span', label), { fontWeight: '600' }), el);
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
  const form = css(document.createElement('div'), { marginTop: '1rem', maxWidth: '48rem' });
  const id = input('新しい記事の ID（英小文字・数字・-）', '');
  const title = input('記事のタイトル', d.name.value);
  const name = input('名前', d.name.value, { note: basisNote(d.name) });
  const role = input('役割', d.role.value, { note: basisNote(d.role) });
  const persona = input('人格', d.persona.value, { multiline: true, rows: 4, note: basisNote(d.persona) });
  const voice = input('口調', d.voice.value, { note: basisNote(d.voice) });
  const greeting = input('挨拶', d.greeting.value, { note: basisNote(d.greeting) });
  const knowledgeNotes = document.createElement('div');
  for (const k of d.knowledge) {
    const why = k.basis.kind === 'article' ? `記事に基づく:「${plainQuote(k.basis.quote)}」` : '補った設定（記事にはありません）';
    knowledgeNotes.append(css(text('small', `・${k.value} — ${why}`, 'muted'), { display: 'block', marginTop: '0.2rem' }));
  }
  const knowledge = input('知っていること（1 行に 1 つ）', d.knowledge.map((k) => k.value).join('\n'), { multiline: true, rows: Math.max(3, d.knowledge.length + 1), note: knowledgeNotes });
  const background = input('背景（記事の本文になります）', '', { multiline: true, rows: 5 });
  const secrets = d.secrets.map((s, i) => {
    const keep = document.createElement('input');
    keep.type = 'checkbox';
    const visits = document.createElement('input');
    visits.type = 'number';
    visits.min = '1';
    visits.max = '100';
    visits.value = String(s.reveal.afterVisits);
    const t = input(`秘密の候補 ${i + 1}（採用するものだけ「残す」に印を付けます）`, s.value, { multiline: true, rows: 2, note: basisNote(s) });
    const row = css(document.createElement('div'), { border: '1px solid currentColor', borderRadius: '6px', padding: '0.6rem', margin: '0 0 0.9rem', opacity: '0.95' });
    css(visits, { width: '4.5rem' });
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
