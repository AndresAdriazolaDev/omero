"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.S3Stack = void 0;
const cdk = require("aws-cdk-lib");
const s3 = require("aws-cdk-lib/aws-s3");
class S3Stack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Bucket principal para imágenes .ndpi (hasta 5GB por archivo)
        this.omeroImagesBucket = new s3.Bucket(this, 'OmeroImagesBucket', {
            bucketName: `s3-omero-${props.environment}-images`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            publicReadAccess: false,
            removalPolicy: cdk.RemovalPolicy.RETAIN, // imágenes críticas, no eliminar
            versioned: false,
            lifecycleRules: [
                {
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(30),
                        },
                        {
                            storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
                            transitionAfter: cdk.Duration.days(90),
                        },
                    ],
                },
            ],
            cors: [
                {
                    allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
                    allowedOrigins: ['*'],
                    allowedHeaders: ['*'],
                    maxAge: 3000,
                },
            ],
        });
        new cdk.CfnOutput(this, 'OmeroImagesBucketName', {
            value: this.omeroImagesBucket.bucketName,
            exportName: `s3-omero-${props.environment}-images-bucket`,
        });
    }
}
exports.S3Stack = S3Stack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiczMtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzMy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFHbkMseUNBQXlDO0FBT3pDLE1BQWEsT0FBUSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBR3BDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBbUI7UUFDM0QsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsK0RBQStEO1FBQy9ELElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQ2hFLFVBQVUsRUFBRSxZQUFZLEtBQUssQ0FBQyxXQUFXLFNBQVM7WUFDbEQsVUFBVSxFQUFFLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxVQUFVO1lBQzFDLGlCQUFpQixFQUFFLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxTQUFTO1lBQ2pELGdCQUFnQixFQUFFLEtBQUs7WUFDdkIsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFLGlDQUFpQztZQUMxRSxTQUFTLEVBQUUsS0FBSztZQUNoQixjQUFjLEVBQUU7Z0JBQ2Q7b0JBQ0UsV0FBVyxFQUFFO3dCQUNYOzRCQUNFLFlBQVksRUFBRSxFQUFFLENBQUMsWUFBWSxDQUFDLGlCQUFpQjs0QkFDL0MsZUFBZSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQzt5QkFDdkM7d0JBQ0Q7NEJBQ0UsWUFBWSxFQUFFLEVBQUUsQ0FBQyxZQUFZLENBQUMseUJBQXlCOzRCQUN2RCxlQUFlLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO3lCQUN2QztxQkFDRjtpQkFDRjthQUNGO1lBQ0QsSUFBSSxFQUFFO2dCQUNKO29CQUNFLGNBQWMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxXQUFXLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDO29CQUM3RSxjQUFjLEVBQUUsQ0FBQyxHQUFHLENBQUM7b0JBQ3JCLGNBQWMsRUFBRSxDQUFDLEdBQUcsQ0FBQztvQkFDckIsTUFBTSxFQUFFLElBQUk7aUJBQ2I7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDL0MsS0FBSyxFQUFFLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxVQUFVO1lBQ3hDLFVBQVUsRUFBRSxZQUFZLEtBQUssQ0FBQyxXQUFXLGdCQUFnQjtTQUMxRCxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUEzQ0QsMEJBMkNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgU3RhY2tQcm9wcyB9IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5cbmludGVyZmFjZSBTM1N0YWNrUHJvcHMgZXh0ZW5kcyBTdGFja1Byb3BzIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFMzU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICByZWFkb25seSBvbWVyb0ltYWdlc0J1Y2tldDogczMuQnVja2V0O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBTM1N0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIEJ1Y2tldCBwcmluY2lwYWwgcGFyYSBpbcOhZ2VuZXMgLm5kcGkgKGhhc3RhIDVHQiBwb3IgYXJjaGl2bylcbiAgICB0aGlzLm9tZXJvSW1hZ2VzQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnT21lcm9JbWFnZXNCdWNrZXQnLCB7XG4gICAgICBidWNrZXROYW1lOiBgczMtb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0taW1hZ2VzYCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICBwdWJsaWNSZWFkQWNjZXNzOiBmYWxzZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiwgLy8gaW3DoWdlbmVzIGNyw610aWNhcywgbm8gZWxpbWluYXJcbiAgICAgIHZlcnNpb25lZDogZmFsc2UsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW1xuICAgICAgICB7XG4gICAgICAgICAgdHJhbnNpdGlvbnM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc3RvcmFnZUNsYXNzOiBzMy5TdG9yYWdlQ2xhc3MuSU5GUkVRVUVOVF9BQ0NFU1MsXG4gICAgICAgICAgICAgIHRyYW5zaXRpb25BZnRlcjogY2RrLkR1cmF0aW9uLmRheXMoMzApLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc3RvcmFnZUNsYXNzOiBzMy5TdG9yYWdlQ2xhc3MuR0xBQ0lFUl9JTlNUQU5UX1JFVFJJRVZBTCxcbiAgICAgICAgICAgICAgdHJhbnNpdGlvbkFmdGVyOiBjZGsuRHVyYXRpb24uZGF5cyg5MCksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgY29yczogW1xuICAgICAgICB7XG4gICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IFtzMy5IdHRwTWV0aG9kcy5HRVQsIHMzLkh0dHBNZXRob2RzLlBVVCwgczMuSHR0cE1ldGhvZHMuSEVBRF0sXG4gICAgICAgICAgYWxsb3dlZE9yaWdpbnM6IFsnKiddLFxuICAgICAgICAgIGFsbG93ZWRIZWFkZXJzOiBbJyonXSxcbiAgICAgICAgICBtYXhBZ2U6IDMwMDAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09tZXJvSW1hZ2VzQnVja2V0TmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm9tZXJvSW1hZ2VzQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBleHBvcnROYW1lOiBgczMtb21lcm8tJHtwcm9wcy5lbnZpcm9ubWVudH0taW1hZ2VzLWJ1Y2tldGAsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==