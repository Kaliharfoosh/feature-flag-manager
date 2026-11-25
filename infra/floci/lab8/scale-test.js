// Lab 8 scale test for our API (a Node port of the lab's infra/scale-test.sh, so it runs in
// PowerShell and Git Bash alike). It updates what Floci records (ECS desired count, task size,
// ALB targets) AND starts the real local copies that serve the traffic.
//
//   node infra/floci/lab8/scale-test.js vertical        1 bigger task (1024 CPU / 2048 MB) on :8080
//   node infra/floci/lab8/scale-test.js horizontal [N]  N small tasks (default 3) behind the LB on :8080
//   node infra/floci/lab8/scale-test.js kill N          crash copy ffm-task-N (failover drill)
//   node infra/floci/lab8/scale-test.js status          what Floci recorded + which copies are alive
//   node infra/floci/lab8/scale-test.js stop            stop every copy and the LB
//
// Each copy gets DATABASE_URL and SESSION_SECRET from the Floci secret ffm/load-test-config, the
// way ECS injects a task's secrets. That secret points at the throwaway local database, never Neon,
// and .env is NOT read. Set EVAL_RATE_LIMIT before "vertical"/"horizontal" to raise the per-key
// limit for load tests (tests/load/README.md); leave it unset to test the real limit.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUN = path.join(__dirname, '.run');
const LOGS = path.join(RUN, 'logs');
const AWS_ENV = { ...process.env, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_DEFAULT_REGION: 'us-east-1', MSYS_NO_PATHCONV: '1' };
const say = (msg) => console.log(`[scale-test] ${msg}`);

function awsl(args, { quiet = false } = {}) {
  const r = spawnSync('aws', ['--endpoint-url', 'http://localhost:4566', ...args], { env: AWS_ENV, encoding: 'utf8' });
  if (r.status !== 0 && !quiet) say(`WARNING: aws ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

function requireFloci() {
  if (awsl(['sts', 'get-caller-identity', '--output', 'text'], { quiet: true }) === null) {
    console.error('Floci is not answering on :4566. Start it: docker compose -f infra/floci/docker-compose.yml up -d');
    process.exit(1);
  }
}

function readSecret() {
  const raw = awsl(['secretsmanager', 'get-secret-value', '--secret-id', 'ffm/load-test-config', '--query', 'SecretString', '--output', 'text']);
  if (!raw) { console.error('Secret ffm/load-test-config missing. Run: bash infra/floci/lab8/setup.sh'); process.exit(1); }
  const { DATABASE_URL, SESSION_SECRET } = JSON.parse(raw);
  return { DATABASE_URL, SESSION_SECRET };
}

const tgArn = () => awsl(['elbv2', 'describe-target-groups', '--names', 'ffm-tg', '--query', 'TargetGroups[0].TargetGroupArn', '--output', 'text']);

// Re-register ffm-api-task with a new size (a new revision), like the lab's vertical step.
function registerTaskSize(cpu, memory) {
  const current = JSON.parse(awsl(['ecs', 'describe-task-definition', '--task-definition', 'ffm-api-task', '--query', 'taskDefinition', '--output', 'json']) || 'null');
  if (!current) return;
  const input = {
    family: 'ffm-api-task',
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: String(cpu),
    memory: String(memory),
    executionRoleArn: current.executionRoleArn,
    taskRoleArn: current.taskRoleArn,
    containerDefinitions: current.containerDefinitions.map((c) => ({ ...c, cpu, memory })),
  };
  fs.mkdirSync(RUN, { recursive: true });
  const file = path.join(RUN, 'task-definition.json');
  fs.writeFileSync(file, JSON.stringify(input));
  const arn = awsl(['ecs', 'register-task-definition', '--cli-input-json', `file://${file}`, '--query', 'taskDefinition.taskDefinitionArn', '--output', 'text']);
  if (arn) say(`task definition ${arn.split('/').pop()}: ${cpu} CPU units / ${memory} MB`);
}

function setDesiredCount(n) {
  if (awsl(['ecs', 'update-service', '--cluster', 'ffm-cluster', '--service', 'ffm-api-service', '--desired-count', String(n), '--task-definition', 'ffm-api-task']) !== null) {
    say(`ECS ffm-api-service desired count = ${n}`);
  }
}

function deregisterAll() {
  const arn = tgArn();
  if (!arn) return;
  const list = awsl(['elbv2', 'describe-target-health', '--target-group-arn', arn, '--query', 'TargetHealthDescriptions[].Target', '--output', 'json'], { quiet: true });
  for (const t of JSON.parse(list || '[]')) {
    awsl(['elbv2', 'deregister-targets', '--target-group-arn', arn, '--targets', `Id=${t.Id},Port=${t.Port}`], { quiet: true });
  }
}

function startProcess(name, script, env) {
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, `${name}.log`), 'w');
  const child = spawn(process.execPath, [script], {
    cwd: ROOT, env, detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(path.join(RUN, `${name}.pid`), String(child.pid));
  return child.pid;
}

function startCopy(name, port, secret) {
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, // enough for Node on Windows and Linux
    ...secret,
    PORT: String(port),
    INSTANCE_ID: name,
    NODE_ENV: 'development', // local copies: plain http (the task definition says production for real AWS)
    LOG_LEVEL: 'warn',
    GITHUB_TOKEN: '', // a load test must never open real GitHub issues
  };
  if (process.env.EVAL_RATE_LIMIT) env.EVAL_RATE_LIMIT = process.env.EVAL_RATE_LIMIT;
  const pid = startProcess(name, 'backend/server.js', env);
  say(`started ${name} on :${port} (pid ${pid})`);
}

async function waitHealthy(port, seconds = 20) {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      const r = await fetch(`http://localhost:${port}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  say(`WARNING: :${port} did not become healthy in ${seconds} s (see ${path.relative(ROOT, LOGS)})`);
  return false;
}

function stopPidFile(file) {
  const name = path.basename(file, '.pid');
  const pid = Number(fs.readFileSync(file, 'utf8'));
  try { process.kill(pid); say(`stopped ${name} (pid ${pid})`); } catch { /* already gone */ }
  fs.rmSync(file, { force: true });
}

async function stopAll({ quiet = false } = {}) {
  deregisterAll();
  if (fs.existsSync(RUN)) {
    for (const f of fs.readdirSync(RUN).filter((f) => f.endsWith('.pid'))) stopPidFile(path.join(RUN, f));
  }
  await new Promise((r) => setTimeout(r, 500));
  if (!quiet) say('all local copies and the load balancer are stopped.');
}

async function vertical() {
  requireFloci();
  const secret = readSecret();
  await stopAll({ quiet: true });
  say('vertical (scale UP): one bigger task');
  registerTaskSize(1024, 2048);
  setDesiredCount(1);
  startCopy('ffm-task-vertical', 8080, secret);
  if (await waitHealthy(8080)) say('ready: one copy on http://localhost:8080. Run k6 with -e BASE_URL=http://localhost:8080');
}

async function horizontal(count) {
  if (!Number.isInteger(count) || count < 1 || count > 4) { console.error('Count must be 1 to 4 (the auto scaling maximum).'); process.exit(1); }
  requireFloci();
  const secret = readSecret();
  await stopAll({ quiet: true });
  say(`horizontal (scale OUT): ${count} small tasks behind the load balancer`);
  registerTaskSize(256, 512);
  setDesiredCount(count);
  const arn = tgArn();
  const urls = [];
  for (let i = 1; i <= count; i += 1) {
    const port = 3000 + i;
    if (arn) awsl(['elbv2', 'register-targets', '--target-group-arn', arn, '--targets', `Id=127.0.0.1,Port=${port}`]);
    startCopy(`ffm-task-${i}`, port, secret);
    urls.push(`http://localhost:${port}`);
  }
  for (let i = 1; i <= count; i += 1) await waitHealthy(3000 + i);
  const pid = startProcess('lb', path.join(__dirname, 'lb.js'), { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: '8080', TARGETS: urls.join(',') });
  say(`started the load balancer ffm-alb-local on :8080 (pid ${pid}) -> ${urls.join(', ')}`);
  if (await waitHealthy(8080)) {
    say(`ready: ${count} copies behind http://localhost:8080. Run k6 with -e BASE_URL=http://localhost:8080`);
    say('failover drill: node infra/floci/lab8/scale-test.js kill 2   (in a second window, during k6)');
  }
}

function kill(n) {
  const file = path.join(RUN, `ffm-task-${n}.pid`);
  if (!fs.existsSync(file)) { console.error(`No running copy ffm-task-${n}.`); process.exit(1); }
  stopPidFile(file);
  say(`ffm-task-${n} crashed on purpose. The load balancer skips it after the next failed request or health check (3 s).`);
}

async function status() {
  requireFloci();
  const svc = awsl(['ecs', 'describe-services', '--cluster', 'ffm-cluster', '--services', 'ffm-api-service', '--query', 'services[0].[desiredCount,taskDefinition]', '--output', 'text']);
  console.log(`Floci ECS ffm-api-service: desired count, task definition = ${svc}`);
  const arn = tgArn();
  if (arn) console.log(`Floci ffm-tg targets (ports): ${awsl(['elbv2', 'describe-target-health', '--target-group-arn', arn, '--query', 'TargetHealthDescriptions[].Target.Port', '--output', 'text']) || '(none)'}`);
  const scaling = awsl(['application-autoscaling', 'describe-scalable-targets', '--service-namespace', 'ecs', '--query', 'ScalableTargets[0].[MinCapacity,MaxCapacity]', '--output', 'text']);
  console.log(`Floci auto scaling min, max = ${scaling}`);
  const files = fs.existsSync(RUN) ? fs.readdirSync(RUN).filter((f) => f.endsWith('.pid')) : [];
  for (const f of files) {
    const pid = Number(fs.readFileSync(path.join(RUN, f), 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    console.log(`local ${path.basename(f, '.pid')}: pid ${pid} ${alive ? 'running' : 'NOT running'}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
const commands = {
  vertical: () => vertical(),
  horizontal: () => horizontal(Number(arg ?? 3)),
  kill: () => kill(arg),
  status: () => status(),
  stop: () => stopAll(),
};
if (!commands[cmd]) {
  console.error('Usage: node infra/floci/lab8/scale-test.js vertical | horizontal [N] | kill N | status | stop');
  process.exit(1);
}
Promise.resolve(commands[cmd]()).catch((err) => { console.error(err); process.exit(1); });
