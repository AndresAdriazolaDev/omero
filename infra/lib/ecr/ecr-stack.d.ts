import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
interface EcrStackProps extends StackProps {
    environment: string;
}
export declare class EcrStack extends cdk.Stack {
    readonly omeroServerRepo: Repository;
    readonly omeroWebRepo: Repository;
    readonly omeroPostgresRepo: Repository;
    constructor(scope: Construct, id: string, props: EcrStackProps);
}
export {};
