#!/bin/bash
cd "$(dirname "$0")"
# prerequisites: npm install; a 600 KB stand-in for the Silero weights; production build in dist/.
# dist-tt (Trusted Types enforced) is dist/ with a trustedTypes default policy (createScriptURL: same-origin only)
# prepended to the entry chunk; see README.
[ -f src/weights.bin ] || head -c 600000 /dev/urandom > src/weights.bin
[ -d dist ] || npx vite build
run() { node server.mjs "$1" "$2" "$3" > "srv_$2.log" 2>&1 & SP=$!; sleep 1; timeout 120 node run.mjs "$2" "$4" 2>&1 | tail -45; kill $SP 2>/dev/null; wait $SP 2>/dev/null; }
run dist 8089 report "TT report-only, no default policy"
run dist-tt 8090 enforce "TT ENFORCED + default policy"
npx playwright --version
