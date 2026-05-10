# Personal Assistant Heart Starter

A small, generic TypeScript starter for running a personal assistant "heart": one primary `oly` session, one initial wake prompt, a bounded `tli` task-supervisor pass, and a simple long-uptime sleep/handoff prompt.

This was distilled from the shape of a private Jarvis setup, but it intentionally omits private memory, message history, task history, schedules, notifications, `.tli` state, news, secrets, and repo-specific automation.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Make sure `oly`, `tli`, and your assistant command are available on `PATH`.

3. Copy `.env.example` to `.env` or export equivalent environment variables.

4. Customize the name and prompts:

   - `ASSISTANT_NAME=Gogo`
   - `ASSISTANT_SESSION_TITLE=Gogo`
   - `ASSISTANT_SESSION_TAG=gogo`
   - edit `prompts\soul.md`, `prompts\task-hook.md`, and `prompts\sleep.md`

## Run

Run one supervisor pass:

```powershell
npm run once
```

Check configuration without touching `oly` or `tli`:

```powershell
npm run check-config
```

Run continuously:

```powershell
npm start
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASSISTANT_NAME` | `Gogo` | Display name injected into prompts. |
| `ASSISTANT_SESSION_TITLE` | assistant name | Exact primary `oly` session title to adopt/start. |
| `ASSISTANT_SESSION_TAG` | normalized assistant name | `oly` tag used to keep this starter separate from other assistants. |
| `ASSISTANT_COMMAND` | `copilot` | Command launched by `oly start`. |
| `ASSISTANT_ARGS` | empty | Extra launch args split like a simple shell string. |
| `HEART_CHECK_INTERVAL_MS` | `5000` | Continuous loop delay. |
| `HEART_SLEEP_AFTER_MS` | `10800000` | Uptime before sending the sleep prompt. |

Runtime logs and state stay under `runtime\` and are ignored by git. Local `.tli` state is also ignored so this starter remains clean and copyable.
