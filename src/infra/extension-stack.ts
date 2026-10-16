import { join } from 'node:path';
import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_bedrockagentcore as agentcore,
  aws_dynamodb as ddb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { acknowledge } from './nag.js';

export interface WikiLink {
  /** ARN of the MCPWiki CloudFront distribution that serves the bundle (the only reader of the bucket). */
  distributionArn: string;
  /** The wiki's origin (https://host): the only page that may ask for tickets and connect. */
  origin: string;
  /** Cognito issuer of the wiki's tokens (config.json "issuer"). */
  issuer: string;
  /** The wiki's web client id (config.json "webClientId"): tokens of any other client are refused. */
  clientId: string;
}

export interface ExtensionStackProps extends StackProps {
  envName: 'dev' | 'prod';
  repoRoot: string;
  /** Extension id: the bundle lives under ext/<id>/ and is served by the wiki under /ext/<id>/. */
  extensionId: string;
  wiki: WikiLink;
  /** Bedrock model for NPC drafts, as a US cross-region inference profile id (docs/spike.md). */
  draftModel: string;
}

/** Regions a "us." inference profile routes to (docs/spike.md, 2026-10). */
const US_PROFILE_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

/**
 * The persona-chat extension for one environment.
 * - Bundle bucket: MCPWiki's distribution reads ext/<id>/* through OAC (MCPWiki docs/extensions.md).
 * - POST /ticket (HTTP API) trades the user's access token for a single-use connection ticket, after the wiki
 *   confirmed the account (GET /api/me); the WebSocket API's $connect authorizer consumes it (docs/spike.md).
 * No CloudFormation reference links this stack to the wiki's: the wiki's values come in as configuration, the
 * bucket domain and endpoints go out as outputs.
 */
export class ExtensionStack extends Stack {
  constructor(scope: Construct, id: string, props: ExtensionStackProps) {
    super(scope, id, props);
    const { wiki, extensionId } = props;
    const prod = props.envName === 'prod';

    // ---------------------------------------------------------------- bundle bucket
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
        resources: [bundles.arnForObjects(`ext/${extensionId}/*`)],
        conditions: { StringEquals: { 'AWS:SourceArn': wiki.distributionArn } },
      }),
    );

    // ---------------------------------------------------------------- state
    // Tickets (30 s) and live connections (until $disconnect); TTL cleans up whatever is left.
    const table = new ddb.TableV2(this, 'State', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      billing: ddb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY, // short-lived data only
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });

    // Published facilities and NPC snapshots (docs/articles.md). The source of truth stays in the wiki articles, so
    // a lost table only means publishing again; prod keeps it anyway (and its backups).
    const catalog = new ddb.TableV2(this, 'Catalog', {
      partitionKey: { name: 'id', type: ddb.AttributeType.STRING },
      billing: ddb.Billing.onDemand(),
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: prod },
      deletionProtection: prod,
    });

    // What NPCs remember about PCs (docs/spike.md): long-term records per NPC x PC under /npc/<npc>/pc/<pc>/, extracted
    // by AgentCore's built-in semantic strategy (no execution role needed). Raw events expire after 30 days.
    const articleIdRe = '^[a-z0-9][a-z0-9-]{0,62}$';
    const memory = new agentcore.CfnMemory(this, 'Memory', {
      name: `PersonaChat_${props.envName}`, // no dashes allowed; the guard's name backstop expects PersonaChat_prod*
      description: `persona-chat ${props.envName}: what NPCs remember about PCs`,
      eventExpiryDuration: 30,
      namespaceKeys: [
        { key: 'npc', validation: { regexPattern: articleIdRe } },
        { key: 'pc', validation: { regexPattern: articleIdRe } },
      ],
      memoryStrategies: [{ semanticMemoryStrategy: { name: 'facts', namespaceTemplates: ['/npc/{npc}/pc/{pc}/'] } }],
      tags: { Project: 'persona-chat', Environment: props.envName, Component: 'memory' },
    });
    memory.applyRemovalPolicy(prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

    // ---------------------------------------------------------------- functions
    const code = lambda.Code.fromAsset(join(props.repoRoot, 'dist/backend'));
    const environment = { WIKI_ORIGIN: wiki.origin, ISSUER: wiki.issuer, CLIENT_ID: wiki.clientId, TABLE: table.tableName, CATALOG: catalog.tableName, MODEL_ID: props.draftModel, MEMORY_ID: memory.attrMemoryId };
    const fn = (name: string, handler: string, description: string, timeout = Duration.seconds(10)) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
      return new lambda.Function(this, name, {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        handler: `index.${handler}`,
        code,
        memorySize: 256,
        timeout,
        // Caps a flood's share of the account-wide concurrency pool.
        reservedConcurrentExecutions: prod ? 20 : 5,
        logGroup,
        environment,
        description: `persona-chat ${props.envName}: ${description}`,
      });
    };
    // Drafts wait for the model: just under the HTTP API's 30 s integration limit.
    const httpFn = fn('HttpFn', 'http', 'HTTP API (tickets, facilities, drafts)', Duration.seconds(29));
    const authorizerFn = fn('AuthorizerFn', 'authorize', 'WebSocket $connect authorizer');
    const wsFn = fn('WsFn', 'ws', 'WebSocket routes (presence, queueing lines)');
    // The room worker answers lines one room at a time (SQS FIFO, group = facility) and streams the reply.
    const workerFn = fn('WorkerFn', 'worker', 'room worker (NPC replies)', Duration.seconds(60));
    // Least privilege: tickets are written by one function and consumed by another; connections by the routes; only
    // the HTTP function touches the catalog.
    httpFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'], resources: [table.tableArn] })); // tickets, draft budgets
    // Drafts: this one model only, through its US inference profile.
    if (!/^us\.[a-z0-9.:-]+$/.test(props.draftModel)) throw new Error('draftModel must be a "us." inference profile id');
    const foundationModel = props.draftModel.slice('us.'.length);
    const modelArns = [
      `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${props.draftModel}`,
      ...US_PROFILE_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${foundationModel}`),
    ];
    httpFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: modelArns }));
    // Conversations: the same model, streamed (by the room worker).
    workerFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModelWithResponseStream'], resources: modelArns }));
    httpFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan'], resources: [catalog.tableArn] }));
    authorizerFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:DeleteItem'], resources: [table.tableArn] }));
    // Connections, rooms, room histories and chat budgets; published snapshots are read only.
    for (const f of [wsFn, workerFn]) {
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'], resources: [table.tableArn] }));
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [catalog.tableArn] }));
    }
    // Memory: the routes recall (list one NPC x PC namespace) when a PC joins; the worker adds events. No deletion or
    // editing here (that is the DM's, Task 11).
    wsFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:ListMemoryRecords'], resources: [memory.attrMemoryArn] }));
    workerFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:CreateEvent'], resources: [memory.attrMemoryArn] }));
    // Lines of a room, in order: FIFO, one message group per facility. Failed jobs end in the dead-letter queue.
    // Encrypted with SQS-managed keys (lines are player text; no key sharing needed).
    const deadLetters = new sqs.Queue(this, 'RoomJobsDlq', { fifo: true, retentionPeriod: Duration.days(4), enforceSSL: true, encryption: sqs.QueueEncryption.SQS_MANAGED });
    const roomJobs = new sqs.Queue(this, 'RoomJobs', {
      fifo: true,
      visibilityTimeout: Duration.seconds(120), // >= the worker's timeout
      retentionPeriod: Duration.hours(1), // a line nobody answered within an hour is no longer worth answering
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 2 },
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    roomJobs.grantSendMessages(wsFn);
    workerFn.addEventSource(new eventSources.SqsEventSource(roomJobs, { batchSize: 1 }));
    workerFn.addEnvironment('QUEUE_URL', roomJobs.queueUrl);
    wsFn.addEnvironment('QUEUE_URL', roomJobs.queueUrl);

    // ---------------------------------------------------------------- APIs
    const http = new apigw.HttpApi(this, 'TicketApi', {
      apiName: `persona-chat-${props.envName}-ticket`,
      corsPreflight: {
        allowOrigins: [wiki.origin],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });
    const httpIntegration = new integrations.HttpLambdaIntegration('TicketIntegration', httpFn);
    const routes = [
      [apigw.HttpMethod.POST, '/ticket'], [apigw.HttpMethod.POST, '/publish'], [apigw.HttpMethod.POST, '/unpublish'], [apigw.HttpMethod.GET, '/facilities'],
      [apigw.HttpMethod.POST, '/draft'], [apigw.HttpMethod.POST, '/adopt'],
    ] as const;
    for (const [method, path] of routes) {
      http.addRoutes({ path, methods: [method], integration: httpIntegration });
    }
    const httpStage = http.defaultStage!.node.defaultChild as apigw.CfnStage;
    httpStage.defaultRouteSettings = { throttlingRateLimit: 5, throttlingBurstLimit: 10 };
    const httpLogs = new logs.LogGroup(this, 'TicketApiAccessLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    httpStage.accessLogSettings = {
      destinationArn: httpLogs.logGroupArn,
      // No headers, no query strings: never the token.
      format: JSON.stringify({ requestId: '$context.requestId', ip: '$context.identity.sourceIp', path: '$context.path', status: '$context.status', latency: '$context.responseLatency', time: '$context.requestTime' }),
    };

    const ws = new apigw.WebSocketApi(this, 'Socket', {
      apiName: `persona-chat-${props.envName}-socket`,
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ConnectIntegration', wsFn),
        authorizer: new authorizers.WebSocketLambdaAuthorizer('TicketAuthorizer', authorizerFn, { identitySource: ['route.request.querystring.ticket'] }),
      },
      disconnectRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('DisconnectIntegration', wsFn) },
      defaultRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('DefaultIntegration', wsFn) },
    });
    const wsStage = new apigw.WebSocketStage(this, 'SocketStage', {
      webSocketApi: ws,
      stageName: props.envName,
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
    });
    wsStage.grantManagementApiAccess(wsFn);
    wsStage.grantManagementApiAccess(workerFn);
    // Built from the API id, not the stage: the stage depends on the routes, which depend on the functions.
    const socketEndpoint = `https://${ws.apiId}.execute-api.${this.region}.amazonaws.com/${props.envName}`;
    for (const f of [wsFn, workerFn]) f.addEnvironment('SOCKET_ENDPOINT', socketEndpoint);

    // ---------------------------------------------------------------- bundle + its runtime configuration
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
    // Endpoints are only known after deployment, so the bundle reads them from here (same origin). Even a
    // tampered file could only point at hosts the wiki's CSP connect-src already allows.
    new s3deploy.BucketDeployment(this, 'DeployConfig', {
      sources: [s3deploy.Source.jsonData('config.json', { apiUrl: http.apiEndpoint, ticketUrl: `${http.apiEndpoint}/ticket`, socketUrl: wsStage.url })],
      destinationBucket: bundles,
      destinationKeyPrefix: `ext/${extensionId}/`,
      cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
      prune: false,
      memoryLimit: 256,
    });

    // ---------------------------------------------------------------- cdk-nag
    acknowledge(bundles, [
      { id: 'AwsSolutions-S1', reason: 'Bundles are public code, read only through the wiki CloudFront distribution, whose access logs cover every read.' },
    ]);
    acknowledge(table, [{ id: 'AwsSolutions-DDB3', reason: 'Tickets live 30 seconds and connections until disconnect: nothing to recover.' }]);
    if (!prod) acknowledge(catalog, [{ id: 'AwsSolutions-DDB3', reason: 'dev: publications are rebuilt from the wiki articles by publishing again.' }]);
    for (const f of [httpFn, authorizerFn, wsFn, workerFn]) {
      acknowledge(f, [
        { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: 'Writes its own logs only.' },
      ]);
    }
    for (const f of [wsFn, workerFn]) acknowledge(f, [
      {
        id: `AwsSolutions-IAM5[Resource::arn:aws:execute-api:${this.region}:${this.account}:<${this.getLogicalId(ws.node.defaultChild as apigw.CfnApi)}>/${props.envName}/*/@connections/*]`,
        reason: 'Posts to / closes any connection of its own WebSocket stage.',
      },
    ]);
    acknowledge(deadLetters, [{ id: 'AwsSolutions-SQS3', reason: 'This is the dead-letter queue.' }]);
    acknowledge(ws, [
      { id: 'AwsSolutions-APIG4', reason: '$connect has the ticket authorizer; $default and $disconnect only run on an authorized connection.' },
      { id: 'AwsSolutions-APIG1', reason: 'WebSocket access logging needs the account-wide API Gateway CloudWatch role, which this stack does not own; the route function logs connect, disconnect and refusals.' },
    ]);
    acknowledge(wsStage, [{ id: 'AwsSolutions-APIG1', reason: 'See the WebSocket API: the route function logs instead.' }]);
    acknowledge(http, [
      { id: 'AwsSolutions-APIG4', reason: 'Every route verifies the Cognito access token itself and asks the wiki (GET /api/me) about the account.' },
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

    // Not exports (see the class comment): copied into the wiki's MCPWIKI_EXTENSIONS by hand.
    new CfnOutput(this, 'BundleBucketDomain', { value: bundles.bucketRegionalDomainName, description: 'bucketRegionalDomainName for the wiki configuration' });
    new CfnOutput(this, 'ConnectSrc', {
      value: `https://${http.apiId}.execute-api.${this.region}.amazonaws.com wss://${ws.apiId}.execute-api.${this.region}.amazonaws.com`,
      description: 'connectSrc for the wiki configuration',
    });
  }
}
