#!/usr/bin/env python3
"""Deterministic helpers for the orchestrate skill (no network, no GitHub).

  sched.py pick STATE.json [--slots N] [--priority demo|path]
      Ready tasks in priority order, with the overlap rule applied, and the
      tasks to claim now (at most N agent tasks). Prints JSON.
  sched.py scope TASK NAMES.txt --state STATE.json
      Prints changed files (one per line in NAMES.txt) that are outside the
      task's Scope. Exit 1 if any, 0 if none, 2 on any error (never treat 2
      as "out of scope").
  sched.py overlap TASK_A TASK_B [--state STATE.json]
      Prints the overlapping Scope entries of two tasks.
  sched.py dashboard STATE.json
      Prints the ORCH-DASHBOARD table rows (markdown) for the state file.

STATE.json (kept by the orchestrator in /tmp/orch/state.json):
  {"tasks": {"T07": {"state": "pr-open", "pr": 131, "since": "ISO",
                      "note": "...", "branch": true}, ...},
   "intake": {"I124": {"issue": 124, "title": "...", "kind": "agent|owner",
                       "blockedBy": [37, 42], "scope": ["src/x.ts"],
                       "state": "none"}},
   "closedIssues": [2, 124]}
  state is "done" for a closed issue, "none" when no ORCH-STATE exists,
  otherwise the latest ORCH-STATE value ("merged-done" also counts as done).
  Tasks missing from "tasks" count as "none". An intake blocker that is
  neither a task nor listed in closedIssues counts as NOT done.
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


DONE_STATES = {"done", "merged-done"}


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
    closed = set((state or {}).get("closedIssues", []))
    for tid, it in (state or {}).get("intake", {}).items():
        blockers = []
        for n in it.get("blockedBy", []):
            if n in by_issue:
                blockers.append(by_issue[n])
            elif n not in closed:
                blockers.append(f"#{n}")  # unknown, open or unverified: never done
        tasks[tid] = {
            "id": tid, "issue": it["issue"], "title": it.get("title", ""),
            "kind": it.get("kind", "agent"), "wave": 99,
            "blockedBy": blockers, "scope": list(it.get("scope", [])), "demo": False,
        }
    return tasks


def st(state, tid):
    if tid.startswith("#"):
        return "none"  # unknown blocker issue
    if tid in (state or {}).get("intake", {}):
        v = state["intake"][tid].get("state", "none")
    else:
        v = (state or {}).get("tasks", {}).get(tid, {}).get("state", "none")
    return "done" if v in DONE_STATES else v


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


def seg_compatible(x, y):
    """Can one path segment match both segment patterns (no '/' inside)?"""
    gx, gy = any(c in GLOB_CHARS for c in x), any(c in GLOB_CHARS for c in y)
    if not gx and not gy:
        return x == y
    if gx and not gy:
        return bool(to_re(x).match(y))
    if gy and not gx:
        return bool(to_re(y).match(x))
    px, py = fixed_prefix(x), fixed_prefix(y)
    return px.startswith(py) or py.startswith(px)  # conservative within a segment


def segs_overlap(xs, ys):
    if not xs and not ys:
        return True
    if xs and xs[0] == "**":
        return segs_overlap(xs[1:], ys) or (bool(ys) and segs_overlap(xs, ys[1:]))
    if ys and ys[0] == "**":
        return segs_overlap(xs, ys[1:]) or (bool(xs) and segs_overlap(xs[1:], ys))
    if not xs or not ys:
        return False
    return seg_compatible(xs[0], ys[0]) and segs_overlap(xs[1:], ys[1:])


def split_pattern(p):
    if p.endswith("/"):
        p += "**"
    return [s for s in p.split("/") if s != ""]


def overlap(a, b):
    """True if some path can match both Scope entries."""
    for x in expand(a):
        for y in expand(b):
            if segs_overlap(split_pattern(x), split_pattern(y)):
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
            raise CycleError(k)
        w = OWNER_WEIGHT if tasks[k]["kind"] == "owner" else 1
        best = 0
        for d in down[k]:
            if st(state, d) != "done":
                best = max(best, tail(d, seen + (k,)))
        memo[k] = w + best
        return memo[k]

    out, cyclic = {}, set()
    for k in tasks:
        if st(state, k) == "done":
            continue
        try:
            out[k] = tail(k)
        except CycleError:
            cyclic.add(k)
    return out, cyclic


class CycleError(Exception):
    pass


def cmd_pick(state, slots, priority):
    tasks = load_tasks(state)
    tl, cyclic = tails(tasks, state)
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
        if k in cyclic:
            row["action"] = "cycle"  # post blocked: the dependency graph has a cycle
        elif t["kind"] == "owner":
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
    warnings = []
    if priority == "demo" and not any(t["demo"] for t in tasks.values()):
        warnings.append("PRIORITY=demo but no task has demo=true in tasks.json")
    if cyclic:
        warnings.append("dependency cycle among: " + ", ".join(sorted(cyclic)))
    print(json.dumps({"warnings": warnings, "slotsUsed": used, "slotsFree": free, "claim": pick,
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
        if not state_path:
            raise SystemExit("scope needs --state /tmp/orch/state.json")
        cmd_scope(args[1], args[2], json.loads(Path(state_path).read_text()))
    elif cmd == "overlap":
        state = json.loads(Path(state_path).read_text()) if state_path else {}
        tasks = load_tasks(state)
        print(json.dumps(task_overlap(tasks[args[1]], tasks[args[2]])))
    elif cmd == "dashboard":
        cmd_dashboard(json.loads(Path(args[1]).read_text()))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except SystemExit as e:
        if e.code in (0, 1, None):
            raise
        print(e.code if isinstance(e.code, str) else f"error {e.code}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:  # never let a crash look like "out of scope" (exit 1)
        print(f"sched.py error: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(2)
