# Open Relay Assistant Heart Starter

This starter now follows the same broad runtime shape as Jarvis, but with the repo-specific behavior stripped out:

- `heart.ts` is the main entrypoint
- `heart\` holds the reusable supervision runtime
- `heart-hooks\` holds the bounded `tli` task hook flow
- `prompts\soul.md` and `prompts\sleep.md` stay generic

It keeps only the reusable core: adopt or start one main assistant session through `oly`, wake it once, feed it a bounded `tli` task hook, and rotate it through a short sleep handoff after long uptime.

## Setup

1. Install dependencies.

   ```bash
   npm install
   ```

2. Make sure `oly`, `tli`, and your assistant command are available on `PATH`.

   ```bash
   npm i -g @slaveoftime/oly
   npm i -g @slaveoftime/tli
   ```

3. Edit `heart.ts` and set the starter-specific values you want to use:

   - `assistantName`
   - `primarySessionTitle`
   - `supervisedSessionTag`
   - `launch.command`
   - `launch.arguments`
   - any timing values under `settings`

4. Adjust the generic prompts in:

   - `heart-hooks\tasks-hook.md`
   - `heart-hooks\tasks-hook-compact.md`
   - `prompts\soul.md`
   - `prompts\sleep.md`

## Run

Run one supervisor pass:

```powershell
npm run once
```

Check config without touching `oly` or `tli`:

```powershell
npm run check-config
```

Run continuously:

```powershell
oly start -t gogo-heart --disable-notifications node heart.ts
```
