#!/usr/bin/env python3
"""Deterministic helpers for the orchestrate skill (no network, no GitHub).

  sched.py pick STATE.json [--slots N] [--priority demo|path]
      Ready tasks in priority order, with the overlap rule applied, and the
      tasks to claim now (at most N agent tasks). Prints JSON.
  sched.py scope TASK NAMES.txt [--state STATE.json]
      Prints changed files (one per line in NAMES.txt) that are outside the
      task's Scope. Exit 1 if any.
  sched.py overlap TASK_A TASK_B [--state STATE.json]
      Prints the overlapping Scope entries of two tasks.
  sched.py dashboard STATE.json
      Prints the ORCH-DASHBOARD table rows (markdown) for the state file.

STATE.json (kept by the orchestrator in /tmp/orch/state.json):
  {"tasks": {"T07": {"state": "pr-open", "pr": 131, "since": "ISO",
                      "note": "...", "branch": true}, ...},
   "intake": {"I124": {"issue": 124, "title": "...", "kind": "agent|owner",
                       "blockedBy": [37, 42], "scope": ["src/x.ts"],
                       "state": "none"}}}
  state is "done" for a closed issue, "none" when no ORCH-STATE exists,
  otherwise the latest ORCH-STATE value. Tasks missing from "tasks" count
  as "none".
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GRAPH = json.loads((HERE / "tasks.json").read_text())

# Shared files that never block scheduling; the later PR merges main.
EXEMPT = {
    "package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml",
    ".github/dependabot.yml", "CLAUDE.md", "vitest.config.ts",
    "lab/index.html", "src/main.ts",
}
# States whose Scope files are "in flight" for the overlap rule.
IN_FLIGHT = {
    "claimed", "planning", "plan-approved", "implementing", "validating",
    "validated", "ci-wait", "pr-open", "pr-ready",
}
SLOT_STATES = {
    "claimed", "planning", "plan-approved", "implementing", "validating",
    "validated",
}
OWNER_WEIGHT = 3  # an owner task costs human latency; weigh it in path length
GLOB_CHARS = set("*?[{")


def load_tasks(state):
    tasks = {}
    for t in GRAPH["tasks"]:
        tasks[t["id"]] = {
            "id": t["id"], "issue": t["issue"], "title": t["title"],
            "kind": t["kind"], "wave": t["wave"],
            "blockedBy": list(t["blockedByIds"]), "scope": list(t["scopeFiles"]),
            "demo": bool(t.get("demo", False)),
        }
    by_issue = {v["issue"]: k for k, v in tasks.items()}
    for tid, it in (state or {}).get("intake", {}).items():
        by_issue[it["issue"]] = tid
    for tid, it in (state or {}).get("intake", {}).items():
        tasks[tid] = {
            "id": tid, "issue": it["issue"], "title": it.get("title", ""),
            "kind": it.get("kind", "agent"), "wave": 99,
            "blockedBy": [by_issue[n] for n in it.get("blockedBy", []) if n in by_issue],
            "scope": list(it.get("scope", [])), "demo": False,
        }
    return tasks


def st(state, tid):
    if tid in (state or {}).get("intake", {}):
        return state["intake"][tid].get("state", "none")
    return (state or {}).get("tasks", {}).get(tid, {}).get("state", "none")


def expand(p):
    m = re.search(r"\{([^{}]*)\}", p)
    if not m:
        return [p]
    out = []
    for alt in m.group(1).split(","):
        out += expand(p[: m.start()] + alt + p[m.end():])
    return out


def is_glob(p):
    return any(c in GLOB_CHARS for c in p) or p.endswith("/")


def to_re(p):
    if p.endswith("/"):
        p += "**"
    i, out = 0, ""
    while i < len(p):
        if p.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif p.startswith("**", i):
            out += ".*"
            i += 2
        elif p[i] == "*":
            out += "[^/]*"
            i += 1
        elif p[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(p[i])
            i += 1
    return re.compile(out + r"\Z")


def fixed_prefix(p):
    for i, c in enumerate(p):
        if c in GLOB_CHARS:
            return p[:i]
    return p


def overlap(a, b):
    """True if some path can match both Scope entries."""
    for x in expand(a):
        for y in expand(b):
            gx, gy = is_glob(x), is_glob(y)
            if not gx and not gy:
                hit = x == y
            elif gx and not gy:
                hit = bool(to_re(x).match(y))
            elif gy and not gx:
                hit = bool(to_re(y).match(x))
            else:
                px, py = fixed_prefix(x), fixed_prefix(y)
                hit = px.startswith(py) or py.startswith(px)
            if hit:
                return True
    return False


def in_scope(name, scope):
    if name == "pnpm-lock.yaml":
        return True
    for s in scope:
        for e in expand(s):
            if (is_glob(e) and to_re(e).match(name)) or e == name:
                return True
    return False


def task_overlap(ta, tb):
    hits = []
    for a in ta["scope"]:
        if a in EXEMPT:
            continue
        for b in tb["scope"]:
            if b in EXEMPT:
                continue
            if overlap(a, b):
                hits.append([a, b])
    return hits


def tails(tasks, state):
    """Longest remaining path (weighted) from each not-done task to a sink."""
    down = {k: [] for k in tasks}
    for k, t in tasks.items():
        for b in t["blockedBy"]:
            if b in down:
                down[b].append(k)
    memo = {}

    def tail(k, seen=()):
        if k in memo:
            return memo[k]
        if k in seen:
            raise SystemExit(f"dependency cycle through {k}")
        w = OWNER_WEIGHT if tasks[k]["kind"] == "owner" else 1
        best = 0
        for d in down[k]:
            if st(state, d) != "done":
                best = max(best, tail(d, seen + (k,)))
        memo[k] = w + best
        return memo[k]

    return {k: tail(k) for k in tasks if st(state, k) != "done"}


def cmd_pick(state, slots, priority):
    tasks = load_tasks(state)
    tl = tails(tasks, state)
    in_flight = [
        k for k in tasks
        if st(state, k) in IN_FLIGHT
        or (st(state, k) == "blocked" and state.get("tasks", {}).get(k, {}).get("branch"))
    ]
    ready = [
        k for k, t in tasks.items()
        if st(state, k) in ("none", "released")
        and all(st(state, b) == "done" for b in t["blockedBy"])
    ]

    def key(k):
        t = tasks[k]
        demo_first = 0 if (priority == "demo" and t["demo"]) else 1
        return (demo_first, -tl.get(k, 0), t["wave"], int(re.sub(r"\D", "", k) or 0))

    ready.sort(key=key)
    used = sum(1 for k in tasks if st(state, k) in SLOT_STATES)
    free = max(0, slots - used)
    rows, pick, taken = [], [], list(in_flight)
    for k in ready:
        t = tasks[k]
        row = {"id": k, "issue": t["issue"], "kind": t["kind"], "tail": tl.get(k, 0),
               "demo": t["demo"], "overlapsWith": []}
        if t["kind"] == "owner":
            row["action"] = "waiting-owner"
        else:
            for o in taken:
                h = task_overlap(t, tasks[o])
                if h:
                    row["overlapsWith"].append({"task": o, "files": h})
            if row["overlapsWith"]:
                row["action"] = "skip-overlap"
            elif len(pick) < free:
                row["action"] = "claim"
                pick.append(k)
                taken.append(k)
            else:
                row["action"] = "wait-slot"
        rows.append(row)
    done = sum(1 for k in tasks if st(state, k) == "done")
    print(json.dumps({"slotsUsed": used, "slotsFree": free, "claim": pick,
                      "ownerReady": [r["id"] for r in rows if r["kind"] == "owner"],
                      "done": done, "total": len(tasks), "ready": rows}, indent=1))


def cmd_scope(tid, names_file, state):
    tasks = load_tasks(state)
    names = [l.strip() for l in Path(names_file).read_text().splitlines() if l.strip()]
    bad = [n for n in names if not in_scope(n, tasks[tid]["scope"])]
    for n in bad:
        print(n)
    sys.exit(1 if bad else 0)


def cmd_dashboard(state):
    tasks = load_tasks(state)
    rows = []
    for k, t in tasks.items():
        s = st(state, k)
        if s in ("done", "none", "released"):
            continue
        e = state.get("tasks", {}).get(k) or state.get("intake", {}).get(k) or {}
        pr = f"#{e['pr']}" if e.get("pr") else ""
        note = str(e.get("note", "")).replace("|", "/")[:80]
        rows.append(f"| {k} | #{t['issue']} | {s} | {pr} | {e.get('since', '')} | {note} |")
    print("| Task | Issue | State | PR | Since | Note |")
    print("|---|---|---|---|---|---|")
    print("\n".join(rows))


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    args = argv[1:]

    def opt(name, default=None):
        if name in args:
            i = args.index(name)
            v = args[i + 1]
            del args[i:i + 2]
            return v
        return default

    slots = int(opt("--slots", "3"))
    priority = opt("--priority", "demo")
    state_path = opt("--state")
    cmd = args[0]
    if cmd == "pick":
        cmd_pick(json.loads(Path(args[1]).read_text()), slots, priority)
    elif cmd == "scope":
        state = json.loads(Path(state_path).read_text()) if state_path else {}
        cmd_scope(args[1], args[2], state)
    elif cmd == "overlap":
        state = json.loads(Path(state_path).read_text()) if state_path else {}
        tasks = load_tasks(state)
        print(json.dumps(task_overlap(tasks[args[1]], tasks[args[2]])))
    elif cmd == "dashboard":
        cmd_dashboard(json.loads(Path(args[1]).read_text()))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
