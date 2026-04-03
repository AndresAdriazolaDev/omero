import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { applyTags } from '../utils/env-utils';

interface EcrStackProps extends cdk.StackProps {
  environment: string;
}

export class EcrStack extends cdk.Stack {
  readonly omeroServerRepo: ecr.Repository;
  readonly omeroWebRepo: ecr.Repository;
  readonly omeroPostgresRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);
    applyTags(this, props.environment);

    this.omeroServerRepo = this.makeRepo('OmeroServerRepo', `ecr-omero-server-${props.environment}`);
    this.omeroWebRepo = this.makeRepo('OmeroWebRepo', `ecr-omero-web-${props.environment}`);
    this.omeroPostgresRepo = this.makeRepo('OmeroPostgresRepo', `ecr-omero-postgres-${props.environment}`);
  }

  private makeRepo(id: string, name: string): ecr.Repository {
    const repo = new ecr.Repository(this, id, {
      repositoryName: name,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
    });
    repo.addLifecycleRule({ maxImageCount: 5, description: 'Keep last 5 images' });
    return repo;
  }
}
