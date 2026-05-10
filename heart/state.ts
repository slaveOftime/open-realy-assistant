import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendBoundedLogLine, appendLifeEvent, log } from "./logging.ts";
import type { HeartRuntimeContext, RuntimeState } from "./types.ts";
import { ensureDirectoryExists, formatLocalTimestamp, toErrorMessage } from "./utils.ts";

const sleepAttemptCooldownMs = 5 * 60_000;

type LifecycleState = {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  lastEvent: string;
  expectedStop: boolean;
  stopReason: string | null;
  exitAt?: string;
  exitCode?: number;
};

function isLifecycleState(value: unknown): value is LifecycleState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Record<keyof LifecycleState, unknown>>;
  return typeof candidate.pid === "number"
    && typeof candidate.startedAt === "string"
    && typeof candidate.lastHeartbeatAt === "string"
    && typeof candidate.lastEvent === "string"
    && typeof candidate.expectedStop === "boolean"
    && (candidate.stopReason === null || typeof candidate.stopReason === "string");
}

let lifecycleState: LifecycleState | null = null;
let lifecycleExitRecorded = false;

export function createRuntimeState(): RuntimeState {
  return {
    isAgentAbleToAcceptMessage: false,
    shouldStop: false,
    lastStartAttemptAt: 0,
    lastInitializedSessionKey: null,
    lastInitializationPendingSessionKey: null,
    lastInitializationSentAt: 0,
    lastSleepHandoffActivityMarker: null,
    lastHookPromptMarker: null,
    lastSleepAttemptSessionKey: null,
    lastSleepAttemptAt: 0,
    lastSleepBlockedBusySessionKey: null,
    lastSleepBlockedBusySinceAt: 0,
    lastSleepBlockedBusyNotified: false,
    lastSlowDeliveryNotificationAt: new Map<string, number>(),
    sessionIdleStates: new Map(),
    idleSupervisedPromptStates: new Map(),
  };
}

export function resetForStartedSession(context: HeartRuntimeContext): void {
  context.state.isAgentAbleToAcceptMessage = false;
  context.state.lastInitializedSessionKey = null;
  context.state.lastInitializationPendingSessionKey = null;
  context.state.lastInitializationSentAt = 0;
  context.state.lastSleepHandoffActivityMarker = null;
  context.state.lastHookPromptMarker = null;
  context.state.lastSleepAttemptSessionKey = null;
  context.state.lastSleepAttemptAt = 0;
  context.state.lastSleepBlockedBusySessionKey = null;
  context.state.lastSleepBlockedBusySinceAt = 0;
  context.state.lastSleepBlockedBusyNotified = false;
}

export function recordHookPrompt(context: HeartRuntimeContext, marker: string): void {
  context.state.lastHookPromptMarker = marker;
}

export function markInitializationSent(context: HeartRuntimeContext, sessionKey: string, now = Date.now()): void {
  context.state.lastInitializedSessionKey = sessionKey;
  context.state.lastInitializationPendingSessionKey = sessionKey;
  context.state.lastInitializationSentAt = now;
}

export function clearInitializationPending(context: HeartRuntimeContext, sessionKey: string): void {
  if (context.state.lastInitializationPendingSessionKey !== sessionKey) {
    return;
  }

  context.state.lastInitializationPendingSessionKey = null;
  context.state.lastInitializationSentAt = 0;
}

export function shouldSkipSleep(context: HeartRuntimeContext, sessionKey: string, now = Date.now()): boolean {
  return context.state.lastSleepAttemptSessionKey === sessionKey
    && now - context.state.lastSleepAttemptAt < sleepAttemptCooldownMs;
}

export function recordSleepAttempt(context: HeartRuntimeContext, sessionKey: string, now = Date.now()): void {
  context.state.lastSleepAttemptSessionKey = sessionKey;
  context.state.lastSleepAttemptAt = now;
}

function nowTimestamp(context: HeartRuntimeContext): string {
  return formatLocalTimestamp(
    Date.now(),
    context.config.settings.logTimestampFractionDigits,
    context.config.settings.logicTimestampPrecisionMs,
  );
}

export function ensureWorkspaceRoot(context: HeartRuntimeContext): void {
  ensureDirectoryExists(context.config.launch.cwd);
}

function persistLifecycleState(context: HeartRuntimeContext): void {
  if (!lifecycleState) {
    return;
  }

  ensureDirectoryExists(dirname(context.config.artifacts.lifecycleStateFile));
  writeFileSync(context.config.artifacts.lifecycleStateFile, `${JSON.stringify(lifecycleState, null, 2)}\n`, "utf8");
}

function updateLifecycleState(context: HeartRuntimeContext, patch: Partial<LifecycleState>): void {
  if (!lifecycleState) {
    return;
  }

  lifecycleState = {
    ...lifecycleState,
    ...patch,
  };
  persistLifecycleState(context);
}

function appendLifecycleFailure(context: HeartRuntimeContext, message: string): void {
  appendBoundedLogLine(
    context.config.artifacts.lifecycleFailureLogFile,
    `[${nowTimestamp(context)}] ${message}`,
    context.config.settings.lifecycleFailureLogMaxEntries,
  );
}

function appendLifecycleLog(context: HeartRuntimeContext, message: string): void {
  ensureDirectoryExists(dirname(context.config.artifacts.logFile));
  appendFileSync(context.config.artifacts.logFile, `[${nowTimestamp(context)}] ${message}\n`);
}

function readPreviousLifecycleState(context: HeartRuntimeContext): LifecycleState | null {
  if (!existsSync(context.config.artifacts.lifecycleStateFile)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(context.config.artifacts.lifecycleStateFile, "utf8"));
    if (isLifecycleState(parsed)) {
      return parsed;
    }
    appendLifecycleFailure(context, "Previous lifecycle state has an invalid shape.");
    return null;
  } catch (error) {
    appendLifecycleFailure(context, `Failed to parse previous lifecycle state: ${toErrorMessage(error)}`);
    return null;
  }
}

function recordUnexpectedPreviousExit(context: HeartRuntimeContext, previousState: LifecycleState): void {
  if (previousState.exitAt) {
    return;
  }

  const message =
    `Previous heart instance appears to have ended unexpectedly: ` +
    `pid=${previousState.pid} started_at=${previousState.startedAt} ` +
    `last_heartbeat_at=${previousState.lastHeartbeatAt} last_event=${previousState.lastEvent}`;
  appendLifecycleFailure(context, message);
  log(context, `Warning: ${message}`);
}

function recordCrash(context: HeartRuntimeContext, kind: string, error: unknown): void {
  const reason = `${kind}: ${toErrorMessage(error)}`;
  updateLifecycleState(context, {
    stopReason: reason,
    expectedStop: false,
    lastEvent: kind,
  });
  appendLifecycleFailure(context, reason);
  appendLifecycleLog(context, `Lifecycle failure: ${reason}`);
}

export function initializeLifecycle(context: HeartRuntimeContext): void {
  const previousState = readPreviousLifecycleState(context);
  if (previousState) {
    recordUnexpectedPreviousExit(context, previousState);
  }

  lifecycleState = {
    pid: process.pid,
    startedAt: nowTimestamp(context),
    lastHeartbeatAt: nowTimestamp(context),
    lastEvent: "start",
    expectedStop: false,
    stopReason: null,
  };
  persistLifecycleState(context);
  appendLifeEvent(context, "heart-start", { pid: process.pid });
}

export function recordPulse(context: HeartRuntimeContext, event: string): void {
  updateLifecycleState(context, {
    lastHeartbeatAt: nowTimestamp(context),
    lastEvent: event,
  });
}

export function registerSignalHandlers(context: HeartRuntimeContext): void {
  process.on("uncaughtExceptionMonitor", (error) => {
    recordCrash(context, "uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    recordCrash(context, "unhandledRejection", error);
    setImmediate(() => {
      throw error;
    });
  });

  process.on("exit", (code) => {
    if (lifecycleExitRecorded) {
      return;
    }
    lifecycleExitRecorded = true;

    const reason = lifecycleState?.stopReason ?? (context.state.shouldStop ? "stop-requested" : `exit-code-${code}`);
    updateLifecycleState(context, {
      expectedStop: context.state.shouldStop || code === 0,
      stopReason: reason,
      exitAt: nowTimestamp(context),
      exitCode: code,
      lastEvent: "exit",
    });
    appendLifecycleLog(
      context,
      `Process exit: code=${code} reason=${reason} expected_stop=${context.state.shouldStop || code === 0}`,
    );
    if (!context.state.shouldStop || code !== 0) {
      appendLifecycleFailure(context, `Process exit: code=${code} reason=${reason}`);
    }
    appendLifeEvent(context, "heart-stop", {
      pid: process.pid,
      code,
      reason,
      expected_stop: context.state.shouldStop || code === 0,
    });
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.on(signal, () => {
      context.state.shouldStop = true;
      updateLifecycleState(context, {
        expectedStop: true,
        stopReason: `signal:${signal}`,
        lastEvent: signal,
      });
      log(context, `Received ${signal}. Shutting down heart loop.`);
    });
  }
}
