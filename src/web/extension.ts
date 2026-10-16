// The persona-chat bundle, loaded by MCPWiki's extension host (MCPWiki docs/extensions.md, contract 1).
// For now a placeholder that proves the integration: it shows that it was loaded, below articles and on its page.
// It runs in the wiki's origin: build the DOM with textContent only and never store or log tokens.

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
/** Replaced by scripts/build-bundle.mjs with the bundle's content hash (the version shown to users). */
const BUILD = '__BUILD__';

const text = (tag: string, value: string, cls?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = value;
  return el;
};

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
      el.append(
        text('h1', 'Persona Chat'),
        text('p', `拡張が読み込まれました。契約 v${ctx.contract}、版 ${BUILD}。`),
        text('p', `利用者: ${ctx.me.username}（${ctx.me.role}）・パス: ${subpath}`, 'muted'),
      );
    },
  });
}
