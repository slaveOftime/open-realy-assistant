import { runOly } from "./oly.ts";
import { log } from "./logging.ts";
import { getPrimarySessions, getSessionStartTimestamp, sendMessageToAgent, sessionIsWaiting } from "./sessions.ts";
import { clearInitializationPending, markInitializationSent, resetForStartedSession } from "./state.ts";
import type { HeartRuntimeContext, SessionInfo, SessionSelection } from "./types.ts";
import { extractSessionId, formatLocalTimestamp, readText, throwIfStopping, wait } from "./utils.ts";

export type ActiveSession = {
  selection: SessionSelection;
  uptime: Date;
  canAcceptMessage: boolean;
};

function getSessionUptime(context: HeartRuntimeContext, session: SessionInfo): Date | null {
  const startedAt = getSessionStartTimestamp(session, context.config.settings.logicTimestampPrecisionMs);
  return startedAt === null ? null : new Date(startedAt);
}

export function getWakeSessionKey(session: SessionInfo): string {
  return `${session.id}::${session.started_at ?? session.created_at ?? "unknown"}`;
}

function validateSessionUptime(context: HeartRuntimeContext, session: SessionInfo): boolean {
  const uptime = getSessionUptime(context, session);
  if (uptime === null) {
    log(context, `Warning: Could not derive uptime from session ${session.id} - missing created_at/started_at`);
    return false;
  }

  const uptimeMs = Date.now() - uptime.getTime();
  return uptimeMs >= 0 && uptimeMs <= 365 * 24 * 60 * 60 * 1000;
}

function getInitialPrompt(context: HeartRuntimeContext): string {
  return readText(context.config.prompts.initialPromptFile).trim();
}

function buildInitializationPrompt(context: HeartRuntimeContext): string {
  return [
    `HEART-WAKE ${formatLocalTimestamp(
      Date.now(),
      0,
      context.config.settings.logicTimestampPrecisionMs,
    )}`,
    `You are ${context.config.identity.agentName}, the supervisor assistant for this repo.`,
    "Apply this supervisor stance now:",
    "",
    getInitialPrompt(context),
    "",
    "Refresh from the inline supervisor guidance above, follow any reminder there to read other files only when needed, keep the main session interruptible and supervisor-first, and reply with one short ready/status line after re-centering.",
  ].join("\n");
}

async function initializeSessionIfNeeded(
  context: HeartRuntimeContext,
  selection: SessionSelection,
): Promise<boolean> {
  const initializationKey = getWakeSessionKey(selection.primarySession);
  if (context.state.lastInitializedSessionKey === initializationKey) {
    if (context.state.lastInitializationPendingSessionKey === initializationKey) {
      const settleRemainingMs =
        context.config.settings.initializationSettleMs - (Date.now() - context.state.lastInitializationSentAt);
      if (settleRemainingMs > 0) {
        log(context, `Initialization settled recently; waiting ${Math.ceil(settleRemainingMs / 1_000)}s before hooks.`);
        return true;
      }

      clearInitializationPending(context, initializationKey);
    }
    return false;
  }

  log(context, "New primary session detected. Waiting for initialization.");
  const sent = await sendMessageToAgent(
    context,
    selection.primarySessionId,
    "initialization",
    buildInitializationPrompt(context),
    10,
    undefined,
    true,
    context.config.settings.initializationReadyTimeoutMs,
  );
  if (!sent) {
    log(context, "Initialization is still pending.");
    return true;
  }

  markInitializationSent(context, initializationKey);
  log(context, "Primary session accepted initialization. Letting wake context settle before hooks.");
  return true;
}

async function tryStartPrimarySession(context: HeartRuntimeContext): Promise<string | null> {
  throwIfStopping("starting the primary session", context);
  log(context, "Primary session is not running. Starting...");

  if (context.config.flags.readOnly) {
    log(context, "[read-only] Skipping primary session start.");
    return null;
  }

  if (Date.now() - context.state.lastStartAttemptAt < context.config.settings.startCooldownMs) {
    await wait(
      context.config.settings.startRetryDelayMs,
      true,
      "waiting before retrying primary session start",
      context,
    );
    return null;
  }

  const result = runOly(context, [
    "start",
    "--title",
    context.config.identity.primarySessionTitle,
    "--tag",
    context.config.identity.supervisedSessionTag,
    "--cwd",
    context.config.launch.cwd,
    "--disable-notifications",
    "--detach",
    context.config.launch.command,
    ...context.config.launch.arguments,
  ]);

  if (!result.ok) {
    log(context, `Error starting primary session: ${result.error ?? "unknown error"}`);
    await wait(
      context.config.settings.startRetryDelayMs,
      true,
      "waiting before retrying primary session start",
      context,
    );
    return null;
  }

  context.state.lastStartAttemptAt = Date.now();
  resetForStartedSession(context);
  await wait(context.config.settings.retryDelayMs, true, "waiting for primary session startup prompt", context);
  return extractSessionId(result.stdout);
}

async function ensurePrimarySession(context: HeartRuntimeContext): Promise<SessionSelection> {
  let selection = getPrimarySessions(context);
  if (!selection && context.config.flags.readOnly) {
    context.state.shouldStop = true;
    throw new Error("Primary session is not running and read-only mode cannot start it.");
  }

  while (!selection) {
    throwIfStopping("ensuring a primary session", context);
    const startedSessionId = await tryStartPrimarySession(context);
    if (!startedSessionId) {
      selection = getPrimarySessions(context);
      continue;
    }

    selection = getPrimarySessions(context, startedSessionId);
  }

  return selection;
}

export async function wakePrimarySession(context: HeartRuntimeContext): Promise<ActiveSession | null> {
  const selection = await ensurePrimarySession(context);
  const uptime = getSessionUptime(context, selection.primarySession);
  if (uptime === null || !validateSessionUptime(context, selection.primarySession)) {
    log(context, "Primary session uptime validation failed - refreshing session state on the next cycle.");
    context.state.isAgentAbleToAcceptMessage = false;
    return null;
  }

  if (getSessionStartTimestamp(selection.primarySession, context.config.settings.logicTimestampPrecisionMs) !== null) {
    log(
      context,
      `Primary session uptime derived from session start timestamp: ${formatLocalTimestamp(
        uptime.getTime(),
        context.config.settings.logTimestampFractionDigits,
        context.config.settings.logicTimestampPrecisionMs,
      )}`,
    );
  }

  log(context, `Primary session is running with session ID: ${selection.primarySessionId}`);

  if (await initializeSessionIfNeeded(context, selection)) {
    return null;
  }

  context.state.isAgentAbleToAcceptMessage = sessionIsWaiting(context, selection.primarySession);
  if (!context.state.isAgentAbleToAcceptMessage) {
    log(context, "Primary session is busy or not ready yet. Will check again later.");
  }

  return {
    selection,
    uptime,
    canAcceptMessage: context.state.isAgentAbleToAcceptMessage,
  };
}
