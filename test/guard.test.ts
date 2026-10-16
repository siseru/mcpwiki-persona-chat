import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DEV_BOUNDARY_NAME, DEV_QUALIFIER, DEV_SERVICES, GuardStack } from '../src/infra/guard-stack.js';

interface Statement {
  Sid: string;
  Effect: 'Allow' | 'Deny';
  Action: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

function boundary(devBedrockModels: string[] = []) {
  const app = new App();
  const stack = new GuardStack(app, 'PersonaChat-guard', { env: { account: '123456789012', region: 'us-west-2' }, devBedrockModels });
  const policies = Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy');
  const [policy] = Object.values(policies) as { Properties: { ManagedPolicyName: string; PolicyDocument: { Statement: Statement[] } } }[];
  assert.ok(policy);
  assert.equal(policy.Properties.ManagedPolicyName, DEV_BOUNDARY_NAME);
  const statements = policy.Properties.PolicyDocument.Statement;
  return { statements, sid: (s: string) => statements.find((x) => x.Sid === s) };
}
const list = (v: unknown) => (Array.isArray(v) ? v : [v]).map((x) => JSON.stringify(x));

test('the allow set is exactly the service allowlist', () => {
  const { statements } = boundary();
  const allows = statements.filter((s) => s.Effect === 'Allow');
  assert.equal(allows.length, 1);
  assert.deepEqual([...list(allows[0]!.Action)].sort(), DEV_SERVICES.map((s) => JSON.stringify(`${s}:*`)).sort());
  // Never needed by this project; a later change must be deliberate.
  for (const s of ['route53', 'cognito-idp', 'cloudfront', 'organizations', 'secretsmanager']) assert.ok(!DEV_SERVICES.includes(s), s);
});

test('the deny statements carried over from MCPWiki are all present', () => {
  const { sid } = boundary();
  for (const s of [
    'DenyIamOutsideDev', 'DenyPassRoleOutsideDev', 'RequireBoundaryOnDevRoles', 'DenyBoundaryRemoval', 'DenyAssumeOutsideDev',
    'DenyOtherStacksResources', 'DenyProdTagged', 'DenyCreatingProdTagged', 'DenyOtherStacks', 'DenyOtherData',
    'DenyOtherBootstrapParamWrites', 'DenyMcpwikiTagged', 'DenyBedrockAccountLevel',
  ]) {
    assert.equal(sid(s)?.Effect, 'Deny', s);
  }
  assert.ok(list(sid('DenyOtherStacks')!.NotResource).some((r) => r.includes('stack/PersonaChat-dev*')));
  assert.ok(list(sid('DenyAssumeOutsideDev')!.NotResource).some((r) => r.includes(`role/cdk-${DEV_QUALIFIER}-*`)));
  assert.deepEqual(sid('DenyMcpwikiTagged')!.Condition, { Null: { 'aws:ResourceTag/mcpwiki:env': 'false' } });
  const data = list(sid('DenyOtherData')!.Resource).join(' ');
  for (const r of ['personachat-prod-*', 'table/PersonaChat-prod-*', 'memory/PersonaChat_prod*', 'cdk-hnb659fds-*', 'cdk-mwdev-*', 'mcpwiki-*', 'table/MCPWiki-*']) {
    assert.ok(data.includes(r), r);
  }
});

test('without an allowed model list, dev cannot invoke any Bedrock model', () => {
  const { sid } = boundary();
  const deny = sid('DenyAllModels');
  assert.equal(deny?.Effect, 'Deny');
  assert.deepEqual(deny.Resource, '*');
  assert.equal(sid('DenyOtherModels'), undefined);
});

test('an allowed model list permits only those models (foundation model and US inference profile)', () => {
  const { sid } = boundary(['anthropic.claude-haiku-*']);
  assert.equal(sid('DenyAllModels'), undefined);
  const deny = sid('DenyOtherModels')!;
  assert.deepEqual([...list(deny.Action)].sort(), ['"bedrock:InvokeModel"', '"bedrock:InvokeModelWithResponseStream"']);
  const allowed = list(deny.NotResource).join(' ');
  assert.ok(allowed.includes('foundation-model/anthropic.claude-haiku-*'));
  assert.ok(allowed.includes('inference-profile/us.anthropic.claude-haiku-*'));
});

test('model id patterns are validated before they reach an ARN', () => {
  for (const bad of ['*', 'a', 'Anthropic.Claude', 'x/../y', 'a"b', 'anthropic.claude haiku']) {
    assert.throws(() => boundary([bad]), /invalid Bedrock model id/, bad);
  }
});
