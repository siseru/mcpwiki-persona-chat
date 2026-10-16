// Repository policy checks (deterministic; non-zero exit on violation). Carried over from MCPWiki
// (scripts/lint.mjs there); rules for code that does not exist yet apply as soon as it does.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL#pathname: on Windows the latter yields "/D:/...", which is not a usable path.
const root = fileURLToPath(new URL('..', import.meta.url));
const files = (dir) => !existsSync(dir) ? [] : statSync(dir).isFile() ? [dir] :
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
const violations = [];
const check = (glob, re, why) => {
  for (const f of files(join(root, glob)).filter((f) => f.endsWith('.ts'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line) && !/lint-allow/.test(line)) violations.push(`${relative(root, f)}:${i + 1}: ${why}\n    ${line.trim()}`);
    });
  }
};

// Trojan Source (CVE-2021-42574): no literal bidi control characters in code; tests use \u escapes.
for (const dir of ['src', 'test', 'scripts']) {
  for (const f of files(join(root, dir)).filter((f) => /\.(ts|mjs|js|sh)$/.test(f))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/[\u202a-\u202e\u2066-\u2069]/.test(line)) violations.push(`${relative(root, f)}:${i + 1}: literal bidi control character (write it as a \\u escape)`);
    });
  }
}

// Alarm e-mail: EmailSubscription derives the construct (logical) id from the address, which CloudFormation
// events then print in public deploy logs. Use sns.Subscription with a fixed id instead.
check('src/infra', /\bEmailSubscription\s*\(/, 'EmailSubscription puts the e-mail address into the logical id (use sns.Subscription with a fixed id)');

// XSS: the extension UI runs inside the wiki's origin and must never write HTML strings into the DOM.
check('src/web', /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, 'raw HTML / dynamic code in web code');
// Tokens must not be persisted in localStorage.
check('src/web', /localStorage/, 'use sessionStorage for tokens');
// MCP tools must not offer deletion.
check('src/mcp', /name:\s*'[^']*(delete|remove|destroy)[^']*'/, 'MCP must not expose a delete tool');
// No logging of tokens, message text or request bodies in the backend.
check('src/backend', /console\.(log|error)\(.*(authorization|accessToken|idToken|ticket|req\.body|\.body\)|\.text\)|prompt)/i, 'do not log credentials, prompts or message text');

// GitHub Actions supply chain: actions pinned to full commit SHAs, explicit permissions, and OIDC token
// minting confined to the deploy job (and Scorecard's result publishing).
const wfDir = join(root, '.github/workflows');
for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(wfDir, f), 'utf8');
  text.split('\n').forEach((line, i) => {
    const m = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
    if (m && !m[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(m[1])) violations.push(`.github/workflows/${f}:${i + 1}: action not pinned to a commit SHA: ${m[1]}`);
    if (/id-token:\s*write/.test(line) && !['deploy.yml', 'scorecard.yml'].includes(f)) violations.push(`.github/workflows/${f}:${i + 1}: id-token: write outside the deploy workflow`);
    if (/pull_request_target/.test(line)) violations.push(`.github/workflows/${f}:${i + 1}: pull_request_target is not allowed`);
  });
  if (!/^permissions:/m.test(text)) violations.push(`.github/workflows/${f}: missing top-level permissions`);
  if (f === 'deploy.yml' && /^permissions:[\s\S]*?^\S/m.exec(text)?.[0].includes('id-token')) violations.push(`.github/workflows/${f}: id-token must be granted per job, not workflow-wide`);
}

// Environment-specific values must come from secrets: the runner prints each step's env block before masks
// can be registered, and only secrets are redacted there (a vars.* value would appear in public logs).
for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
  readFileSync(join(wfDir, f), 'utf8').split('\n').forEach((line, i) => {
    const m = /vars\.(AWS_ACCOUNT_ID|AWS_DEPLOY_ROLE_ARN|ALARM_EMAIL|WIKI_URL|DEV_URL|\w*(ENDPOINT|DOMAIN|HOST|URL)\w*)\b/.exec(line);
    if (m) violations.push(`.github/workflows/${f}:${i + 1}: use secrets.${m[1]} (vars are printed unmasked in public logs)`);
  });
}

// Runtime dependencies are restricted to the approved set (none yet: anything new is discussed first).
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const allowed = new Set([]);
for (const d of Object.keys(pkg.dependencies ?? {})) if (!allowed.has(d)) violations.push(`package.json: runtime dependency "${d}" is not approved`);

if (violations.length) {
  console.error(`lint: ${violations.length} violation(s)\n` + violations.join('\n'));
  process.exit(1);
}
console.log('lint: ok');
