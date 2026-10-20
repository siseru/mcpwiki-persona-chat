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
    draftModel: 'us.anthropic.claude-haiku-5-5',
    wiki: { distributionArn: ARN, origin: 'https://wiki-dev.example.com', issuer: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_EXAMPLE12', clientId: 'exampleclientid0123456789ab' },
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

test('the ticket API answers the wiki page only, the socket needs a ticket, and functions get least privilege', () => {
  const { Resources } = devStack();
  const of = (type: string) => Object.entries(Resources).filter(([, r]) => r.Type === type);
  const [[, httpApi]] = of('AWS::ApiGatewayV2::Api').filter(([, r]) => r.Properties.ProtocolType === 'HTTP') as [string, any][];
  assert.deepEqual(httpApi.Properties.CorsConfiguration.AllowOrigins, ['https://wiki-dev.example.com']);
  const [[, auth]] = of('AWS::ApiGatewayV2::Authorizer') as [string, any][];
  assert.deepEqual(auth.Properties.IdentitySource, ['route.request.querystring.ticket']);
  const connect = of('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties).find((p) => p.RouteKey === '$connect')!;
  assert.equal(connect.AuthorizationType, 'CUSTOM');
  // Access logs never include headers or query strings (the token / ticket).
  for (const [, st] of of('AWS::ApiGatewayV2::Stage')) {
    const fmt = st.Properties.AccessLogSettings?.Format as string | undefined;
    if (fmt) assert.ok(!/header|querystring|authorizer/i.test(fmt), fmt);
  }
  // DynamoDB actions per function: tickets are written by one function and consumed by another.
  const statements = of('AWS::IAM::Policy').flatMap(([, p]) => p.Properties.PolicyDocument.Statement as any[]);
  const actions = of('AWS::IAM::Policy')
    .map(([, p]) => (p.Properties.PolicyDocument.Statement as any[]).flatMap((s) => [s.Action].flat()).filter((a: string) => a.startsWith('dynamodb:')).sort())
    .filter((a) => a.length)
    .map((a) => a.join(','))
    .sort();
  assert.deepEqual(actions, [
    'dynamodb:DeleteItem', // authorizer: consumes tickets
    'dynamodb:DeleteItem,dynamodb:GetItem,dynamodb:GetItem,dynamodb:PutItem,dynamodb:UpdateItem', // routes: connections, rooms, budgets; reads snapshots
    'dynamodb:DeleteItem,dynamodb:GetItem,dynamodb:GetItem,dynamodb:PutItem,dynamodb:UpdateItem', // room worker: rooms, histories; reads snapshots
    'dynamodb:DeleteItem,dynamodb:GetItem,dynamodb:PutItem,dynamodb:PutItem,dynamodb:Scan,dynamodb:UpdateItem', // HTTP: tickets, budgets, catalog
  ]);
  // Bedrock: one model, through its US inference profile; nothing else can invoke models.
  const invoke = statements.filter((s) => JSON.stringify(s.Action).includes('bedrock:'));
  assert.deepEqual(invoke.map((s) => s.Action).sort(), ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
  // Memory: the route function adds events and lists records of this one memory; nothing deletes or edits them.
  const mem = statements.filter((s) => JSON.stringify(s.Action).includes('bedrock-agentcore:'));
  assert.deepEqual(mem.map((s) => [s.Action].flat().sort()).sort(), [['bedrock-agentcore:CreateEvent'], ['bedrock-agentcore:ListMemoryRecords']]);
  // Room jobs carry player text: both queues encrypted, TLS only.
  for (const [, q] of of('AWS::SQS::Queue')) assert.equal(q.Properties.SqsManagedSseEnabled, true);
  const [[, memRes]] = of('AWS::BedrockAgentCore::Memory') as [string, any][];
  assert.equal(memRes.Properties.Name, 'PersonaChat_dev');
  assert.deepEqual(memRes.Properties.MemoryStrategies[0].SemanticMemoryStrategy.NamespaceTemplates, ['/npc/{npc}/pc/{pc}/']);
  assert.deepEqual(memRes.Properties.NamespaceKeys.map((k: any) => k.Key), ['npc', 'pc']);
  for (const s of invoke) assert.ok(s.Resource.every((r: string) => r.endsWith('/us.anthropic.claude-haiku-5-5') || r.endsWith('foundation-model/anthropic.claude-haiku-5-5')), JSON.stringify(s.Resource));
  // The catalog is touched by the HTTP function only, and nothing may scan the ticket / connection table.
  const catalogLogical = of('AWS::DynamoDB::GlobalTable').find(([k]) => k.startsWith('Catalog'))![0];
  for (const st of statements.filter((s) => [s.Action].flat().includes('dynamodb:Scan'))) assert.ok(JSON.stringify(st.Resource).includes(catalogLogical), JSON.stringify(st.Resource));
});
