"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VpcStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
class VpcStack extends cdk.Stack {
    constructor(scope, id, props) {
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
exports.VpcStack = VpcStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidnBjLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidnBjLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUduQywyQ0FBMkM7QUFNM0MsTUFBYSxRQUFTLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFHckMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFvQjtRQUM1RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ2xDLE9BQU8sRUFBRSxhQUFhLEtBQUssQ0FBQyxXQUFXLEVBQUU7WUFDekMsV0FBVyxFQUFFLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQztZQUNoRCxNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDLEVBQUUsNENBQTRDO1lBQzVELG1CQUFtQixFQUFFO2dCQUNuQjtvQkFDRSxJQUFJLEVBQUUsU0FBUyxLQUFLLENBQUMsV0FBVyxTQUFTO29CQUN6QyxVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNO29CQUNqQyxRQUFRLEVBQUUsRUFBRTtpQkFDYjtnQkFDRDtvQkFDRSxJQUFJLEVBQUUsU0FBUyxLQUFLLENBQUMsV0FBVyxVQUFVO29CQUMxQyxVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUI7b0JBQzlDLFFBQVEsRUFBRSxFQUFFO2lCQUNiO2dCQUNEO29CQUNFLElBQUksRUFBRSxTQUFTLEtBQUssQ0FBQyxXQUFXLFdBQVc7b0JBQzNDLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLGdCQUFnQjtvQkFDM0MsUUFBUSxFQUFFLEVBQUU7aUJBQ2I7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO1lBQy9CLEtBQUssRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUs7WUFDckIsVUFBVSxFQUFFLFNBQVMsS0FBSyxDQUFDLFdBQVcsU0FBUztTQUNoRCxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFuQ0QsNEJBbUNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgU3RhY2tQcm9wcyB9IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcblxuaW50ZXJmYWNlIFZwY1N0YWNrUHJvcHMgZXh0ZW5kcyBTdGFja1Byb3BzIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFZwY1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcmVhZG9ubHkgdnBjOiBlYzIuVnBjO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBWcGNTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICB0aGlzLnZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdWcGMnLCB7XG4gICAgICB2cGNOYW1lOiBgdnBjLW9tZXJvLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGlwQWRkcmVzc2VzOiBlYzIuSXBBZGRyZXNzZXMuY2lkcignMTAuMC4wLjAvMTYnKSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLCAvLyBtw61uaW1vIHBhcmEgcmVkdWNpciBjb3N0b3MgKH4kMzIgVVNEL21lcylcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6IGBvbWVyby0ke3Byb3BzLmVudmlyb25tZW50fS1wdWJsaWNgLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiBgb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0tcHJpdmF0ZWAsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiBgb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0taXNvbGF0ZWRgLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdWcGNJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnZwYy52cGNJZCxcbiAgICAgIGV4cG9ydE5hbWU6IGBvbWVyby0ke3Byb3BzLmVudmlyb25tZW50fS12cGMtaWRgLFxuICAgIH0pO1xuICB9XG59XG4iXX0=