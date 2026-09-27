#!/usr/bin/env bash
# Runs ONE heavy command (browser, vite preview, Playwright, vitest --project browser,
# Docker, Go server) under the shared machine lock, freeing the shared ports
# 4173-4175 and 8080-8082 before and after, so a leaked server can't break the next run.
#
#   cd <worktree> && bash .claude/skills/orchestrate/heavy.sh '<command>'
#
# Exit 75 = the lock wasn't free within HEAVY_WAIT seconds (default 1800): a lock
# timeout, not a test failure. Otherwise the command's own exit code.
set -u
[ $# -eq 1 ] || { echo "usage: heavy.sh '<command>'" >&2; exit 2; }
exec flock -E 75 -w "${HEAVY_WAIT:-1800}" /tmp/talking-bear-heavy.lock bash -c '
free_ports() { for p in 4173 4174 4175 8080 8081 8082; do fuser -k -n tcp "$p" >/dev/null 2>&1; done; }
free_ports
bash -c "$1"; rc=$?
free_ports
exit $rc' heavy "$1"
