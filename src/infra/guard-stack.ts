import { Stack, type StackProps, aws_iam as iam } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { acknowledge } from './nag.js';

export const DEV_BOUNDARY_NAME = 'PersonaChatDevBoundary';
export const DEV_QUALIFIER = 'pcdev';
export const DEV_TOOLKIT_STACK = 'CDKToolkit-persona-chat-dev';

/**
 * Services the dev environment legitimately uses (anything else is denied by the boundary).
 * Provisional until the Task 2 spike (docs/plan.md): the AgentCore actions and the Bedrock inference
 * profiles actually needed are fixed there.
 */
export const DEV_SERVICES = [
  'apigateway', 'bedrock', 'bedrock-agentcore', 'cloudformation', 'cloudwatch', 'dynamodb', 'execute-api', 'iam', 'kms',
  'lambda', 'logs', 's3', 'sqs', 'ssm', 'sts', 'tag', 'xray',
];

/** Bedrock actions that run a model (Converse / ConverseStream are authorized as InvokeModel*). */
const INVOKE_ACTIONS = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];

export interface GuardStackProps extends StackProps {
  /**
   * Bedrock model ids dev may invoke (wildcards allowed, e.g. "anthropic.claude-haiku-*"). Matched as foundation
   * models in any region and as cross-region inference profiles ("us.<id>"). Empty = dev cannot invoke any model.
   */
  devBedrockModels: string[];
}

/**
 * Account-level guard rails for persona-chat dev, which shares one AWS account with persona-chat prod and with
 * MCPWiki (deployed by an administrator, never by CI). Everything acting for dev — the dev CDK bootstrap roles
 * (qualifier "pcdev"), the CloudFormation execution role and every role created by dev stacks — carries this
 * permissions boundary, so a compromised dev pipeline cannot reach prod, MCPWiki, other stacks in the account,
 * escalate via IAM/STS, or run up Bedrock costs outside the allowed models.
 */
export class GuardStack extends Stack {
  constructor(scope: Construct, id: string, props: GuardStackProps) {
    super(scope, id, props);
    const a = this.account;
    for (const m of props.devBedrockModels) {
      // Interpolated into ARNs: model ids are lowercase names with dots, dashes, colons and version suffixes.
      if (!/^[a-z0-9][a-z0-9.:*-]{2,100}$/.test(m)) throw new Error(`invalid Bedrock model id pattern: ${m}`);
    }
    const devRoles = [`arn:aws:iam::${a}:role/PersonaChat-dev*`];
    const statements: iam.PolicyStatement[] = [
      new iam.PolicyStatement({ sid: 'AllowDevServices', actions: DEV_SERVICES.map((s) => `${s}:*`), resources: ['*'] }),
      // IAM: only dev roles may be created/changed/passed, and only with this boundary attached.
      new iam.PolicyStatement({
        sid: 'DenyIamOutsideDev',
        effect: iam.Effect.DENY,
        actions: [
          'iam:Create*', 'iam:Delete*', 'iam:Put*', 'iam:Attach*', 'iam:Detach*', 'iam:Update*', 'iam:Add*', 'iam:Remove*',
          'iam:Set*', 'iam:Tag*', 'iam:Untag*', 'iam:Upload*', 'iam:Change*', 'iam:Enable*', 'iam:Deactivate*', 'iam:Reset*',
          'iam:Resync*',
        ],
        notResources: [...devRoles, `arn:aws:iam::${a}:role/aws-service-role/*`],
      }),
      // The dev deploy role hands the (boundary-limited) dev execution role to CloudFormation.
      new iam.PolicyStatement({
        sid: 'DenyPassRoleOutsideDev',
        effect: iam.Effect.DENY,
        actions: ['iam:PassRole'],
        notResources: [...devRoles, `arn:aws:iam::${a}:role/cdk-${DEV_QUALIFIER}-cfn-exec-role-*`],
      }),
      new iam.PolicyStatement({
        sid: 'RequireBoundaryOnDevRoles',
        effect: iam.Effect.DENY,
        actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        resources: ['*'],
        conditions: { StringNotEquals: { 'iam:PermissionsBoundary': `arn:aws:iam::${a}:policy/${DEV_BOUNDARY_NAME}` } },
      }),
      new iam.PolicyStatement({ sid: 'DenyBoundaryRemoval', effect: iam.Effect.DENY, actions: ['iam:DeleteRolePermissionsBoundary'], resources: ['*'] }),
      // STS: the default CDK bootstrap roles trust the account root; never let dev assume them (or anything else).
      new iam.PolicyStatement({
        sid: 'DenyAssumeOutsideDev',
        effect: iam.Effect.DENY,
        actions: ['sts:AssumeRole', 'sts:AssumeRoleWithWebIdentity', 'sts:AssumeRoleWithSAML'],
        notResources: [...devRoles, `arn:aws:iam::${a}:role/cdk-${DEV_QUALIFIER}-*`],
      }),
      // Anything created by another CloudFormation stack (prod, CI, guard, default bootstrap, MCPWiki, other projects).
      new iam.PolicyStatement({
        sid: 'DenyOtherStacksResources',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: {
          Null: { 'aws:ResourceTag/aws:cloudformation:stack-name': 'false' },
          StringNotLike: { 'aws:ResourceTag/aws:cloudformation:stack-name': ['PersonaChat-dev*', DEV_TOOLKIT_STACK] },
        },
      }),
      new iam.PolicyStatement({
        sid: 'DenyProdTagged',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:ResourceTag/personachat:env': 'prod' } },
      }),
      new iam.PolicyStatement({
        sid: 'DenyCreatingProdTagged',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestTag/personachat:env': 'prod' } },
      }),
      // MCPWiki (dev and prod) is another project: dev of this extension talks to it over HTTPS only.
      new iam.PolicyStatement({
        sid: 'DenyMcpwikiTagged',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: { Null: { 'aws:ResourceTag/mcpwiki:env': 'false' } },
      }),
      new iam.PolicyStatement({
        sid: 'DenyOtherStacks',
        effect: iam.Effect.DENY,
        actions: [
          'cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'cloudformation:CreateChangeSet',
          'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet', 'cloudformation:UpdateTerminationProtection',
          'cloudformation:SetStackPolicy', 'cloudformation:ContinueUpdateRollback', 'cloudformation:RollbackStack',
          'cloudformation:CancelUpdateStack', 'cloudformation:SignalResource', 'cloudformation:TagResource', 'cloudformation:UntagResource',
          'cloudformation:CreateStackRefactor', 'cloudformation:ExecuteStackRefactor', 'cloudformation:*StackSet*',
          'cloudformation:*StackInstances', 'cloudformation:RegisterType', 'cloudformation:ActivateType', 'cloudformation:SetTypeConfiguration',
        ],
        notResources: [`arn:aws:cloudformation:*:${a}:stack/PersonaChat-dev*/*`],
      }),
      // Name-based backstops for services/actions without resource-tag support (e.g. S3 objects).
      new iam.PolicyStatement({
        sid: 'DenyOtherData',
        effect: iam.Effect.DENY,
        actions: ['s3:*', 'dynamodb:*', 'lambda:*', 'sqs:*', 'ssm:*', 'logs:*', 'bedrock-agentcore:*'],
        resources: [
          'arn:aws:s3:::personachat-prod-*', 'arn:aws:s3:::personachat-prod-*/*',
          `arn:aws:dynamodb:*:${a}:table/PersonaChat-prod-*`, `arn:aws:dynamodb:*:${a}:table/PersonaChat-prod-*/*`,
          `arn:aws:lambda:*:${a}:function:PersonaChat-prod-*`,
          `arn:aws:sqs:*:${a}:PersonaChat-prod-*`,
          `arn:aws:ssm:*:${a}:parameter/personachat/prod/*`,
          `arn:aws:logs:*:${a}:log-group:/aws/lambda/PersonaChat-prod-*`,
          // AgentCore memory names allow no dashes.
          `arn:aws:bedrock-agentcore:*:${a}:memory/PersonaChat_prod*`,
          // Other CDK bootstraps' asset buckets (deploy poisoning): default / prod, and MCPWiki dev.
          'arn:aws:s3:::cdk-hnb659fds-*', 'arn:aws:s3:::cdk-hnb659fds-*/*', 'arn:aws:s3:::cdk-mwdev-*', 'arn:aws:s3:::cdk-mwdev-*/*',
          // MCPWiki.
          'arn:aws:s3:::mcpwiki-*', 'arn:aws:s3:::mcpwiki-*/*',
          `arn:aws:dynamodb:*:${a}:table/MCPWiki-*`, `arn:aws:dynamodb:*:${a}:table/MCPWiki-*/*`,
          `arn:aws:lambda:*:${a}:function:MCPWiki-*`,
          `arn:aws:ssm:*:${a}:parameter/mcpwiki/*`,
          `arn:aws:logs:*:${a}:log-group:/aws/lambda/MCPWiki-*`,
        ],
      }),
      // Other bootstrap version parameters may be read (CloudFormation re-resolves previous parameter values
      // during updates) but never changed.
      new iam.PolicyStatement({
        sid: 'DenyOtherBootstrapParamWrites',
        effect: iam.Effect.DENY,
        actions: ['ssm:Put*', 'ssm:Delete*', 'ssm:Label*', 'ssm:AddTags*', 'ssm:RemoveTags*', 'ssm:Unlabel*'],
        notResources: [`arn:aws:ssm:*:${a}:parameter/cdk-bootstrap/${DEV_QUALIFIER}/*`, `arn:aws:ssm:*:${a}:parameter/personachat/dev/*`],
      }),
      // Bedrock: only the listed models, and nothing account-wide or long-running that costs money or copies
      // prompts elsewhere (invocation logging), or accepts model terms for the account.
      props.devBedrockModels.length
        ? new iam.PolicyStatement({
            sid: 'DenyOtherModels',
            effect: iam.Effect.DENY,
            actions: INVOKE_ACTIONS,
            notResources: props.devBedrockModels.flatMap((m) => [
              `arn:aws:bedrock:*::foundation-model/${m}`,
              `arn:aws:bedrock:*:${a}:inference-profile/us.${m}`,
            ]),
          })
        : new iam.PolicyStatement({ sid: 'DenyAllModels', effect: iam.Effect.DENY, actions: INVOKE_ACTIONS, resources: ['*'] }),
      new iam.PolicyStatement({
        sid: 'DenyBedrockAccountLevel',
        effect: iam.Effect.DENY,
        actions: [
          'bedrock:*ProvisionedModelThroughput', 'bedrock:CreateModelCustomizationJob', 'bedrock:CreateModelInvocationJob',
          'bedrock:*ModelInvocationLoggingConfiguration', 'bedrock:PutUseCaseForModelAccess', 'bedrock:*FoundationModelAgreement',
          'bedrock:CreateMarketplaceModelEndpoint', 'bedrock:CreateCustomModelDeployment',
        ],
        resources: ['*'],
      }),
    ];
    const boundary = new iam.ManagedPolicy(this, 'DevBoundary', {
      managedPolicyName: DEV_BOUNDARY_NAME,
      description: 'Permissions boundary for everything acting on behalf of persona-chat dev (account shared with prod and MCPWiki).',
      statements,
    });
    acknowledge(boundary, [
      ...DEV_SERVICES.map((s) => ({ id: `AwsSolutions-IAM5[Action::${s}:*]`, reason: 'Permissions boundary: the allow set is the service allowlist; denies carve out prod/MCPWiki/IAM/STS.' })),
      { id: 'AwsSolutions-IAM5[Resource::*]', reason: 'Permissions boundary (upper bound), not a grant.' },
    ]);
  }
}
