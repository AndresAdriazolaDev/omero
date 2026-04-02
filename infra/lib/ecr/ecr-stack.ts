import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';

interface EcrStackProps extends StackProps {
  environment: string;
}

export class EcrStack extends cdk.Stack {
  readonly omeroServerRepo: Repository;
  readonly omeroWebRepo: Repository;
  readonly omeroPostgresRepo: Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    this.omeroServerRepo = new Repository(this, 'OmeroServerRepo', {
      repositoryName: `ecr-omero-server-${props.environment}`,
      imageTagMutability: TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.omeroWebRepo = new Repository(this, 'OmeroWebRepo', {
      repositoryName: `ecr-omero-web-${props.environment}`,
      imageTagMutability: TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.omeroPostgresRepo = new Repository(this, 'OmeroPostgresRepo', {
      repositoryName: `ecr-omero-postgres-${props.environment}`,
      imageTagMutability: TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
