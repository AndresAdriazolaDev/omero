"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FargateStack = void 0;
const cdk = require("aws-cdk-lib");
const aws_ecs_1 = require("aws-cdk-lib/aws-ecs");
const aws_elasticloadbalancingv2_1 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const aws_iam_1 = require("aws-cdk-lib/aws-iam");
const aws_ec2_1 = require("aws-cdk-lib/aws-ec2");
const ec2 = require("aws-cdk-lib/aws-ec2");
const efs = require("aws-cdk-lib/aws-efs");
const route53 = require("aws-cdk-lib/aws-route53");
const route53Targets = require("aws-cdk-lib/aws-route53-targets");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const lambda = require("aws-cdk-lib/aws-lambda");
const events = require("aws-cdk-lib/aws-events");
const targets = require("aws-cdk-lib/aws-events-targets");
const servicediscovery = require("aws-cdk-lib/aws-servicediscovery");
class FargateStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const vpc = props.vpc;
        // ── Cloud Map namespace ───────────────────────────────────────────────────
        const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
            name: `omero-${props.environment}.local`,
            vpc,
        });
        // ── Cluster ───────────────────────────────────────────────────────────────
        const cluster = new aws_ecs_1.Cluster(this, 'Cluster', {
            vpc,
            clusterName: `ecs-cluster-omero-${props.environment}`,
            containerInsights: false,
        });
        // ── EFS para persistencia de PostgreSQL ───────────────────────────────────
        const efsSg = new aws_ec2_1.SecurityGroup(this, 'EfsSg', {
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
        const taskRole = new aws_iam_1.Role(this, 'TaskRole', {
            roleName: `ecs-taskRole-omero-${props.environment}`,
            assumedBy: new aws_iam_1.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        taskRole.addToPolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
            resources: [
                props.omeroImagesBucket.bucketArn,
                `${props.omeroImagesBucket.bucketArn}/*`,
            ],
        }));
        taskRole.addToPolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: [
                'elasticfilesystem:ClientMount',
                'elasticfilesystem:ClientWrite',
                'elasticfilesystem:ClientRootAccess',
            ],
            resources: [efsFileSystem.fileSystemArn],
        }));
        const executionRolePolicy = new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
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
        const logging = new aws_ecs_1.AwsLogDriver({
            streamPrefix: `ecs-omero-${props.environment}`,
            logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        });
        // ── Security Groups ───────────────────────────────────────────────────────
        const albSg = new aws_ec2_1.SecurityGroup(this, 'AlbSg', {
            vpc,
            securityGroupName: `omero-${props.environment}-alb-sg`,
            description: 'OMERO ALB',
            allowAllOutbound: true,
        });
        albSg.addIngressRule(aws_ec2_1.Peer.anyIpv4(), aws_ec2_1.Port.tcp(443), 'HTTPS');
        albSg.addIngressRule(aws_ec2_1.Peer.anyIpv4(), aws_ec2_1.Port.tcp(80), 'HTTP redirect');
        const ecsSg = new aws_ec2_1.SecurityGroup(this, 'EcsSg', {
            vpc,
            securityGroupName: `omero-${props.environment}-ecs-sg`,
            description: 'OMERO ECS tasks',
            allowAllOutbound: true,
        });
        ecsSg.addIngressRule(albSg, aws_ec2_1.Port.tcp(4080), 'alb-to-web');
        ecsSg.addIngressRule(ecsSg, aws_ec2_1.Port.tcp(4064), 'web-to-server');
        ecsSg.addIngressRule(ecsSg, aws_ec2_1.Port.tcp(5432), 'server-to-postgres');
        efsSg.addIngressRule(ecsSg, aws_ec2_1.Port.tcp(2049), 'ecs-to-efs');
        // ── ALB ───────────────────────────────────────────────────────────────────
        this.alb = new aws_elasticloadbalancingv2_1.ApplicationLoadBalancer(this, 'Alb', {
            vpc,
            internetFacing: true,
            loadBalancerName: `alb-omero-${props.environment}`,
            securityGroup: albSg,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });
        const targetGroup = new aws_elasticloadbalancingv2_1.ApplicationTargetGroup(this, 'TgWeb', {
            vpc,
            port: 4080,
            protocol: aws_elasticloadbalancingv2_1.ApplicationProtocol.HTTP,
            targetType: aws_elasticloadbalancingv2_1.TargetType.IP,
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
                protocol: aws_elasticloadbalancingv2_1.ApplicationProtocol.HTTPS,
                certificates: [props.certificate],
                defaultAction: aws_elasticloadbalancingv2_1.ListenerAction.forward([targetGroup]),
            });
            this.alb.addListener('HttpListener', {
                port: 80,
                protocol: aws_elasticloadbalancingv2_1.ApplicationProtocol.HTTP,
                defaultAction: aws_elasticloadbalancingv2_1.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
            });
        }
        else {
            this.alb.addListener('HttpListener', {
                port: 80,
                protocol: aws_elasticloadbalancingv2_1.ApplicationProtocol.HTTP,
                defaultAction: aws_elasticloadbalancingv2_1.ListenerAction.forward([targetGroup]),
            });
        }
        // ── Secrets ───────────────────────────────────────────────────────────────
        const omeroSecrets = secretsmanager.Secret.fromSecretNameV2(this, 'OmeroSecrets', `omero-${props.environment}-secrets`);
        // ── POSTGRES task ─────────────────────────────────────────────────────────
        const postgresTaskDef = new aws_ecs_1.FargateTaskDefinition(this, 'PostgresTaskDef', {
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
            image: aws_ecs_1.ContainerImage.fromEcrRepository(props.omeroPostgresRepo, 'latest'),
            logging,
            environment: { POSTGRES_DB: 'omero', POSTGRES_USER: 'omero' },
            secrets: {
                POSTGRES_PASSWORD: aws_ecs_1.Secret.fromSecretsManager(omeroSecrets, 'POSTGRES_PASSWORD'),
            },
            stopTimeout: cdk.Duration.seconds(30),
        });
        postgresContainer.addPortMappings({ containerPort: 5432, protocol: aws_ecs_1.Protocol.TCP, name: 'postgres' });
        postgresContainer.addMountPoints({
            sourceVolume: 'postgres-data',
            containerPath: '/var/lib/postgresql/data',
            readOnly: false,
        });
        new aws_ecs_1.FargateService(this, 'PostgresService', {
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
        const serverTaskDef = new aws_ecs_1.FargateTaskDefinition(this, 'ServerTaskDef', {
            taskRole,
            cpu: 1024,
            memoryLimitMiB: 2048,
            family: `ecs-td-omero-server-${props.environment}`,
        });
        serverTaskDef.addToExecutionRolePolicy(executionRolePolicy);
        const serverContainer = serverTaskDef.addContainer('omeroserver', {
            image: aws_ecs_1.ContainerImage.fromEcrRepository(props.omeroServerRepo, 'latest'),
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
                CONFIG_omero_db_pass: aws_ecs_1.Secret.fromSecretsManager(omeroSecrets, 'POSTGRES_PASSWORD'),
                ROOTPASS: aws_ecs_1.Secret.fromSecretsManager(omeroSecrets, 'OMERO_ROOT_PASSWORD'),
            },
            stopTimeout: cdk.Duration.seconds(30),
        });
        serverContainer.addPortMappings({ containerPort: 4064, protocol: aws_ecs_1.Protocol.TCP, name: 'omero-server' });
        new aws_ecs_1.FargateService(this, 'ServerService', {
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
        const webTaskDef = new aws_ecs_1.FargateTaskDefinition(this, 'WebTaskDef', {
            taskRole,
            cpu: 512,
            memoryLimitMiB: 1024,
            family: `ecs-td-omero-web-${props.environment}`,
        });
        webTaskDef.addToExecutionRolePolicy(executionRolePolicy);
        const webContainer = webTaskDef.addContainer('omeroweb', {
            image: aws_ecs_1.ContainerImage.fromEcrRepository(props.omeroWebRepo, 'latest'),
            logging,
            environment: {
                OMEROHOST: `server.omero-${props.environment}.local`,
                CONFIG_omero_web_apps_append: 'omero_iviewer',
                CONFIG_omero_web_open_with: '[{"name": "iViewer", "supported_objects": ["image"], "url": "iviewer_index"}]',
                CONFIG_omero_web_wsgi__timeout: '600',
                CONFIG_omero_web_session__engine: 'django.contrib.sessions.backends.cache',
                CONFIG_omero_web_csrf__trusted__origins: '["https://omero.teleinforme-dev.minsal.cl", "https://*.minsal.cl"]',
                CONFIG_omero_web_allowed__hosts: '["*"]',
            },
            stopTimeout: cdk.Duration.seconds(30),
        });
        webContainer.addPortMappings({ containerPort: 4080, protocol: aws_ecs_1.Protocol.TCP, name: 'omero-web' });
        new aws_ecs_1.FargateService(this, 'WebService', {
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
        autoRegisterLambda.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
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
exports.FargateStack = FargateStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmFyZ2F0ZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImZhcmdhdGUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBR25DLGlEQUc2QjtBQUU3Qix1RkFHZ0Q7QUFDaEQsaURBQXNGO0FBQ3RGLGlEQUFnRTtBQUNoRSwyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBRTNDLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFDbEUsaUVBQWlFO0FBRWpFLGlEQUFpRDtBQUNqRCxpREFBaUQ7QUFDakQsMERBQTBEO0FBQzFELHFFQUFxRTtBQWVyRSxNQUFhLFlBQWEsU0FBUSxHQUFHLENBQUMsS0FBSztJQUd6QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXdCO1FBQ2hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUM7UUFFdEIsNkVBQTZFO1FBQzdFLE1BQU0sU0FBUyxHQUFHLElBQUksZ0JBQWdCLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtZQUM1RSxJQUFJLEVBQUUsU0FBUyxLQUFLLENBQUMsV0FBVyxRQUFRO1lBQ3hDLEdBQUc7U0FDSixDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsTUFBTSxPQUFPLEdBQUcsSUFBSSxpQkFBTyxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDM0MsR0FBRztZQUNILFdBQVcsRUFBRSxxQkFBcUIsS0FBSyxDQUFDLFdBQVcsRUFBRTtZQUNyRCxpQkFBaUIsRUFBRSxLQUFLO1NBQ3pCLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSxNQUFNLEtBQUssR0FBRyxJQUFJLHVCQUFhLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtZQUM3QyxHQUFHO1lBQ0gsaUJBQWlCLEVBQUUsU0FBUyxLQUFLLENBQUMsV0FBVyxTQUFTO1lBQ3RELFdB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SSxLQUFLLENBQUMsWUFBWSxJQUFJLEtBQUssQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNuRSxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLHdCQUF3QixDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7Z0JBQ2pGLFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtnQkFDaEMsUUFBUSxFQUFFLEtBQUssQ0FBQyxjQUFjO2FBQy9CLENBQUMsQ0FBQztZQUNILElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7Z0JBQzFDLElBQUksRUFBRSxVQUFVO2dCQUNoQixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7Z0JBQzVCLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLGNBQWMsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7YUFDeEYsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUVELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLG1CQUFtQjtZQUNuQyxVQUFVLEVBQUUsU0FBUyxLQUFLLENBQUMsV0FBVyxVQUFVO1NBQ2pELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQS9XRCxvQ0ErV0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBTdGFja1Byb3BzIH0gZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHtcbiAgQ2x1c3RlciwgQXdzTG9nRHJpdmVyLCBGYXJnYXRlVGFza0RlZmluaXRpb24sXG4gIENvbnRhaW5lckltYWdlLCBQcm90b2NvbCwgRmFyZ2F0ZVNlcnZpY2UsIFNlY3JldCBhcyBFY3NTZWNyZXQsXG59IGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0IHsgUmVwb3NpdG9yeSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0IHtcbiAgQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIsIEFwcGxpY2F0aW9uUHJvdG9jb2wsXG4gIEFwcGxpY2F0aW9uVGFyZ2V0R3JvdXAsIFRhcmdldFR5cGUsIExpc3RlbmVyQWN0aW9uLFxufSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgeyBSb2xlLCBTZXJ2aWNlUHJpbmNpcGFsLCBQb2xpY3lTdGF0ZW1lbnQsIEVmZmVjdCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgU2VjdXJpdHlHcm91cCwgUG9ydCwgUGVlciB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWZzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lZnMnO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXInO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1Myc7XG5pbXBvcnQgKiBhcyByb3V0ZTUzVGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMnO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzLXRhcmdldHMnO1xuaW1wb3J0ICogYXMgc2VydmljZWRpc2NvdmVyeSBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VydmljZWRpc2NvdmVyeSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmFyZ2F0ZVN0YWNrUHJvcHMgZXh0ZW5kcyBTdGFja1Byb3BzIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZztcbiAgdnBjOiBlYzIuVnBjO1xuICBvbWVyb1NlcnZlclJlcG86IFJlcG9zaXRvcnk7XG4gIG9tZXJvV2ViUmVwbzogUmVwb3NpdG9yeTtcbiAgb21lcm9Qb3N0Z3Jlc1JlcG86IFJlcG9zaXRvcnk7XG4gIG9tZXJvSW1hZ2VzQnVja2V0OiBzMy5CdWNrZXQ7XG4gIGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIGhvc3RlZFpvbmVJZD86IHN0cmluZztcbiAgaG9zdGVkWm9uZU5hbWU/OiBzdHJpbmc7XG4gIGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcbn1cblxuZXhwb3J0IGNsYXNzIEZhcmdhdGVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHJlYWRvbmx5IGFsYjogQXBwbGljYXRpb25Mb2FkQmFsYW5jZXI7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEZhcmdhdGVTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB2cGMgPSBwcm9wcy52cGM7XG5cbiAgICAvLyDilIDilIAgQ2xvdWQgTWFwIG5hbWVzcGFjZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBuYW1lc3BhY2UgPSBuZXcgc2VydmljZWRpc2NvdmVyeS5Qcml2YXRlRG5zTmFtZXNwYWNlKHRoaXMsICdOYW1lc3BhY2UnLCB7XG4gICAgICBuYW1lOiBgb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0ubG9jYWxgLFxuICAgICAgdnBjLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSAIENsdXN0ZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyBDbHVzdGVyKHRoaXMsICdDbHVzdGVyJywge1xuICAgICAgdnBjLFxuICAgICAgY2x1c3Rlck5hbWU6IGBlY3MtY2x1c3Rlci1vbWVyby0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBjb250YWluZXJJbnNpZ2h0czogZmFsc2UsXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIAgRUZTIHBhcmEgcGVyc2lzdGVuY2lhIGRlIFBvc3RncmVTUUwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3QgZWZzU2cgPSBuZXcgU2VjdXJpdHlHcm91cCh0aGlzLCAnRWZzU2cnLCB7XG4gICAgICB2cGMsXG4gICAgICBzZWN1cml0eUdyb3VwTmFtZTogYG9tZXJvLSR7cHJvcHMuZW52aXJvbm1lbnR9LWVmcy1zZ2AsXG4gICAgICBkZXNjcmlwdGlvbjogJ09NRVJPIEVGUycsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGVmc0ZpbGVTeXN0ZW0gPSBuZXcgZWZzLkZpbGVTeXN0ZW0odGhpcywgJ1Bvc3RncmVzRWZzJywge1xuICAgICAgdnBjLFxuICAgICAgZmlsZVN5c3RlbU5hbWU6IGBlZnMtb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0tcG9zdGdyZXNgLFxuICAgICAgc2VjdXJpdHlHcm91cDogZWZzU2csXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICBsaWZlY3ljbGVQb2xpY3k6IGVmcy5MaWZlY3ljbGVQb2xpY3kuQUZURVJfMzBfREFZUyxcbiAgICAgIHBlcmZvcm1hbmNlTW9kZTogZWZzLlBlcmZvcm1hbmNlTW9kZS5HRU5FUkFMX1BVUlBPU0UsXG4gICAgICB0aHJvdWdocHV0TW9kZTogZWZzLlRocm91Z2hwdXRNb2RlLkJVUlNUSU5HLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZWZzQWNjZXNzUG9pbnQgPSBlZnNGaWxlU3lzdGVtLmFkZEFjY2Vzc1BvaW50KCdQb3N0Z3Jlc0FjY2Vzc1BvaW50Jywge1xuICAgICAgcGF0aDogJy9wb3N0Z3Jlcy1kYXRhJyxcbiAgICAgIGNyZWF0ZUFjbDogeyBvd25lckdpZDogJzk5OScsIG93bmVyVWlkOiAnOTk5JywgcGVybWlzc2lvbnM6ICc3NTAnIH0sXG4gICAgICBwb3NpeFVzZXI6IHsgZ2lkOiAnOTk5JywgdWlkOiAnOTk5JyB9LFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSAIElBTSBUYXNrIFJvbGUgY29tcGFydGlkbyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCB0YXNrUm9sZSA9IG5ldyBSb2xlKHRoaXMsICdUYXNrUm9sZScsIHtcbiAgICAgIHJvbGVOYW1lOiBgZWNzLXRhc2tSb2xlLW9tZXJvLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGFzc3VtZWRCeTogbmV3IFNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydzMzpHZXRPYmplY3QnLCAnczM6UHV0T2JqZWN0JywgJ3MzOkRlbGV0ZU9iamVjdCcsICdzMzpMaXN0QnVja2V0J10sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgcHJvcHMub21lcm9JbWFnZXNCdWNrZXQuYnVja2V0QXJuLFxuICAgICAgICBgJHtwcm9wcy5vbWVyb0ltYWdlc0J1Y2tldC5idWNrZXRBcm59LypgLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnZWxhc3RpY2ZpbGVzeXN0ZW06Q2xpZW50TW91bnQnLFxuICAgICAgICAnZWxhc3RpY2ZpbGVzeXN0ZW06Q2xpZW50V3JpdGUnLFxuICAgICAgICAnZWxhc3RpY2ZpbGVzeXN0ZW06Q2xpZW50Um9vdEFjY2VzcycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbZWZzRmlsZVN5c3RlbS5maWxlU3lzdGVtQXJuXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBleGVjdXRpb25Sb2xlUG9saWN5ID0gbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJyxcbiAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAnZWNyOkdldERvd25sb2FkVXJsRm9yTGF5ZXInLFxuICAgICAgICAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgICAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLFxuICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvZ2dpbmcgPSBuZXcgQXdzTG9nRHJpdmVyKHtcbiAgICAgIHN0cmVhbVByZWZpeDogYGVjcy1vbWVyby0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBsb2dSZXRlbnRpb246IGNkay5hd3NfbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSAIFNlY3VyaXR5IEdyb3VwcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBhbGJTZyA9IG5ldyBTZWN1cml0eUdyb3VwKHRoaXMsICdBbGJTZycsIHtcbiAgICAgIHZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiBgb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0tYWxiLXNnYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnT01FUk8gQUxCJyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXG4gICAgfSk7XG4gICAgYWxiU2cuYWRkSW5ncmVzc1J1bGUoUGVlci5hbnlJcHY0KCksIFBvcnQudGNwKDQ0MyksICdIVFRQUycpO1xuICAgIGFsYlNnLmFkZEluZ3Jlc3NSdWxlKFBlZXIuYW55SXB2NCgpLCBQb3J0LnRjcCg4MCksICdIVFRQIHJlZGlyZWN0Jyk7XG5cbiAgICBjb25zdCBlY3NTZyA9IG5ldyBTZWN1cml0eUdyb3VwKHRoaXMsICdFY3NTZycsIHtcbiAgICAgIHZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiBgb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0tZWNzLXNnYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnT01FUk8gRUNTIHRhc2tzJyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXG4gICAgfSk7XG4gICAgZWNzU2cuYWRkSW5ncmVzc1J1bGUoYWxiU2csIFBvcnQudGNwKDQwODApLCAnYWxiLXRvLXdlYicpO1xuICAgIGVjc1NnLmFkZEluZ3Jlc3NSdWxlKGVjc1NnLCBQb3J0LnRjcCg0MDY0KSwgJ3dlYi10by1zZXJ2ZXInKTtcbiAgICBlY3NTZy5hZGRJbmdyZXNzUnVsZShlY3NTZywgUG9ydC50Y3AoNTQzMiksICdzZXJ2ZXItdG8tcG9zdGdyZXMnKTtcbiAgICBlZnNTZy5hZGRJbmdyZXNzUnVsZShlY3NTZywgUG9ydC50Y3AoMjA0OSksICdlY3MtdG8tZWZzJyk7XG5cbiAgICAvLyDilIDilIAgQUxCIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIHRoaXMuYWxiID0gbmV3IEFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHRoaXMsICdBbGInLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIGxvYWRCYWxhbmNlck5hbWU6IGBhbGItb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgc2VjdXJpdHlHcm91cDogYWxiU2csXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgdGFyZ2V0R3JvdXAgPSBuZXcgQXBwbGljYXRpb25UYXJnZXRHcm91cCh0aGlzLCAnVGdXZWInLCB7XG4gICAgICB2cGMsXG4gICAgICBwb3J0OiA0MDgwLFxuICAgICAgcHJvdG9jb2w6IEFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIHRhcmdldFR5cGU6IFRhcmdldFR5cGUuSVAsXG4gICAgICB0YXJnZXRHcm91cE5hbWU6IGB0Zy1vbWVyby13ZWItJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgcGF0aDogJy9zdGF0aWMvb21lcm93ZWIvY3NzL29tZS5ib2R5LmNzcycsXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCwzMDEsMzAyLDQwMCcsXG4gICAgICB9LFxuICAgICAgZGVyZWdpc3RyYXRpb25EZWxheTogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgIH0pO1xuXG4gICAgaWYgKHByb3BzLmNlcnRpZmljYXRlKSB7XG4gICAgICB0aGlzLmFsYi5hZGRMaXN0ZW5lcignSHR0cHNMaXN0ZW5lcicsIHtcbiAgICAgICAgcG9ydDogNDQzLFxuICAgICAgICBwcm90b2NvbDogQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgICAgY2VydGlmaWNhdGVzOiBbcHJvcHMuY2VydGlmaWNhdGVdLFxuICAgICAgICBkZWZhdWx0QWN0aW9uOiBMaXN0ZW5lckFjdGlvbi5mb3J3YXJkKFt0YXJnZXRHcm91cF0pLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmFsYi5hZGRMaXN0ZW5lcignSHR0cExpc3RlbmVyJywge1xuICAgICAgICBwb3J0OiA4MCxcbiAgICAgICAgcHJvdG9jb2w6IEFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgZGVmYXVsdEFjdGlvbjogTGlzdGVuZXJBY3Rpb24ucmVkaXJlY3QoeyBwcm90b2NvbDogJ0hUVFBTJywgcG9ydDogJzQ0MycsIHBlcm1hbmVudDogdHJ1ZSB9KSxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmFsYi5hZGRMaXN0ZW5lcignSHR0cExpc3RlbmVyJywge1xuICAgICAgICBwb3J0OiA4MCxcbiAgICAgICAgcHJvdG9jb2w6IEFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgZGVmYXVsdEFjdGlvbjogTGlzdGVuZXJBY3Rpb24uZm9yd2FyZChbdGFyZ2V0R3JvdXBdKSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIOKUgOKUgCBTZWNyZXRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGNvbnN0IG9tZXJvU2VjcmV0cyA9IHNlY3JldHNtYW5hZ2VyLlNlY3JldC5mcm9tU2VjcmV0TmFtZVYyKFxuICAgICAgdGhpcywgJ09tZXJvU2VjcmV0cycsIGBvbWVyby0ke3Byb3BzLmVudmlyb25tZW50fS1zZWNyZXRzYFxuICAgICk7XG5cbiAgICAvLyDilIDilIAgUE9TVEdSRVMgdGFzayDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBwb3N0Z3Jlc1Rhc2tEZWYgPSBuZXcgRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdQb3N0Z3Jlc1Rhc2tEZWYnLCB7XG4gICAgICB0YXNrUm9sZSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICAgIGZhbWlseTogYGVjcy10ZC1vbWVyby1wb3N0Z3Jlcy0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICB2b2x1bWVzOiBbe1xuICAgICAgICBuYW1lOiAncG9zdGdyZXMtZGF0YScsXG4gICAgICAgIGVmc1ZvbHVtZUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBmaWxlU3lzdGVtSWQ6IGVmc0ZpbGVTeXN0ZW0uZmlsZVN5c3RlbUlkLFxuICAgICAgICAgIHRyYW5zaXRFbmNyeXB0aW9uOiAnRU5BQkxFRCcsXG4gICAgICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzogeyBhY2Nlc3NQb2ludElkOiBlZnNBY2Nlc3NQb2ludC5hY2Nlc3NQb2ludElkLCBpYW06ICdFTkFCTEVEJyB9LFxuICAgICAgICB9LFxuICAgICAgfV0sXG4gICAgfSk7XG4gICAgcG9zdGdyZXNUYXNrRGVmLmFkZFRvRXhlY3V0aW9uUm9sZVBvbGljeShleGVjdXRpb25Sb2xlUG9saWN5KTtcblxuICAgIGNvbnN0IHBvc3RncmVzQ29udGFpbmVyID0gcG9zdGdyZXNUYXNrRGVmLmFkZENvbnRhaW5lcigncG9zdGdyZXMnLCB7XG4gICAgICBpbWFnZTogQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkocHJvcHMub21lcm9Qb3N0Z3Jlc1JlcG8sICdsYXRlc3QnKSxcbiAgICAgIGxvZ2dpbmcsXG4gICAgICBlbnZpcm9ubWVudDogeyBQT1NUR1JFU19EQjogJ29tZXJvJywgUE9TVEdSRVNfVVNFUjogJ29tZXJvJyB9LFxuICAgICAgc2VjcmV0czoge1xuICAgICAgICBQT1NUR1JFU19QQVNTV09SRDogRWNzU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihvbWVyb1NlY3JldHMsICdQT1NUR1JFU19QQVNTV09SRCcpLFxuICAgICAgfSxcbiAgICAgIHN0b3BUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgfSk7XG4gICAgcG9zdGdyZXNDb250YWluZXIuYWRkUG9ydE1hcHBpbmdzKHsgY29udGFpbmVyUG9ydDogNTQzMiwgcHJvdG9jb2w6IFByb3RvY29sLlRDUCwgbmFtZTogJ3Bvc3RncmVzJyB9KTtcbiAgICBwb3N0Z3Jlc0NvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICBzb3VyY2VWb2x1bWU6ICdwb3N0Z3Jlcy1kYXRhJyxcbiAgICAgIGNvbnRhaW5lclBhdGg6ICcvdmFyL2xpYi9wb3N0Z3Jlc3FsL2RhdGEnLFxuICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgbmV3IEZhcmdhdGVTZXJ2aWNlKHRoaXMsICdQb3N0Z3Jlc1NlcnZpY2UnLCB7XG4gICAgICBjbHVzdGVyLFxuICAgICAgc2VydmljZU5hbWU6IGBlY3Mtc3ZjLW9tZXJvLXBvc3RncmVzLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIHRhc2tEZWZpbml0aW9uOiBwb3N0Z3Jlc1Rhc2tEZWYsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBzZWN1cml0eUdyb3VwczogW2Vjc1NnXSxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgICAgY2lyY3VpdEJyZWFrZXI6IHsgcm9sbGJhY2s6IHRydWUgfSxcbiAgICAgIGVuYWJsZUV4ZWN1dGVDb21tYW5kOiB0cnVlLFxuICAgICAgY2xvdWRNYXBPcHRpb25zOiB7XG4gICAgICAgIG5hbWU6ICdwb3N0Z3JlcycsXG4gICAgICAgIGNsb3VkTWFwTmFtZXNwYWNlOiBuYW1lc3BhY2UsXG4gICAgICAgIGRuc1JlY29yZFR5cGU6IHNlcnZpY2VkaXNjb3ZlcnkuRG5zUmVjb3JkVHlwZS5BLFxuICAgICAgICBkbnNUdGw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIAgT01FUk8gU0VSVkVSIHRhc2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgY29uc3Qgc2VydmVyVGFza0RlZiA9IG5ldyBGYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ1NlcnZlclRhc2tEZWYnLCB7XG4gICAgICB0YXNrUm9sZSxcbiAgICAgIGNwdTogMTAyNCxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxuICAgICAgZmFtaWx5OiBgZWNzLXRkLW9tZXJvLXNlcnZlci0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgfSk7XG4gICAgc2VydmVyVGFza0RlZi5hZGRUb0V4ZWN1dGlvblJvbGVQb2xpY3koZXhlY3V0aW9uUm9sZVBvbGljeSk7XG5cbiAgICBjb25zdCBzZXJ2ZXJDb250YWluZXIgPSBzZXJ2ZXJUYXNrRGVmLmFkZENvbnRhaW5lcignb21lcm9zZXJ2ZXInLCB7XG4gICAgICBpbWFnZTogQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkocHJvcHMub21lcm9TZXJ2ZXJSZXBvLCAnbGF0ZXN0JyksXG4gICAgICBsb2dnaW5nLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ09ORklHX29tZXJvX2RiX2hvc3Q6IGBwb3N0Z3Jlcy5vbWVyby0ke3Byb3BzLmVudmlyb25tZW50fS5sb2NhbGAsXG4gICAgICAgIENPTkZJR19vbWVyb19kYl9uYW1lOiAnb21lcm8nLFxuICAgICAgICBDT05GSUdfb21lcm9fZGJfdXNlcjogJ29tZXJvJyxcbiAgICAgICAgQ09ORklHX29tZXJvX21hbmFnZWRfcmVwb3NpdG9yeTogYHMzOi8vJHtwcm9wcy5vbWVyb0ltYWdlc0J1Y2tldC5idWNrZXROYW1lfS9tYW5hZ2VkYCxcbiAgICAgICAgQ09ORklHX29tZXJvX3MzX2J1Y2tldDogcHJvcHMub21lcm9JbWFnZXNCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgICAgQ09ORklHX29tZXJvX3MzX3JlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICAgIENPTkZJR19vbWVyb19qdm1jZmdfcGVyY2VudF9ibGl0ejogJzUwJyxcbiAgICAgICAgQ09ORklHX29tZXJvX2p2bWNmZ19wZXJjZW50X3BpeGVsZGF0YTogJzIwJyxcbiAgICAgIH0sXG4gICAgICBzZWNyZXRzOiB7XG4gICAgICAgIENPTkZJR19vbWVyb19kYl9wYXNzOiBFY3NTZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKG9tZXJvU2VjcmV0cywgJ1BPU1RHUkVTX1BBU1NXT1JEJyksXG4gICAgICAgIFJPT1RQQVNTOiBFY3NTZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKG9tZXJvU2VjcmV0cywgJ09NRVJPX1JPT1RfUEFTU1dPUkQnKSxcbiAgICAgIH0sXG4gICAgICBzdG9wVGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgIH0pO1xuICAgIHNlcnZlckNvbnRhaW5lci5hZGRQb3J0TWFwcGluZ3MoeyBjb250YWluZXJQb3J0OiA0MDY0LCBwcm90b2NvbDogUHJvdG9jb2wuVENQLCBuYW1lOiAnb21lcm8tc2VydmVyJyB9KTtcblxuICAgIG5ldyBGYXJnYXRlU2VydmljZSh0aGlzLCAnU2VydmVyU2VydmljZScsIHtcbiAgICAgIGNsdXN0ZXIsXG4gICAgICBzZXJ2aWNlTmFtZTogYGVjcy1zdmMtb21lcm8tc2VydmVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIHRhc2tEZWZpbml0aW9uOiBzZXJ2ZXJUYXNrRGVmLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtlY3NTZ10sXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSxcbiAgICAgIGNpcmN1aXRCcmVha2VyOiB7IHJvbGxiYWNrOiB0cnVlIH0sXG4gICAgICBlbmFibGVFeGVjdXRlQ29tbWFuZDogdHJ1ZSxcbiAgICAgIGNsb3VkTWFwT3B0aW9uczoge1xuICAgICAgICBuYW1lOiAnc2VydmVyJyxcbiAgICAgICAgY2xvdWRNYXBOYW1lc3BhY2U6IG5hbWVzcGFjZSxcbiAgICAgICAgZG5zUmVjb3JkVHlwZTogc2VydmljZWRpc2NvdmVyeS5EbnNSZWNvcmRUeXBlLkEsXG4gICAgICAgIGRuc1R0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgCBPTUVSTyBXRUIgdGFzayDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCB3ZWJUYXNrRGVmID0gbmV3IEZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnV2ViVGFza0RlZicsIHtcbiAgICAgIHRhc2tSb2xlLFxuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICAgIGZhbWlseTogYGVjcy10ZC1vbWVyby13ZWItJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgIH0pO1xuICAgIHdlYlRhc2tEZWYuYWRkVG9FeGVjdXRpb25Sb2xlUG9saWN5KGV4ZWN1dGlvblJvbGVQb2xpY3kpO1xuXG4gICAgY29uc3Qgd2ViQ29udGFpbmVyID0gd2ViVGFza0RlZi5hZGRDb250YWluZXIoJ29tZXJvd2ViJywge1xuICAgICAgaW1hZ2U6IENvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHByb3BzLm9tZXJvV2ViUmVwbywgJ2xhdGVzdCcpLFxuICAgICAgbG9nZ2luZyxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE9NRVJPSE9TVDogYHNlcnZlci5vbWVyby0ke3Byb3BzLmVudmlyb25tZW50fS5sb2NhbGAsXG4gICAgICAgIENPTkZJR19vbWVyb193ZWJfYXBwc19hcHBlbmQ6ICdvbWVyb19pdmlld2VyJyxcbiAgICAgICAgQ09ORklHX29tZXJvX3dlYl9vcGVuX3dpdGg6ICdbe1wibmFtZVwiOiBcImlWaWV3ZXJcIiwgXCJzdXBwb3J0ZWRfb2JqZWN0c1wiOiBbXCJpbWFnZVwiXSwgXCJ1cmxcIjogXCJpdmlld2VyX2luZGV4XCJ9XScsXG4gICAgICAgIENPTkZJR19vbWVyb193ZWJfd3NnaV9fdGltZW91dDogJzYwMCcsXG4gICAgICAgIENPTkZJR19vbWVyb193ZWJfc2Vzc2lvbl9fZW5naW5lOiAnZGphbmdvLmNvbnRyaWIuc2Vzc2lvbnMuYmFja2VuZHMuY2FjaGUnLFxuICAgICAgICBDT05GSUdfb21lcm9fd2ViX2NzcmZfX3RydXN0ZWRfX29yaWdpbnM6ICdbXCJodHRwczovL29tZXJvLnRlbGVpbmZvcm1lLWRldi5taW5zYWwuY2xcIiwgXCJodHRwczovLyoubWluc2FsLmNsXCJdJyxcbiAgICAgICAgQ09ORklHX29tZXJvX3dlYl9hbGxvd2VkX19ob3N0czogJ1tcIipcIl0nLFxuICAgICAgfSxcbiAgICAgIHN0b3BUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgfSk7XG4gICAgd2ViQ29udGFpbmVyLmFkZFBvcnRNYXBwaW5ncyh7IGNvbnRhaW5lclBvcnQ6IDQwODAsIHByb3RvY29sOiBQcm90b2NvbC5UQ1AsIG5hbWU6ICdvbWVyby13ZWInIH0pO1xuXG4gICAgbmV3IEZhcmdhdGVTZXJ2aWNlKHRoaXMsICdXZWJTZXJ2aWNlJywge1xuICAgICAgY2x1c3RlcixcbiAgICAgIHNlcnZpY2VOYW1lOiBgZWNzLXN2Yy1vbWVyby13ZWItJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgdGFza0RlZmluaXRpb246IHdlYlRhc2tEZWYsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBzZWN1cml0eUdyb3VwczogW2Vjc1NnXSxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgICAgY2lyY3VpdEJyZWFrZXI6IHsgcm9sbGJhY2s6IHRydWUgfSxcbiAgICAgIGVuYWJsZUV4ZWN1dGVDb21tYW5kOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSAIExhbWJkYSBhdXRvLXJlZ2lzdHJvIGNyb3NzLVZQQyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICBjb25zdCBhdXRvUmVnaXN0ZXJMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdBdXRvUmVnaXN0ZXJUYXJnZXRzJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTMsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBmdW5jdGlvbk5hbWU6IGBsYW1iZGEtb21lcm8tcmVnaXN0ZXItdGFyZ2V0cy0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBib3RvMywgbG9nZ2luZ1xubG9nZ2VyID0gbG9nZ2luZy5nZXRMb2dnZXIoKVxubG9nZ2VyLnNldExldmVsKGxvZ2dpbmcuSU5GTylcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIHRyeTpcbiAgICAgICAgZWxidjIgPSBib3RvMy5jbGllbnQoJ2VsYnYyJylcbiAgICAgICAgZGV0YWlsID0gZXZlbnRbJ2RldGFpbCddXG4gICAgICAgIGxhc3Rfc3RhdHVzID0gZGV0YWlsWydsYXN0U3RhdHVzJ11cbiAgICAgICAgaWYgJ29tZXJvLXdlYicgbm90IGluIGRldGFpbC5nZXQoJ2dyb3VwJywgJycpOlxuICAgICAgICAgICAgcmV0dXJuIHsnc3RhdHVzQ29kZSc6IDIwMH1cbiAgICAgICAgZm9yIGF0dGFjaG1lbnQgaW4gZGV0YWlsLmdldCgnYXR0YWNobWVudHMnLCBbXSk6XG4gICAgICAgICAgICBpZiBhdHRhY2htZW50LmdldCgndHlwZScpID09ICdlbmknOlxuICAgICAgICAgICAgICAgIGZvciBkIGluIGF0dGFjaG1lbnQuZ2V0KCdkZXRhaWxzJywgW10pOlxuICAgICAgICAgICAgICAgICAgICBpZiBkLmdldCgnbmFtZScpID09ICdwcml2YXRlSVB2NEFkZHJlc3MnOlxuICAgICAgICAgICAgICAgICAgICAgICAgaXAgPSBkWyd2YWx1ZSddXG4gICAgICAgICAgICAgICAgICAgICAgICBheiA9IGRldGFpbC5nZXQoJ2F2YWlsYWJpbGl0eVpvbmUnLCAnJylcbiAgICAgICAgICAgICAgICAgICAgICAgIHRnX2FybiA9ICcke3RhcmdldEdyb3VwLnRhcmdldEdyb3VwQXJufSdcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIGxhc3Rfc3RhdHVzID09ICdSVU5OSU5HJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbGJ2Mi5yZWdpc3Rlcl90YXJnZXRzKFRhcmdldEdyb3VwQXJuPXRnX2FybiwgVGFyZ2V0cz1beydJZCc6IGlwLCAnUG9ydCc6IDQwODAsICdBdmFpbGFiaWxpdHlab25lJzogYXp9XSlcbiAgICAgICAgICAgICAgICAgICAgICAgIGVsaWYgbGFzdF9zdGF0dXMgPT0gJ1NUT1BQRUQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVsYnYyLmRlcmVnaXN0ZXJfdGFyZ2V0cyhUYXJnZXRHcm91cEFybj10Z19hcm4sIFRhcmdldHM9W3snSWQnOiBpcCwgJ1BvcnQnOiA0MDgwLCAnQXZhaWxhYmlsaXR5Wm9uZSc6IGF6fV0pXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geydzdGF0dXNDb2RlJzogMjAwfVxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgbG9nZ2VyLmVycm9yKHN0cihlKSlcbiAgICAgICAgcmV0dXJuIHsnc3RhdHVzQ29kZSc6IDUwMH1cbmApLFxuICAgIH0pO1xuXG4gICAgYXV0b1JlZ2lzdGVyTGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydlbGFzdGljbG9hZGJhbGFuY2luZzpSZWdpc3RlclRhcmdldHMnLCAnZWxhc3RpY2xvYWRiYWxhbmNpbmc6RGVyZWdpc3RlclRhcmdldHMnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgbmV3IGV2ZW50cy5SdWxlKHRoaXMsICdFY3NUYXNrU3RhdGVSdWxlJywge1xuICAgICAgcnVsZU5hbWU6IGBydWxlLW9tZXJvLWVjcy1zdGF0ZS0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBldmVudFBhdHRlcm46IHtcbiAgICAgICAgc291cmNlOiBbJ2F3cy5lY3MnXSxcbiAgICAgICAgZGV0YWlsVHlwZTogWydFQ1MgVGFzayBTdGF0ZSBDaGFuZ2UnXSxcbiAgICAgICAgZGV0YWlsOiB7XG4gICAgICAgICAgY2x1c3RlckFybjogW2NsdXN0ZXIuY2x1c3RlckFybl0sXG4gICAgICAgICAgbGFzdFN0YXR1czogWydSVU5OSU5HJywgJ1NUT1BQRUQnXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB0YXJnZXRzOiBbbmV3IHRhcmdldHMuTGFtYmRhRnVuY3Rpb24oYXV0b1JlZ2lzdGVyTGFtYmRhKV0sXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIAgUm91dGU1MyAob3BjaW9uYWwpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIGlmIChwcm9wcy5kb21haW5OYW1lICYmIHByb3BzLmhvc3RlZFpvbmVJZCAmJiBwcm9wcy5ob3N0ZWRab25lTmFtZSkge1xuICAgICAgY29uc3QgaG9zdGVkWm9uZSA9IHJvdXRlNTMuSG9zdGVkWm9uZS5mcm9tSG9zdGVkWm9uZUF0dHJpYnV0ZXModGhpcywgJ0hvc3RlZFpvbmUnLCB7XG4gICAgICAgIGhvc3RlZFpvbmVJZDogcHJvcHMuaG9zdGVkWm9uZUlkLFxuICAgICAgICB6b25lTmFtZTogcHJvcHMuaG9zdGVkWm9uZU5hbWUsXG4gICAgICB9KTtcbiAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgJ0FsYkFsaWFzUmVjb3JkJywge1xuICAgICAgICB6b25lOiBob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW5OYW1lLFxuICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M1RhcmdldHMuTG9hZEJhbGFuY2VyVGFyZ2V0KHRoaXMuYWxiKSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxiRG5zTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFsYi5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZXhwb3J0TmFtZTogYG9tZXJvLSR7cHJvcHMuZW52aXJvbm1lbnR9LWFsYi1kbnNgLFxuICAgIH0pO1xuICB9XG59XG4iXX0=