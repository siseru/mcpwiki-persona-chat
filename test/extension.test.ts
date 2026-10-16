import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { App, DefaultStackSynthesizer, PermissionsBoundary } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ExtensionStack } from '../src/infra/extension-stack.js';
import { DEV_BOUNDARY_NAME, DEV_QUALIFIER } from '../src/infra/guard-stack.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)); // build/test -> repository root
const ARN = 'arn:aws:cloudfront::123456789012:distribution/E1EXAMPLE12345';

function devStack() {
  const app = new App();
  const stack = new ExtensionStack(app, 'PersonaChat-dev', {
    env: { account: '123456789012', region: 'us-west-2' },
    envName: 'dev',
    repoRoot,
    extensionId: 'persona-chat',
    wikiDistributionArn: ARN,
    synthesizer: new DefaultStackSynthesizer({ qualifier: DEV_QUALIFIER }),
    permissionsBoundary: PermissionsBoundary.fromName(DEV_BOUNDARY_NAME),
  });
  return Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties: any }> };
}

test('only the wiki distribution may read, and only the bundles of this extension', () => {
  const { Resources } = devStack();
  const policies = Object.values(Resources).filter((r) => r.Type === 'AWS::S3::BucketPolicy');
  assert.equal(policies.length, 1);
  const statements = policies[0]!.Properties.PolicyDocument.Statement as any[];
  const reads = statements.filter((s) => s.Effect === 'Allow' && JSON.stringify(s.Action).includes('s3:GetObject'));
  assert.equal(reads.length, 1);
  const [read] = reads;
  assert.deepEqual(read.Principal, { Service: 'cloudfront.amazonaws.com' });
  assert.deepEqual(read.Condition, { StringEquals: { 'AWS:SourceArn': ARN } });
  assert.ok(JSON.stringify(read.Resource).endsWith('"/ext/persona-chat/*"]]}'), JSON.stringify(read.Resource));
  // TLS only; no public access.
  assert.ok(statements.some((s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false'));
  const [bucket] = Object.values(Resources).filter((r) => r.Type === 'AWS::S3::Bucket');
  assert.deepEqual(bucket!.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
});

test('every dev role carries the dev permissions boundary', () => {
  const roles = Object.values(devStack().Resources).filter((r) => r.Type === 'AWS::IAM::Role');
  assert.ok(roles.length > 0);
  for (const r of roles) assert.ok(JSON.stringify(r.Properties.PermissionsBoundary ?? '').includes(DEV_BOUNDARY_NAME), JSON.stringify(r.Properties));
});

test('the built bundle matches its SRI hash and content-hashed file name, and registers with contract 1', () => {
  const meta = JSON.parse(readFileSync(join(repoRoot, 'dist/bundle.json'), 'utf8')) as { id: string; contract: number; script: string; integrity: string };
  assert.equal(meta.id, 'persona-chat');
  assert.equal(meta.contract, 1);
  assert.match(meta.script, /^persona-chat-[0-9a-f]{8}\.js$/);
  const body = readFileSync(join(repoRoot, 'dist/ext/persona-chat', meta.script));
  assert.equal(meta.integrity, `sha384-${createHash('sha384').update(body).digest('base64')}`);
  const text = body.toString('utf8');
  assert.ok(!text.includes('__BUILD__'));
  // Runs inside the wiki's origin: no HTML strings, no storage.
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|eval\(/.test(text));
});
