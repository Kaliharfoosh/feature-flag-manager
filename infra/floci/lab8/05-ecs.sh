#!/usr/bin/env bash
set -euo pipefail
# [5/5] ECS + Application Auto Scaling (Lab 8's 10-ecs.sh, for our API).
#   cluster ffm-cluster, task definition ffm-api-task (256 CPU = 1/4 vCPU, 512 MB),
#   service ffm-api-service (desired count 1, registered in ffm-tg),
#   auto scaling: min 1, max 4 tasks, aim for 50% CPU.
# The max of 4 matters: scaling is not DDoS protection, and without a max a traffic spike could
# start unlimited tasks (and an unlimited bill on real AWS).
# On Floci ECS and Auto Scaling are recorded, not running: scale-test.js starts the real copies.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

echo "=== [5/5] ECS ffm-cluster, ffm-api-task, ffm-api-service, auto scaling 1-4 ==="
VPC_ID=$(awsl ec2 describe-vpcs --filters Name=cidr,Values=10.0.0.0/16 --query 'Vpcs[0].VpcId' --output text)
SUBNET_A=$(awsl ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" Name=cidr-block,Values=10.0.1.0/24 --query 'Subnets[0].SubnetId' --output text)
SUBNET_B=$(awsl ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" Name=cidr-block,Values=10.0.2.0/24 --query 'Subnets[0].SubnetId' --output text)
SG_ID=$(awsl ec2 describe-security-groups --filters Name=group-name,Values=ffm-sg --query 'SecurityGroups[0].GroupId' --output text)
TG_ARN=$(awsl elbv2 describe-target-groups --names ffm-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
SECRET_ARN=$(awsl secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text)

ok awsl ecs create-cluster --cluster-name ffm-cluster

# The secret is injected as two environment variables when a task starts (valueFrom), so the
# task definition holds only the secret's ARN, never the values.
container_defs() { # cpu memory
  cat <<JSON
[{
  "name": "ffm-api",
  "image": "ffm-api:local",
  "cpu": $1, "memory": $2,
  "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
  "environment": [{ "name": "NODE_ENV", "value": "production" }],
  "secrets": [
    { "name": "DATABASE_URL",   "valueFrom": "${SECRET_ARN}:DATABASE_URL::" },
    { "name": "SESSION_SECRET", "valueFrom": "${SECRET_ARN}:SESSION_SECRET::" }
  ],
  "healthCheck": { "command": ["CMD-SHELL", "wget -qO- http://localhost:3000/api/v1/health || exit 1"], "interval": 10, "retries": 3 },
  "logConfiguration": { "logDriver": "awslogs", "options": {
    "awslogs-group": "/aws/ecs/ffm-api", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "ffm" } }
}]
JSON
}

awsl ecs register-task-definition --family ffm-api-task \
  --requires-compatibilities FARGATE --network-mode awsvpc --cpu 256 --memory 512 \
  --execution-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/ffm-ecs-execution-role" \
  --task-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/ffm-ecs-task-role" \
  --container-definitions "$(container_defs 256 512)" \
  --query 'taskDefinition.taskDefinitionArn' --output text \
  || echo "  WARNING: register-task-definition failed on this Floci; continuing (control plane only)." >&2

EXISTING=$(awsl ecs describe-services --cluster ffm-cluster --services ffm-api-service --query 'services[0].serviceName' --output text 2>/dev/null || true)
if [ "$EXISTING" = "ffm-api-service" ]; then
  echo "  (service already exists, skipping)"
else
  awsl ecs create-service --cluster ffm-cluster --service-name ffm-api-service \
    --task-definition ffm-api-task --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_A},${SUBNET_B}],securityGroups=[${SG_ID}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${TG_ARN},containerName=ffm-api,containerPort=3000" >/dev/null 2>&1 \
    || echo "  WARNING: create-service failed on this Floci; continuing (control plane only)." >&2
fi

awsl application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/ffm-cluster/ffm-api-service --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 --max-capacity 4 >/dev/null 2>&1 || echo "  WARNING: register-scalable-target failed; continuing." >&2

awsl application-autoscaling put-scaling-policy --service-namespace ecs \
  --resource-id service/ffm-cluster/ffm-api-service --scalable-dimension ecs:service:DesiredCount \
  --policy-name ffm-api-cpu-50 --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{"TargetValue":50.0,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"}}' \
  >/dev/null 2>&1 || echo "  WARNING: put-scaling-policy failed; continuing." >&2

echo "[5/5] done: ffm-cluster / ffm-api-service (min 1, max 4, target 50% CPU)"
