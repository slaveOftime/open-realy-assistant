tli task hook:

- use only the ready, pending-dependency, and active items shown below; do one bounded supervisor pass and stop unless direct action is clearly needed
- trust the listed `next` command first; use `tli next <id>` or `tli show <id> --verbose` only for the specific listed task when needed
- for an active task with a live worker session, read `oly logs <id> --tail 20 --no-truncate` first and treat that as the source of truth
- classify worker-backed tasks fast: progressing -> no action; waiting-input -> send one unblock/refocus; waiting-review -> update task if needed and keep session alive; stalled -> leave one concrete recovery step
- if logs show the worker already finished and is only sitting at a prompt, treat the work as finished: update the real task and stop the session unless review requires it to stay alive
- if the user gives a direct close command like `Mark <session-id> done` or `mark it done`, treat it as explicit approval to close that reviewed/finished work: resolve the task by `task:<task-id>` tag/title or existing `.tli` linkage first, then `tli done` and `oly stop` in the same pass
- for session-driven close requests, prefer the shortest trustworthy mapping path and do not widen investigation once one real task is clearly identified
- treat ready tasks as actionable now unless the task detail shows a real reason to wait
- treat pending-dependency tasks as due-but-not-ready signals: notice them, inspect the hinted blocker/dependency path, and either handle the blocker, notify, or postpone intentionally instead of ignoring them
- keep continuity in `.tli` with `tli checkpoint`, `tli review`, `tli done --next-step|--next-subtask|--next-task`, `tli note`, or `tli block`; do not create side tracking
- if a task is broad, multi-phase, or branching, shape it with `tli subtask`, `tli dep`, and scheduled follow-up pickups early instead of keeping one oversized active task with vague notes
- widen at most once with `tli state --verbose` or `tli list --all` only if the listed items do not provide enough same-day context
- if a user-directed task reaches checkpoint, review, done, or blocked, set the real `.tli` status properly in the same pass; keep review sessions alive until the user explicitly closes them
- a direct in-session close command from the user is already the acknowledgment, so after closing the task/session reply briefly in-session and skip extra notifications unless something is ambiguous or blocked
- if you are going to continue, nudge, or resume a task that is currently in `checkpoint` or `review`, first move it back to active with `tli start` in that same pass so checkpoint/review filtering stays correct
- if the user asks to push a checkpointed/review task forward, move it back to active with `tli start` before nudging the worker or continuing the work
- if you act, do it in this same pass and end with one very short status line only

{{due_tasks_section}}

{{pending_dependency_tasks_section}}

{{active_tasks_section}}

When you are done, give one very short summary. And say you are ready to analysis and create new tasks.
