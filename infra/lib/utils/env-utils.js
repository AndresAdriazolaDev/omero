"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnv = void 0;
function getEnv(environment) {
    return {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: environment === 'prod' ? 'us-east-1' : 'us-east-1',
    };
}
exports.getEnv = getEnv;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW52LXV0aWxzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZW52LXV0aWxzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLFNBQWdCLE1BQU0sQ0FBQyxXQUFtQjtJQUN4QyxPQUFPO1FBQ0wsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO1FBQ3hDLE1BQU0sRUFBRSxXQUFXLEtBQUssTUFBTSxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLFdBQVc7S0FDM0QsQ0FBQztBQUNKLENBQUM7QUFMRCx3QkFLQyIsInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBnZXRFbnYoZW52aXJvbm1lbnQ6IHN0cmluZykge1xuICByZXR1cm4ge1xuICAgIGFjY291bnQ6IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQsXG4gICAgcmVnaW9uOiBlbnZpcm9ubWVudCA9PT0gJ3Byb2QnID8gJ3VzLWVhc3QtMScgOiAndXMtZWFzdC0xJyxcbiAgfTtcbn1cbiJdfQ==