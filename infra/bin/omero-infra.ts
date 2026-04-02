#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getEnv } from '../lib/utils/env-utils';
import { VpcStack } from '../lib/network/vpc-stack';
import { DnsStack } from '../lib/network/dns-stack';
import { S3Stack } from '../lib/storage/s3-stack';
import { EcrStack } from '../lib/ecr/ecr-stack';
import { FargateStack } from '../lib/compute/fargate-stack';

const environment = 'dev' as string;

const domainConfig = {
  domainName: 'omero.teleinforme-dev.minsal.cl',
  hostedZoneId: 'Z04904051AN4003Q9UY41',
  hostedZoneName: 'teleinforme-dev.minsal.cl',
};

const app = new cdk.App();
const env = getEnv(environment);

const vpcStack = new VpcStack(app, `vpc-omero-${environment}`, {
  env,
  environment,
});

const dnsStack = new DnsStack(app, `dns-omero-${environment}`, {
  env,
  environment,
  ...domainConfig,
});

const s3Stack = new S3Stack(app, `s3-omero-${environment}`, {
  env,
  environment,
});

const ecrStack = new EcrStack(app, `ecr-omero-${environment}`, {
  env,
  environment,
});

const fargateStack = new FargateStack(app, `fargate-omero-${environment}`, {
  env,
  environment,
  vpc: vpcStack.vpc,
  omeroServerRepo: ecrStack.omeroServerRepo,
  omeroWebRepo: ecrStack.omeroWebRepo,
  omeroPostgresRepo: ecrStack.omeroPostgresRepo,
  omeroImagesBucket: s3Stack.omeroImagesBucket,
  certificate: dnsStack.certificate,
  ...domainConfig,
});
