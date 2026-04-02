import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import {
  Cluster, AwsLogDriver, FargateTaskDefinition,
  ContainerImage, Protocol, FargateService, Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  ApplicationLoadBalancer, ApplicationProtocol,
  ApplicationTargetGroup, TargetType, ListenerAction,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { SecurityGroup, Port, Peer } from 'aws-cdk-lib/aws-ec2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

export interface FargateStackProps extends StackProps {
  environment: string;
  vpc: ec2.Vpc;
  omeroServerRepo: Repository;
  omeroWebRepo: Repository;
  omeroPostgresRepo: Repository;
  omeroImagesBucket: s3.Bucket;
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificate?: acm.ICertificate;
}

export class FargateStack extends cdk.Stack {
  readonly alb: ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: FargateStackProps) {
    super(scope, id, props);

    const vpc = props.vpc;

    // ── Cloud Map namespace ───────────────────────────────────────────────────
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: `omero-${props.environment}.local`,
      vpc,
    });

    // ── Cluster ───────────────────────────────────────────────────────────────
    const cluster = new Cluster(this, 'Cluster', {
      vpc,
      clusterName: `ecs-cluster-omero-${props.environment}`,
      containerInsights: false,
    });

    // ── EFS para persistencia de PostgreSQL ───────────────────────────────────
    const efsSg = new SecurityGroup(this, 'EfsSg', {
      vpc,
      securityGroupName: `omero-${props.environment}-efs-sg`,
      description: 'OMERO EFS',
      allowAllOutbound: false,
    });

    const efsFileSystem = new efs.FileSystem(this, 'PostgresEfs', {
      vpc,
      fileSystemName: `efs-omero-${props.environment}-postgres`,
      securityGroup: efsSg,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
    });

    const efsAccessPoint = efsFileSystem.addAccessPoint('PostgresAccessPoint', {
      path: '/postgres-data',
      createAcl: { ownerGid: '999', ownerUid: '999', permissions: '750' },
      posixUser: { gid: '999', uid: '999' },
    });

    // ── IAM Task Role compartido ──────────────────────────────────────────────
    const taskRole = new Role(this, 'TaskRole', {
      roleName: `ecs-taskRole-omero-${props.environment}`,
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [
        props.omeroImagesBucket.bucketArn,
        `${props.omeroImagesBucket.bucketArn}/*`,
      ],
    }));

    taskRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess',
      ],
      resources: [efsFileSystem.fileSystemArn],
    }));

    const executionRolePolicy = new PolicyStatement({
      effect: Effect.ALLOW,
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

    const logging = new AwsLogDriver({
      streamPrefix: `ecs-omero-${props.environment}`,
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
    });

    // ── Security Groups ───────────────────────────────────────────────────────
    const albSg = new SecurityGroup(this, 'AlbSg', {
      vpc,
      securityGroupName: `omero-${props.environment}-alb-sg`,
      description: 'OMERO ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS');
    albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'HTTP redirect');

    const ecsSg = new SecurityGroup(this, 'EcsSg', {
      vpc,
      securityGroupName: `omero-${props.environment}-ecs-sg`,
      description: 'OMERO ECS tasks',
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(albSg, Port.tcp(4080), 'alb-to-web');
    ecsSg.addIngressRule(ecsSg, Port.tcp(4064), 'web-to-server');
    ecsSg.addIngressRule(ecsSg, Port.tcp(5432), 'server-to-postgres');
    efsSg.addIngressRule(ecsSg, Port.tcp(2049), 'ecs-to-efs');

    // ── ALB ───────────────────────────────────────────────────────────────────
    this.alb = new ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      loadBalancerName: `alb-omero-${props.environment}`,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const targetGroup = new ApplicationTargetGroup(this, 'TgWeb', {
      vpc,
      port: 4080,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targetGroupName: `tg-omero-web-${props.environment}`,
      healthCheck: {
        path: '/static/omeroweb/css/ome.body.css',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200,301,302,400',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    if (props.certificate) {
      this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [props.certificate],
        defaultAction: ListenerAction.forward([targetGroup]),
      });
      this.alb.addListener('HttpListener', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      this.alb.addListener('HttpListener', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.forward([targetGroup]),
      });
    }

    // ── Secrets ───────────────────────────────────────────────────────────────
    const omeroSecrets = secretsmanager.Secret.fromSecretNameV2(
      this, 'OmeroSecrets', `omero-${props.environment}-secrets`
    );

    // ── POSTGRES task ─────────────────────────────────────────────────────────
    const postgresTaskDef = new FargateTaskDefinition(this, 'PostgresTaskDef', {
      taskRole,
      cpu: 256,
      memoryLimitMiB: 512,
      family: `ecs-td-omero-postgres-${props.environment}`,
      volumes: [{
        name: 'postgres-data',
        efsVolumeConfiguration: {
          fileSystemId: efsFileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: efsAccessPoint.accessPointId, iam: 'ENABLED' },
        },
      }],
    });
    postgresTaskDef.addToExecutionRolePolicy(executionRolePolicy);

    const postgresContainer = postgresTaskDef.addContainer('postgres', {
      image: ContainerImage.fromEcrRepository(props.omeroPostgresRepo, 'latest'),
      logging,
      environment: { POSTGRES_DB: 'omero', POSTGRES_USER: 'omero' },
      secrets: {
        POSTGRES_PASSWORD: EcsSecret.fromSecretsManager(omeroSecrets, 'POSTGRES_PASSWORD'),
      },
      stopTimeout: cdk.Duration.seconds(30),
    });
    postgresContainer.addPortMappings({ containerPort: 5432, protocol: Protocol.TCP, name: 'postgres' });
    postgresContainer.addMountPoints({
      sourceVolume: 'postgres-data',
      containerPath: '/var/lib/postgresql/data',
      readOnly: false,
    });

    new FargateService(this, 'PostgresService', {
      cluster,
      serviceName: `ecs-svc-omero-postgres-${props.environment}`,
      taskDefinition: postgresTaskDef,
      desiredCount: 1,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      cloudMapOptions: {
        name: 'postgres',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    // ── OMERO SERVER task ─────────────────────────────────────────────────────
    const serverTaskDef = new FargateTaskDefinition(this, 'ServerTaskDef', {
      taskRole,
      cpu: 1024,
      memoryLimitMiB: 2048,
      family: `ecs-td-omero-server-${props.environment}`,
    });
    serverTaskDef.addToExecutionRolePolicy(executionRolePolicy);

    const serverContainer = serverTaskDef.addContainer('omeroserver', {
      image: ContainerImage.fromEcrRepository(props.omeroServerRepo, 'latest'),
      logging,
      environment: {
        CONFIG_omero_db_host: `postgres.omero-${props.environment}.local`,
        CONFIG_omero_db_name: 'omero',
        CONFIG_omero_db_user: 'omero',
        CONFIG_omero_managed_repository: `s3://${props.omeroImagesBucket.bucketName}/managed`,
        CONFIG_omero_s3_bucket: props.omeroImagesBucket.bucketName,
        CONFIG_omero_s3_region: this.region,
        CONFIG_omero_jvmcfg_percent_blitz: '50',
        CONFIG_omero_jvmcfg_percent_pixeldata: '20',
      },
      secrets: {
        CONFIG_omero_db_pass: EcsSecret.fromSecretsManager(omeroSecrets, 'POSTGRES_PASSWORD'),
        ROOTPASS: EcsSecret.fromSecretsManager(omeroSecrets, 'OMERO_ROOT_PASSWORD'),
      },
      stopTimeout: cdk.Duration.seconds(30),
    });
    serverContainer.addPortMappings({ containerPort: 4064, protocol: Protocol.TCP, name: 'omero-server' });

    new FargateService(this, 'ServerService', {
      cluster,
      serviceName: `ecs-svc-omero-server-${props.environment}`,
      taskDefinition: serverTaskDef,
      desiredCount: 1,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      cloudMapOptions: {
        name: 'server',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    // ── OMERO WEB task ────────────────────────────────────────────────────────
    const webTaskDef = new FargateTaskDefinition(this, 'WebTaskDef', {
      taskRole,
      cpu: 512,
      memoryLimitMiB: 1024,
      family: `ecs-td-omero-web-${props.environment}`,
    });
    webTaskDef.addToExecutionRolePolicy(executionRolePolicy);

    const webContainer = webTaskDef.addContainer('omeroweb', {
      image: ContainerImage.fromEcrRepository(props.omeroWebRepo, 'latest'),
      logging,
      environment: {
        OMEROHOST: `server.omero-${props.environment}.local`,
        CONFIG_omero_web_apps_append: 'omero_iviewer',
        CONFIG_omero_web_open_with: '[{"name": "iViewer", "supported_objects": ["image"], "url": "iviewer_index"}]',
        CONFIG_omero_web_wsgi__timeout: '600',
        CONFIG_omero_web_session__engine: 'django.contrib.sessions.backends.file',
        CONFIG_omero_web_csrf__trusted__origins: '["https://omero.teleinforme-dev.minsal.cl", "https://*.minsal.cl"]',
        CONFIG_omero_web_allowed__hosts: '["*"]',
        CONFIG_omero_web_use__x__forwarded__host: 'true',
        CONFIG_omero_web_secure__proxy__ssl__header: '["HTTP_X_FORWARDED_PROTO", "https"]',
        CONFIG_omero_web_csrf__cookie__secure: 'false',
        CONFIG_omero_web_session__cookie__secure: 'false',
        CONFIG_omero_web_caches: '{"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}',
      },
      stopTimeout: cdk.Duration.seconds(30),
    });
    webContainer.addPortMappings({ containerPort: 4080, protocol: Protocol.TCP, name: 'omero-web' });

    new FargateService(this, 'WebService', {
      cluster,
      serviceName: `ecs-svc-omero-web-${props.environment}`,
      taskDefinition: webTaskDef,
      desiredCount: 1,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
    });

    // ── Lambda auto-registro cross-VPC ────────────────────────────────────────
    const autoRegisterLambda = new lambda.Function(this, 'AutoRegisterTargets', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      functionName: `lambda-omero-register-targets-${props.environment}`,
      code: lambda.Code.fromInline(`
import boto3, logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    try:
        elbv2 = boto3.client('elbv2')
        detail = event['detail']
        last_status = detail['lastStatus']
        if 'omero-web' not in detail.get('group', ''):
            return {'statusCode': 200}
        for attachment in detail.get('attachments', []):
            if attachment.get('type') == 'eni':
                for d in attachment.get('details', []):
                    if d.get('name') == 'privateIPv4Address':
                        ip = d['value']
                        az = detail.get('availabilityZone', '')
                        tg_arn = '${targetGroup.targetGroupArn}'
                        if last_status == 'RUNNING':
                            elbv2.register_targets(TargetGroupArn=tg_arn, Targets=[{'Id': ip, 'Port': 4080, 'AvailabilityZone': az}])
                        elif last_status == 'STOPPED':
                            elbv2.deregister_targets(TargetGroupArn=tg_arn, Targets=[{'Id': ip, 'Port': 4080, 'AvailabilityZone': az}])
                        return {'statusCode': 200}
    except Exception as e:
        logger.error(str(e))
        return {'statusCode': 500}
`),
    });

    autoRegisterLambda.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets'],
      resources: ['*'],
    }));

    new events.Rule(this, 'EcsTaskStateRule', {
      ruleName: `rule-omero-ecs-state-${props.environment}`,
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          lastStatus: ['RUNNING', 'STOPPED'],
        },
      },
      targets: [new targets.LambdaFunction(autoRegisterLambda)],
    });

    // ── Route53 (opcional) ────────────────────────────────────────────────────
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
