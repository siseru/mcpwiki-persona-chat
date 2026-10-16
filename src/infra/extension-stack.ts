import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, aws_iam as iam, aws_s3 as s3, aws_s3_deployment as s3deploy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { acknowledge } from './nag.js';

export interface ExtensionStackProps extends StackProps {
  envName: 'dev' | 'prod';
  repoRoot: string;
  /** Extension id: the bundle lives under ext/<id>/ and is served by the wiki under /ext/<id>/. */
  extensionId: string;
  /** ARN of the MCPWiki CloudFront distribution that serves the bundle (the only reader of the bucket). */
  wikiDistributionArn: string;
}

/**
 * The persona-chat extension for one environment. For now only the bundle bucket: MCPWiki's distribution reads
 * ext/<id>/* through OAC (MCPWiki docs/extensions.md). No CloudFormation reference links this stack to the wiki's:
 * the distribution ARN comes in as configuration, the bucket domain goes out as an output.
 */
export class ExtensionStack extends Stack {
  constructor(scope: Construct, id: string, props: ExtensionStackProps) {
    super(scope, id, props);
    // Bundles are rebuilt from the repository: nothing in the bucket needs to survive the stack.
    const bundles = new s3.Bucket(this, 'Bundles', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // OAC reads SSE-S3 objects without a key policy
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });
    bundles.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'WikiDistributionReadsBundles',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [bundles.arnForObjects(`ext/${props.extensionId}/*`)],
        conditions: { StringEquals: { 'AWS:SourceArn': props.wikiDistributionArn } },
      }),
    );
    // Old bundles stay (prune: false): the wiki keeps serving the version its configuration pins until it is
    // redeployed with the new hash.
    new s3deploy.BucketDeployment(this, 'DeployBundle', {
      sources: [s3deploy.Source.asset(join(props.repoRoot, 'dist/ext'))],
      destinationBucket: bundles,
      destinationKeyPrefix: 'ext/',
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
      contentType: 'text/javascript; charset=utf-8',
      prune: false,
      memoryLimit: 256,
    });

    acknowledge(bundles, [
      { id: 'AwsSolutions-S1', reason: 'Bundles are public code, read only through the wiki CloudFront distribution, whose access logs cover every read.' },
    ]);
    // CDK-managed BucketDeployment / autoDeleteObjects custom resources.
    for (const child of this.node.children) {
      if (!child.node.id.startsWith('Custom::')) continue;
      acknowledge(child, [
        ...['s3:List*', 's3:GetObject*', 's3:GetBucket*', 's3:DeleteObject*', 's3:Abort*'].map((a) => ({
          id: `AwsSolutions-IAM5[Action::${a}]`,
          reason: 'CDK-managed BucketDeployment copies the bundle into the bundle bucket (scoped to the asset and bundle buckets).',
        })),
        ...['hnb659fds', 'pcdev'].map((q) => ({ id: `AwsSolutions-IAM5[Resource::arn:aws:s3:::cdk-${q}-assets-${this.account}-${this.region}/*]`, reason: 'CDK asset bucket.' })),
        { id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(bundles.node.defaultChild as s3.CfnBucket)}.Arn>/*]`, reason: 'Deploys the bundle into the bundle bucket.' },
        { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: 'CDK-managed custom resource (writes its own logs).' },
        { id: 'AwsSolutions-L1', reason: 'CDK-managed custom resource runtime.' },
      ]);
    }
    // Not an export (see the class comment): copied into the wiki's MCPWIKI_EXTENSIONS by hand.
    new CfnOutput(this, 'BundleBucketDomain', { value: bundles.bucketRegionalDomainName, description: 'bucketRegionalDomainName for the wiki configuration' });
  }
}
