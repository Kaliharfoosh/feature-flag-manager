# Load test results: Rollout Service (S2)

Lab 8 applied to our design. Lab 8 compares one server with three behind a load balancer. Our API
is serverless, so Vercel (and Lambda on Floci) start more copies by themselves. What we can
measure is one copy of the service: how fast `POST /evaluations` and `POST /evaluations/batch`
answer under normal load, under a spike and under a stress test with no pauses, and whether the
per-key rate limit holds under a burst.

How to repeat it: [tests/load/README.md](../tests/load/README.md). Raw k6 output:
`evidence/test-results/k6-run-*.txt`.

## Setup

| | |
|---|---|
| Date | 25 Nov 2026, commit `97c9174` + branch `test/k6-load` |
| Where | One local Node.js process (`backend/server.js`, Node 24) and a throwaway Postgres 16 in Docker, with the same migrations, grants and demo data as Neon. The app connects as `ffm_app` with a pool of 3 connections, like on Vercel |
| PC | Intel i7-13700F (16 cores), 32 GB RAM. k6, the API and the database all share this PC |
| Not production | On purpose: a load test on the live site would use up the free Vercel and Neon limits and fill the real audit log |
| Traffic mix | 70% one flag (`/evaluations`), 30% all 28 store flags at once (`/evaluations/batch`); random user ids |
| Rate limit | Raised with `EVAL_RATE_LIMIT` for Runs A, B and stress (all k6 users share one key); the normal 120/min for Run C. The raise is ignored when `NODE_ENV=production` (unit-tested) |
| Pass criteria | p(95) < 500 ms, failed requests < 5%, checks > 99% |

## Results

| Run | Users | Requests | Requests/s | avg | p(95) | max | Failed | Result |
|---|---|---|---|---|---|---|---|---|
| A: normal | 20 | 1,494 | 16.6 | 3.7 ms | 5.1 ms | 75 ms | 0% | ✓ Pass |
| B: spike | 20 → 100 → 20 | 5,552 | 61.0 | 3.1 ms | 4.0 ms | 20 ms | 0% | ✓ Pass |
| Stress: no pauses | 50 → 200 | 71,453 | 1,020 | 108 ms | 203 ms | 234 ms | 0% | ✓ Pass |

Single flag vs batch had the same p(95) in every run (Run B: 3.9 ms vs 4.2 ms; stress: 203.4 ms vs
203.5 ms). Asking for 28 flags in one batch costs about the same as asking for one, because all
28 are read in one database query.

In Runs A and B about half the single-flag answers were `true` (50.6% and 52.0%): the flags'
percentages decide, and random users spread evenly over the buckets.

### Run C: rate limit under a burst

One fresh key, 150 requests from 10 users at once, normal limit (120 per minute).

| Check | Expected | Actual | Result |
|---|---|---|---|
| Answered 200 | At most 120 | **120** | ✓ |
| Answered 429 `RATE_LIMITED` | The rest | **30** | ✓ |
| `Retry-After` on every 429 | 1–60 s | Present on all 30 | ✓ |
| Anything other than 200 or 429 | 0 | 0 | ✓ |
| Security event | One `rate_limit.hit`, not one per refusal | One row (prefix `ffm_stg_4ku925`, count 120) | ✓ |

The count is exact under 10 parallel users because it is kept in the database
(`INSERT … ON CONFLICT DO UPDATE`), not in the memory of one server. Lab 8's limiter counts in
memory, and the lab itself points out that each of its three servers then counts separately.
Ours stays correct however many serverless copies Vercel starts.

## What the numbers mean

- **Normal load and spikes are easy.** At 100 users p(95) stayed at 4 ms. The spike was actually
  faster than Run A, because the server and database were warm (code compiled, data cached).
- **The ceiling of one copy is about 1,000 requests per second.** With no pauses, 200 users got
  1,020 requests/s with no errors, but the average answer rose from 3 ms to 108 ms. The requests
  were queueing: each evaluation makes 3–4 database calls through a pool of only 3 connections.
  The pool is small on purpose: on Vercel every copy has its own pool, and Neon's free plan
  limits connections. 200 users ÷ 1,020 requests/s ≈ 0.2 s, which matches the measured p(95).
- **On Vercel the ceiling moves up by itself.** More traffic means more copies, each with its own
  3 connections, all going through Neon's pooled connection string. The limit then becomes Neon's
  connections and compute, not the code.
- **Rate limiting protects the service from one noisy client.** Even if one client app runs out of
  control, its key stops at 120 requests per minute, so other teams' apps are not slowed down.

## Lab 8 on Floci

The lab's own experiment with our API: the same AWS pieces built on Floci (Secrets Manager, IAM,
CloudWatch Logs, VPC + ALB + target group, ECS + Auto Scaling), and the same kind of local load
balancer (round robin, health check every 3 s) in front of local copies of the API, because on
Floci the ALB and ECS are recorded, not running. How to repeat it:
[infra/floci/lab8/README.md](../infra/floci/lab8/README.md). Same PC, same throwaway database,
same k6 scripts with `BASE_URL=http://localhost:8080`.

### What Floci recorded

| Piece | Recorded on Floci |
|---|---|
| Secret | `ffm/load-test-config` (throwaway DB + session secret; value never printed) |
| IAM | `ffm-ecs-execution-role`: read that one secret, write `/aws/ecs/ffm-api`. `ffm-ecs-task-role`: no permissions, because the code only talks to Postgres |
| Network | VPC `10.0.0.0/16`, subnets in `us-east-1a` and `us-east-1b`, security group `ffm-sg` (HTTP in only) |
| Load balancer | ALB `ffm-alb`, listener :80, target group `ffm-tg`, health check `GET /api/v1/health` |
| ECS | `ffm-cluster`, `ffm-api-service`, task definition `ffm-api-task` (secrets injected by ARN) |
| Auto Scaling | min 1, max 4 tasks, target 50% CPU |
| Run A (vertical) | task definition revision 2: 1024 CPU / 2048 MB, desired count 1 |
| Run B (horizontal) | revision 3: 256 CPU / 512 MB, desired count 3, targets 3001, 3002, 3003 (`evidence/test-results/floci-horizontal-3-status.txt`) |

### Results

| Run | Copies | Load | Requests/s | median | p(95) | Failed | Who answered |
|---|---|---|---|---|---|---|---|
| A: scale up, normal | 1 (1024 CPU) | 20 users | 16.7 | 4.4 ms | 9.5 ms | 0% | `ffm-task-vertical` 1,501 |
| B: scale out, normal | 3 (256 CPU each) | 20 users | 16.7 | 4.8 ms | 9.9 ms | 0% | task-1 502 · task-2 502 · task-3 503 |
| A: scale up, stress | 1 | 200 users, no pauses | 1,144 | 82 ms | 190 ms | 0% | `ffm-task-vertical` 80,099 |
| B: scale out, stress | 3 | 200 users, no pauses | **1,234** | **54 ms** | 300 ms | 0% | 28,805 each |
| C: failover | 3 → 2 (task-2 killed at 30 s) | 20 users | 16.8 | 4.7 ms | 9.7 ms | **0.06% (1 of 1,534)** | task-1 695 · task-2 143 · task-3 694 |
| Rate limit, 3 copies | 3 | 150 requests, 1 key | | | | | 50 each |

Raw output: `evidence/test-results/k6-floci-*.txt`.

**Rate limit across 3 copies:** exactly **120 × 200 and 30 × 429** (all with `Retry-After`), and one
`rate_limit.hit` row, although each copy answered 50 requests. Lab 8 warns that its limiter counts
in memory, so with 3 workers each counts separately. Ours counts in the shared database, so the
limit stays exact however many copies run.

**Failover:** the load balancer log shows the crash and the switch in the same millisecond:

```
[lb] 2026-11-25T01:18:37.986Z http://localhost:3002/ is now UNHEALTHY (request: ECONNREFUSED)
[lb] 2026-11-25T01:18:37.987Z upstream http://localhost:3002/ failed
```

One request that was on its way to task-2 failed (502), then every request went to task-1 and
task-3. On real AWS, ECS would now start a replacement task to get back to 3.

### What the numbers mean
- **Round robin works:** 6 health checks went 2, 3, 1, 2, 3, 1, and under load every copy got the
  same share (502/502/503, then 28,805 each).
- **Scale out helped a little, as the lab predicts on one PC:** 3 copies did 8% more requests per
  second and the median answer fell from 82 ms to 54 ms, because each copy has its own 3 database
  connections (9 instead of 3). But p(95) rose from 190 to 300 ms: every request now passes through
  one extra program (the local load balancer, a single Node process), and the 3 copies, the load
  balancer, k6 and Postgres all share one CPU and one database. On real AWS each task has its own
  CPU and the ALB is a managed service, so the gain would be much larger.
- **Scale up did not help** for the same reason the lab gives: the 1024-CPU task is still one
  Node.js process, and Node runs our code on one core. A bigger task cannot make one core faster.
- **Failover costs almost nothing:** 1 failed request in 1,534 (0.06%), far under the 5% limit.

## Run C through API Gateway and Lambda (Floci, 27 Nov)

The same rate-limit test, but through the real AWS path on Floci: k6 → API Gateway `ffm-http-api`
→ Lambda `ffm-eval-fn` (S2's function, built by `infra/floci/services/s2-lambdas.sh`). Raw output:
`evidence/test-results/k6-floci-gateway-ratelimit.txt`.

| | |
|---|---|
| Date | 27 Nov 2026, main `f2c606c`, Floci 2.5.0 |
| Database | `ffm-eval-fn`'s secret `ffm/eval-db` was pointed for the run at the throwaway Postgres (`tests/load/start-local-db.ps1`, reached from the Lambda container as `host.docker.internal:55432`), with a fresh local staging key. Neon was never load-tested. Afterwards `s2-lambdas.sh` was run again, which rewrote the secret from `.env`; the test key then got 401, proving the function was back on Neon |
| Start | At second 1–4 of a clock minute, so all 150 requests fell into one minute window |

| Check | Expected | Actual | Result |
|---|---|---|---|
| Answered 200 | At most 120 | **120** | ✓ |
| Answered 429 `RATE_LIMITED` | The rest | **30** | ✓ |
| `Retry-After` on every 429 | 1–60 s | Present on all 30 (60 of 60 checks passed) | ✓ |
| Anything other than 200 or 429 | 0 | 0 of 150 | ✓ |
| Security event | One `rate_limit.hit` | **One** row in `audit_events` | ✓ |
| Counter row in `api_key_usage` | Stops at the first refusal | `count = 121` (120 allowed + 1 first refusal; the other 29 refusals write nothing) | ✓ |

**What the numbers mean**
- **The limit is exact through API Gateway and Lambda too.** Floci started several copies of
  `ffm-eval-fn` for the 10 parallel users, and the count stayed exactly 120 because it lives in
  Postgres, not in one copy's memory: the same result as on one server (Run C) and across three
  containers (Lab 8).
- **Cold starts show in the tail, not the middle:** median 16.8 ms and p(90) 125 ms, but p(95)
  5.75 s and max 8.2 s. Those slow requests are the first request of each new Lambda copy (start
  the container, read the secret, open the database pool). On AWS, provisioned concurrency or a
  warm-up call would remove most of them; here they cost nothing because only the first request
  of each copy pays.
- **The API Gateway throttle (50 requests/s, burst 100) was not reached:** k6 sent about 18
  requests/s, so every 429 came from the per-key limiter (code `RATE_LIMITED`, with `Retry-After`).
  Whether Floci enforces the gateway throttle is still not shown (see Limitations).

## Limitations of this test

- Everything ran on one PC, so k6, the API and the database competed for the same CPU. The real
  numbers on Vercel and Neon will differ (network time is added, and cold starts on the first
  request).
- Only the Rollout Service's public endpoints were tested, not the signed-in website pages.
- We did not test the scale-out on Vercel itself, to stay inside the free plan. The Floci runs
  show scale-out and failover the container way instead; on Vercel a crashed copy is simply
  replaced on the next request.
- On Floci the ALB, ECS and Auto Scaling are recorded, not running, so no automatic scaling or
  task replacement happened: the copies were started and killed by `scale-test.js`, as in the lab.
