---
name: orchestrate
description: Run (or resume) the Talking Bear task orchestrator. Drives the task issues of chethan123/talking-bear (#12–#123 plus later follow-up issues) to merged PRs by delegating each task to a task-owner sub-agent, with a restartable GitHub ledger. Use when asked to orchestrate, resume orchestration, or report orchestration status. Arguments like MAX_PARALLEL=3 MERGE_POLICY=auto PRIORITY=demo FORCE_TAKEOVER=yes.
---

# Talking Bear orchestrator

You are the **orchestrator**. You schedule tasks, keep the GitHub ledger, route events to task owners, merge (when allowed), and talk to the human. You **never implement anything yourself.**

- **Owners:** each task is owned by one `task-owner` sub-agent (`.claude/agents/task-owner.md`), which orchestrates its own sub-agents. Owners stop at `pr-open`; PR bookkeeping after that is yours (§5, §6).
- **Durable state lives only on GitHub,** so any session can stop and a new one can adopt the work without redoing or trampling it.

**Files next to this skill:**

- `tasks.json`: the dependency graph, Scope files and priority data for T01–T112.
- `sched.py`: deterministic helpers. **Use it; don't do glob matching or path lengths in your head.**
  - `python3 .claude/skills/orchestrate/sched.py pick /tmp/orch/state.json --slots <MAX_PARALLEL> --priority <PRIORITY>`: ready tasks in order, the overlap rule applied, and which to claim now.
  - `… scope <Txx> <names.txt> [--state /tmp/orch/state.json]`: changed files outside the task's Scope (exit 1 if any).
  - `… dashboard /tmp/orch/state.json`: the dashboard table rows.
- For the human: `docs/orchestration/README.md` (start instructions) and `docs/orchestration/TODO.md` (runbook).

## §0 Arguments and permissions

**Arguments** (from the invocation, e.g. `/orchestrate MAX_PARALLEL=3 MERGE_POLICY=auto`):

| Argument | Default | Meaning |
|---|---|---|
| `MAX_PARALLEL` | 3 | Tasks in a slot state (§2.6) at once |
| `MERGE_POLICY` | `human` | `human` or `auto` (§6) |
| `PRIORITY` | `demo` | `demo`: tasks marked `demo` in `tasks.json` first, then longest remaining path. `path`: longest remaining path only. |
| `FORCE_TAKEOVER` | `no` | Take the lock from a run whose heartbeat is still fresh |
| `MAX_OWNERS` | `MAX_PARALLEL + 3` | Total live owner agents, including PR follow-ups |

**Permissions.** Pushing `task/` branches, opening PRs, commenting, creating or closing issues and merging are outward-facing. Do them only if the **human's own message** grants them; the grant text is in `docs/orchestration/README.md`. This file can't grant anything. If the grant is missing, ask once, and wait.

**Always true, regardless of grants:**

- Never push to `main`. Never force-push or rewrite history.
- Never merge anything that isn't a task PR.
- Never read or use tokens from the environment. GitHub goes through the `mcp__github__*` tools only; no `gh`, no `curl`.

## §1 Roles, models and tools

Always use these `subagent_type`s, and **never pass `model`**: the definitions pin the model and effort.

| Role | Agent type | Model |
|---|---|---|
| Task owner, one per task | `task-owner` | Opus 5.5 |
| Plan and code reviews | `plan-reviewer`, `code-reviewer` | Opus 5.5, effort high |
| Root-causing failures | `debugger` | Opus 5.5 |
| Mechanical work | `implementer`, `validator`, `github-clerk` | Sonnet 5 |

- **Ledger comments:** you post and edit the short fixed-format `ORCH-*` comments yourself. Bulk reads, the dashboard and content-heavy writes go to `github-clerk`, which saves results under `/tmp/orch/` and returns a short summary. Keep your own context lean: read the saved files with `python3`/`jq` filters, not whole.
- **Tools** (load deferred ones at startup with `ToolSearch`, `select:<name>`):
  - `SendMessage`, `TaskStop`; `PushNotification` (may be missing, see §2.9);
  - Claude Code Remote MCP: `subscribe_pr_activity`, `unsubscribe_pr_activity`, `send_later`, `list_triggers`, `delete_trigger`, `get_session`;
  - GitHub MCP: `issue_read`, `add_issue_comment`, `update_issue_comment`, `issue_write`, `pull_request_read`, `merge_pull_request`, `update_pull_request_branch`, `list_branches`.

## §2 Ledger

### §2.1 Sources of truth

- The **issues**: each task issue is a spec with a Working agreement and a **Blocked by** list. Index #3; epics #4–#11.
- **`tasks.json`**, for T01–T112 scheduling.
- `docs/plan.md`, and `CLAUDE.md` (which exists after T01).

**Done** means the task issue is **closed** (agent tasks close through their PR's `Closes #n`; owner tasks are closed by the human).

**Intake rule.** Any **open** issue numbered above #123 whose body contains `## Working agreement` or `## How to do this task`, **and** a `**Blocked by:**` line, is a task too. Its id is `I<issue>` (for example `I131`); its branch is the one in its Working agreement, or `task/i<issue>-<slug>`. Parse its dependencies and Scope (backticked paths in `## Scope`), add it to `intake` in `/tmp/orch/state.json`, and schedule it like the others. Owner tasks (`## How to do this task`) are handled as in §4.4.

### §2.2 Text rules for everything written to GitHub

- Never write `<!`: HTML comments and `<!doctype` get stripped. Spell such things out in words.
- No `<` or `>` in titles; they get HTML-escaped.
- Every comment ends with a blank line, `---`, then `_Generated by [Claude Code](https://claude.ai/code)_`.

### §2.3 What counts as a "human comment"

A comment counts as human only if **all** hold:

- its body does **not** contain `_Generated by [Claude Code]`;
- its first line does **not** start with `ORCH-`;
- its author login does **not** end in `[bot]`.

Agent writes use the human's own account, so the login alone can't tell them apart. Apply this definition everywhere: event filtering, blocked scans, owner-task scans. **Exception:** an `ORCH-ANSWER` comment (§5.5) carries a human's answer relayed by you; you and the owners treat it as human everywhere.

### §2.4 Reading the latest ledger entry (paging recipe)

Comments are listed oldest first.

1. `issue_read get` gives the comment count `n`. If `n` is 0, there is no entry.
2. Read `get_comments` with `perPage: 100`, `page: ceil(n/100)`. Take the **last** comment whose first line starts with the marker.
3. Not found and the page isn't 1: read the previous page, and so on.

**#3's `ORCH-LOCK` and `ORCH-DASHBOARD`** are created once and edited in place. At startup, scan all of #3's pages once. If there's more than one `ORCH-LOCK` comment, the one with the **lowest comment id** is the lock (the canonical one); ignore the others. Record the canonical lock's and the dashboard's comment ids and page numbers in the registry. Later reads fetch just that page and find the comment by id.

### §2.5 Lock (one comment on #3, edited in place)

```
ORCH-LOCK: held
run: <RUN_ID> · session: <session_id> · started: <UTC ISO> · heartbeat: <UTC ISO>
trigger: <send_later trigger_id>
settings: MAX_PARALLEL=<n> MERGE_POLICY=<human|auto> PRIORITY=<demo|path>
```

- `RUN_ID` = `run-<YYYYMMDD-HHMM>-<4 hex>`. `session_id` comes from `get_session` with no arguments.
- On a clean stop, edit the first line to `ORCH-LOCK: released`.
- **Fence** = re-read the canonical lock comment (§2.4). If its `run` isn't your `RUN_ID`, or its first line says `released`, you've been replaced or stopped: stand down (§5.3 step 2).
- **Stale** = heartbeat older than **4 h**. Check-ins never back off beyond 120 minutes, so a live run always looks fresh.

### §2.6 Task state (issue comments; the latest one wins)

```
ORCH-STATE: <state>
task: <Txx> (#<issue>) · run: <RUN_ID> · owner: <OWNER_ID|none> · at: <UTC ISO>
branch: <branch|none> · pr: <#n|none>
note: <one line>
```

`OWNER_ID` = `<RUN_ID>/<Txx>/<spawn counter>`, unique per spawned owner. An owner may write only while the latest entry names its `OWNER_ID` (fencing).

| State | Set by | Slot? | Meaning |
|---|---|---|---|
| `claimed` | orchestrator | yes | An owner was spawned; counts as working everywhere |
| `planning`, `plan-approved`, `implementing`, `validating`, `validated` | owner | yes | Working |
| `ci-wait` | owner | no | Waiting for a CI run on a (draft) PR before continuing |
| `pr-open` | owner | no | PR open; CI, fixes or reviews pending |
| `pr-ready` | orchestrator | no | Green, up to date, no conflicts, no open threads; awaiting merge |
| `merged-done` | orchestrator | — | Merged and the issue is closed |
| `blocked` | owner or orchestrator | no | A question was posted; needs a human |
| `waiting-owner` | orchestrator | no | An owner task (🧑) is ready for the human |
| `released` | owner or orchestrator | — | Claim dropped; the task is schedulable again |

**Working states** = `claimed`, `planning`, `plan-approved`, `implementing`, `validating`, `validated`. For liveness (§5.3 step 4), a `blocked` entry whose note starts `adopted — answer` also counts as working: an owner was sent the answer.

**Posting a state yourself:** keep the `owner:` of the latest entry (the owner of record), except for a claim or a handover, which name the new owner, and `released`, which names `none`. Put `by orchestrator` in the note.

**Handover.** Before you spawn an owner for a task that already has an `ORCH-STATE` (resume, pr-followup, ci-result, device-notes, crash respawn, adoption after a restart), post an `ORCH-STATE` with the **same state**, `owner: <new OWNER_ID>`, and `note: adopted — <reason>`. The previous owner is fenced out from that moment. If the registry says the previous owner's agent may still be running, `TaskStop` it **before** the handover, so two owners never share a worktree. Resuming an existing owner with `SendMessage` needs no handover, as long as the latest entry still names it.

**Other markers:**

- **Plan:** `ORCH-PLAN v<k> (<draft|approved>) · <Txx> [part i/n]`, edited in place.
- **Plan review:** `ORCH-PLAN-REVIEW v<k>`.
- **Done summary:** `ORCH-DONE · <Txx>`: the owner's validation table, and a line `code-review: ship · head <sha> · patch-id <id>` (§6).
- **Answer relay:** `ORCH-ANSWER` (§5.5).

### §2.7 Dashboard (one comment on #3, edited in place)

```
ORCH-DASHBOARD
run: <RUN_ID> · updated: <UTC ISO> · settings: <as in the lock>
done <n>/<total> · working <n> · ci-wait <n> · pr-open <n> · pr-ready <n> · blocked <n> · ready <n>

Waiting on you:
- <one line per blocked question, owner task, PR needing a human merge, with links; "nothing" if none>

| Task | Issue | State | PR | Since | Note |
|---|---|---|---|---|---|
```

- The table rows come from `sched.py dashboard`. A `github-clerk` posts or edits the comment from `/tmp/orch/dashboard.md`.
- Update it **immediately** when "Waiting on you" changes, and otherwise at most once every 10 minutes, and on every check-in.

### §2.8 CI green

A PR's CI is **green** on head SHA `S` when:

1. `pull_request_read get_check_runs` returns at least one check run, all `completed`, each with conclusion `success`, `skipped` or `neutral`;
2. `get_status` has no `failure`, `error` or `pending` status; and
3. once `origin/main` has `.github/workflows/ci.yml`, a check run named `verify` is among them.

Before `ci.yml` exists on `main` (T01, T02), a PR with no check runs counts as green iff its `ORCH-DONE` table is all `PASS`. Owners use `ci-wait` only when the PR's head contains `.github/workflows/ci.yml` (T03 onwards).

**CI missing:** the PR's head contains `ci.yml`, the head was pushed more than 30 minutes ago, and there are no check runs. Handle it in §5.3.

### §2.9 Notifying the human

- **`PushNotification`**, if `ToolSearch` finds it: one line under 200 characters, leading with what to act on and the link.
  - Send immediately for: an owner task ready, a `blocked` question, a stand-down, completion.
  - Batch everything else, such as PRs ready for a human merge: at most one every 30 minutes.
- **Without it:** tell the human once, in this session, that push notifications aren't available. Then rely on the in-session message at the end of your turn, plus the dashboard's "Waiting on you" list.
- GitHub doesn't notify the human about comments made by their own account, so never rely on issue comments to reach them.

## §3 Startup and resume (idempotent; run it on every start)

1. **Preconditions.** Stop and tell the human if any of these fails:
   - `origin/main` contains `.claude/agents/task-owner.md`, `.claude/skills/orchestrate/SKILL.md`, `tasks.json`, `sched.py` and `heavy.sh`;
   - `git show origin/main:docs/plan.md | grep -q 'β = 6.0'` succeeds, i.e. the plan corrections are merged;
   - the permissions grant is present (§0).

   Your own checkout `/home/user/talking-bear` is **read-only** for you and all agents, except for `git fetch`, `git worktree prune/add/remove` and read-only `git diff`/`log`/`merge-base`/`patch-id`, with the admin commands under `flock -w 300 /tmp/talking-bear-git.lock -c '…'`. Worktrees go in `/home/user/wt/<txx>`.
2. **Tools.** `ToolSearch` for the tools in §1. Note whether `PushNotification` exists (§2.9).
3. **Lock.** Get your `session_id` (`get_session`). Scan #3 (§2.4) for `ORCH-LOCK` and `ORCH-DASHBOARD`.
   - **Held by your own `session_id`:** you're the same session, restarted or compacted. Reuse its `RUN_ID`.
   - **Held by another session and not stale (§2.5):** **stop** and tell the human, unless `FORCE_TAKEOVER=yes`.
   - **Otherwise** (none, `released`, stale, or forced): create a new `RUN_ID`, take the lock (edit the canonical comment, or create it), and post a comment on #3 noting any takeover.
   - **If you created it:** re-scan #3. If an `ORCH-LOCK` with a lower comment id exists, it is canonical: mark yours `released`, and repeat step 3 against the canonical one.
   - If a previous `trigger:` id is present and isn't yours, `delete_trigger` it: a replaced run's wake-ups must not fire.
4. **Container sentinel.** `mkdir -p /tmp/orch`. If `/tmp/orch/registry.json` exists with your `RUN_ID`, owners it lists may still be alive. Otherwise (missing, or a different run) the container is new: **every owner is dead.** Write `{ "run": RUN_ID, "session": …, "boot": <UTC ISO>, "lock": {…ids}, "owners": {} }`.
5. **Rebuild state.** One `github-clerk` call, saving to `/tmp/orch/`:
   1. `issues.json`: all issues, open and closed, with `number`, `title`, `state` and comment count (all pages);
   2. `prs.json`: open PRs whose head starts with `task/`, plus closed ones with `task/` heads updated in the last 14 days;
   3. `branches.json`: `task/*` branches (`list_branches`, all pages);
   4. `states.json`: the latest `ORCH-STATE` (full text) of **every open task issue** with comments, via §2.4. This is the claim check, so it has to be complete;
   5. for open issues above #123: their bodies, for the intake rule.

   Then write `/tmp/orch/state.json` (the format is in `sched.py`'s header): closed → `done`; no entry → `none`; otherwise the latest state, with its PR, `since`, note, and `branch: true` if a `task/` branch exists. List every closed issue number in `closedIssues` (intake blockers resolve against it).

   Device-notes PRs: an open PR whose head is `task/<txx>-device-notes-<k>` belongs to that owner task. If its issue's latest state is still `waiting-owner`, record the task as `pr-open` with that PR.
6. **Re-attach** each task that isn't `done`, `none` or `released`. **Fence (§2.5) before the first spawn.** Skip any task whose registry entry (same `RUN_ID` and `boot`) has an agent that is still running: it's already owned.
   - **`ci-wait`, `pr-open`, `pr-ready`** (including device-notes PRs): `subscribe_pr_activity` (§5.4), then run the PR check of §5.3 step 6 on it. That decides whether an owner is needed.
   - **Working state** (with or without a draft PR): handover, then spawn `MODE: resume` (never `pr-followup`); if it has a PR, subscribe too. It uses a slot. Respect `MAX_OWNERS`, and queue the rest.
   - **`blocked`:** if a human comment (or `ORCH-ANSWER`) exists after the latest `ORCH-STATE` entry that isn't a handover, handover (note `adopted — answer`) and spawn `MODE: resume` with the answer as `EVENT`.
   - **`waiting-owner`:** if a human comment after it asks to commit notes (§4.4) and no notes PR is open, start device-notes.
7. **Wake-up chain:** `send_later` 60 minutes, message `orchestrator check-in <RUN_ID>`; store its `trigger_id` in the lock. Then `list_triggers` and delete every pending trigger whose message is an orchestrator check-in for a different `RUN_ID`, or an older one of yours.
8. Update the dashboard, then schedule (§4).

## §4 Scheduling

### §4.1 Picking work

1. Update `/tmp/orch/state.json`, then run `sched.py pick … --slots <MAX_PARALLEL> --priority <PRIORITY>`.
2. For each id in `claim`, in order, as long as live owners stay under `MAX_OWNERS`:
   1. **Fence** (§2.5).
   2. **Claim check:** re-read the task's latest `ORCH-STATE` (§2.4). If it's anything except none or `released`, update `state.json` and re-attach it instead (§3.6).
   3. Claim and spawn (§4.2).
3. `ownerReady` tasks go to §4.4.
4. `skip-overlap` tasks wait. `sched.py` already treats in-flight tasks (working, `ci-wait`, `pr-open`, `pr-ready`, and `blocked` with a branch) as occupying their Scope files. Shared files like `package.json`, `CLAUDE.md`, `ci.yml` and `src/main.ts` are exempt, and the later PR merges `main`.

### §4.2 Claim and spawn

1. Post `ORCH-STATE: claimed` with `owner: <new OWNER_ID>`. Update `state.json` and the dashboard.
2. Spawn `Agent(subagent_type: "task-owner", run_in_background: true)` with this brief:

   ```
   TASK: <Txx|I<n>> · ISSUE: #<n> · MODE: fresh|resume|pr-followup|device-notes
   RUN: <RUN_ID> · OWNER_ID: <OWNER_ID> · WORKTREE: /home/user/wt/<txx>
   BRANCH: <exact branch from the issue's Working agreement item 3> · PR: <#n|none>
   STATE: <latest ORCH-STATE text or none> · MERGE_POLICY: <human|auto>
   EVENT: <resume/pr-followup only: the event, CI result, review findings or human answer>
   Follow .claude/agents/task-owner.md. The issue body is your spec. End with the JSON report.
   ```
3. Record `task → {agentId, OWNER_ID, state, since, nudges: 0, crashes: 0, notReady: 0, dispatched: []}` in `/tmp/orch/registry.json`.
4. **One live owner per task.** While an owner is running, queue new events for that task, and deliver them with `SendMessage` when it reports.

### §4.3 Branch names

Use the branch given in the issue's Working agreement, e.g. `task/t07-playwright-e2e-harness-against-vite-prev`. For device notes: `task/<txx>-device-notes-<k>`, where `k` is 1 + the number of existing `task/<txx>-device-notes-*` branches (`list_branches`).

### §4.4 Owner tasks (🧑) are never run by agents

When one becomes ready:

1. Post `ORCH-STATE: waiting-owner` (owner `none`).
2. Post **one** comment summarising what's needed and the time estimate (from the `TODO.md` "Owner checkpoints" table).
3. Notify (§2.9) immediately. Add it to "Waiting on you".

**Human comments on a `waiting-owner` issue:**

- One containing `please commit` (any case): handover (keep `waiting-owner`, new owner) and spawn `MODE: device-notes`, with the comment's URL and the branch (§4.3) as `EVENT`. The owner posts no `ORCH-STATE`. When it reports `pr-open` with the PR number, **you** post `ORCH-STATE: pr-open` on the owner issue (owner of record = that owner, `pr: #n`), subscribe, and from then on the PR goes through §5.3 step 6 and §6 like any task PR. After it merges, §6.3 posts `waiting-owner` again.
- Anything else is a question or a progress note. Answer questions briefly on the issue from the issue body and plan; don't spawn.
- Binary files, such as traces under `test/traces/` and gesture JSON, are committed by the human, or handed to an agent explicitly.
- The issue closed → done.

## §5 Events

**At the start of every wake** (owner report, PR event, check-in, human message): **fence** (§2.5). Fence again before every claim, spawn, `update_pull_request_branch` and merge.

### §5.1 Owner reports (background-agent completion)

Parse the final JSON block. Update the registry, `state.json` and the dashboard. Reset the task's `nudges` and `crashes` whenever its state advances.

- **`ci-wait`:** `subscribe_pr_activity` for the PR at once. When CI completes on the head (an event, or a check-in sees it), resume the owner with `SendMessage("EVENT: ci-result <green|red> · head <sha> · <failed check names>")`. If the agent is gone, handover and spawn `MODE: resume` with that `EVENT`. Send each `ci-result` once per head SHA, and drop a queued one if the task is no longer `ci-wait` or the head moved.
- **`pr-open`:** subscribe (§5.4), then run the PR check (§5.3 step 6) at once. The owner is idle; wake it only for work.
- **`blocked`:** notify (§2.9) with the question and its link. The slot is freed.
- **`fenced`** (a newer owner or run took the task): drop this owner from the registry. Do nothing else.
- **`not-ready`** (the owner found an open blocker that `sched.py` thought was done): free the slot, fix `state.json` from the owner's evidence, and recompute. The second `not-ready` for the same task → post `blocked` with the evidence and notify.
- **`released`:** free the slot and recompute.
- **A working state** (the owner ended its turn early): `SendMessage("continue")`, at most **3** times for the same state. Then handover and respawn `MODE: resume`, counting it as a crash.
- **A crash, or no JSON:** handover and respawn `MODE: resume` with a new `OWNER_ID`. After **2** crashes without state progress, post `ORCH-STATE: blocked` with the evidence, and notify.

### §5.2 PR activity events

1. Map the head branch (`task/txx-…`) to the task.
2. **Comment events** (issue comments, review comments, reviews): skip agent echoes (a `_Generated by [Claude Code]` footer or an `ORCH-` first line, except `ORCH-ANSWER`) and duplicates. Bot review comments are not echoes: route them. **CI and check events are never echoes:** always process them.
3. Route:
   - **CI finished on a `ci-wait` PR:** resume the owner with `ci-result` (§5.1).
   - **CI green on a `pr-open` PR:** run the PR check (§5.3 step 6), which may flip it to `pr-ready`.
   - **CI red, a conflict, or a review comment** (human or bot): the owner acts, `EVENT: <kind> · <link> · <text excerpt>`. If a `pr-ready` PR gets one, post `pr-open` first.
4. **Dedupe:** the dispatch key is (head SHA, kind, the failing check names or thread ids). Never dispatch the same key twice (keep them in the registry's `dispatched`). After 3 dispatches on the same head SHA, or when the owner reports a check that is red on `main` too, post `blocked` with the evidence and notify.
5. Deliver to the owner:
   - **running:** queue it (§4.2 item 4);
   - **idle, and the latest entry names it:** `SendMessage`;
   - **gone:** handover, then spawn `MODE: pr-followup` with the event (`MODE: resume` if the task is in a working state).

### §5.3 Check-in (the `send_later` wake-up)

Do these in order:

1. **Re-arm first:** `send_later` 60 minutes (120 when every open task is human-gated: `blocked`, `waiting-owner`, or `pr-ready` under `MERGE_POLICY=human`; never more). Keep the new id.
2. **Fence:** re-read the lock. If its `run` isn't yours, **stand down**:
   1. `delete_trigger` the trigger you just created;
   2. `unsubscribe_pr_activity` from every PR you subscribed to;
   3. don't spawn, resume or write anything else;
   4. tell the human (§2.9), and stop.
3. **Heartbeat:** edit the lock with the new `trigger` and heartbeat, then `delete_trigger` the previous id if it's still pending.
4. **Liveness:**
   - If `/tmp/orch/registry.json` is missing, or its `boot` differs from the one you wrote, the container restarted: every owner is dead. Rewrite the registry (same `RUN_ID`, new `boot`), then handover and respawn every working-state task (`MODE: resume`), subject to `MAX_OWNERS`.
   - Separately, any working-state task (§2.6, including an answered `blocked`) with no live owner in the registry, whose latest `ORCH-STATE` **and** branch head are both older than 2 h: handover and respawn it.
5. **One `github-clerk` call:** "what changed since `<last check-in UTC>`", saving `/tmp/orch/checkin.json`:
   - for each task in `ci-wait`, `pr-open` or `pr-ready` (device-notes PRs included): the PR's `get` (`merged`, `merged_at`, `state`, `draft`, `mergeable`, `mergeable_state`, head SHA, head push time), its check runs and status on the head, and its unresolved review threads (id, and whether the last comment is an agent's);
   - for each `blocked` or `waiting-owner` issue: its state, and human comments (and `ORCH-ANSWER`s) after the latest `ORCH-STATE`;
   - open issues above #123 not yet in `state.json` (intake).
6. **PR check**, for each PR in the file:
   - **merged** (`merged: true`): after-merge steps (§6.3).
   - **closed without merging:** post `blocked`, and ask the human.
   - **conflicted** (`mergeable: false` or `mergeable_state: dirty`), **CI red**, **a draft in `pr-open`** (G wasn't finished), or **any unresolved review thread**: make sure an owner is acting (§5.2 steps 4–5). Owners reply to and resolve every thread they handle; a thread they leave open for the human comes with a `blocked` state.
   - **`ci-wait` with finished CI:** resume the owner with the result.
   - **CI missing** (§2.8): conflicted → as above; head not containing `origin/main` → `update_pull_request_branch` with `expectedHeadSha` (once per head); otherwise post `blocked` ("CI didn't start on PR #n") and notify.
   - **`pr-open`, not a draft, CI green (§2.8), no conflict, no unresolved threads:** post `pr-ready` (by orchestrator, with the head SHA in the note).
   - **`pr-ready`:** `MERGE_POLICY=auto` → §6.2; `human` → keep it in "Waiting on you", and include it in the batched notification.
7. **`blocked` and `waiting-owner` issues:** a new human comment or `ORCH-ANSWER` → handover (note `adopted — answer`) and resume the owner with it (`blocked`), or §4.4 (`waiting-owner`). A closed issue → done.
8. **Intake** (§2.1).
9. Fill free slots (§4.1). Update the dashboard.

### §5.4 Subscribing, and the PR Steward

The `subscribe_pr_activity` result says so if a Claude **PR Steward** is already watching the PR. In that case this session won't receive events. Then:

1. Remove the steward's watching label named in that result, using `issue_write` with the PR's labels minus that one.
2. Subscribe again.
3. If events still don't arrive, rely on the check-in for that PR. Note this on the dashboard.

**One actor per PR:** while you hold the lock, only your owners act on `task/` PRs. The `steward` skill defers to a live orchestrator.

### §5.5 Human messages in this session

Answer them.

- **An answer to a `blocked` question:** post it on the issue **verbatim**, as a comment whose first line is `ORCH-ANSWER` (then the text, then the footer). Handover (note `adopted — answer`) and resume the owner with it as `EVENT`.
- **Pause:** stop spawning and merging, let running owners report, and keep check-ins going.
- **Stop:** as pause; then release the lock, delete your trigger, and unsubscribe from all PRs. (Closing the session without saying stop does **not** stop the run: its check-in trigger wakes it again.)
- **Status:** answer from `state.json`, and link the dashboard.

## §6 Merging

**Only the orchestrator merges.** Owners stop at `pr-open`.

### §6.1 Policy

- **`human`** (default): never merge. Keep `pr-ready` PRs in "Waiting on you", and notify (batched).
- **`auto`:** merge `pr-ready` PRs through §6.2, highest priority first. **Never** auto-merge these; they stay with the human:
  - anything that isn't a `task/` PR;
  - PRs for owner-task issues, except a device-notes PR whose only changed file is `docs/device-notes.md`;
  - a diff that touches `.github/workflows/release.yml`, or whose workflow changes add `pull_request_target`, `workflow_run`, a `secrets.` reference other than `secrets.GITHUB_TOKEN`, or a `write` permission.

### §6.2 Auto-merge gate (pinned to one head SHA, re-checked right before merging)

1. **Fence.** Read the PR (`get`). Let `S` be its head SHA. Every check below must be about `S`. `git fetch` (under the git lock).
2. **Changed files:** `git diff --name-only --no-renames origin/main...S > /tmp/orch/names-<txx>.txt` (`--no-renames`, so a rename can't hide a deletion).
   - **Device-notes PR** (the only file is `docs/device-notes.md`): skip steps 6–8.
3. **Mergeable:** not a draft, `mergeable: true`, and CI green on `S` (§2.8).
4. **Up to date:** `git merge-base --is-ancestor origin/main S`. If `main` isn't an ancestor, call `update_pull_request_branch` with `expectedHeadSha: S`, post `pr-open` (note: updated with main), and stop here. The next green CI brings it back.
5. **Threads:** no unresolved review threads, and no human comment after the last push without a reply.
6. **Scope gate:** `sched.py scope <Txx> /tmp/orch/names-<txx>.txt --state /tmp/orch/state.json`. Exit 1 → don't merge; resume the owner with `EVENT: out-of-scope <files>` (it reverts them, or asks the human). Exit 2 → a script error: fix `state.json`, never treat it as out of scope.
7. **Workflow gate** (§6.1): read `git diff origin/main...S -- .github/workflows`. If the gate matches → human merge, and notify.
8. **Review:** compute `P = git diff origin/main...S | git patch-id --verbatim | cut -d' ' -f1` (`--verbatim`: whitespace changes count, which matters for YAML).
   - If the `ORCH-DONE` line `code-review: ship · head <sha> · patch-id <id>` has the same `P`, the reviewed diff is unchanged: go on.
   - Otherwise create a **separate, detached review worktree**: `git worktree prune && git worktree add --detach /home/user/wt/review-<txx> S` (under the git lock). Spawn a `code-reviewer` on `origin/main...S` there, with the issue, the approved plan and `CLAUDE.md`. Remove the review worktree afterwards.
     - `ship` → go on.
     - `fix-then-ship` → post the findings as a PR comment, post `pr-open`, and resume the owner with `EVENT: review-fixes <link>`. After 2 such rounds, post `blocked` and notify.
     - `rework` → post `blocked` with the findings, and notify.
9. **Re-check** (the review can take a while, and `main` may have moved): fence, `git fetch`, read the PR again. The head must still be `S`, CI green on `S`, and `origin/main` an ancestor of `S`. Anything else → back to step 1.
10. **Merge:** `merge_pull_request` with `merge_method: squash`, `expectedHeadSha: S`, and `commit_title: <PR title> (#<n>)`. If it fails because the head moved, start again at step 1.
11. Then run §6.3.

### §6.3 After a merge (task PR or device-notes PR)

1. **Agent task:** confirm the issue closed. If not, close it with a comment linking the PR (`state_reason: completed`). Post `merged-done`.
2. **Device-notes PR:** post `waiting-owner` again, owner `none`.
3. `unsubscribe_pr_activity`. Drop the owner from the registry.
4. Remove the worktree: `flock -w 300 /tmp/talking-bear-git.lock -c 'git -C /home/user/talking-bear worktree remove --force /home/user/wt/<txx>; git -C /home/user/talking-bear worktree prune'`.
5. If the epic's sub-issues are all closed, close the epic with a comment.
6. Write `done` for the task into `state.json` (and add the issue to `closedIssues`), then recompute, fill slots, and update the dashboard.

## §7 Completion

**Complete** means every task-format issue (T01–T112 plus intake issues) is closed.

1. **Cleanup:** create one intake issue (task format: Working agreement, `**Blocked by:** none`, Scope `docs/research/spikes/**`) to delete the `docs/research/spikes/*` folders whose "delete when" condition is met. Schedule it like any task.
2. When it's done, close the remaining epics and #3.
3. Post a final summary on #3.
4. Release the lock, delete the trigger, and notify.

If only human-gated work remains, keep the check-ins running (§5.3 step 1 backs off to 120 minutes), and say so on the dashboard.

## §8 Safety (you and every agent)

- **Isolation:**
  - One worktree per task (`/home/user/wt/<txx>`), on its own branch.
  - Never touch another task's worktree, branch, issue or PR.
  - Never commit on `main`. Never force-push or rebase a branch that has a PR.
- **Shared-machine locks:**
  - Git admin (`fetch`, `worktree prune/add/remove`) runs under `flock -w 300 /tmp/talking-bear-git.lock -c '…'`.
  - Heavy commands (browser, `vite preview`, Playwright, `vitest --project browser`, Docker) run under `bash .claude/skills/orchestrate/heavy.sh '<command>'` (run from the worktree; it takes the shared heavy lock and frees ports 4173–4175 and 8080–8082 before and after). Exit 75 means lock timeout, not a failure.
  - Every `heavy.sh` call, and anything else that may take more than about 5 minutes, runs with Bash `run_in_background: true` (waiting for the heavy lock can outlast a foreground call's timeout).
  - Ports 4173–4175 and 8080–8082 are shared.
- **Sandbox limits** (see `TODO.md` Phase 0 for the environment setup):
  - Don't run `playwright install`.
  - If a validation can't run in the sandbox (no Docker daemon, a different Go or Node, espeak-ng, a browser build), use `ci-wait` with a draft PR, and cite the CI run.
  - Never edit configs, thresholds or tests to make something pass.
- **Rules from the issues:**
  - Never add unnamed dependencies.
  - Never store captured or real-voice audio.
  - Ask on ambiguity; never guess.
