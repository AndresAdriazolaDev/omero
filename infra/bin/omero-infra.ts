#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getEnv, DOMAIN_CONFIGS, DeployMode, DomainConfig } from '../lib/utils/env-utils';
import { VpcStack } from '../lib/network/vpc-stack';
import { DnsStack } from '../lib/network/dns-stack';
import { S3Stack } from '../lib/storage/s3-stack';
import { EcrStack } from '../lib/ecr/ecr-stack';
import { FargateStack } from '../lib/compute/fargate-stack';
import { Ec2Stack } from '../lib/compute/ec2-stack';
import { FrontendStack } from '../lib/frontend/frontend-stack';
import { ApiStack } from '../lib/api/api-stack';

const app = new cdk.App();
const environment = (app.node.tryGetContext('environment') as string) ?? 'ada';
const mode = (app.node.tryGetContext('mode') as DeployMode) ?? 'fargate';
const env = getEnv(environment);

const domainConfig: DomainConfig | undefined = DOMAIN_CONFIGS[environment];

const vpcStack = new VpcStack(app, `vpc-omero-${environment}`, { env, environment });
const dnsStack = new DnsStack(app, `dns-omero-${environment}`, {
  env,
  environment,
  ...(domainConfig ?? { domainName: '', hostedZoneId: '', hostedZoneName: '' }),
});
const s3Stack = new S3Stack(app, `s3-omero-${environment}`, { env, environment });

const apiStack = new ApiStack(app, `api-omero-${environment}`, {
  env,
  environment,
  omeroImagesBucket: s3Stack.omeroImagesBucket,
});

if (domainConfig) {
  new FrontendStack(app, `frontend-omero-${environment}`, {
    env,
    environment,
    hostedZoneId: domainConfig.hostedZoneId,
    hostedZoneName: domainConfig.hostedZoneName,
    uploaderDomain: `uploader.${domainConfig.hostedZoneName}`,
    apiUrl: apiStack.apiUrl,
  });
}

if (mode === 'fargate') {
  const ecrStack = new EcrStack(app, `ecr-omero-${environment}`, { env, environment });

  new FargateStack(app, `fargate-omero-${environment}`, {
    env,
    environment,
    vpc: vpcStack.vpc,
    omeroServerRepo: ecrStack.omeroServerRepo,
    omeroWebRepo: ecrStack.omeroWebRepo,
    omeroPostgresRepo: ecrStack.omeroPostgresRepo,
    omeroImagesBucket: s3Stack.omeroImagesBucket,
    importQueue: s3Stack.importQueue,
    certificate: dnsStack.certificate,
    ...domainConfig,
  });
} else {
  new Ec2Stack(app, `ec2-omero-${environment}`, {
    env,
    environment,
    vpc: vpcStack.vpc,
    omeroImagesBucket: s3Stack.omeroImagesBucket,
    importQueue: s3Stack.importQueue,
    certificate: dnsStack.certificate,
    ...domainConfig,
  });
}
