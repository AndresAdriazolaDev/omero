import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { applyTags } from '../utils/env-utils';

export interface UploaderStackProps extends cdk.StackProps {
  environment: string;
  omeroImagesBucket: s3.Bucket;
  hostedZoneId: string;
  hostedZoneName: string;
  uploaderDomain: string;
}

export class UploaderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UploaderStackProps) {
    super(scope, id, props);
    applyTags(this, props.environment);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.uploaderDomain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `s3-omero-${props.environment}-uploader`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

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

    const api = new apigateway.RestApi(this, 'UploaderApi', {
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

    new s3deploy.BucketDeployment(this, 'WebsiteDeploy', {
      sources: [s3deploy.Source.data('index.html', `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subir Placa Virtual</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; }
    h1 { color: #232f3e; }
    .upload-box { border: 2px dashed #aaa; border-radius: 8px; padding: 40px; text-align: center; }
    input[type=file] { margin: 20px 0; }
    button { background: #232f3e; color: white; border: none; padding: 12px 30px; border-radius: 4px; cursor: pointer; font-size: 16px; }
    button:disabled { background: #aaa; cursor: not-allowed; }
    #status { margin-top: 20px; font-weight: bold; }
    .progress { width: 100%; background: #eee; border-radius: 4px; margin-top: 10px; display: none; }
    .progress-bar { height: 20px; background: #232f3e; border-radius: 4px; width: 0%; transition: width 0.3s; }
  </style>
</head>
<body>
  <h1>Subir Placa Virtual</h1>
  <p>Selecciona un archivo <strong>.ndpi</strong> para subirlo al repositorio.</p>
  <div class="upload-box">
    <input type="file" id="fileInput" accept=".ndpi" />
    <br>
    <button id="uploadBtn" onclick="upload()" disabled>Subir</button>
    <div class="progress" id="progressBox">
      <div class="progress-bar" id="progressBar"></div>
    </div>
    <div id="status"></div>
  </div>
  <script>
    const API_URL = '${api.url}presign';
    document.getElementById('fileInput').addEventListener('change', e => {
      document.getElementById('uploadBtn').disabled = !e.target.files.length;
    });
    async function upload() {
      const file = document.getElementById('fileInput').files[0];
      const btn = document.getElementById('uploadBtn');
      const status = document.getElementById('status');
      const progressBox = document.getElementById('progressBox');
      const progressBar = document.getElementById('progressBar');
      btn.disabled = true;
      status.textContent = 'Obteniendo URL de subida...';
      try {
        const res = await fetch(API_URL + '?filename=' + encodeURIComponent(file.name));
        const { url } = await res.json();
        status.textContent = 'Subiendo archivo...';
        progressBox.style.display = 'block';
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
              progressBar.style.width = (e.loaded / e.total * 100) + '%';
            }
          };
          xhr.onload = () => xhr.status === 200 ? resolve() : reject(xhr.statusText);
          xhr.onerror = () => reject('Error de red');
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.send(file);
        });
        status.textContent = '✓ Archivo subido correctamente. Será procesado en breve.';
        status.style.color = 'green';
      } catch (e) {
        status.textContent = '✗ Error: ' + e;
        status.style.color = 'red';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`)],
      destinationBucket: websiteBucket,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [props.uploaderDomain],
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      defaultRootObject: 'index.html',
    });

    new route53.ARecord(this, 'UploaderDns', {
      zone: hostedZone,
      recordName: props.uploaderDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    new cdk.CfnOutput(this, 'UploaderUrl', {
      value: `https://${props.uploaderDomain}`,
    });
  }
}
