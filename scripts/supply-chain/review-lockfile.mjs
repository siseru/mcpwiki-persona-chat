// Supply-chain review of npm lockfile changes (run on every PR that changes a lockfile).
//
// For every package version that is new compared with the base revision, it checks the npm registry:
//   FAIL  published less than MIN_AGE_DAYS ago (most compromised releases are caught and pulled within days)
//   FAIL  adds install scripts (preinstall / install / postinstall) the previous version did not have
//   FAIL  drops npm provenance (signed build attestation) that the previous version had
//   FAIL  resolved from anywhere but https://registry.npmjs.org/ or without an sha512 integrity hash
//   FAIL  a runtime (non-dev) dependency changed: its source diff is saved for human review
//   WARN  published by a different npm user than the previous version
//   WARN  newly introduced packages (new transitive dependencies)
// Findings that were reviewed by a human are accepted with PR labels:
//   supply-chain-reviewed   accepts the FAIL items above except runtime changes
//   runtime-deps-reviewed   accepts runtime dependency changes (after reading the saved diff)
//
// Usage: node scripts/supply-chain/review-lockfile.mjs <base-git-ref> [lockfile ...]
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS ?? 7);
const REGISTRY = 'https://registry.npmjs.org/';
const base = process.argv[2];
const lockfiles = process.argv.slice(3).length ? process.argv.slice(3) : ['package-lock.json'];
const labels = new Set(JSON.parse(process.env.PR_LABELS || '[]'));
if (!base) {
  console.error('usage: review-lockfile.mjs <base-git-ref> [lockfile ...]');
  process.exit(2);
}

let bundled = 0;

/** @returns {Map<string, {name:string, version:string, resolved?:string, integrity?:string, dev:boolean, scripts:boolean}>} */
function readLock(text, countBundled = false) {
  const out = new Map();
  if (!text) return out;
  const lock = JSON.parse(text);
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path || p.link) continue; // root package / workspace links
    if (p.inBundle) {
      if (countBundled) bundled++; // shipped inside the parent's tarball: covered by the parent's integrity hash
      continue;
    }
    const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.set(`${name}@${p.version}`, {
      name, version: p.version, resolved: p.resolved, integrity: p.integrity, dev: !!p.dev, scripts: !!p.hasInstallScript,
    });
  }
  return out;
}

const gitShow = (ref, file) => {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return '';
  }
};

const packuments = new Map();
async function packument(name) {
  if (!packuments.has(name)) {
    const url = REGISTRY + encodeURIComponent(name);
    packuments.set(name, fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }).then((r) => {
      if (!r.ok) throw new Error(`registry ${r.status} for ${name}`);
      return r.json();
    }));
  }
  return packuments.get(name);
}

/** Markdown table cell from untrusted text (registry metadata / PR-controlled lockfile values). */
const mdCell = (v) =>
  String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, "'");
/** Safe file name from a package name/version taken from the (PR-controlled) lockfile. */
const safeFile = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 120);

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const hasScripts = (meta) => INSTALL_SCRIPTS.some((s) => meta?.scripts?.[s]);
const hasProvenance = (meta) => !!meta?.dist?.attestations;

const findings = []; // { level: 'FAIL'|'WARN', kind, pkg, detail }
const add = (level, kind, pkg, detail) => findings.push({ level, kind, pkg, detail });
const runtimeChanges = [];
let reviewed = 0;

for (const file of lockfiles) {
  if (!existsSync(file)) continue;
  // <base> is a git ref, or (for local testing) a lockfile path.
  const before = readLock(existsSync(base) && base.endsWith('.json') ? readFileSync(base, 'utf8') : gitShow(base, file));
  const after = readLock(readFileSync(file, 'utf8'), true);
  const beforeByName = new Map();
  for (const p of before.values()) beforeByName.set(p.name, p);
  for (const [key, p] of after) {
    if (before.has(key)) continue;
    reviewed++;
    const prev = beforeByName.get(p.name);
    const label = `${p.name}@${p.version}${prev ? ` (was ${prev.version})` : ' (new)'}`;
    if (!p.resolved?.startsWith(REGISTRY)) add('FAIL', 'non-registry source', label, p.resolved ?? 'no resolved URL');
    if (!p.integrity?.startsWith('sha512-')) add('FAIL', 'weak/missing integrity', label, p.integrity ?? 'none');
    let doc;
    try {
      doc = await packument(p.name);
    } catch (e) {
      add('FAIL', 'registry lookup failed', label, e.message);
      continue;
    }
    const meta = doc.versions?.[p.version];
    const prevMeta = prev ? doc.versions?.[prev.version] : undefined;
    if (!meta) {
      add('FAIL', 'version not on registry', label, 'unpublished or never published');
      continue;
    }
    const published = Date.parse(doc.time?.[p.version] ?? '');
    const ageDays = (Date.now() - published) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < MIN_AGE_DAYS) {
      add('FAIL', `younger than ${MIN_AGE_DAYS} days`, label, Number.isFinite(ageDays) ? `${ageDays.toFixed(1)} days old` : 'no publish time');
    }
    if ((hasScripts(meta) || p.scripts) && !(prev && (hasScripts(prevMeta) || prev.scripts))) {
      add('FAIL', 'new install script', label, INSTALL_SCRIPTS.filter((s) => meta.scripts?.[s]).map((s) => `${s}: ${meta.scripts[s]}`).join('; ') || 'hasInstallScript');
    }
    if (prevMeta && hasProvenance(prevMeta) && !hasProvenance(meta)) {
      add('FAIL', 'provenance dropped', label, 'previous version had an npm provenance attestation, this one has none');
    }
    const who = meta._npmUser?.name;
    const prevWho = prevMeta?._npmUser?.name;
    if (prevMeta && who && prevWho && who !== prevWho) add('WARN', 'different publisher', label, `${prevWho} -> ${who}`);
    if (!prev) add('WARN', 'new package', label, p.dev ? 'dev dependency' : 'RUNTIME dependency');
    if (!p.dev) runtimeChanges.push({ ...p, prev });
  }
}

// Runtime dependencies end up in the browser / Lambda bundles: keep the full source diff for review.
if (runtimeChanges.length) {
  mkdirSync('supply-chain-report', { recursive: true });
  for (const p of runtimeChanges) {
    const file = `supply-chain-report/${safeFile(p.name)}-${safeFile(p.prev?.version ?? 'new')}-to-${safeFile(p.version)}.diff`;
    try {
      const args = p.prev ? ['diff', `--diff=${p.name}@${p.prev.version}`, `--diff=${p.name}@${p.version}`] : ['view', `${p.name}@${p.version}`];
      writeFileSync(file, execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 256 << 20 }));
    } catch (e) {
      writeFileSync(file, `npm diff failed: ${e.message}\n`);
    }
    add(labels.has('runtime-deps-reviewed') ? 'WARN' : 'FAIL', 'runtime dependency changed', `${p.name}@${p.version}`, `review ${file}, then add the "runtime-deps-reviewed" label`);
  }
}

const accepted = labels.has('supply-chain-reviewed');
const blocking = findings.filter((f) => f.level === 'FAIL' && (f.kind === 'runtime dependency changed' || !accepted));
const lines = [
  '## Supply-chain review (lockfile)',
  '',
  `Base: \`${base}\` · new package versions reviewed: **${reviewed}** · skipped (bundled inside a parent package): ${bundled} · minimum age: ${MIN_AGE_DAYS} days`,
  `FAIL: ${findings.filter((f) => f.level === 'FAIL').length} (blocking: ${blocking.length}${accepted ? ', "supply-chain-reviewed" label present' : ''}) · WARN: ${findings.filter((f) => f.level === 'WARN').length}`,
  '',
];
if (reviewed === 0) lines.push('_No package versions changed (if this PR changed a lockfile, check that the base ref is correct)._');
if (findings.length) {
  lines.push('| Level | Check | Package | Detail |', '|---|---|---|---|');
  for (const f of findings) lines.push(`| ${f.level} | ${mdCell(f.kind)} | ${mdCell(f.pkg)} | ${mdCell(String(f.detail).slice(0, 300))} |`);
}
const report = lines.join('\n') + '\n';
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
process.exit(blocking.length ? 1 : 0);
