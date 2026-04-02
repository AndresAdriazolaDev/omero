import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
interface DnsStackProps extends StackProps {
    environment: string;
    domainName: string;
    hostedZoneId: string;
    hostedZoneName: string;
}
export declare class DnsStack extends cdk.Stack {
    readonly certificate: acm.Certificate;
    readonly hostedZone: route53.IHostedZone;
    constructor(scope: Construct, id: string, props: DnsStackProps);
}
export {};
