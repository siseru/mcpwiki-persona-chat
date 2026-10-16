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
async function endpoints(): Promise<{ ticketUrl: string; socketUrl: string }> {
  const r = await fetch(`/ext/${EXTENSION_ID}/config.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`config.json: ${r.status}`);
  return (await r.json()) as { ticketUrl: string; socketUrl: string };
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
    articleSlot(ctx, el) {
      if (!ctx.article) return;
      el.append(text('p', `persona-chat 拡張が読み込まれました（契約 v${ctx.contract}、版 ${BUILD}）。`, 'muted'));
    },
    page(ctx, el, subpath) {
      const out = document.createElement('ul');
      const button = text('button', '接続テスト') as HTMLButtonElement;
      // One test at a time, so the lines of two runs never mix.
      button.addEventListener('click', () => {
        button.disabled = true;
        void connectionTest(ctx, out).finally(() => (button.disabled = false));
      });
      el.append(
        text('h1', 'Persona Chat'),
        text('p', `拡張が読み込まれました。契約 v${ctx.contract}、版 ${BUILD}。`),
        text('p', `利用者: ${ctx.me.username}（${ctx.me.role}）・パス: ${subpath}`, 'muted'),
        button,
        out,
      );
    },
  });
}
