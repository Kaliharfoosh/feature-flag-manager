# Creates a THROWAWAY Postgres for the load tests in Docker, with the same tables, grants and
# demo data as Neon, and prints a staging key for it. Neon is never touched.
#
# Usage (PowerShell, repo root, Docker Desktop running):
#   powershell -ExecutionPolicy Bypass -File tests\load\start-local-db.ps1
# Remove it afterwards:
#   docker rm -f ffm-loadtest-db
$ErrorActionPreference = 'Stop'

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) { $docker = $docker.Source } else { $docker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe" }
if (-not (Test-Path $docker)) { throw 'docker.exe not found. Install or start Docker Desktop first.' }

$name = 'ffm-loadtest-db'
$port = 55432
# Local-only passwords for a database that lives a few minutes on your PC.
$owner = "postgres://postgres:postgres@localhost:$port/ffm_load"
$app = "postgres://ffm_app:local-only@localhost:${port}/ffm_load"

& $docker rm -f $name 2>$null | Out-Null
& $docker run -d --name $name -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ffm_load -p "${port}:5432" postgres:16 | Out-Null

Write-Host 'Waiting for Postgres...'
for ($i = 0; $i -lt 60; $i++) {
  & $docker exec $name pg_isready -U postgres -d ffm_load 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 1
}
Start-Sleep -Seconds 2

# The app connects as ffm_app (least privilege), exactly like on Neon and in CI.
& $docker exec $name psql -U postgres -d ffm_load -c "CREATE ROLE ffm_app LOGIN PASSWORD 'local-only'" | Out-Null

# Variables set here win over the values in .env, so these scripts write to the local copy.
$env:DATABASE_URL_MIGRATE = $owner
$env:DATABASE_URL = $app
node --env-file=.env backend/db/migrate.js
node --env-file=.env backend/db/seed.js
node --env-file=.env backend/db/seed-demo.js | Select-Object -First 4
$keyOutput = node --env-file=.env backend/db/seed-key.js
$key = ($keyOutput | Select-Object -Last 1).Trim()

Write-Host ''
Write-Host "Throwaway database ready on port $port."
Write-Host 'Staging key for the load tests (local database only):'
Write-Host $key
