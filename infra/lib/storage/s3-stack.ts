import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

interface S3StackProps extends StackProps {
  environment: string;
}

export class S3Stack extends cdk.Stack {
  readonly omeroImagesBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);

    // Bucket principal para imágenes .ndpi (hasta 5GB por archivo)
    this.omeroImagesBucket = new s3.Bucket(this, 'OmeroImagesBucket', {
      bucketName: `s3-omero-${props.environment}-images`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // imágenes críticas, no eliminar
      versioned: false,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(90),
            },
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

    new cdk.CfnOutput(this, 'OmeroImagesBucketName', {
      value: this.omeroImagesBucket.bucketName,
      exportName: `s3-omero-${props.environment}-images-bucket`,
    });
  }
}
