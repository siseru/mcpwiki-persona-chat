// CDK app. Stacks:
//   PersonaChat-guard               shared-account guard rails (an administrator deploys it; docs/deploy.md)
//   PersonaChat-dev / -prod         the extension per environment (only when that environment's wiki is configured)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, DefaultStackSynthesizer, PermissionsBoundary, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import { ExtensionStack, type WikiLink } from './extension-stack.js';
import { DEV_BOUNDARY_NAME, DEV_QUALIFIER, GuardStack } from './guard-stack.js';

// build/src/infra/app.js -> repository root
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = (app.node.tryGetContext('region') as string | undefined) ?? process.env.CDK_DEFAULT_REGION ?? 'us-west-2';

// cdk.json context, or -c devBedrockModels='["anthropic.claude-haiku-5-5"]'.
const modelsCtx = app.node.tryGetContext('devBedrockModels') as string[] | string | undefined;
const devBedrockModels: string[] = typeof modelsCtx === 'string' ? JSON.parse(modelsCtx) : (modelsCtx ?? []);

/**
 * The MCPWiki deployment each environment plugs into (config/wiki.example.json):
 * { "dev": { "distributionArn", "origin", "issuer", "clientId" }, "prod": {...} }.
 * Kept out of git: -c wiki='<json>', the secret PERSONACHAT_WIKI, or config/wiki.local.json.
 */
type WikiConfig = Partial<Record<'dev' | 'prod', WikiLink>>;
function loadWiki(): WikiConfig {
  const ctx = app.node.tryGetContext('wiki') as WikiConfig | string | undefined;
  if (ctx) return typeof ctx === 'string' ? (JSON.parse(ctx) as WikiConfig) : ctx;
  if (process.env.PERSONACHAT_WIKI) return JSON.parse(process.env.PERSONACHAT_WIKI) as WikiConfig;
  const file = `${repoRoot}config/wiki.local.json`;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as WikiConfig) : {};
}
const wiki = loadWiki();

// Cost allocation tags: same keys as MCPWiki, so one Cost Explorer view covers both.
const costTags = (scope: IConstruct, environment: string, component: string) => {
  for (const [k, v] of Object.entries({ Project: 'persona-chat', Environment: environment, Component: component, ManagedBy: 'cdk' })) Tags.of(scope).add(k, v);
};

const guard = new GuardStack(app, 'PersonaChat-guard', { env: { account, region }, devBedrockModels });
costTags(guard, 'shared', 'guard');

for (const envName of ['dev', 'prod'] as const) {
  const link = wiki[envName];
  if (!link) continue;
  // Interpolated into the bucket policy, CORS and the functions' configuration: validated strictly.
  const bad = (k: string) => new Error(`wiki.${envName}.${k} is invalid`);
  if (!/^arn:aws:cloudfront::\d{12}:distribution\/E[A-Z0-9]{8,20}$/.test(link.distributionArn ?? '')) throw bad('distributionArn');
  if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(link.origin ?? '')) throw bad('origin');
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(link.issuer ?? '')) throw bad('issuer');
  if (!/^[a-z0-9]{20,40}$/.test(link.clientId ?? '')) throw bad('clientId');
  const stack = new ExtensionStack(app, `PersonaChat-${envName}`, {
    env: { account, region },
    envName,
    repoRoot,
    extensionId: 'persona-chat',
    wiki: link,
    draftModel: (app.node.tryGetContext('draftModel') as string | undefined) ?? 'us.anthropic.claude-haiku-5-5',
    // dev uses its own CDK bootstrap (qualifier pcdev) whose roles carry the dev permissions boundary.
    ...(envName === 'dev'
      ? { synthesizer: new DefaultStackSynthesizer({ qualifier: DEV_QUALIFIER }), permissionsBoundary: PermissionsBoundary.fromName(DEV_BOUNDARY_NAME) }
      : { terminationProtection: true }),
  });
  Tags.of(stack).add('personachat:env', envName);
  costTags(stack, envName, 'app');
}

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

// CDK-internal providers created during the final synthesis phase are not always reached by PermissionsBoundary.
// Patch the synthesized dev template deterministically; the dev boundary denies creating roles without it, so a
// miss fails closed (same approach as MCPWiki).
const assembly = app.synth();
for (const st of assembly.stacks) {
  if (st.stackName !== 'PersonaChat-dev') continue;
  const file = join(assembly.directory, st.templateFile);
  const template = JSON.parse(readFileSync(file, 'utf8')) as { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
  let patched = 0;
  for (const r of Object.values(template.Resources ?? {})) {
    if (r.Type !== 'AWS::IAM::Role' || r.Properties?.PermissionsBoundary) continue;
    r.Properties = { ...r.Properties, PermissionsBoundary: { 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${DEV_BOUNDARY_NAME}` } };
    patched++;
  }
  if (patched) writeFileSync(file, JSON.stringify(template, null, 1));
}
