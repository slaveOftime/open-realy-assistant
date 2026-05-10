tli task hook:

- use only the listed ready, pending-dependency, and active tasks; do one bounded pass and stop unless action is clearly needed
- trust the listed `next` command first; inspect `oly logs <id> --tail 20 --no-truncate` before reopening context for a live worker
- classify fast: progressing -> no action; waiting-input -> one unblock; waiting-review -> keep alive; finished-at-prompt -> update task and stop session unless review must stay alive
- for direct user close commands like `Mark <session-id> done`, resolve the mapped task by `task:<task-id>` tag/title or existing `.tli` linkage first, then `tli done` and `oly stop` in the same pass
- ready tasks are actionable unless task detail shows a real reason to wait
- pending-dependency tasks are due-but-blocked signals; inspect their `next` hint or task detail so you can work the blocker, notify, or reschedule intentionally without mislabeling them as ready
- if a task is obviously broad or multi-phase, split it with `tli subtask`/`tli dep` or schedule the follow-up instead of leaving one vague active item
- for user-directed tasks, checkpoint/review/done/blocked means update the real `.tli` status in the same pass; if you continue any `checkpoint` or `review` task later, run `tli start` first so checkpoint/review filtering stays correct
- a direct in-session user close command is already the acknowledgment, so after closing the task/session reply briefly in-session and skip extra notifications unless the mapping is ambiguous or blocked
- if exact `tli` usage or task-shaping flow is uncertain, rerun `tli skill` first

{{due_tasks_section}}

{{pending_dependency_tasks_section}}

{{active_tasks_section}}
