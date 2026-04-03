import json
import logging
import os
import urllib.parse

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _get_root_password() -> str:
    sm = boto3.client('secretsmanager', region_name=os.environ['REGION'])
    secret = sm.get_secret_value(SecretId=os.environ['SECRET_ID'])['SecretString']
    return json.loads(secret)['OMERO_ROOT_PASSWORD']


def _generate_presigned_url(s3_client, bucket: str, key: str) -> str:
    return s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': bucket, 'Key': key},
        ExpiresIn=7200,
    )


def handler(event: dict, context: object) -> dict:
    ecs = boto3.client('ecs')
    s3 = boto3.client('s3')
    root_pass = _get_root_password()
    omero_server = os.environ['OMERO_SERVER']

    for record in event.get('Records', []):
        body = json.loads(record['body'])
        for s3_record in body.get('Records', []):
            bucket: str = s3_record['s3']['bucket']['name']
            key: str = urllib.parse.unquote_plus(s3_record['s3']['object']['key'])
            logger.info('Importing s3://%s/%s', bucket, key)

            presigned_url = _generate_presigned_url(s3, bucket, key)

            # Pass the URL as an environment variable to avoid shell injection
            resp = ecs.run_task(
                cluster=os.environ['CLUSTER'],
                taskDefinition=os.environ['TASK_DEF'],
                launchType='FARGATE',
                networkConfiguration={
                    'awsvpcConfiguration': {
                        'subnets': [os.environ['SUBNET']],
                        'securityGroups': [os.environ['SECURITY_GROUP']],
                        'assignPublicIp': 'DISABLED',
                    },
                },
                overrides={
                    'containerOverrides': [{
                        'name': 'omero-import',
                        'environment': [
                            {'name': 'IMPORT_URL', 'value': presigned_url},
                            {'name': 'OMERO_SERVER', 'value': omero_server},
                            {'name': 'ROOTPASS', 'value': root_pass},
                        ],
                        'command': [
                            'sleep 10'
                            ' && wget -q -O /tmp/import.ndpi "$IMPORT_URL"'
                            ' && /opt/omero/server/venv3/bin/omero import'
                            ' -s "$OMERO_SERVER" -u root -w "$ROOTPASS"'
                            ' --skip-minmax --no-upgrade-check'
                            ' /tmp/import.ndpi'
                            ' && rm -f /tmp/import.ndpi',
                        ],
                    }],
                },
            )

            failures = resp.get('failures', [])
            if failures:
                logger.error('ECS RunTask failures: %s', failures)
                raise RuntimeError(f'ECS RunTask failed: {failures}')

            task_arn = resp['tasks'][0]['taskArn']
            logger.info('ECS task launched: %s', task_arn)

    return {'statusCode': 200}
