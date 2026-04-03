import * as cdk from 'aws-cdk-lib';

export type Environment = 'ada' | 'dev' | 'prod';
export type DeployMode = 'fargate' | 'ec2';

interface EnvConfig {
  account: string | undefined;
  region: string;
}

const REGION_MAP: Record<Environment, string> = {
  ada: 'us-east-1',
  dev: 'us-east-1',
  prod: 'us-east-1',
};

export function getEnv(environment: string): EnvConfig {
  const region = REGION_MAP[environment as Environment] ?? 'us-east-1';
  return {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  };
}

export interface DomainConfig {
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

export const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
  ada: {
    domainName: 'omero.adatech.cl',
    hostedZoneId: 'Z08821841LM73LXF3VWXS',
    hostedZoneName: 'adatech.cl',
  },
};

export function applyTags(scope: cdk.Stack, environment: string, project = 'omero'): void {
  cdk.Tags.of(scope).add('Project', project);
  cdk.Tags.of(scope).add('Environment', environment);
  cdk.Tags.of(scope).add('ManagedBy', 'CDK');
}
