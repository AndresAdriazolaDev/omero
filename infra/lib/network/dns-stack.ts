import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { applyTags } from '../utils/env-utils';

interface DnsStackProps extends cdk.StackProps {
  environment: string;
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

export class DnsStack extends cdk.Stack {
  readonly certificate: acm.Certificate;
  readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    applyTags(this, props.environment);

    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      exportName: `omero-${props.environment}-certificate-arn`,
    });
  }
}
