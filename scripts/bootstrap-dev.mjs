// Bootstraps the dev-only CDK environment (qualifier "pcdev") with every bootstrap role bound by the
// PersonaChatDevBoundary permissions boundary (deploy the PersonaChat-guard stack first, as an administrator).
//
// The stock bootstrap template only applies a boundary to the CloudFormation execution role; the deploy
// role has cloudformation:* on all stacks and could otherwise update prod (or MCPWiki) stacks with their stored
// (administrator) execution role. Usage (administrator credentials):
//   node scripts/bootstrap-dev.mjs            # prints the command it runs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const QUALIFIER = 'pcdev';
const BOUNDARY = 'PersonaChatDevBoundary';
const TOOLKIT_STACK = 'CDKToolkit-persona-chat-dev';
const ROLES = ['FilePublishingRole', 'ImagePublishingRole', 'LookupRole', 'DeploymentActionRole'];

const npx = (args, opts = {}) => execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
let template = npx(['cdk', 'bootstrap', '--show-template']);
for (const role of ROLES) {
  const header = `\n  ${role}:\n    Type: AWS::IAM::Role\n    Properties:\n`;
  if (!template.includes(header)) throw new Error(`bootstrap template changed: ${role} not found; review this script`);
  template = template.replace(
    header,
    header +
      '      PermissionsBoundary:\n' +
      '        Fn::If:\n' +
      '          - PermissionsBoundarySet\n' +
      "          - Fn::Sub: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/${InputPermissionsBoundary}'\n" +
      '          - Ref: AWS::NoValue\n',
  );
}
const count = (template.match(/policy\/\$\{InputPermissionsBoundary\}/g) ?? []).length;
if (count < ROLES.length + 1) throw new Error(`expected ${ROLES.length + 1} boundary references, found ${count}`);
mkdirSync('cdk.out', { recursive: true });
const file = 'cdk.out/bootstrap-dev.yaml';
writeFileSync(file, template);

const account = execFileSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { encoding: 'utf8' }).trim();
// Same region resolution as the CDK app (cdk.json context.region). No us-east-1: this project has no
// CloudFront distribution or certificate of its own (it is served through MCPWiki's).
const region = JSON.parse(readFileSync('cdk.json', 'utf8')).context?.region ?? 'us-west-2';
const args = [
  'cdk', 'bootstrap', `aws://${account}/${region}`,
  '--qualifier', QUALIFIER,
  '--toolkit-stack-name', TOOLKIT_STACK,
  '--template', file,
  '--custom-permissions-boundary', BOUNDARY,
  '--cloudformation-execution-policies', 'arn:aws:iam::aws:policy/AdministratorAccess', // bounded by the boundary
  '--termination-protection',
];
console.log(`$ npx ${args.join(' ')}`);
execFileSync('npx', args, { stdio: 'inherit' });
