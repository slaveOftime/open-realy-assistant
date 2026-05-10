# Sleep handoff for {{assistant_name}}

You have been running for a while.

Do one compact continuity pass:

- checkpoint meaningful active task changes in `tli` if needed
- keep the handoff short and focused on durable next actions
- do not preserve temporary session IDs, message history, secrets, or private memory
- do not stop worker sessions unless the user explicitly asked for that behavior

Reply with a brief handoff summary.
