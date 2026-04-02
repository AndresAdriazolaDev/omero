import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

interface VpcStackProps extends StackProps {
  environment: string;
}

export class VpcStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `vpc-omero-${props.environment}`,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1, // mínimo para reducir costos (~$32 USD/mes)
      subnetConfiguration: [
        {
          name: `omero-${props.environment}-public`,
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: `omero-${props.environment}-private`,
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: `omero-${props.environment}-isolated`,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `omero-${props.environment}-vpc-id`,
    });
  }
}
