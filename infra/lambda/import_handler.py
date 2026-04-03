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
    ssm = boto3.client('ssm')
    s3 = boto3.client('s3')
    root_pass = _get_root_password()
    instance_id = os.environ['INSTANCE_ID']

    for record in event.get('Records', []):
        body = json.loads(record['body'])
        for s3_record in body.get('Records', []):
            bucket: str = s3_record['s3']['bucket']['name']
            key: str = urllib.parse.unquote_plus(s3_record['s3']['object']['key'])
            logger.info('Importing s3://%s/%s', bucket, key)

            presigned_url = _generate_presigned_url(s3, bucket, key)

            # Use a shell variable to hold the URL — avoids injection via key names
            commands = [
                f'IMPORT_URL={json.dumps(presigned_url)}',
                'wget -q -O /tmp/import.ndpi "$IMPORT_URL"',
                'docker cp /tmp/import.ndpi omero-omeroserver-1:/tmp/import.ndpi',
                f'docker exec -u omero-server omero-omeroserver-1'
                f' /opt/omero/server/venv3/bin/omero -C import'
                f' -s localhost -u root -w {json.dumps(root_pass)} /tmp/import.ndpi',
                'rm -f /tmp/import.ndpi',
            ]

            resp = ssm.send_command(
                InstanceIds=[instance_id],
                DocumentName='AWS-RunShellScript',
                Parameters={'commands': commands},
            )
            command_id = resp['Command']['CommandId']
            logger.info('SSM command sent: %s', command_id)

    return {'statusCode': 200}
