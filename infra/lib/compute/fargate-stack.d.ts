import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
export interface FargateStackProps extends StackProps {
    environment: string;
    vpc: ec2.Vpc;
    omeroServerRepo: Repository;
    omeroWebRepo: Repository;
    omeroPostgresRepo: Repository;
    omeroImagesBucket: s3.Bucket;
    domainName?: string;
    hostedZoneId?: string;
    hostedZoneName?: string;
    certificate?: acm.ICertificate;
}
export declare class FargateStack extends cdk.Stack {
    readonly alb: ApplicationLoadBalancer;
    constructor(scope: Construct, id: string, props: FargateStackProps);
}
