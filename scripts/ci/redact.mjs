// Keeps environment-specific identifiers out of public Actions logs and job summaries.
//
// Workflow logs, job summaries and artifacts of a public repository are readable by anyone, so the
// AWS account id, the wiki host and the extension's endpoints must not appear there either.
//
//   <cmd> 2>&1 | node scripts/ci/redact.mjs    copy stdin to stdout with known values and AWS ids replaced
// (Masks for the runner are registered by scripts/ci/mask.sh.)
//
// Known values come from AWS_ACCOUNT_ID, ALARM_EMAIL and REDACT_EXTRA (comma-separated values or URLs).
import { createInterface } from 'node:readline';

const values = new Set();
const add = (v) => {
  if (typeof v === 'string' && v.trim().length >= 4) values.add(v.trim());
};
add(process.env.AWS_ACCOUNT_ID);
add(process.env.ALARM_EMAIL);
add((process.env.ALARM_EMAIL ?? '').replace(/[^A-Za-z0-9]/g, ''));
for (const item of (process.env.REDACT_EXTRA ?? '').split(',')) {
  try {
    add(new URL(item.trim()).host);
  } catch {
    add(item);
  }
}

// The wiki each environment plugs into (PERSONACHAT_WIKI): distribution ARNs and ids.
try {
  for (const w of Object.values(JSON.parse(process.env.PERSONACHAT_WIKI || '{}') ?? {})) {
    const arn = w?.distributionArn;
    if (typeof arn === 'string') {
      add(arn);
      add(arn.slice(arn.lastIndexOf('/') + 1));
    }
  }
} catch {
  console.error('redact: PERSONACHAT_WIKI is not valid JSON; only generic patterns are applied');
}

// Identifiers created at deploy time (not known in advance). Each log line is split into tokens and every
// token is tested against fully anchored patterns (no partial matches inside unrelated words or URLs).
const TOKEN_PATTERNS = [
  /^\d{12}$/, // AWS account id
  /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}$/, // Cognito user pool id
  /^d[a-z0-9]{8,16}\.cloudfront\.net$/, // CloudFront distribution domain
  /^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/, // API Gateway endpoint (HTTP and WebSocket)
  /^Z[A-Z0-9]{8,32}$/, // Route 53 hosted zone id
  /^E[A-Z0-9]{12,14}$/, // CloudFront distribution id
  /^[a-z0-9.-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/, // S3 bucket (regional) domain
];
const TOKEN = /[A-Za-z0-9_.-]+/g;

// Longest first so that a longer value is replaced before a value it contains.
const literal = [...values].sort((a, b) => b.length - a.length);
const redactLine = (line) => {
  let out = line;
  for (const v of literal) out = out.split(v).join('***');
  // Any e-mail address: never meant for public logs or job summaries.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***');
  // ARNs split on ":" and "/", so an account id inside an ARN is its own token.
  return out.replace(TOKEN, (tok) => (TOKEN_PATTERNS.some((re) => re.test(tok)) ? '***' : tok));
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) process.stdout.write(redactLine(line) + '\n');
