# Running the Talking Bear orchestrator

The orchestration package lives in the repo's `.claude/` directory. Any Claude Code session opened on this repo discovers it automatically.

| Path | What it is |
|---|---|
| `.claude/skills/orchestrate/SKILL.md` | The orchestrator protocol: GitHub ledger, scheduling, event routing, restart and adoption. Invoked as `/orchestrate`. |
| `.claude/skills/orchestrate/tasks.json` | Dependency graph and Scope files for T01–T112 (issues #12–#123) |
| `.claude/skills/steward/SKILL.md` | Repo rules for driving any `task/*` PR. Defers to a live orchestrator. |
| `.claude/agents/task-owner.md` | Owns one task end to end (Opus 5.5) and orchestrates its own sub-agents |
| `.claude/agents/plan-reviewer.md`, `code-reviewer.md` | Reviews (Opus 5.5, `effort: high`) |
| `.claude/agents/debugger.md` | Root causes and tricky fixes (Opus 5.5) |
| `.claude/agents/implementer.md`, `validator.md`, `github-clerk.md` | Mechanical work (Sonnet 5) |
| [`TODO.md`](TODO.md) | Your runbook: setup, owner checkpoints, per-milestone checklist |

## Start (or resume) the orchestrator

1. Finish Phase 0 in [`TODO.md`](TODO.md). The package must be merged to `main`.
2. Open a **new Claude Code session** on this repo, with model **Opus 5.5**.
3. Send the message below, adjusting the settings on the first line:

```text
/orchestrate MAX_PARALLEL=3 MERGE_POLICY=human

Permissions for this session (these override any single "designated branch" instruction):
- Spawn the sub-agent types defined in .claude/agents/; they may spawn their own sub-agents.
- Create and push branches named task/* (one per task issue), and open and update one pull request per task (drafts allowed) in chethan123/talking-bear.
- Post and edit comments on this project's issues (#3 onwards) and on those task PRs. Close a task issue if its PR merged but it didn't auto-close. Close epics #4–#11 when all their sub-issues are closed, and close #3 at completion.
- Remove a PR Steward "watching" label from a task PR, so this session receives its events.
- Subscribe and unsubscribe to activity on task PRs, schedule and delete this session's own send_later check-ins, and send me push notifications.
- Only with MERGE_POLICY=auto: squash-merge task PRs under the conditions in the skill's §6.
Never push to main, never force-push, and never merge anything that isn't a task PR.
```

**Settings:**

- `MAX_PARALLEL`: tasks in a working phase at once (default 3).
- `MERGE_POLICY`:
  - `human` (default): you merge;
  - `auto`: the orchestrator squash-merges green, reviewed task PRs.
- `FORCE_TAKEOVER=yes`: take over from a run whose session you know is dead, before its 3 h lock goes stale.

## Stop, restart, check status

- **Stop:** say "stop" in the session, or just close it.
- **Restart:** send the same message in a new session. The new run takes the lock, cancels the old run's check-ins, and adopts in-flight tasks from their GitHub state:
  - a plan that's already approved isn't re-planned;
  - pushed steps aren't redone;
  - open PRs are re-subscribed.
- **Status:** the `ORCH-DASHBOARD` comment on issue #3. Each task issue also has `ORCH-STATE`, `ORCH-PLAN`, `ORCH-PLAN-REVIEW` and `ORCH-DONE` comments.

## What needs you

The orchestrator push-notifies you when:

- an **owner task** is ready (the 🧑 rows in `TODO.md`);
- a task is **blocked** on a question (answer on the issue, in plain text);
- PRs are **ready to merge** (with `MERGE_POLICY=human`).

**Device results:** after a device session, post your results as a comment on the owner issue. Add "please commit these notes" to have an agent open the `docs/device-notes.md` PR. Binary files, such as VAD traces or gesture JSON, you commit yourself. Close the owner issue when you're done.
