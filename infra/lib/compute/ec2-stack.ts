import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbTargets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { Construct } from 'constructs';
import { applyTags } from '../utils/env-utils';

export interface Ec2StackProps extends cdk.StackProps {
  environment: string;
  vpc: ec2.Vpc;
  omeroImagesBucket: s3.Bucket;
  importQueue: sqs.Queue;
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificate?: acm.ICertificate;
}

export class Ec2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Ec2StackProps) {
    super(scope, id, props);
    applyTags(this, props.environment);

    // ── IAM ─────────────────────────────────────────────────────────────────
    const role = new iam.Role(this, 'Ec2Role', {
      roleName: `ecs-task-role-omero-${props.environment}`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [props.omeroImagesBucket.bucketArn, `${props.omeroImagesBucket.bucketArn}/*`],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:omero-${props.environment}-secrets*`,
      ],
    }));

    // ── Security Groups ─────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      securityGroupName: `omero-${props.environment}-alb-sg`,
      description: 'OMERO EC2 ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect');

    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc: props.vpc,
      securityGroupName: `omero-${props.environment}-ec2-sg`,
      description: 'OMERO EC2',
      allowAllOutbound: true,
    });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(4080), 'ALB to web');

    // ── UserData ─────────────────────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();
    const secretId = `omero-${props.environment}-secrets`;
    const bucketName = props.omeroImagesBucket.bucketName;
    const domain = props.domainName ?? '*';

    userData.addCommands(
      // Install dependencies
      'dnf install -y docker',
      'systemctl enable --now docker',
      'curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" -o /usr/local/bin/docker-compose',
      'chmod +x /usr/local/bin/docker-compose',
      'mkdir -p /opt/omero',

      // Fetch secrets with retry
      `for i in $(seq 1 5); do`,
      `  SECRETS=$(aws secretsmanager get-secret-value --secret-id ${secretId} --region ${this.region} --query SecretString --output text 2>/dev/null) && break`,
      `  sleep $((i * 5))`,
      `done`,
      `[ -z "$SECRETS" ] && { echo "ERROR: could not fetch secrets"; exit 1; }`,
      `POSTGRES_PASSWORD=$(echo "$SECRETS" | python3 -c "import sys,json; print(json.load(sys.stdin)['POSTGRES_PASSWORD'])")`,
      `OMERO_ROOT_PASSWORD=$(echo "$SECRETS" | python3 -c "import sys,json; print(json.load(sys.stdin)['OMERO_ROOT_PASSWORD'])")`,

      // Write docker-compose
      `cat > /opt/omero/docker-compose.yml << 'COMPOSE'`,
      `version: "3"`,
      `services:`,
      `  database:`,
      `    image: postgres:14`,
      `    environment:`,
      `      POSTGRES_USER: omero`,
      `      POSTGRES_DB: omero`,
      `      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}`,
      `    volumes:`,
      `      - db:/var/lib/postgresql/data`,
      `    healthcheck:`,
      `      test: ["CMD-SHELL", "pg_isready -U omero"]`,
      `      interval: 10s`,
      `      retries: 5`,
      ``,
      `  omeroserver:`,
      `    image: openmicroscopy/omero-server:5.6.17`,
      `    environment:`,
      `      CONFIG_omero_db_host: database`,
      `      CONFIG_omero_db_user: omero`,
      `      CONFIG_omero_db_pass: \${POSTGRES_PASSWORD}`,
      `      CONFIG_omero_db_name: omero`,
      `      CONFIG_omero_managed_repository: s3://${bucketName}/managed`,
      `      CONFIG_omero_s3_bucket: ${bucketName}`,
      `      CONFIG_omero_s3_region: ${this.region}`,
      `      CONFIG_omero_jvmcfg_percent_blitz: "50"`,
      `      CONFIG_omero_jvmcfg_percent_pixeldata: "20"`,
      `      ROOTPASS: \${OMERO_ROOT_PASSWORD}`,
      `    ports:`,
      `      - "4064:4064"`,
      `    volumes:`,
      `      - omero:/OMERO`,
      `    depends_on:`,
      `      database:`,
      `        condition: service_healthy`,
      ``,
      `  omeroweb:`,
      `    image: openmicroscopy/omero-web-standalone:5.31.0`,
      `    environment:`,
      `      OMEROHOST: omeroserver`,
      `      CONFIG_omero_web_apps_append: omero_iviewer`,
      `      CONFIG_omero_web_open_with: '[{"name": "iViewer", "supported_objects": ["image"], "url": "iviewer_index"}]'`,
      `      CONFIG_omero_web_allowed__hosts: '["*"]'`,
      `      CONFIG_omero_web_use__x__forwarded__host: "true"`,
      `      CONFIG_omero_web_secure__proxy__ssl__header: '["HTTP_X_FORWARDED_PROTO", "https"]'`,
      `      CONFIG_omero_web_csrf__trusted__origins: '["https://${domain}"]'`,
      `      CONFIG_omero_web_csrf__cookie__secure: "false"`,
      `      CONFIG_omero_web_session__cookie__secure: "false"`,
      `      CONFIG_omero_web_session__engine: django.contrib.sessions.backends.file`,
      `      CONFIG_omero_web_wsgi__timeout: "600"`,
      `    ports:`,
      `      - "4080:4080"`,
      `    depends_on:`,
      `      - omeroserver`,
      ``,
      `volumes:`,
      `  db:`,
      `  omero:`,
      `COMPOSE`,

      // Start services in order
      'cd /opt/omero',
      'POSTGRES_PASSWORD="$POSTGRES_PASSWORD" OMERO_ROOT_PASSWORD="$OMERO_ROOT_PASSWORD" docker-compose up -d database',
      'sleep 20',
      'POSTGRES_PASSWORD="$POSTGRES_PASSWORD" OMERO_ROOT_PASSWORD="$OMERO_ROOT_PASSWORD" docker-compose up -d omeroserver',
      'sleep 60',
      'POSTGRES_PASSWORD="$POSTGRES_PASSWORD" OMERO_ROOT_PASSWORD="$OMERO_ROOT_PASSWORD" docker-compose up -d omeroweb',

      // Systemd service for auto-start on reboot
      `cat > /etc/systemd/system/omero.service << 'SERVICE'`,
      `[Unit]`,
      `Description=OMERO Docker Compose`,
      `Requires=docker.service`,
      `After=docker.service network-online.target`,
      ``,
      `[Service]`,
      `Type=oneshot`,
      `RemainAfterExit=yes`,
      `WorkingDirectory=/opt/omero`,
      `EnvironmentFile=/opt/omero/.env`,
      `ExecStart=/usr/local/bin/docker-compose up -d`,
      `ExecStop=/usr/local/bin/docker-compose down`,
      `TimeoutStartSec=300`,
      ``,
      `[Install]`,
      `WantedBy=multi-user.target`,
      `SERVICE`,

      // Persist env vars for systemd (no secrets in plain text beyond this point)
      `echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" > /opt/omero/.env`,
      `echo "OMERO_ROOT_PASSWORD=$OMERO_ROOT_PASSWORD" >> /opt/omero/.env`,
      `chmod 600 /opt/omero/.env`,

      'systemctl daemon-reload',
      'systemctl enable omero',
    );

    // ── EC2 Instance ─────────────────────────────────────────────────────────
    const instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2Sg,
      role,
      userData,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceName: `ec2-omero-${props.environment}`,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(30) }],
    });

    // ── ALB ─────────────────────────────────────────────────────────────────
    const alb = new elb.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      loadBalancerName: `alb-omero-${props.environment}`,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const targetGroup = new elb.ApplicationTargetGroup(this, 'TgWeb', {
      vpc: props.vpc,
      port: 4080,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.INSTANCE,
      targetGroupName: `tg-omero-web-${props.environment}`,
      targets: [new elbTargets.InstanceTarget(instance, 4080)],
      healthCheck: {
        path: '/static/omeroweb/css/ome.body.css',
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: '200,301,302,400',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    if (props.certificate) {
      alb.addListener('HttpsListener', {
        port: 443,
        protocol: elb.ApplicationProtocol.HTTPS,
        certificates: [props.certificate],
        defaultAction: elb.ListenerAction.forward([targetGroup]),
      });
      alb.addListener('HttpListener', {
        port: 80,
        protocol: elb.ApplicationProtocol.HTTP,
        defaultAction: elb.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      alb.addListener('HttpListener', {
        port: 80,
        protocol: elb.ApplicationProtocol.HTTP,
        defaultAction: elb.ListenerAction.forward([targetGroup]),
      });
    }

    // ── DNS ──────────────────────────────────────────────────────────────────
    if (props.domainName && props.hostedZoneId && props.hostedZoneName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });
      new route53.ARecord(this, 'AlbDns', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
      });
    }

    // ── Import Lambda ────────────────────────────────────────────────────────
    const importLambda = new lambda.Function(this, 'ImportLambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'import_handler.handler',
      timeout: cdk.Duration.minutes(1),
      functionName: `lambda-omero-import-${props.environment}`,
      reservedConcurrentExecutions: 1,
      logGroup: new cdk.aws_logs.LogGroup(this, 'ImportLambdaLogGroup', {
        logGroupName: `/aws/lambda/lambda-omero-import-${props.environment}`,
        retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        INSTANCE_ID: instance.instanceId,
        BUCKET: props.omeroImagesBucket.bucketName,
        REGION: this.region,
        SECRET_ID: secretId,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda')),
    });

    importLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
        'arn:aws:ssm:*::document/AWS-RunShellScript',
      ],
    }));

    importLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${props.omeroImagesBucket.bucketArn}/import/*`],
    }));

    importLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:omero-${props.environment}-secrets*`,
      ],
    }));

    importLambda.addEventSource(new lambdaEvents.SqsEventSource(props.importQueue, { batchSize: 1 }));

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'PrivateIp', { value: instance.instancePrivateIp });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
  }
}
