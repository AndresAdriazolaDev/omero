import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

interface S3StackProps extends StackProps {
  environment: string;
}

export class S3Stack extends cdk.Stack {
  readonly omeroImagesBucket: s3.Bucket;
  readonly importQueue: sqs.Queue;
  readonly importDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);

    this.omeroImagesBucket = new s3.Bucket(this, 'OmeroImagesBucket', {
      bucketName: `s3-omero-${props.environment}-images`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: false,
      lifecycleRules: [
        {
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(90) },
          ],
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    this.importDlq = new sqs.Queue(this, 'ImportDlq', {
      queueName: `sqs-omero-import-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.importQueue = new sqs.Queue(this, 'ImportQueue', {
      queueName: `sqs-omero-import-${props.environment}`,
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: { queue: this.importDlq, maxReceiveCount: 3 },
    });

    this.omeroImagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.importQueue),
      { prefix: 'import/' },
    );

    new cdk.CfnOutput(this, 'OmeroImagesBucketName', {
      value: this.omeroImagesBucket.bucketName,
      exportName: `s3-omero-${props.environment}-images-bucket`,
    });
  }
}
