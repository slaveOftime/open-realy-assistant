import { runHeartbeatHooks, type HeartHook } from "./phase20-hook.ts";
import { log } from "./logging.ts";
import { trySleepHandoff } from "./phase30-sleep.ts";
import { createRuntimeState, ensureWorkspaceRoot, initializeLifecycle, recordPulse, registerSignalHandlers } from "./state.ts";
import { toErrorMessage, wait } from "./utils.ts";
import { wakePrimarySession } from "./phase10-wake.ts";
import type { HeartRuntimeConfig, HeartRuntimeContext } from "./types.ts";

export type RuntimeOptions = {
  hooks: readonly HeartHook[];
};

async function runCycle(context: HeartRuntimeContext, hooks: readonly HeartHook[]): Promise<void> {
  if (context.state.shouldStop) {
    return;
  }

  const activeSession = await wakePrimarySession(context);
  if (!activeSession) {
    return;
  }

  if (activeSession.canAcceptMessage) {
    if (await runHeartbeatHooks(context, activeSession.selection, hooks)) {
      return;
    }
  }

  await trySleepHandoff(context, activeSession.selection, activeSession.uptime);
}

export async function run(config: HeartRuntimeConfig, options: RuntimeOptions): Promise<void> {
  const context: HeartRuntimeContext = {
    config,
    state: createRuntimeState(),
  };

  ensureWorkspaceRoot(context);
  initializeLifecycle(context);
  registerSignalHandlers(context);

  do {
    try {
      await runCycle(context, options.hooks);
    } catch (error) {
      log(context, `Heart cycle failed: ${toErrorMessage(error)}`);
    }

    recordPulse(context, "cycle-complete");
    if (context.config.flags.runOnce || context.state.shouldStop) {
      break;
    }

    log(context, "Heart beat");
    recordPulse(context, "heartbeat");
    await wait(context.config.settings.checkIntervalMs, true, "waiting before next heart check", context);
  } while (!context.state.shouldStop);
}
