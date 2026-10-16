// Compares two synthesized cloud assemblies (cdk.out) resource by resource.
//
// Why: a compromised CDK library (or build tool) can change *what gets deployed* without touching our
// source. Every dependency PR and every prod release shows the infrastructure delta, and dependency-only
// PRs that change security-relevant resources fail until a human adds the "infra-diff-reviewed" label.
//
// Usage: node scripts/supply-chain/template-diff.mjs <base cdk.out> <head cdk.out> [--strict]
//   --strict  exit 1 on security-relevant changes (unless PR_LABELS contains "infra-diff-reviewed")
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [baseDir, headDir, ...flags] = process.argv.slice(2);
if (!baseDir || !headDir) {
  console.error('usage: template-diff.mjs <base cdk.out> <head cdk.out> [--strict]');
  process.exit(2);
}
const strict = flags.includes('--strict');
const labels = new Set(JSON.parse(process.env.PR_LABELS || '[]'));

// Resource types whose changes can alter who can access what (or what code runs where).
const SENSITIVE = [
  /^AWS::IAM::/, /^AWS::Lambda::(Function|Permission|LayerVersion)/, /^AWS::S3::BucketPolicy/, /^AWS::SNS::TopicPolicy/,
  /^AWS::KMS::/, /^AWS::SecretsManager::/, /^AWS::CloudFront::/, /^AWS::Cognito::/, /^AWS::WAFv2::/, /^AWS::Route53::/,
  /^AWS::ApiGatewayV2::/, /^AWS::S3::Bucket$/, /^AWS::Backup::/, /^AWS::CertificateManager::/, /^AWS::SSM::/, /^Custom::/,
];
const isSensitive = (type, path) => SENSITIVE.some((re) => re.test(type)) || /Polic(y|ies)|Role|Principal|AssumeRole/.test(path);

const ASSET_HASH = /[0-9a-f]{64}/g;
/** Markdown table cell from untrusted text (registry metadata / PR-controlled lockfile values). */
const mdCell = (v) =>
  String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, "'");

function templates(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.template.json'))) {
    out.set(f.replace('.template.json', ''), JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  return out;
}

/** Drop noise (CDK metadata, asset hashes) and return { resources, assetChanges }. */
function normalize(t) {
  const resources = {};
  for (const [id, r] of Object.entries(t?.Resources ?? {})) {
    if (r.Type === 'AWS::CDK::Metadata') continue;
    const { Metadata: _m, ...rest } = r;
    resources[id] = rest;
  }
  return resources;
}

function flatten(v, prefix = '', out = {}) {
  if (v && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    if (!entries.length) out[prefix] = JSON.stringify(v);
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : String(k), out);
  } else out[prefix] = JSON.stringify(v);
  return out;
}

const base = templates(baseDir);
const head = templates(headDir);
const rows = []; // { stack, id, type, change, detail, sensitive }
let assetChanges = 0;

for (const stack of new Set([...base.keys(), ...head.keys()])) {
  const b = normalize(base.get(stack));
  const h = normalize(head.get(stack));
  if (!base.has(stack)) rows.push({ stack, id: '*', type: 'stack', change: 'added', detail: `${Object.keys(h).length} resources`, sensitive: true });
  if (!head.has(stack)) rows.push({ stack, id: '*', type: 'stack', change: 'removed', detail: '', sensitive: true });
  for (const id of new Set([...Object.keys(b), ...Object.keys(h)])) {
    const type = (h[id] ?? b[id]).Type;
    if (!b[id]) {
      rows.push({ stack, id, type, change: 'added', detail: '', sensitive: isSensitive(type, '') });
      continue;
    }
    if (!h[id]) {
      rows.push({ stack, id, type, change: 'removed', detail: '', sensitive: isSensitive(type, '') });
      continue;
    }
    const fb = flatten(b[id]);
    const fh = flatten(h[id]);
    const changed = [];
    for (const k of new Set([...Object.keys(fb), ...Object.keys(fh)])) {
      if (fb[k] === fh[k]) continue;
      // Asset hash only (Lambda code / web bundle rebuilt): reported separately, not a structural change.
      if (fb[k] !== undefined && fh[k] !== undefined && fb[k].replace(ASSET_HASH, '#') === fh[k].replace(ASSET_HASH, '#')) {
        assetChanges++;
        continue;
      }
      changed.push(k);
    }
    if (changed.length) {
      rows.push({
        stack, id, type, change: 'modified',
        // Each piece is escaped; only the <br> separators are markup.
        detail: changed.slice(0, 6).map((k) => mdCell(`${k}: ${(fb[k] ?? '∅').slice(0, 80)} → ${(fh[k] ?? '∅').slice(0, 80)}`)).join('<br>') + (changed.length > 6 ? `<br>… ${changed.length - 6} more` : ''),
        sensitive: changed.some((k) => isSensitive(type, k)),
      });
    }
  }
}

const sensitive = rows.filter((r) => r.sensitive);
const accepted = labels.has('infra-diff-reviewed');
const lines = [
  '## Infrastructure diff (synthesized CloudFormation)',
  '',
  `Stacks compared: ${new Set([...base.keys(), ...head.keys()]).size} · resource changes: **${rows.length}** (security-relevant: **${sensitive.length}**) · asset-hash-only changes: ${assetChanges}`,
  '',
];
if (rows.length) {
  lines.push('| | Stack | Resource | Type | Change | Detail |', '|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.sensitive ? '⚠️' : ''} | ${mdCell(r.stack)} | ${mdCell(r.id)} | ${mdCell(r.type)} | ${r.change} | ${r.detail} |`);
} else {
  lines.push('_No structural changes._');
}
if (strict && sensitive.length) {
  lines.push('', accepted ? '"infra-diff-reviewed" label present: accepted.' : '**Dependency-only change alters security-relevant infrastructure.** Review the table, then add the `infra-diff-reviewed` label.');
}
const report = lines.join('\n') + '\n';
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
process.exit(strict && sensitive.length && !accepted ? 1 : 0);
