import boto3
import json
import logging
import os
import urllib.parse

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_root_password():
    sm = boto3.client('secretsmanager', region_name=os.environ['REGION'])
    secret = sm.get_secret_value(SecretId=os.environ['SECRET_ID'])['SecretString']
    return json.loads(secret)['OMERO_ROOT_PASSWORD']


def handler(event, context):
    ecs = boto3.client('ecs')
    s3 = boto3.client('s3')
    root_pass = get_root_password()
    omero_server = os.environ['OMERO_SERVER']

    for record in event['Records']:
        body = json.loads(record['body'])
        for s3_record in body.get('Records', []):
            bucket = s3_record['s3']['bucket']['name']
            key = urllib.parse.unquote_plus(s3_record['s3']['object']['key'])
            logger.info('Importing s3://%s/%s', bucket, key)

            url = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': bucket, 'Key': key},
                ExpiresIn=7200
            )

            cmd = (
                'sleep 10 && '
                'wget -q -O /tmp/import.ndpi "' + url + '" && '
                '/opt/omero/server/venv3/bin/omero -C import'
                ' -s ' + omero_server +
                ' -u root'
                ' -w "' + root_pass + '"'
                ' /tmp/import.ndpi &&'
                ' rm /tmp/import.ndpi'
            )

            resp = ecs.run_task(
                cluster=os.environ['CLUSTER'],
                taskDefinition=os.environ['TASK_DEF'],
                launchType='FARGATE',
                networkConfiguration={
                    'awsvpcConfiguration': {
                        'subnets': [os.environ['SUBNET']],
                        'securityGroups': [os.environ['SECURITY_GROUP']],
                        'assignPublicIp': 'DISABLED',
                    }
                },
                overrides={
                    'containerOverrides': [{
                        'name': 'omero-import',
                        'command': [cmd],
                    }]
                },
            )
            task_arn = resp['tasks'][0]['taskArn'] if resp.get('tasks') else 'unknown'
            logger.info('ECS Task launched: %s', task_arn)

    return {'statusCode': 200}
