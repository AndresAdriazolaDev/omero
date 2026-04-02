export function getEnv(environment: string) {
  return {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: environment === 'prod' ? 'us-east-1' : 'us-east-1',
  };
}
