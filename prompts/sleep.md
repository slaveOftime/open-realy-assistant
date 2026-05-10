# Sleep handoff for {{assistant_name}}

You have been running for a while.

Do one compact continuity pass:

- checkpoint meaningful task progress in `tli` if needed
- keep the handoff short and focused on durable next actions
- do not preserve temporary session ids, message history, secrets, or private memory
- do not create new work just to make the handoff prettier

Reply with a brief handoff summary, then be ready to stop.
