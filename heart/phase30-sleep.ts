import { sendNotification, sendSessionKey, stopSession } from "./oly.ts";
import { appendLifeEvent, log } from "./logging.ts";
import { recordSleepAttempt, shouldSkipSleep } from "./state.ts";
import {
  findRunningSession,
  getSessionActivityMarker,
  sendMessageToAgent,
  sessionIsWaiting,
  waitForQuietOutput,
  waitForSessionStop,
} from "./sessions.ts";
import type { HeartRuntimeContext, SessionSelection } from "./types.ts";
import { formatDuration, formatLocalTimestamp, readText, StopRequestedError, wait } from "./utils.ts";
import { getWakeSessionKey } from "./phase10-wake.ts";

function getSleepPrompt(context: HeartRuntimeContext): string {
  return readText(context.config.prompts.sleepPromptFile).trim();
}

function buildEnvelope(purpose: string, body: string, context: HeartRuntimeContext): string {
  const localTime = formatLocalTimestamp(
    Date.now(),
    0,
    context.config.settings.logicTimestampPrecisionMs,
  );
  const normalizedPurpose =
    purpose
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "NUDGE";
  return [
    `HEART-${normalizedPurpose} ${localTime}`,
    "Keep this pass bounded, start from compact task/message state first, and reply briefly.",
    "Do not create a standalone housekeeping entry for this pass itself.",
    body,
  ].join("\n");
}

function clearSleepBusyState(context: HeartRuntimeContext): void {
  context.state.lastSleepBlockedBusySessionKey = null;
  context.state.lastSleepBlockedBusySinceAt = 0;
  context.state.lastSleepBlockedBusyNotified = false;
}

function deferSleepWhilePrimaryBusy(
  context: HeartRuntimeContext,
  selection: SessionSelection,
  sessionUptime: Date,
  sessionKey: string,
): boolean {
  const now = Date.now();
  if (context.state.lastSleepBlockedBusySessionKey !== sessionKey) {
    context.state.lastSleepBlockedBusySessionKey = sessionKey;
    context.state.lastSleepBlockedBusySinceAt = now;
    context.state.lastSleepBlockedBusyNotified = false;
  }

  const busyForMs = now - context.state.lastSleepBlockedBusySinceAt;
  if (
    !context.state.lastSleepBlockedBusyNotified
    && busyForMs >= context.config.settings.sleepBusyNotificationAfterMs
  ) {
    sendNotification(
      context,
      selection.primarySessionId,
      context.config.identity.attentionNotificationTitle,
      `Primary session ${selection.primarySessionId} has stayed busy for ${formatDuration(busyForMs)} and could not go to sleep.`,
      [
        `Primary session: ${selection.primarySessionId}`,
        `Busy duration: ${formatDuration(busyForMs)}`,
        `Session uptime: ${formatDuration(now - sessionUptime.getTime())}`,
        "Sleep remains deferred only because the main assistant session is still busy.",
      ].join("\n"),
    );
    context.state.lastSleepBlockedBusyNotified = true;
    log(context, "Primary session stayed busy for 30 minutes past the sleep window. Sent attention notification.");
  }

  return false;
}

async function forceStopPrimarySession(
  context: HeartRuntimeContext,
  selection: SessionSelection,
  reason: string,
): Promise<string> {
  log(context, reason);
  const interruptResult = sendSessionKey(context, selection.primarySessionId, "ctrl+c");
  if (interruptResult.ok) {
    await wait(
      context.config.settings.sleepInterruptSettleMs,
      true,
      "waiting after forced Ctrl+C before sleep stop",
      context,
    );
  } else {
    log(context, `Error sending Ctrl+C before forced sleep stop: ${interruptResult.error ?? "unknown error"}`);
  }

  const stopResult = stopSession(context, selection.primarySessionId);
  if (!stopResult.ok) {
    log(context, `Error force-stopping the primary session after sleep deadline: ${stopResult.error ?? "unknown error"}`);
    return "force-stop-failed";
  }

  if (context.config.flags.readOnly) {
    context.state.isAgentAbleToAcceptMessage = false;
    log(context, "Read-only mode simulated a forced primary session stop after the sleep deadline.");
    return "forced-read-only";
  }

  const stopped = await waitForSessionStop(
    context,
    selection.primarySessionId,
    context.config.settings.sessionRotationWaitMs,
    true,
  );
  if (!stopped) {
    log(context, "Timed out waiting for the primary session to stop after forced sleep.");
    return "force-stop-timeout";
  }

  context.state.isAgentAbleToAcceptMessage = false;
  context.state.lastSleepHandoffActivityMarker = null;
  log(context, "Primary session force-stopped after the sleep deadline.");
  return "forced";
}

export async function trySleepHandoff(
  context: HeartRuntimeContext,
  selection: SessionSelection,
  sessionUptime: Date,
): Promise<boolean> {
  if (Date.now() - sessionUptime.getTime() <= context.config.settings.sleepAfterMs) {
    clearSleepBusyState(context);
    return false;
  }

  const sleepSessionKey = getWakeSessionKey(selection.primarySession);
  if (!sessionIsWaiting(context, selection.primarySession)) {
    return deferSleepWhilePrimaryBusy(context, selection, sessionUptime, sleepSessionKey);
  }

  clearSleepBusyState(context);

  if (shouldSkipSleep(context, sleepSessionKey)) {
    return false;
  }

  const currentActivityMarker = getSessionActivityMarker(context, selection.primarySession);
  if (currentActivityMarker === context.state.lastSleepHandoffActivityMarker) {
    return false;
  }

  recordSleepAttempt(context, sleepSessionKey);
  context.state.lastSleepHandoffActivityMarker = currentActivityMarker;

  const sleepPlannedAt = Date.now();
  const sleepDeadlineAt = sleepPlannedAt + context.config.settings.maxSleepSequenceMs;
  appendLifeEvent(context, "sleep-plan", {
    uptime: formatDuration(sleepPlannedAt - sessionUptime.getTime()),
    planned_sleep_at: formatLocalTimestamp(
      sleepPlannedAt,
      0,
      context.config.settings.logicTimestampPrecisionMs,
    ),
  }, sleepPlannedAt);

  let promptStatus = "skipped";
  let postQuietStatus = "skipped";
  let rotationStatus = "skipped";

  try {
    const sessionBeforeSleepPrompt = findRunningSession(context, selection.primarySessionId);
    if (!sessionBeforeSleepPrompt) {
      promptStatus = "session-missing";
      postQuietStatus = "session-missing";
      log(context, "Primary session disappeared before the sleep handoff could be delivered.");
    } else {
      const sent = await sendMessageToAgent(
        context,
        selection.primarySessionId,
        "sleep",
        buildEnvelope("sleep", getSleepPrompt(context), context),
        1,
        sleepDeadlineAt,
        true,
      );
      if (!sent) {
        promptStatus = "deadline-timeout";
        rotationStatus = await forceStopPrimarySession(
          context,
          selection,
          "Primary session stayed busy past the sleep deadline. Forcing sleep now.",
        );
      } else {
        promptStatus = "sent";
        const postSleepQuiet = await waitForQuietOutput(
          context,
          selection.primarySessionId,
          context.config.settings.sleepQuietPeriodMs,
          sleepDeadlineAt,
          "post-sleep settle window",
          true,
          true,
        );
        postQuietStatus = postSleepQuiet ? "ok" : "timeout";
        if (!postSleepQuiet) {
          rotationStatus = await forceStopPrimarySession(
            context,
            selection,
            "Sleep handoff exceeded the quiet deadline. Forcing sleep now.",
          );
        } else {
          const stopResult = stopSession(context, selection.primarySessionId);
          if (!stopResult.ok) {
            rotationStatus = "stop-failed";
            log(context, `Error rotating the primary session after sleep handoff: ${stopResult.error ?? "unknown error"}`);
          } else if (context.config.flags.readOnly) {
            rotationStatus = "read-only";
            context.state.isAgentAbleToAcceptMessage = false;
            log(context, "Read-only mode simulated primary session rotation after the sleep handoff.");
          } else {
            const stopped = await waitForSessionStop(
              context,
              selection.primarySessionId,
              context.config.settings.sessionRotationWaitMs,
              true,
            );
            if (!stopped) {
              rotationStatus = "stop-timeout";
              log(context, "Timed out waiting for the primary session to stop after sleep handoff.");
            } else {
              rotationStatus = "rotated";
              context.state.isAgentAbleToAcceptMessage = false;
              context.state.lastSleepHandoffActivityMarker = null;
              log(context, "Primary session rotated after successful sleep handoff.");
            }
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof StopRequestedError)) {
      throw error;
    }
    log(context, "Stop requested during the sleep handoff; skipping the remaining grace steps.");
  }

  appendLifeEvent(context, "sleep", {
    uptime: formatDuration(Date.now() - sessionUptime.getTime()),
    planned_sleep_at: formatLocalTimestamp(
      sleepPlannedAt,
      0,
      context.config.settings.logicTimestampPrecisionMs,
    ),
    prompt: promptStatus,
    post_quiet: postQuietStatus,
    rotation: rotationStatus,
  });

  if (!context.state.shouldStop && !context.config.flags.readOnly) {
    await wait(context.config.settings.postSleepDelayMs, true, "waiting after sleep handoff", context);
  }

  return true;
}
