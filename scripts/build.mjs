// Build outputs under dist/:
//   ext/persona-chat/persona-chat-<hash>.js  the browser bundle, from the compiled build/src/web/extension.js; the
//                                           file name carries the content hash (the wiki caches it as immutable)
//   bundle.json                             { id, contract, script, integrity }: what the wiki's MCPWIKI_EXTENSIONS needs
//   backend/index.mjs                       the Lambda handlers (esbuild; the AWS SDK comes from the Lambda runtime)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(join(root, 'build/src/web/extension.js'), 'utf8');
const id = /EXTENSION_ID = '([a-z][a-z0-9-]+)'/.exec(src)?.[1];
const contract = Number(/CONTRACT = (\d+)/.exec(src)?.[1]);
if (!id || !contract) throw new Error('build: EXTENSION_ID / CONTRACT not found in the compiled bundle');
if (/^\s*import\s/m.test(src)) throw new Error('build: the bundle must not import anything (it is served as a single file)');
// The version label is derived from the source, so it never changes the hash for the same code.
const version = createHash('sha256').update(src).digest('hex').slice(0, 8);
const body = src.replace('__BUILD__', version);
const script = `${id}-${version}.js`;
const integrity = `sha384-${createHash('sha384').update(body).digest('base64')}`;
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'ext', id), { recursive: true });
writeFileSync(join(out, 'ext', id, script), body);
writeFileSync(join(out, 'bundle.json'), JSON.stringify({ id, contract, script, integrity }, null, 2) + '\n');
console.log(`bundle: dist/ext/${id}/${script} ${integrity}`);

await build({
  entryPoints: [join(root, 'src/backend/index.ts')],
  outfile: join(out, 'backend/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['@aws-sdk/*'],
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('backend: dist/backend/index.mjs');
