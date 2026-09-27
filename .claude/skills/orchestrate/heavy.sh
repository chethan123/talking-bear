#!/usr/bin/env bash
# Runs ONE heavy command (browser, vite preview, Playwright, vitest --project browser,
# Docker, Go server) under the shared machine lock, freeing the shared ports
# 4173-4175 and 8080-8082 before and after, and killing anything the command left
# running, so a leaked server can neither hold the lock nor break the next run.
#
#   cd <worktree> && bash .claude/skills/orchestrate/heavy.sh '<command>'
#
# Always call it with Bash run_in_background: true (waiting for the lock can take
# longer than a foreground call's timeout).
# Exit 75 = the lock wasn't free within HEAVY_WAIT seconds (default 1800): a lock
# timeout, not a test failure. Otherwise the command's own exit code.
set -u
[ $# -eq 1 ] || { echo "usage: heavy.sh '<command>'" >&2; exit 2; }
# -o: the lock fd is not inherited by the command, so leaked children can't hold it.
exec flock -o -E 75 -w "${HEAVY_WAIT:-1800}" /tmp/talking-bear-heavy.lock bash -c '
free_ports() { for p in 4173 4174 4175 8080 8081 8082; do fuser -k -n tcp "$p" >/dev/null 2>&1; done; }
free_ports
# Own session and process group, so everything the command starts can be killed after.
setsid bash -c "$1" &
pid=$!
wait "$pid"; rc=$?
kill -TERM -- "-$pid" 2>/dev/null; sleep 1; kill -KILL -- "-$pid" 2>/dev/null
free_ports
exit $rc' heavy "$1"
