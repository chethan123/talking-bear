#!/usr/bin/env bash
# Usage: bash scripts/check-compose-headers.sh [base-url]        (default https://localhost:8443)
#        The front's plain-HTTP port is ${HTTP_BASE_URL:-http://localhost:8080}.
#
# X-P4 (plan §5, §4.8.3 "Where headers live", Q5; issue #110): the image's headers arrive exactly once and unchanged
# through the deploy/compose topology, front Caddy (TLS, redirect, HSTS) → sidecar Caddy (plain reverse_proxy) →
# the image. Start the stack first:
#
#   docker compose -f deploy/compose/compose.yml up -d && bash scripts/check-compose-headers.sh
#
# It sources scripts/check-headers.sh and runs its 200/304/404 cases through the front, with curl -k (the front's
# certificate comes from Caddy's internal CA). On top of those:
#   - every response carries exactly one Strict-Transport-Security field, the front's value, and exactly two Via
#     fields, `1.1 Caddy` from each proxy (RFC 9110 §7.6.3: every proxy appends one, so via is the one name that
#     may repeat);
#   - no other header field name appears twice on /, /sw.js and the module JS asset. These checks run first, so a
#     duplicated header fails as a duplicate, not as a wrong value;
#   - the module JS asset keeps Content-Encoding: br and the image's own ETag, base64url(sha256(identity
#     bytes))[:16] plus .br (server/handler.go), and its br ETag still revalidates to a 304: the sidecar does not
#     re-encode;
#   - / reaches a client that accepts gzip as the identity bytes the image serves, with their ETag and no Vary: no
#     Caddy runs `encode`;
#   - the front redirects ${HTTP_BASE_URL:-http://localhost:8080}/ (its port 80) to https://localhost/ with a 308.
#
# Via is the one header name that may repeat (ORCH-NOTE 6085261694 on #110): Caddy appends `Via: 1.1 Caddy` at every
# reverse_proxy hop and cannot turn it off, so it is asserted exactly instead. A plain HSTS set at the sidecar only
# sends the same bytes as the front's `?` set, so no black-box check can tell them apart.
#
# Expected values come from ${HEADERS_JSON:-server/headers.json}. Exits 1 on the first failed assertion and prints
# its case. Needs bash, curl, jq, openssl and coreutils.
set -euo pipefail

# shellcheck source=scripts/check-headers.sh
source "$(dirname "${BASH_SOURCE[0]}")/check-headers.sh"

# Caddyfile.front sets it only if absent (?Strict-Transport-Security), and the image never sends it.
hsts='max-age=31536000'
# One Via field per proxy: the sidecar's, then the front's.
via=$'1.1 Caddy\n1.1 Caddy'

# case_extra (replaces check-headers.sh's no-op): the case's last response has exactly one HSTS field and exactly
# the two Via fields.
case_extra() {
  local got
  expect_header Strict-Transport-Security "$hsts"
  got=$(header Via)
  [ "$got" = "$via" ] || fail "Via: expected two fields '1.1 Caddy', got '${got//$'\n'/|}'"
}

# etag_base <file>: the first 16 characters of base64url(sha256(file)), as server/handler.go's etagBase computes.
etag_base() {
  openssl dgst -sha256 -binary "$1" | base64 -w 0 | tr '+/' '-_' | cut -c 1-16
}

case_duplicates_sw() {
  begin 'GET /sw.js (duplicate header names)'
  expect_unique_header_names /sw.js
}

case_duplicates_asset() {
  begin "GET $asset (duplicate header names)"
  expect_unique_header_names "$asset"
}

# The module JS asset's br variant arrives as the image serves it. Needs asset from case_asset.
case_passthrough() {
  local br_etag tag
  begin "GET $asset (Content-Encoding: br and ETag passed through)"
  fetch GET "$asset" -H 'Accept-Encoding: identity'
  expect_status 200
  expect_no_header Content-Encoding
  tag=$(etag_base "$tmp/body")
  expect_header ETag "\"$tag\""
  fetch GET "$asset" -H 'Accept-Encoding: br'
  expect_status 200
  expect_header Content-Encoding br
  expect_header ETag "\"$tag.br\""
  expect_header Vary Accept-Encoding
  br_etag=$(header ETag)
  fetch GET "$asset" -H 'Accept-Encoding: br' -H "If-None-Match: $br_etag"
  expect_status 304
  expect_header ETag "$br_etag"
}

# / (index.html, under precompress.mjs's 1 KB floor, so the image has no compressed variant) reaches a client that
# accepts gzip as the image serves it: identity, with the ETag of those bytes and no Vary. An `encode` at either
# Caddy would gzip it, add Vary and rewrite the ETag (plan §4.8.3).
case_identity_passthrough() {
  local tag
  begin 'GET / (Accept-Encoding: gzip, identity passed through)'
  fetch GET / -H 'Accept-Encoding: gzip'
  expect_status 200
  expect_no_header Content-Encoding
  expect_no_header Vary
  tag=$(etag_base "$tmp/body")
  expect_header ETag "\"$tag\""
}

# The front's HTTP→HTTPS redirect, outside run_cases: a plain-HTTP response carries no HSTS and no Via.
case_redirect() {
  local out
  begin "GET $http_base/ (HTTP→HTTPS redirect)"
  out=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' "$http_base/") \
    || fail "curl failed: GET $http_base/"
  [ "$out" = '308 https://localhost/' ] || fail "expected '308 https://localhost/', got '$out'"
}

# wait_ready: the whole chain answers /healthz with 204 within 60 s (up -d returns before Caddy serves).
wait_ready() {
  local deadline=$((SECONDS + 60)) code
  until code=$(curl -sS --max-time 5 "${curl_opts[@]}" -o /dev/null -w '%{http_code}' "$base/healthz" 2>/dev/null)
    [ "$code" = 204 ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "$base/healthz did not answer 204 within 60 s"
    sleep 1
  done
}

if [ "$#" -gt 1 ]; then
  echo "usage: bash scripts/check-compose-headers.sh [base-url]" >&2
  exit 2
fi
base=${1:-https://localhost:8443}
base=${base%/}
json=${HEADERS_JSON:-server/headers.json}
http_base=${HTTP_BASE_URL:-http://localhost:8080}
http_base=${http_base%/}
curl_opts=(-k)
repeatable_headers=(via)
case_name='setup'
passed=0
require_tools
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
load_expected
wait_ready
# The duplicate checks on / and /sw.js, check-headers.sh's 200/304/404 cases in its order, the duplicate check on the
# asset (case_asset finds it), the two pass-through checks and the redirect.
run_cases case_duplicates case_duplicates_sw case_root case_sw case_manifest case_asset case_duplicates_asset \
  case_not_found case_revalidate case_head case_passthrough case_identity_passthrough
case_redirect
pass
echo "check-compose-headers: all $passed cases passed against $base ($json)"
