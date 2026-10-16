// The deployed artifact, not the TypeScript sources: the Lambda bundle must load (module init) and export every
// handler the stack wires up. A bundling mistake (e.g. a CommonJS dependency calling require() inside the ES
// module) otherwise only shows up as "Runtime.Unknown" for every request after deployment.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)); // build/test -> repository root

test('the Lambda bundle loads and exports the handlers', async () => {
  Object.assign(process.env, {
    WIKI_ORIGIN: 'https://wiki-dev.example.com',
    ISSUER: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_EXAMPLE12',
    CLIENT_ID: 'exampleclientid0123456789ab',
    TABLE: 'state',
    CATALOG: 'catalog',
    MODEL_ID: 'us.anthropic.claude-haiku-5-5',
    MEMORY_ID: 'PersonaChat_dev-EXAMPLE',
    AWS_REGION: 'us-west-2',
  });
  const mod = (await import(pathToFileURL(join(repoRoot, 'dist/backend/index.mjs')).href)) as Record<string, unknown>;
  for (const name of ['http', 'authorize', 'ws']) assert.equal(typeof mod[name], 'function', name);
});
