# Lab 8 on Floci: scale up, scale out, failover (S2)

Lab 8's experiment, done with our API instead of the lab's Social Media App. The same 5 AWS pieces
are built on Floci with scripts (Git Bash), and the same kind of local load balancer and copies
serve the real traffic, because on Floci the ALB, ECS and Auto Scaling are recorded, not running.
Results: [docs/load-test-results.md](../../../docs/load-test-results.md#lab-8-on-floci).

| Script | AWS service | What it builds |
|---|---|---|
| `01-secrets.sh` | Secrets Manager | `ffm/load-test-config`: the throwaway database address + session secret (never Neon) |
| `02-iam.sh` | IAM | `ffm-ecs-execution-role` (read that ONE secret, write ONE log group) and `ffm-ecs-task-role` (no permissions: our code only talks to Postgres) |
| `03-cloudwatch-logs.sh` | CloudWatch Logs | `/aws/ecs/ffm-api`, kept 7 days |
| `04-elbv2.sh` | VPC + ELB | VPC `10.0.0.0/16`, 2 subnets in 2 zones, security group `ffm-sg` (HTTP in only), ALB `ffm-alb`, target group `ffm-tg` (health check `GET /api/v1/health`), listener :80 |
| `05-ecs.sh` | ECS + Auto Scaling | cluster `ffm-cluster`, task definition `ffm-api-task` (256 CPU / 512 MB, secrets injected by ARN), service `ffm-api-service`, scaling min 1 / max 4 / 50% CPU |
| `setup.sh` | all | runs the 5 scripts in order (safe to re-run) |
| `scale-test.js` | | `vertical` / `horizontal N` / `kill N` / `status` / `stop`: changes what Floci records AND starts the real local copies |
| `lb.js` | | the local stand-in for `ffm-alb` on :8080: round robin + health check every 3 s |

## Run it (Git Bash for the scripts, any shell for the rest; repo root)

Docker Desktop running, then:

```bash
docker compose -f infra/floci/docker-compose.yml up -d        # our Floci
powershell -ExecutionPolicy Bypass -File tests/load/start-local-db.ps1   # throwaway DB, prints a key
bash infra/floci/lab8/setup.sh                                # the 5 AWS pieces
```

If `docker compose` says the name `floci` is in use, the Lab 8 project's own Floci container is
there: `docker stop floci` and `docker rename floci floci-social-lab` first (rename it back after).

**Run A: one bigger copy (scale up).** Raise the key limit first (all k6 users share one key):

```bash
export EVAL_RATE_LIMIT=100000          # PowerShell: $env:EVAL_RATE_LIMIT='100000'
node infra/floci/lab8/scale-test.js vertical
k6 run -e BASE_URL=http://localhost:8080 -e FFM_KEY=ffm_stg_PASTE_KEY -e PROFILE=normal tests/load/evaluations-load.js
```

**Run B: three copies (scale out).**

```bash
node infra/floci/lab8/scale-test.js horizontal 3
node infra/floci/lab8/scale-test.js status            # Floci: desired count 3, targets 3001-3003
for i in 1 2 3 4 5 6; do curl -s localhost:8080/api/v1/health | grep -o '"instanceId":"[^"]*"'; done
k6 run -e BASE_URL=http://localhost:8080 -e FFM_KEY=ffm_stg_PASTE_KEY -e PROFILE=normal tests/load/evaluations-load.js
```

Add `-e PROFILE=stress` to either run to find the ceiling.

**Run C: failover.** Window 1 runs k6 (as in Run B); about 30 s later, window 2:

```bash
node infra/floci/lab8/scale-test.js kill 2
grep -E "upstream|HEALTHY" infra/floci/lab8/.run/logs/lb.log
```

**Rate limit across 3 copies.** Unset the raise, restart, use a fresh key (`node --env-file=.env backend/db/seed-key.js` with `DATABASE_URL_MIGRATE` pointing at the throwaway DB, or just re-run `start-local-db.ps1`):

```bash
unset EVAL_RATE_LIMIT                  # PowerShell: Remove-Item Env:EVAL_RATE_LIMIT
node infra/floci/lab8/scale-test.js horizontal 3
k6 run -e BASE_URL=http://localhost:8080 -e FFM_KEY=ffm_stg_PASTE_KEY tests/load/evaluations-ratelimit.js
```

**Clean up:**

```bash
node infra/floci/lab8/scale-test.js stop
docker rm -f ffm-loadtest-db
docker compose -f infra/floci/docker-compose.yml down     # Floci's data is kept
```

## Floci vs real AWS
- Floci records the ALB, ECS service and Auto Scaling but does not run them; `scale-test.js` starts
  local Node processes and keeps Floci's desired count and targets matching what really runs.
- On real AWS, ECS would start a replacement after the crash in Run C, and Auto Scaling would add a
  task when the average CPU passes 50% (up to 4). Here we stop at the failover, like the lab.
- Our real deployment is Vercel (serverless), which scales out on its own. This Floci setup shows
  the same idea the container way, for Lab 8.
