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
    ssm = boto3.client('ssm')
    s3 = boto3.client('s3')
    root_pass = get_root_password()
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
            resp = ssm.send_command(
                InstanceIds=[os.environ['INSTANCE_ID']],
                DocumentName='AWS-RunShellScript',
                Parameters={'commands': [
                    'wget -q -O /tmp/import.ndpi "' + url + '"',
                    'docker cp /tmp/import.ndpi omero-omeroserver-1:/tmp/import.ndpi',
                    'docker exec -u omero-server omero-omeroserver-1 /opt/omero/server/venv3/bin/omero -C import -s localhost -u root -w "' + root_pass + '" /tmp/import.ndpi',
                    'rm /tmp/import.ndpi',
                ]},
            )
            logger.info('SSM Command: %s', resp['Command']['CommandId'])
    return {'statusCode': 200}
