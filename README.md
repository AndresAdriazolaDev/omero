# OMERO en AWS ECS Fargate

Infraestructura para desplegar [OMERO](https://www.openmicroscopy.org/omero/) en AWS usando CDK (TypeScript).

Implementado para el Instituto de Salud Pública de Chile (ISP) - Sección Parasitología, para almacenamiento y visualización online de placas virtuales (.ndpi).

## Arquitectura

```
Internet → ALB (HTTPS) → ECS omeroweb (4080)
                              ↓ Cloud Map
                         ECS omeroserver (4064)
                              ↓ Cloud Map
                         ECS postgres (5432) → EFS
                              ↓
                         S3 (imágenes .ndpi)
```

## Stacks CDK

| Stack | Recursos |
|---|---|
| `vpc-omero-dev` | VPC 10.0.0.0/16, subnets públicas/privadas/aisladas, NAT Gateway |
| `dns-omero-dev` | Certificado ACM para `omero.teleinforme-dev.minsal.cl` |
| `s3-omero-dev` | Bucket imágenes .ndpi con lifecycle Standard→IA(30d)→Glacier(90d) |
| `ecr-omero-dev` | 3 repos ECR: postgres, server, web |
| `fargate-omero-dev` | ECS cluster, 3 servicios, EFS, ALB, Cloud Map, Lambda, Route53 |

## Prerrequisitos antes del deploy

### 1. Imágenes en ECR

```bash
aws ecr get-login-password --region us-east-1 --profile dev | \
  sudo docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

sudo docker pull postgres:14
sudo docker tag postgres:14 <account>.dkr.ecr.us-east-1.amazonaws.com/ecr-omero-postgres-dev:latest
sudo docker push <account>.dkr.ecr.us-east-1.amazonaws.com/ecr-omero-postgres-dev:latest

sudo docker pull openmicroscopy/omero-server:5.6.17
sudo docker tag openmicroscopy/omero-server:5.6.17 <account>.dkr.ecr.us-east-1.amazonaws.com/ecr-omero-server-dev:latest
sudo docker push <account>.dkr.ecr.us-east-1.amazonaws.com/ecr-omero-server-dev:latest

sudo docker pull openmicroscopy/omero-web-standalone:5.31.0
sudo docker tag openmicroscopy/omero-web-standalone:5.31.0 <account>.dkr.ecr.us-east-1.amazonaws.com/ecr-omero-web-dev:latest
sudo docker push <account>.dkr.ecr.us-east-1.amazonaws.com/ecr-omero-web-dev:latest
```

### 2. Secret en Secrets Manager

```bash
aws secretsmanager create-secret \
  --name "omero-dev-secrets" \
  --secret-string '{
    "POSTGRES_PASSWORD": "<password>",
    "OMERO_ROOT_PASSWORD": "<password>",
    "POSTGRES_HOST": "postgres.omero-dev.local",
    "OMERO_SERVER_HOST": "server.omero-dev.local"
  }' \
  --region us-east-1 \
  --profile dev
```

## Deploy

```bash
cd infra
npm install
npx aws-cdk@latest bootstrap --profile dev
npx aws-cdk@latest deploy --all --profile dev --require-approval never
```

El deploy crea los servicios ECS con `desiredCount: 1`. Los servicios arrancan en orden automáticamente gracias a Cloud Map.

## Problemas conocidos y soluciones

### OMERO server requiere mínimo 1 vCPU / 2GB RAM
El proceso Ice de OMERO server es pesado. Con 256MB el proceso es matado por OOM silenciosamente. La task definition del server usa `cpu: 1024, memoryLimitMiB: 2048`.

### OMERO web requiere mínimo 512MB RAM
Gunicorn con 5 workers necesita al menos 512MB. La task definition del web usa `cpu: 512, memoryLimitMiB: 1024`.

### CSRF Failed con ALB
El ALB termina SSL y reenvía el request como HTTP al container. Django rechaza el login porque el `Origin` header es `https://` pero el request llega como `http://`. Solución: configurar `USE_X_FORWARDED_HOST`, `SECURE_PROXY_SSL_HEADER` y `CSRF_TRUSTED_ORIGINS`.

### Session engine
`django.contrib.sessions.backends.cache` con `DummyCache` (default) hace que el CSRF token no persista entre requests. Solución: usar `django.contrib.sessions.backends.file` con `LocMemCache`.

### Health check retorna 400
El ALB hace el health check con la IP interna como `Host` header. Django retorna 400 porque la IP no está en `ALLOWED_HOSTS`. Solución: `ALLOWED_HOSTS = ["*"]` y aceptar código 400 en el health check.

### Security Groups con prefijo sg-
AWS no permite nombres de Security Groups que empiecen con `sg-`. Usar `omero-{env}-{nombre}-sg` en su lugar.

### S3 lifecycle STANDARD_IA mínimo 30 días
AWS requiere mínimo 30 días antes de transicionar a `STANDARD_IA`. No se puede usar 7 días.

### Orden de arranque de servicios
ECS no garantiza orden de arranque. Si `omeroserver` arranca antes que `postgres`, falla. Solución: subir los servicios manualmente en orden después del primer deploy:

```bash
# 1. Postgres primero
aws ecs update-service --cluster ecs-cluster-omero-dev \
  --service ecs-svc-omero-postgres-dev --desired-count 1 \
  --profile dev --region us-east-1
aws ecs wait services-stable --cluster ecs-cluster-omero-dev \
  --services ecs-svc-omero-postgres-dev --profile dev --region us-east-1

# 2. Server
aws ecs update-service --cluster ecs-cluster-omero-dev \
  --service ecs-svc-omero-server-dev --desired-count 1 \
  --profile dev --region us-east-1
aws ecs wait services-stable --cluster ecs-cluster-omero-dev \
  --services ecs-svc-omero-server-dev --profile dev --region us-east-1

# 3. Web
aws ecs update-service --cluster ecs-cluster-omero-dev \
  --service ecs-svc-omero-web-dev --desired-count 1 \
  --profile dev --region us-east-1
aws ecs wait services-stable --cluster ecs-cluster-omero-dev \
  --services ecs-svc-omero-web-dev --profile dev --region us-east-1
```

## Acceso

- URL: https://omero.teleinforme-dev.minsal.cl
- Usuario: `root`
- Password: definido en `omero-dev-secrets` → `OMERO_ROOT_PASSWORD`

## Costos estimados (dev)

| Servicio | Specs | USD/mes |
|---|---|---|
| ECS postgres | 0.25 vCPU / 512MB | ~$5 |
| ECS omeroserver | 1 vCPU / 2GB | ~$35 |
| ECS omeroweb | 0.5 vCPU / 1GB | ~$9 |
| EFS | ~10GB | ~$3 |
| S3 + Glacier | 15TB | ~$90 |
| ALB | - | ~$16 |
| NAT Gateway | - | ~$32 |
| **Total** | | **~$190 USD/mes** |

## Estructura del proyecto

```
omero/
├── docker-compose.yml          # Para desarrollo local
├── Dockerfile.web              # Imagen custom omeroweb (no usada en prod)
└── infra/
    ├── bin/
    │   └── omero-infra.ts      # Entry point CDK
    └── lib/
        ├── network/
        │   ├── vpc-stack.ts
        │   └── dns-stack.ts
        ├── storage/
        │   └── s3-stack.ts
        ├── ecr/
        │   └── ecr-stack.ts
        ├── compute/
        │   └── fargate-stack.ts
        └── utils/
            └── env-utils.ts
```
