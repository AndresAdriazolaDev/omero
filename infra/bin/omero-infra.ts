#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getEnv } from '../lib/utils/env-utils';
import { VpcStack } from '../lib/network/vpc-stack';
import { DnsStack } from '../lib/network/dns-stack';
import { S3Stack } from '../lib/storage/s3-stack';
import { EcrStack } from '../lib/ecr/ecr-stack';
import { FargateStack } from '../lib/compute/fargate-stack';
import { Ec2Stack } from '../lib/compute/ec2-stack';
import { UploaderStack } from '../lib/uploader/uploader-stack';

const app = new cdk.App();
const environment = (app.node.tryGetContext('environment') as string) ?? 'ada';
const mode = (app.node.tryGetContext('mode') as string) ?? 'fargate'; // 'fargate' | 'ec2'
const env = getEnv(environment);

const domainConfigs: Record<string, { domainName: string; hostedZoneId: string; hostedZoneName: string }> = {
  ada: {
    domainName: 'omero.adatech.cl',
    hostedZoneId: 'Z08821841LM73LXF3VWXS',
    hostedZoneName: 'adatech.cl',
  },
};

const domainConfig = domainConfigs[environment];

const vpcStack = new VpcStack(app, `vpc-omero-${environment}`, { env, environment });
const dnsStack = new DnsStack(app, `dns-omero-${environment}`, { env, environment, ...domainConfig });
const s3Stack = new S3Stack(app, `s3-omero-${environment}`, { env, environment });

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

new UploaderStack(app, `uploader-omero-${environment}`, {
  env,
  environment,
  omeroImagesBucket: s3Stack.omeroImagesBucket,
  hostedZoneId: 'Z08821841LM73LXF3VWXS',
  hostedZoneName: 'adatech.cl',
  uploaderDomain: 'uploader.adatech.cl',
});
