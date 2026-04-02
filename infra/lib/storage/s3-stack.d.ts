import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
interface S3StackProps extends StackProps {
    environment: string;
}
export declare class S3Stack extends cdk.Stack {
    readonly omeroImagesBucket: s3.Bucket;
    constructor(scope: Construct, id: string, props: S3StackProps);
}
export {};
