import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
interface VpcStackProps extends StackProps {
    environment: string;
}
export declare class VpcStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    constructor(scope: Construct, id: string, props: VpcStackProps);
}
export {};
