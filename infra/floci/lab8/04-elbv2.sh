#!/usr/bin/env bash
set -euo pipefail
# [4/5] Network + load balancer: VPC, 2 subnets in 2 Availability Zones, security group,
# Application Load Balancer ffm-alb, target group ffm-tg (health check GET /api/v1/health),
# listener on port 80. Same layout as Lab 8's 09-elbv2.sh.
# On Floci the ALB is recorded; the real traffic goes through the small local load balancer
# that scale-test.js starts on :8080 (round robin + health checks, like the lab's).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

echo "=== [4/5] VPC, subnets, security group, ffm-alb, ffm-tg ==="
# Look first, create only if missing (AWS allows many VPCs with the same range).
VPC_ID=$(awsl ec2 describe-vpcs --filters Name=cidr,Values=10.0.0.0/16 --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  VPC_ID=$(awsl ec2 create-vpc --cidr-block 10.0.0.0/16 --query 'Vpc.VpcId' --output text)
fi
echo "  VPC: $VPC_ID"

subnet() { # cidr zone
  local id
  id=$(awsl ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" Name=cidr-block,Values="$1" --query 'Subnets[0].SubnetId' --output text 2>/dev/null || true)
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    id=$(awsl ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block "$1" --availability-zone "$2" --query 'Subnet.SubnetId' --output text)
  fi
  echo "$id"
}
SUBNET_A=$(subnet 10.0.1.0/24 us-east-1a)
SUBNET_B=$(subnet 10.0.2.0/24 us-east-1b)
echo "  Subnets: $SUBNET_A (us-east-1a)  $SUBNET_B (us-east-1b)"

SG_ID=$(awsl ec2 describe-security-groups --filters Name=group-name,Values=ffm-sg Name=vpc-id,Values="$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  SG_ID=$(awsl ec2 create-security-group --group-name ffm-sg --description "Feature Flag Manager API: HTTP in" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
  # Only HTTP in (port 80, to the load balancer). Nothing else is opened.
  awsl ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
fi
echo "  Security group: $SG_ID"

ALB_ARN=$(awsl elbv2 describe-load-balancers --names ffm-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN=$(awsl elbv2 create-load-balancer --name ffm-alb --type application --subnets "$SUBNET_A" "$SUBNET_B" --security-groups "$SG_ID" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
fi
echo "  ALB: $ALB_ARN"

TG_ARN=$(awsl elbv2 describe-target-groups --names ffm-tg --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(awsl elbv2 create-target-group --name ffm-tg --protocol HTTP --port 3001 --vpc-id "$VPC_ID" --target-type ip \
    --health-check-path /api/v1/health --health-check-interval-seconds 5 --healthy-threshold-count 2 --unhealthy-threshold-count 2 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
fi
echo "  Target group: $TG_ARN (health check GET /api/v1/health)"

LISTENER=$(awsl elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query 'Listeners[0].ListenerArn' --output text 2>/dev/null || true)
if [ -z "$LISTENER" ] || [ "$LISTENER" = "None" ]; then
  awsl elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN}" >/dev/null
fi
echo "[4/5] done: ffm-alb (listener :80) -> ffm-tg"
