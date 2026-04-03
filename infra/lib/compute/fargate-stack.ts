import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { Construct } from 'constructs';
import { applyTags } from '../utils/env-utils';

// ── Shared props ──────────────────────────────────────────────────────────────

interface SharedProps {
  environment: string;
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  namespace: servicediscovery.PrivateDnsNamespace;
  ecsSg: ec2.SecurityGroup;
  taskRole: iam.Role;
  executionRolePolicy: iam.PolicyStatement;
  secrets: secretsmanager.ISecret;
  logging: ecs.AwsLogDriver;
}

// ── OmeroDatabase construct ───────────────────────────────────────────────────

interface OmeroDatabaseProps extends SharedProps {
  efsSg: ec2.SecurityGroup;
}

class OmeroDatabase extends Construct {
  constructor(scope: Construct, id: string, props: OmeroDatabaseProps) {
    super(scope, id);

    const fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc: props.vpc,
      fileSystemName: `efs-omero-${props.environment}-postgres`,
      securityGroup: props.efsSg,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
    });

    const accessPoint = fileSystem.addAccessPoint('AccessPoint', {
      path: '/postgres-data',
      createAcl: { ownerGid: '999', ownerUid: '999', permissions: '750' },
      posixUser: { gid: '999', uid: '999' },
    });

    props.taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess',
      ],
      resources: [fileSystem.fileSystemArn],
    }));

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      taskRole: props.taskRole,
      cpu: 256,
      memoryLimitMiB: 512,
      family: `ecs-td-omero-postgres-${props.environment}`,
      volumes: [{
        name: 'postgres-data',
        efsVolumeConfiguration: {
          fileSystemId: fileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
        },
      }],
    });
    taskDef.addToExecutionRolePolicy(props.executionRolePolicy);

    const container = taskDef.addContainer('postgres', {
      image: ecs.ContainerImage.fromRegistry('postgres:14'),
      logging: props.logging,
      environment: { POSTGRES_DB: 'omero', POSTGRES_USER: 'omero' },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(props.secrets, 'POSTGRES_PASSWORD'),
      },
      stopTimeout: cdk.Duration.seconds(30),
      healthCheck: {
        command: ['CMD-SHELL', 'pg_isready -U omero'],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(30),
      },
    });
    container.addPortMappings({ containerPort: 5432, protocol: ecs.Protocol.TCP, name: 'postgres' });
    container.addMountPoints({ sourceVolume: 'postgres-data', containerPath: '/var/lib/postgresql/data', readOnly: false });

    new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      serviceName: `ecs-svc-omero-postgres-${props.environment}`,
      taskDefinition: taskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      securityGroups: [props.ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      cloudMapOptions: {
        name: 'postgres',
        cloudMapNamespace: props.namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });
  }
}

// ── OmeroServer construct ─────────────────────────────────────────────────────

interface OmeroServerProps extends SharedProps {
  serverRepo: ecr.Repository;
  imagesBucket: s3.Bucket;
}

class OmeroServer extends Construct {
  constructor(scope: Construct, id: string, props: OmeroServerProps) {
    super(scope, id);

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      taskRole: props.taskRole,
      cpu: 1024,
      memoryLimitMiB: 2048,
      family: `ecs-td-omero-server-${props.environment}`,
    });
    taskDef.addToExecutionRolePolicy(props.executionRolePolicy);

    const container = taskDef.addContainer('omeroserver', {
      image: ecs.ContainerImage.fromEcrRepository(props.serverRepo, 'latest'),
      logging: props.logging,
      environment: {
        CONFIG_omero_db_host: `postgres.omero-${props.environment}.local`,
        CONFIG_omero_db_name: 'omero',
        CONFIG_omero_db_user: 'omero',
        CONFIG_omero_managed_repository: `s3://${props.imagesBucket.bucketName}/managed`,
        CONFIG_omero_s3_bucket: props.imagesBucket.bucketName,
        CONFIG_omero_s3_region: cdk.Stack.of(scope).region,
        CONFIG_omero_jvmcfg_percent_blitz: '50',
        CONFIG_omero_jvmcfg_percent_pixeldata: '20',
      },
      secrets: {
        CONFIG_omero_db_pass: ecs.Secret.fromSecretsManager(props.secrets, 'POSTGRES_PASSWORD'),
        ROOTPASS: ecs.Secret.fromSecretsManager(props.secrets, 'OMERO_ROOT_PASSWORD'),
      },
      stopTimeout: cdk.Duration.seconds(30),
    });
    container.addPortMappings({ containerPort: 4064, protocol: ecs.Protocol.TCP, name: 'omero-server' });

    new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      serviceName: `ecs-svc-omero-server-${props.environment}`,
      taskDefinition: taskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      securityGroups: [props.ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      cloudMapOptions: {
        name: 'server',
        cloudMapNamespace: props.namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });
  }
}

// ── OmeroWeb construct ────────────────────────────────────────────────────────

interface OmeroWebProps extends SharedProps {
  webRepo: ecr.Repository;
  listener: elb.ApplicationListener;
  domainName?: string;
}

class OmeroWeb extends Construct {
  constructor(scope: Construct, id: string, props: OmeroWebProps) {
    super(scope, id);

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      taskRole: props.taskRole,
      cpu: 512,
      memoryLimitMiB: 1024,
      family: `ecs-td-omero-web-${props.environment}`,
    });
    taskDef.addToExecutionRolePolicy(props.executionRolePolicy);

    const container = taskDef.addContainer('omeroweb', {
      image: ecs.ContainerImage.fromEcrRepository(props.webRepo, 'latest'),
      logging: props.logging,
      environment: {
        OMEROHOST: `server.omero-${props.environment}.local`,
        CONFIG_omero_web_apps_append: 'omero_iviewer',
        CONFIG_omero_web_open_with: '[{"name": "iViewer", "supported_objects": ["image"], "url": "iviewer_index"}]',
        CONFIG_omero_web_wsgi__timeout: '600',
        CONFIG_omero_web_session__engine: 'django.contrib.sessions.backends.file',
        CONFIG_omero_web_csrf__trusted__origins: `["https://${props.domainName ?? '*'}"]`,
        CONFIG_omero_web_allowed__hosts: '["*"]',
        CONFIG_omero_web_use__x__forwarded__host: 'true',
        CONFIG_omero_web_secure__proxy__ssl__header: '["HTTP_X_FORWARDED_PROTO", "https"]',
        CONFIG_omero_web_csrf__cookie__secure: 'false',
        CONFIG_omero_web_session__cookie__secure: 'false',
        CONFIG_omero_web_caches: '{"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}',
      },
      stopTimeout: cdk.Duration.seconds(30),
    });
    container.addPortMappings({ containerPort: 4080, protocol: ecs.Protocol.TCP, name: 'omero-web' });

    const service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      serviceName: `ecs-svc-omero-web-${props.environment}`,
      taskDefinition: taskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      securityGroups: [props.ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: false },
      enableExecuteCommand: true,
    });

    props.listener.addTargets('WebTargets', {
      targetGroupName: `tg-omero-web-${props.environment}`,
      port: 4080,
      protocol: elb.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
        healthyHttpCodes: '200,301,302,400,404',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
  }
}

// ── OmeroImportPipeline construct ─────────────────────────────────────────────

interface OmeroImportPipelineProps {
  environment: string;
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  ecsSg: ec2.SecurityGroup;
  taskRole: iam.Role;
  executionRolePolicy: iam.PolicyStatement;
  serverRepo: ecr.Repository;
  imagesBucket: s3.Bucket;
  importQueue: sqs.Queue;
  secrets: secretsmanager.ISecret;
  logging: ecs.AwsLogDriver;
}

class OmeroImportPipeline extends Construct {
  constructor(scope: Construct, id: string, props: OmeroImportPipelineProps) {
    super(scope, id);

    const stack = cdk.Stack.of(scope);

    const importTaskDef = new ecs.FargateTaskDefinition(this, 'ImportTaskDef', {
      taskRole: props.taskRole,
      cpu: 1024,
      memoryLimitMiB: 2048,
      family: `ecs-td-omero-import-${props.environment}`,
      ephemeralStorageGiB: 21,
    });
    importTaskDef.addToExecutionRolePolicy(props.executionRolePolicy);

    importTaskDef.addContainer('omero-import', {
      image: ecs.ContainerImage.fromEcrRepository(props.serverRepo, 'latest'),
      logging: props.logging,
      essential: true,
      entryPoint: ['/bin/bash', '-c'],
      command: ['echo ready'],
      environment: {
        OMERO_SERVER: `server.omero-${props.environment}.local`,
      },
      secrets: {
        ROOTPASS: ecs.Secret.fromSecretsManager(props.secrets, 'OMERO_ROOT_PASSWORD'),
      },
    });

    const importLambda = new lambda.Function(this, 'ImportLambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'fargate_import.handler',
      timeout: cdk.Duration.minutes(1),
      functionName: `lambda-omero-import-${props.environment}`,
      reservedConcurrentExecutions: 1,
      logGroup: new cdk.aws_logs.LogGroup(scope, 'ImportLambdaLogGroup', {
        logGroupName: `/aws/lambda/lambda-omero-import-${props.environment}`,
        retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        CLUSTER: `ecs-cluster-omero-${props.environment}`,
        TASK_DEF: importTaskDef.taskDefinitionArn,
        SUBNET: props.vpc.privateSubnets[0].subnetId,
        SECURITY_GROUP: props.ecsSg.securityGroupId,
        OMERO_SERVER: `server.omero-${props.environment}.local`,
        SECRET_ID: `omero-${props.environment}-secrets`,
        REGION: stack.region,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda')),
    });

    importLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecs:RunTask'],
      resources: [importTaskDef.taskDefinitionArn],
    }));

    importLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [props.taskRole.roleArn, importTaskDef.executionRole!.roleArn],
    }));

    importLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${props.imagesBucket.bucketArn}/import/*`],
    }));

    importLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:omero-${props.environment}-secrets*`,
      ],
    }));

    importLambda.addEventSource(new lambdaEvents.SqsEventSource(props.importQueue, { batchSize: 1 }));
  }
}

// ── FargateStack ──────────────────────────────────────────────────────────────

export interface FargateStackProps extends cdk.StackProps {
  environment: string;
  vpc: ec2.Vpc;
  omeroServerRepo: ecr.Repository;
  omeroWebRepo: ecr.Repository;
  omeroPostgresRepo: ecr.Repository;
  omeroImagesBucket: s3.Bucket;
  importQueue: sqs.Queue;
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificate?: acm.ICertificate;
}

export class FargateStack extends cdk.Stack {
  readonly alb: elb.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: FargateStackProps) {
    super(scope, id, props);
    applyTags(this, props.environment);

    // ── Service Discovery ───────────────────────────────────────────────────
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: `omero-${props.environment}.local`,
      vpc: props.vpc,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `ecs-cluster-omero-${props.environment}`,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    // ── Security Groups ─────────────────────────────────────────────────────
    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: props.vpc,
      securityGroupName: `omero-${props.environment}-efs-sg`,
      description: 'OMERO EFS',
      allowAllOutbound: false,
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      securityGroupName: `omero-${props.environment}-alb-sg`,
      description: 'OMERO ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect');

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: props.vpc,
      securityGroupName: `omero-${props.environment}-ecs-sg`,
      description: 'OMERO ECS tasks',
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(4080), 'ALB to web');
    ecsSg.addIngressRule(ecsSg, ec2.Port.tcp(4064), 'Web to server');
    ecsSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), 'Server to postgres');
    efsSg.addIngressRule(ecsSg, ec2.Port.tcp(2049), 'ECS to EFS');

    // ── IAM ─────────────────────────────────────────────────────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `ecs-task-role-omero-${props.environment}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [props.omeroImagesBucket.bucketArn, `${props.omeroImagesBucket.bucketArn}/*`],
    }));

    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'secretsmanager:GetSecretValue',
      ],
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: `ecs-omero-${props.environment}`,
      logGroup: new cdk.aws_logs.LogGroup(this, 'LogGroup', {
        logGroupName: `/ecs/omero-${props.environment}`,
        retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const omeroSecrets = secretsmanager.Secret.fromSecretNameV2(
      this, 'OmeroSecrets', `omero-${props.environment}-secrets`,
    );

    const sharedProps: SharedProps = {
      environment: props.environment,
      vpc: props.vpc,
      cluster,
      namespace,
      ecsSg,
      taskRole,
      executionRolePolicy,
      secrets: omeroSecrets,
      logging,
    };

    // ── ALB ─────────────────────────────────────────────────────────────────
    this.alb = new elb.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      loadBalancerName: `alb-omero-${props.environment}`,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    let httpsListener: elb.ApplicationListener;

    if (props.certificate) {
      httpsListener = this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: elb.ApplicationProtocol.HTTPS,
        certificates: [props.certificate],
        open: false,
      });
      this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elb.ApplicationProtocol.HTTP,
        defaultAction: elb.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      httpsListener = this.alb.addListener('HttpListener', {
        port: 80,
        protocol: elb.ApplicationProtocol.HTTP,
        open: false,
      });
    }

    // ── Services ─────────────────────────────────────────────────────────────
    new OmeroDatabase(this, 'Database', { ...sharedProps, efsSg });

    new OmeroServer(this, 'Server', {
      ...sharedProps,
      serverRepo: props.omeroServerRepo,
      imagesBucket: props.omeroImagesBucket,
    });

    new OmeroWeb(this, 'Web', {
      ...sharedProps,
      webRepo: props.omeroWebRepo,
      listener: httpsListener,
      domainName: props.domainName,
    });

    new OmeroImportPipeline(this, 'ImportPipeline', {
      environment: props.environment,
      vpc: props.vpc,
      cluster,
      ecsSg,
      taskRole,
      executionRolePolicy,
      serverRepo: props.omeroServerRepo,
      imagesBucket: props.omeroImagesBucket,
      importQueue: props.importQueue,
      secrets: omeroSecrets,
      logging,
    });

    // ── DNS ──────────────────────────────────────────────────────────────────
    if (props.domainName && props.hostedZoneId && props.hostedZoneName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });
      new route53.ARecord(this, 'AlbAliasRecord', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
      });
    }

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      exportName: `omero-${props.environment}-alb-dns`,
    });
  }
}
