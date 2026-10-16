// CDK app. For now only the shared-account guard rails (deploy manually as an administrator; see docs/deploy.md):
//   cdk deploy PersonaChat-guard
// The extension stacks (PersonaChat-dev, PersonaChat-prod) follow in later tasks (docs/plan.md).
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GuardStack } from './guard-stack.js';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = (app.node.tryGetContext('region') as string | undefined) ?? process.env.CDK_DEFAULT_REGION ?? 'us-west-2';

// cdk.json context, or -c devBedrockModels='["anthropic.claude-haiku-5-5"]'.
const modelsCtx = app.node.tryGetContext('devBedrockModels') as string[] | string | undefined;
const devBedrockModels: string[] = typeof modelsCtx === 'string' ? JSON.parse(modelsCtx) : (modelsCtx ?? []);

const guard = new GuardStack(app, 'PersonaChat-guard', { env: { account, region }, devBedrockModels });

// Cost allocation tags (same keys as MCPWiki, so one Cost Explorer view covers both).
for (const [k, v] of Object.entries({ Project: 'persona-chat', Environment: 'shared', Component: 'guard', ManagedBy: 'cdk' })) {
  Tags.of(guard).add(k, v);
}
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
app.synth();
