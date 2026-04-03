import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { applyTags } from '../utils/env-utils';

export interface ApiStackProps extends cdk.StackProps {
  environment: string;
  omeroImagesBucket: s3.Bucket;
}

export class ApiStack extends cdk.Stack {
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    applyTags(this, props.environment);

    const presignLambda = new lambda.Function(this, 'PresignLambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      functionName: `lambda-omero-presign-${props.environment}`,
      logGroup: new cdk.aws_logs.LogGroup(this, 'PresignLambdaLogGroup', {
        logGroupName: `/aws/lambda/lambda-omero-presign-${props.environment}`,
        retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        BUCKET_NAME: props.omeroImagesBucket.bucketName,
      },
      code: lambda.Code.fromInline(`
import boto3, json, os, urllib.parse

def handler(event, context):
    filename = event.get('queryStringParameters', {}).get('filename', 'upload.ndpi')
    filename = urllib.parse.quote(filename, safe='')
    s3 = boto3.client('s3')
    url = s3.generate_presigned_url(
        'put_object',
        Params={
            'Bucket': os.environ['BUCKET_NAME'],
            'Key': f'import/{filename}',
            'ContentType': 'application/octet-stream',
        },
        ExpiresIn=3600,
    )
    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
        },
        'body': json.dumps({'url': url, 'key': f'import/{filename}'}),
    }
`),
    });

    presignLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject'],
      resources: [`${props.omeroImagesBucket.bucketArn}/import/*`],
    }));

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `api-omero-uploader-${props.environment}`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'OPTIONS'],
      },
    });

    api.root.addResource('presign').addMethod(
      'GET',
      new apigateway.LambdaIntegration(presignLambda),
    );

    this.apiUrl = api.url;

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}
