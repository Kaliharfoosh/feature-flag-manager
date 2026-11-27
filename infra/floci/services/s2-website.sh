#!/usr/bin/env bash
set -euo pipefail
# S2 (Habiba) on Floci: the React frontend as an S3 static website, calling ffm-http-api.
#
#   Amazon S3   bucket ffm-web, website hosting (index.html also answers unknown paths, so React
#               routes like /flags/123/rollout work on reload), read-only public policy.
#   The site:   http://ffm-web.s3-website.localhost.floci.io:4566
#
# The bucket was first made by hand for Lab 7 (16 Nov); this script makes it repeatable, and every
# run uploads the CURRENT frontend. Re-run it after any frontend change, or the Floci site stays old
# (the 16 Nov copy had no login bot check and no monitoring page).
#
# Run from Git Bash, Floci running, AFTER s2-lambdas.sh (it needs the API Gateway id):
#   bash infra/floci/services/s2-website.sh
# Nothing secret goes into the site: the bundle holds only the API address. The Turnstile site key
# comes from the API at run time (/api/v1/auth/config).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
cd "$REPO"

BUCKET="ffm-web"
OUT="build/web-floci"   # ignored by git; separate from frontend/dist, which Vercel uses

echo "=== [0/4] Checks ==="
command -v aws >/dev/null || { echo "AWS CLI not found. Install it first."; exit 1; }
awsl sts get-caller-identity >/dev/null 2>&1 \
  || { echo "Floci is not answering on ${ENDPOINT}. Start it:  docker compose -f infra/floci/docker-compose.yml up -d"; exit 1; }
API=$(awsl apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
if [ -z "$API" ] || [ "$API" = "None" ]; then
  echo "API Gateway ${API_NAME} not found. Run s2-lambdas.sh first."; exit 1
fi
API_BASE="http://${API}.execute-api.localhost.floci.io:4566"
echo "  API         ${API_BASE}"
echo "[0/4] done"

echo "=== [1/4] Build the frontend with VITE_API_BASE=${API_BASE} ==="
[ -d frontend/node_modules ] || npm --prefix frontend ci --no-audit --no-fund
rm -rf "$OUT"
(cd frontend && VITE_API_BASE="$API_BASE" npx vite build --outDir "../${OUT}" --emptyOutDir --logLevel warn)
[ -f "$OUT/index.html" ] || { echo "Build failed: ${OUT}/index.html missing."; exit 1; }
echo "  built       ${OUT} ($(find "$OUT" -type f | wc -l | tr -d ' ') files)"
echo "[1/4] done"

echo "=== [2/4] S3 bucket ${BUCKET}: website hosting + read-only public policy ==="
ok awsl s3api create-bucket --bucket "$BUCKET"
# index.html for "/" and for every unknown path, so the React router handles deep links.
awsl s3api put-bucket-website --bucket "$BUCKET" \
  --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}'
# Block Public Access is on by default for new buckets (as on AWS) and refuses any public policy.
# A public website needs exactly one exception: allow a public bucket POLICY. Public ACLs stay
# blocked, so the read-only policy below is the only way in.
awsl s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
# Anyone may READ the site files (that is what a public website is). Nobody may list, write or
# delete through this policy; uploads use this script's own credentials.
cat > "build/tmp-web-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [ { "Sid": "PublicReadWebsiteFilesOnly", "Effect": "Allow",
  "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::${BUCKET}/*" } ] }
JSON
awsl s3api put-bucket-policy --bucket "$BUCKET" --policy file://build/tmp-web-policy.json
rm -f build/tmp-web-policy.json
echo "  bucket      ${BUCKET} (website on, GetObject only)"
echo "[2/4] done"

echo "=== [3/4] Upload (old files removed) ==="
# Hashed assets can be cached for a long time; index.html must always be fetched fresh, or a
# browser keeps loading the old bundle after a redeploy.
awsl s3 sync "$OUT" "s3://${BUCKET}" --delete --exclude index.html \
  --cache-control "public, max-age=31536000, immutable" --only-show-errors
awsl s3 cp "$OUT/index.html" "s3://${BUCKET}/index.html" \
  --cache-control "no-cache" --content-type "text/html" --only-show-errors
echo "  uploaded    $(awsl s3 ls "s3://${BUCKET}" --recursive | wc -l | tr -d ' ') files"
echo "[3/4] done"

echo "=== [4/4] Self-test ==="
FAILED=0
pass() { echo "  $1  ok"; }
fail() { echo "  $1  FAILED${2:+: $2}"; FAILED=1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "${WEB_ORIGIN}/")
[ "$code" = 200 ] && pass "site /                          200" || fail "site /" "HTTP ${code}"
# A React route the bucket does not have as a file must still give the app.
if curl -s "${WEB_ORIGIN}/flags/self-test/rollout" | grep -q '<div id="root">'; then
  pass "deep link /flags/…/rollout      app"
else
  fail "deep link /flags/…/rollout" "index.html not served"
fi
BUNDLE=$(curl -s "${WEB_ORIGIN}/" | grep -o 'assets/[^"]*\.js' | head -1)
JS=$(curl -s "${WEB_ORIGIN}/${BUNDLE}")
echo "$JS" | grep -q "$API_BASE" && pass "bundle calls ${API}               " || fail "bundle API address" "not ${API_BASE}"
echo "$JS" | grep -q "X-Turnstile-Token" && pass "bundle sends the login bot check " || fail "bundle bot check"
# The browser asks the API first (CORS preflight); the API must allow this site's origin.
allow=$(curl -s -o /dev/null -D - -X OPTIONS "${API_BASE}/api/v1/auth/login" -H "Origin: ${WEB_ORIGIN}" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,x-turnstile-token" \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
[ "$allow" = "$WEB_ORIGIN" ] && pass "API allows this site (CORS)      " || fail "CORS" "allow-origin '${allow}'"
# The login page's bot check needs a site key from the API (503 = no Turnstile keys on Floci).
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: ${WEB_ORIGIN}" "${API_BASE}/api/v1/auth/config")
[ "$code" = 200 ] && pass "login config /auth/config        200" || fail "login config" "HTTP ${code} (re-run s2-lambdas.sh)"

if [ "$FAILED" != 0 ]; then echo; echo "Something did not work (see above)."; exit 1; fi
echo
echo "Website deployed: ${WEB_ORIGIN}"
