#!/usr/bin/env bash
# Usage: bash scripts/check-headers.sh <base-url>        (for example http://localhost:8080)
#
# Asserts the response headers of a running image (plan §4.8.3, §7 M7 `image-smoke`, issue #107). The expected
# header values are read with jq from ${HEADERS_JSON:-server/headers.json}, the file the Go server embeds.
# Exits 1 on the first failed assertion and prints its case. Needs bash, curl and jq only.
#
# GET / is not asserted as brotli: precompress.mjs skips files under 1 KB, and the built index.html is smaller,
# so / is served identity, with no .br ETag and no Vary (plan §4.8.2, §4.8.3). Its encoding, ETag suffix and Vary
# must agree instead, and the brotli assertions run on the module JS asset (ORCH-NOTE 6083551330 on #107).
#
# Sourceable (ORCH-NOTE 6084408281 on #110): sourcing only sets curl_opts and defines the functions, one per case,
# and changes no shell option. scripts/check-compose-headers.sh reuses them. Run directly, main runs the 12 cases.

# Extra options for every curl call: none here. scripts/check-compose-headers.sh sets -k.
curl_opts=()
# Lower-case header names that expect_unique_header_names lets repeat: none here. scripts/check-compose-headers.sh
# allows via, which every proxy appends to (RFC 9110 §7.6.3).
repeatable_headers=()

# fail <message>: prints the failed case and exits 1. Never call it inside $(...): it would only end the subshell.
fail() {
  printf 'check-headers: FAIL [%s] %s\n' "$case_name" "$1" >&2
  exit 1
}

# begin <case>: names the case that the following assertions belong to.
begin() {
  case_name=$1
}

# pass: the current case's assertions all held.
pass() {
  passed=$((passed + 1))
  printf 'check-headers: ok   [%s]\n' "$case_name"
}

# require_tools: curl and jq are installed, and $json is readable.
require_tools() {
  command -v curl >/dev/null || fail 'curl not found'
  command -v jq >/dev/null || fail 'jq not found'
  [ -r "$json" ] || fail "cannot read HEADERS_JSON=$json"
}

# json_value <jq filter>: prints the string that the filter selects in $json, or fails if there is none. Use it
# as `var=$(json_value …)`: under set -e, a failed assignment ends the script with the subshell's status.
json_value() {
  jq -er "$1 | strings" "$json" || fail "$json has no string at $1"
}

# load_expected: reads the expected values from $json into csp, cc_*, mime_*, html_only and security_headers.
load_expected() {
  csp=$(json_value '.common["Content-Security-Policy"]')
  # bearserve rewrites / to /index.html before its lookup, so / gets the /index.html rule; the "/" rule (vite
  # preview) must agree with it.
  cc_root=$(json_value '.cacheControl[] | select(.match == "/index.html") | .value')
  cc_slash=$(json_value '.cacheControl[] | select(.match == "/") | .value')
  [ "$cc_slash" = "$cc_root" ] \
    || fail "$json: Cache-Control rule \"/\" ($cc_slash) differs from \"/index.html\" ($cc_root)"
  cc_sw=$(json_value '.cacheControl[] | select(.match == "/sw.js") | .value')
  cc_manifest=$(json_value '.cacheControl[] | select(.match == "/manifest.webmanifest") | .value')
  cc_assets=$(json_value '.cacheControl[] | select(.match == "/assets/**") | .value')
  cc_error=$(json_value '.errorCacheControl')
  mime_js=$(json_value '.mime[".js"]')
  mime_manifest=$(json_value '.mime[".webmanifest"]')
  # The HTML-only header names (an empty list until Trusted Types Report-Only lands, plan §4.8.3), one per line.
  html_only=$(jq -er '.htmlOnly | if type == "object" then keys | join("\n") else error("not an object") end' "$json") \
    || fail "$json: .htmlOnly must be an object"
  # The common security headers that every response carries, besides the CSP (issue #107, case 1).
  security_headers=(Permissions-Policy Cross-Origin-Opener-Policy Cross-Origin-Resource-Policy X-Content-Type-Options
    Referrer-Policy)
}

# fetch <method> <path> [curl args...]: one request. Sets $status and $body_bytes (bytes of body received); the
# response's header fields, without CRs, are in $tmp/headers and its body in $tmp/body.
fetch() {
  local method=$1 path=$2 out
  shift 2
  rm -f "$tmp/raw" "$tmp/body" # curl leaves no file for an empty body: never read the previous response's
  if [ "$method" = HEAD ]; then
    # -I sends HEAD and reads no body; -X HEAD would wait for one.
    out=$(curl -sS --max-time 10 "${curl_opts[@]}" -I -D "$tmp/raw" -o /dev/null -w '%{http_code} %{size_download}' \
      "$@" "$base$path") || fail "curl failed: HEAD $base$path"
  else
    out=$(curl -sS --max-time 10 "${curl_opts[@]}" -X "$method" -D "$tmp/raw" -o "$tmp/body" \
      -w '%{http_code} %{size_download}' "$@" "$base$path") || fail "curl failed: $method $base$path"
  fi
  status=${out%% *}
  body_bytes=${out##* }
  tr -d '\r' <"$tmp/raw" >"$tmp/headers"
}

# header <name>: every value of header <name> in the last response, one per line; empty if there is none.
header() {
  { grep -i "^$1:" "$tmp/headers" || true; } | sed -e 's/^[^:]*:[[:space:]]*//' -e 's/[[:space:]]*$//'
}

expect_status() {
  [ "$status" = "$1" ] || fail "status: expected $1, got $status"
}

# expect_header <name> <value>: the response has exactly one <name> field, equal to <value>.
expect_header() {
  local got
  got=$(header "$1")
  [ "$got" = "$2" ] || fail "$1: expected '$2', got '${got:-(none)}'"
}

# expect_header_match <name> <extended regex>: the response has exactly one <name> field, matching the regex.
expect_header_match() {
  local got
  got=$(header "$1")
  [[ "$got" != *$'\n'* && "$got" =~ $2 ]] || fail "$1: expected a match for $2, got '${got:-(none)}'"
}

expect_no_header() {
  local got
  got=$(header "$1")
  [ -z "$got" ] || fail "$1: expected none, got '$got'"
}

# expect_unique_header_names <path>: GET <path> with no extra request header; no header field name appears twice
# (a duplicated CSP is enforced twice: plan §4.8.3), except those in repeatable_headers. Leaves the header fields,
# without CRs, in $tmp/headers.
expect_unique_header_names() {
  local dups name
  curl -sS --max-time 10 "${curl_opts[@]}" -D - -o /dev/null "$base$1" >"$tmp/raw" || fail "curl failed: GET $base$1"
  tr -d '\r' <"$tmp/raw" >"$tmp/headers"
  dups=$(sed -n 's/^\([^:[:space:]]*\):.*/\1/p' "$tmp/headers" | tr '[:upper:]' '[:lower:]' | sort | uniq -d)
  for name in "${repeatable_headers[@]}"; do
    dups=$({ grep -vxF -- "$name" <<<"$dups" || true; })
  done
  [ -z "$dups" ] || fail "duplicate header names: $(printf '%s' "$dups" | tr '\n' ' ')"
}

# The cases, in main's order. Each one begins its case and makes its assertions; run_cases passes it. Case 8 needs
# root_etag from case 1, and cases 9 and 10 need asset from case 4.

# 1. GET / with Accept-Encoding: br. ORCH-NOTE 6083551330: encoding, ETag suffix and Vary agree.
case_root() {
  local name value
  begin 'GET / (Accept-Encoding: br)'
  fetch GET / -H 'Accept-Encoding: br'
  expect_status 200
  expect_header Content-Security-Policy "$csp"
  for name in "${security_headers[@]}"; do
    value=$(json_value ".common[\"$name\"]")
    expect_header "$name" "$value"
  done
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    value=$(json_value ".htmlOnly[\"$name\"]")
    expect_header "$name" "$value"
  done <<<"$html_only"
  expect_header Cache-Control "$cc_root"
  expect_header_match ETag '^"[A-Za-z0-9_-]{16}(\.br)?"$'
  root_etag=$(header ETag)
  case "$(header Content-Encoding)" in
    br)
      [[ "$root_etag" == *'.br"' ]] || fail "ETag: Content-Encoding is br, but $root_etag has no .br suffix"
      expect_header Vary Accept-Encoding
      ;;
    '')
      [[ "$root_etag" != *'.br"' ]] || fail "ETag: $root_etag has a .br suffix, but there is no Content-Encoding"
      expect_no_header Vary
      ;;
    *) fail "Content-Encoding: expected br or none, got '$(header Content-Encoding)'" ;;
  esac
}

# 2. /sw.js
case_sw() {
  begin 'GET /sw.js'
  fetch GET /sw.js
  expect_status 200
  expect_header Cache-Control "$cc_sw"
  expect_header Content-Type "$mime_js"
  expect_header Content-Security-Policy "$csp" # a worker's policy comes from its own response (plan §4.8.3)
}

# 3. /manifest.webmanifest
case_manifest() {
  begin 'GET /manifest.webmanifest'
  fetch GET /manifest.webmanifest
  expect_status 200
  expect_header Content-Type "$mime_manifest"
  expect_header Cache-Control "$cc_manifest"
}

# 4. The module JS asset that index.html loads, with Accept-Encoding: br (the brotli assertions, ORCH-NOTE
# 6083551330).
case_asset() {
  begin 'GET <module asset> (Accept-Encoding: br)'
  fetch GET / -H 'Accept-Encoding: identity'
  expect_status 200
  asset=$({ grep -o '<script[^>]*type="module"[^>]*>' "$tmp/body" || true; } | head -n 1 \
    | sed -n 's/.* src="\([^"]*\)".*/\1/p')
  [[ "$asset" =~ ^/assets/[^/]+\.js$ ]] || fail "index.html: no module script src under /assets/ (got '$asset')"
  begin "GET $asset (Accept-Encoding: br)"
  fetch GET "$asset" -H 'Accept-Encoding: br'
  expect_status 200
  expect_header Cache-Control "$cc_assets"
  expect_header Content-Type "$mime_js"
  expect_header Content-Security-Policy "$csp"
  expect_header Content-Encoding br
  expect_header_match ETag '^"[A-Za-z0-9_-]{16}\.br"$'
  expect_header Vary Accept-Encoding
}

# 5. /healthz
case_healthz() {
  begin 'GET /healthz'
  fetch GET /healthz
  expect_status 204
  expect_header Cache-Control "$cc_error"
}

# 6. An unknown path
case_not_found() {
  begin 'GET /does-not-exist'
  fetch GET /does-not-exist
  expect_status 404
  expect_header Cache-Control "$cc_error"
}

# 7. A method other than GET and HEAD
case_post() {
  begin 'POST /'
  fetch POST / --data ''
  expect_status 405
  expect_header Allow 'GET, HEAD'
}

# 8. A revalidation with the ETag from case 1, with the same Accept-Encoding, so the same variant is selected.
case_revalidate() {
  begin "GET / (If-None-Match: $root_etag)"
  fetch GET / -H 'Accept-Encoding: br' -H "If-None-Match: $root_etag"
  expect_status 304
  expect_header Content-Security-Policy "$csp"
}

# 9. A satisfiable range of the identity JS asset
case_range() {
  begin "GET $asset (Range: bytes=0-9, Accept-Encoding: identity)"
  fetch GET "$asset" -H 'Range: bytes=0-9' -H 'Accept-Encoding: identity'
  expect_status 206
  expect_header_match Content-Range '^bytes 0-9/[0-9]+$'
}

# 10. An unsatisfiable range
case_range_unsatisfiable() {
  begin "GET $asset (Range: bytes=99999999-, Accept-Encoding: identity)"
  fetch GET "$asset" -H 'Range: bytes=99999999-' -H 'Accept-Encoding: identity'
  expect_status 416
}

# 11. HEAD /
case_head() {
  begin 'HEAD /'
  fetch HEAD /
  expect_status 200
  [ "$body_bytes" = 0 ] || fail "body: expected none, got $body_bytes bytes"
  expect_header_match Content-Length '^[0-9]+$'
}

# 12. No header field appears twice on /.
case_duplicates() {
  begin 'GET / (duplicate header names)'
  expect_unique_header_names /
}

# case_extra: more assertions on each case's last response, made before it passes. None here;
# scripts/check-compose-headers.sh redefines it.
case_extra() {
  :
}

# run_cases <case function>...: runs each case, then case_extra, then passes it.
run_cases() {
  local c
  for c in "$@"; do
    "$c"
    case_extra
    pass
  done
}

main() {
  set -euo pipefail
  if [ "$#" -ne 1 ]; then
    echo "usage: bash scripts/check-headers.sh <base-url>" >&2
    exit 2
  fi
  base=${1%/}
  json=${HEADERS_JSON:-server/headers.json}
  case_name='setup'
  passed=0
  require_tools
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  load_expected
  run_cases case_root case_sw case_manifest case_asset case_healthz case_not_found case_post case_revalidate \
    case_range case_range_unsatisfiable case_head case_duplicates
  echo "check-headers: all $passed cases passed against $base ($json)"
}

# Not `[[ … ]] && main "$@"`: sourced, that list would end with status 1 and so end a caller running under set -e.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
