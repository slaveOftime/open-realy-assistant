import { loadConnectedNodeNames, runOlyOnNode, sendNotification, sendSessionInputChunked, sendSessionKey } from "./oly.ts";
import { defaultHeartRuntimeSettings, type HeartRuntimeContext, type SessionIdleState, type SessionInfo, type SessionListResponse, type SessionSelection } from "./types.ts";
import { formatDuration, formatLocalTimestamp, formatParsedTimestamp, getMessagePreview, parseOlyTimestamp, sanitizeLifeLessonField, stripAnsi, throwIfStopping, toErrorMessage, wait } from "./utils.ts";
import { log } from "./logging.ts";

export type SessionPromptReadiness = {
  state: "busy" | "idle" | "waiting-input";
  idleMs: number;
  rawIdleMs: number;
  tailStableMs: number;
  preview: string | null;
};

function parseSessionList(context: HeartRuntimeContext, json: string): SessionListResponse | null {
  try {
    const parsed = JSON.parse(json) as SessionListResponse;
    return Array.isArray(parsed.items) ? parsed : null;
  } catch (error) {
    log(context, `Error parsing session list: ${toErrorMessage(error)}`);
    return null;
  }
}

function isProtectedExternalSession(session: SessionInfo): boolean {
  const title = (session.title ?? "").trimStart().toLowerCase();
  return title.startsWith("protected ");
}

export function isPrimarySession(context: HeartRuntimeContext, session: SessionInfo): boolean {
  return (session.title ?? "") === context.config.identity.primarySessionTitle;
}

function startsWithKnownChildPrefix(context: HeartRuntimeContext, title: string): boolean {
  return context.config.identity.childSessionTitlePrefixes.some((prefix) => title.startsWith(prefix));
}

function isExplicitSupervisedChildSession(context: HeartRuntimeContext, session: SessionInfo): boolean {
  const title = session.title ?? "";
  return (session.tags?.includes(context.config.identity.supervisedSessionTag) ?? false)
    || (startsWithKnownChildPrefix(context, title) && session.command === context.config.launch.command);
}

function isManagedSessionSearchMatch(context: HeartRuntimeContext, session: SessionInfo): boolean {
  const title = session.title ?? "";
  if (isProtectedExternalSession(session)) {
    return false;
  }

  return isPrimarySession(context, session)
    || title === context.config.identity.runtimeTitle
    || startsWithKnownChildPrefix(context, title)
    || (session.tags?.includes(context.config.identity.supervisedSessionTag) ?? false);
}

export function isSupervisedChildSession(context: HeartRuntimeContext, session: SessionInfo): boolean {
  return isManagedSessionSearchMatch(context, session)
    && !isPrimarySession(context, session)
    && session.title !== context.config.identity.runtimeTitle
    && isExplicitSupervisedChildSession(context, session);
}

function mergeSessions(primary: readonly SessionInfo[], extra: readonly SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of [...primary, ...extra]) {
    byId.set(getSessionKey(session), session);
  }
  return [...byId.values()];
}

function loadSessionList(
  context: HeartRuntimeContext,
  args: string[],
  description: string,
  nodeName?: string,
): SessionInfo[] | null {
  const result = runOlyOnNode(context, nodeName, args);
  if (!result.ok) {
    log(context, `Error retrieving ${description}: ${result.error ?? "unknown error"}`);
    return null;
  }

  const response = parseSessionList(context, result.stdout);
  if (!response) {
    log(context, `Error parsing ${description}: payload missing items array.`);
    return null;
  }

  return response.items.map((session) => (nodeName ? { ...session, nodeName } : session));
}

function loadRemoteSupervisedSessions(context: HeartRuntimeContext): SessionInfo[] {
  const remoteSessions: SessionInfo[] = [];
  for (const nodeName of loadConnectedNodeNames(context)) {
    const sessions = loadSessionList(
      context,
      ["ls", "--json", "--status", "running", "--tag", context.config.identity.supervisedSessionTag, "--limit", "200"],
      `remote tagged supervised sessions on node ${nodeName}`,
      nodeName,
    );
    if (sessions) {
      remoteSessions.push(...sessions.filter((session) => isSupervisedChildSession(context, session)));
    }
  }

  return remoteSessions;
}

function loadRunningSessions(context: HeartRuntimeContext): SessionInfo[] | null {
  const taggedSessions = loadSessionList(
    context,
    ["ls", "--json", "--status", "running", "--tag", context.config.identity.supervisedSessionTag, "--limit", "200"],
    "tagged supervised sessions",
  );
  if (!taggedSessions) {
    return null;
  }

  const runningSessions = loadSessionList(
    context,
    ["ls", "--json", "--status", "running", "--limit", "200"],
    "running sessions",
  );
  if (!runningSessions) {
    return taggedSessions.filter((session) => isManagedSessionSearchMatch(context, session));
  }

  const legacySessions = runningSessions.filter((session) => {
    const title = session.title ?? "";
    return (title === context.config.identity.runtimeTitle || startsWithKnownChildPrefix(context, title))
      && !(session.tags?.includes(context.config.identity.supervisedSessionTag) ?? false);
  });

  return mergeSessions(
    mergeSessions(taggedSessions, legacySessions).filter((session) => isManagedSessionSearchMatch(context, session)),
    loadRemoteSupervisedSessions(context),
  );
}

function selectPrimarySession(
  context: HeartRuntimeContext,
  sessions: readonly SessionInfo[],
  preferredPrimarySessionId?: string,
): SessionSelection | null {
  const primaryMatches = sessions.filter((session) => isPrimarySession(context, session));
  const localPrimaryMatches = primaryMatches.filter((session) => !session.nodeName);
  const selectable = localPrimaryMatches.length > 0 ? localPrimaryMatches : primaryMatches;
  if (selectable.length === 0) {
    return null;
  }

  const primarySession =
    (preferredPrimarySessionId ? selectable.find((session) => session.id === preferredPrimarySessionId) : undefined)
    ?? [...selectable].sort((left, right) => {
      const leftTitlePriority = left.title === context.config.identity.primarySessionTitle ? 0 : 1;
      const rightTitlePriority = right.title === context.config.identity.primarySessionTitle ? 0 : 1;
      if (leftTitlePriority !== rightTitlePriority) {
        return leftTitlePriority - rightTitlePriority;
      }

      const precisionMs = context.config.settings.logicTimestampPrecisionMs;
      const leftCreated = parseOlyTimestamp(left.created_at, precisionMs) ?? 0;
      const rightCreated = parseOlyTimestamp(right.created_at, precisionMs) ?? 0;
      return leftCreated - rightCreated;
    })[0];

  return {
    primarySessionId: primarySession.id,
    primarySession,
    supervisedSessions: sessions.filter(
      (session) => getSessionKey(session) !== getSessionKey(primarySession) && isSupervisedChildSession(context, session),
    ),
    allSessions: [...sessions],
  };
}

export function getPrimarySessions(
  context: HeartRuntimeContext,
  preferredPrimarySessionId?: string,
): SessionSelection | null {
  const sessions = loadRunningSessions(context);
  return sessions ? selectPrimarySession(context, sessions, preferredPrimarySessionId) : null;
}

export function findRunningSession(context: HeartRuntimeContext, sessionId: string): SessionInfo | null {
  const sessions = loadRunningSessions(context);
  return sessions?.find((session) => session.id === sessionId) ?? null;
}

export function getSessionKey(session: SessionInfo): string {
  return `${session.nodeName ?? "local"}:${session.id}`;
}

function buildRawSessionActivityTimestamp(context: HeartRuntimeContext, session: SessionInfo): number | null {
  const precisionMs = context.config.settings.logicTimestampPrecisionMs;
  return parseOlyTimestamp(session.last_output_epoch, precisionMs)
    ?? parseOlyTimestamp(session.started_at, precisionMs)
    ?? parseOlyTimestamp(session.created_at, precisionMs);
}

function getNormalizedOutputEpochMarker(
  context: Pick<HeartRuntimeContext, "config">,
  session: SessionInfo,
): string {
  const precisionMs = context.config.settings.logicTimestampPrecisionMs;
  const parsed = parseOlyTimestamp(session.last_output_epoch, precisionMs);
  if (parsed !== null) {
    return String(parsed);
  }

  return session.last_output_epoch ?? "__no-output__";
}

export function getSessionStartTimestamp(
  session: SessionInfo,
  precisionMs = defaultHeartRuntimeSettings.logicTimestampPrecisionMs,
): number | null {
  return parseOlyTimestamp(session.started_at, precisionMs) ?? parseOlyTimestamp(session.created_at, precisionMs);
}

function buildTailSignature(output: string): { signature: string | null; preview: string | null } {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  return {
    signature: lines.length > 0 ? lines.join("\n") : null,
    preview: lines.length > 0 ? sanitizeLifeLessonField(lines.slice(-6).join(" / "), 180) : null,
  };
}

function tailLooksPromptReady(signature: string | null, preview: string | null): boolean {
  const haystack = `${signature ?? ""}\n${preview ?? ""}`.toLowerCase();
  return haystack.includes("type @ to mention files")
    && (haystack.includes("shift+tab switch mode") || haystack.includes("remaining reqs.:"));
}

function readSessionTailSnapshot(
  context: HeartRuntimeContext,
  session: SessionInfo,
): { ok: boolean; signature: string | null; preview: string | null; error?: string } {
  const result = runOlyOnNode(
    context,
    session.nodeName,
    ["logs", session.id, "--tail", context.config.settings.idleLogTailLines, "--no-truncate"],
  );
  if (!result.ok) {
    return { ok: false, signature: null, preview: null, error: result.error ?? "unknown error" };
  }

  return { ok: true, ...buildTailSignature(result.stdout) };
}

function refreshSessionIdleState(
  context: HeartRuntimeContext,
  session: SessionInfo,
  forceTailCheck = false,
): SessionIdleState {
  const sessionKey = getSessionKey(session);
  const now = Date.now();
  const currentOutputEpoch = getNormalizedOutputEpochMarker(context, session);
  const existing = context.state.sessionIdleStates.get(sessionKey);
  const fallbackTimestamp = buildRawSessionActivityTimestamp(context, session) ?? now;
  const state: SessionIdleState = existing
    ? { ...existing }
    : {
        lastObservedOutputEpoch: currentOutputEpoch,
        lastObservedTailSignature: null,
        lastObservedTailPreview: null,
        lastObservedTailError: null,
        lastObservedInputNeeded: session.input_needed,
        lastOutputEpochChangedAt: fallbackTimestamp,
        lastTailChangedAt: fallbackTimestamp,
        lastInputNeededChangedAt: fallbackTimestamp,
        lastTailCheckedAt: null,
        lastSuccessfulTailCheckAt: null,
      };

  if (state.lastObservedOutputEpoch !== currentOutputEpoch) {
    state.lastObservedOutputEpoch = currentOutputEpoch;
    state.lastOutputEpochChangedAt = now;
  }

  if (state.lastObservedInputNeeded !== session.input_needed) {
    state.lastObservedInputNeeded = session.input_needed;
    state.lastInputNeededChangedAt = now;
  }

  if (
    forceTailCheck
    || state.lastTailCheckedAt === null
    || now - state.lastTailCheckedAt >= context.config.settings.idleTailCheckMinIntervalMs
  ) {
    state.lastTailCheckedAt = now;
    const tailSnapshot = readSessionTailSnapshot(context, session);
    if (tailSnapshot.ok) {
      state.lastObservedTailError = null;
      state.lastSuccessfulTailCheckAt = now;
      if (state.lastObservedTailSignature !== tailSnapshot.signature) {
        state.lastObservedTailSignature = tailSnapshot.signature;
        state.lastObservedTailPreview = tailSnapshot.preview;
        state.lastTailChangedAt = now;
      }
    } else {
      state.lastObservedTailError = tailSnapshot.error ?? "unknown error";
    }
  }

  context.state.sessionIdleStates.set(sessionKey, state);
  return state;
}

function getSessionActivityTimestamp(context: HeartRuntimeContext, session: SessionInfo): number | null {
  const state = refreshSessionIdleState(context, session);
  const now = Date.now();
  const tailQuietThreshold = context.config.settings.idleTailStablePeriodMs;
  if (
    state.lastSuccessfulTailCheckAt !== null
    && now - state.lastTailChangedAt >= tailQuietThreshold
  ) {
    return Math.max(state.lastTailChangedAt, state.lastInputNeededChangedAt);
  }

  return Math.max(state.lastOutputEpochChangedAt, state.lastTailChangedAt, state.lastInputNeededChangedAt);
}

export function getSessionIdleMs(context: HeartRuntimeContext, session: SessionInfo): number {
  const lastActivityAt = getSessionActivityTimestamp(context, session);
  return lastActivityAt === null ? 0 : Math.max(0, Date.now() - lastActivityAt);
}

export function getSessionActivityMarker(context: HeartRuntimeContext, session: SessionInfo): string {
  const state = refreshSessionIdleState(context, session);
  return [
    session.input_needed ? "input-needed" : "input-clear",
    getNormalizedOutputEpochMarker(context, session),
    state.lastObservedTailSignature ?? "__no-tail__",
  ].join("::");
}

export function getSessionOutputEpochMarker(session: SessionInfo): string {
  const parsed = parseOlyTimestamp(session.last_output_epoch, defaultHeartRuntimeSettings.logicTimestampPrecisionMs);
  if (parsed !== null) {
    return String(parsed);
  }

  return session.last_output_epoch ?? "__no-output__";
}

export function isSessionQuietForPrompt(
  context: HeartRuntimeContext,
  session: SessionInfo,
  purpose: string,
  requiredIdleMs: number,
): boolean {
  refreshSessionIdleState(context, session, true);
  const readiness = getSessionPromptReadiness(context, session, requiredIdleMs);
  const outputQuietThreshold = Math.max(requiredIdleMs, context.config.settings.idleOutputQuietPeriodMs);
  const tailQuietThreshold = Math.max(requiredIdleMs, context.config.settings.idleTailStablePeriodMs);
  const outputQuietEnough = readiness.rawIdleMs >= outputQuietThreshold;
  const tailQuietEnough = readiness.tailStableMs >= tailQuietThreshold;
  if (readiness.state !== "busy" && outputQuietEnough && tailQuietEnough) {
    return true;
  }

  log(
    context,
    `Session ${session.id} is still not quiet enough for ${purpose}: state=${readiness.state} raw_idle=${formatDuration(readiness.rawIdleMs)}/${formatDuration(outputQuietThreshold)} tail_stable=${formatDuration(readiness.tailStableMs)}/${formatDuration(tailQuietThreshold)} last_output_epoch=${formatParsedTimestamp(session.last_output_epoch, context.config.settings.logTimestampFractionDigits, context.config.settings.logicTimestampPrecisionMs) ?? "null"}.`,
  );
  return false;
}

export function sessionIsWaiting(context: HeartRuntimeContext, session: SessionInfo): boolean {
  return getSessionPromptReadiness(context, session, context.config.settings.promptReadySilentMs).state !== "busy";
}

export function getSessionPromptReadiness(
  context: HeartRuntimeContext,
  session: SessionInfo,
  requiredIdleMs = context.config.settings.promptReadySilentMs,
): SessionPromptReadiness {
  const now = Date.now();
  const state = refreshSessionIdleState(context, session);
  const rawActivityAt = buildRawSessionActivityTimestamp(context, session) ?? now;
  const rawIdleMs = Math.max(0, now - rawActivityAt);
  const tailStableMs = Math.max(0, now - state.lastTailChangedAt);
  const tailQuietThreshold = Math.max(requiredIdleMs, context.config.settings.idleTailStablePeriodMs);
  const hasStableTailIdle =
    state.lastSuccessfulTailCheckAt !== null
    && tailStableMs >= tailQuietThreshold;
  const lastActivityAt = Math.max(
    state.lastOutputEpochChangedAt,
    state.lastTailChangedAt,
    state.lastInputNeededChangedAt,
  );
  const idleMs = Math.max(0, now - lastActivityAt);

  if (session.input_needed) {
    return {
      state: "waiting-input",
      idleMs,
      rawIdleMs,
      tailStableMs,
      preview: state.lastObservedTailPreview,
    };
  }

  if (
    rawIdleMs < Math.max(requiredIdleMs, context.config.settings.idleOutputQuietPeriodMs)
    && !hasStableTailIdle
    && !tailLooksPromptReady(state.lastObservedTailSignature, state.lastObservedTailPreview)
  ) {
    return {
      state: "busy",
      idleMs,
      rawIdleMs,
      tailStableMs,
      preview: state.lastObservedTailPreview,
    };
  }

  if (
    tailLooksPromptReady(state.lastObservedTailSignature, state.lastObservedTailPreview)
    || hasStableTailIdle
  ) {
    return {
      state: "idle",
      idleMs,
      rawIdleMs,
      tailStableMs,
      preview: state.lastObservedTailPreview,
    };
  }

  return {
    state: "busy",
    idleMs,
    rawIdleMs,
    tailStableMs,
    preview: state.lastObservedTailPreview,
  };
}

function getSlowDeliveryNotificationKey(sessionId: string, purpose: string): string {
  return `${sessionId}::${purpose}`;
}

function shouldSendSlowDeliveryNotification(
  context: HeartRuntimeContext,
  sessionId: string,
  purpose: string,
  now = Date.now(),
): boolean {
  const key = getSlowDeliveryNotificationKey(sessionId, purpose);
  const previousAt = context.state.lastSlowDeliveryNotificationAt.get(key) ?? 0;
  if (now - previousAt < context.config.settings.slowDeliveryNotificationCooldownMs) {
    return false;
  }

  context.state.lastSlowDeliveryNotificationAt.set(key, now);
  return true;
}

async function waitForSessionReady(
  context: HeartRuntimeContext,
  sessionId: string,
  readyCheck?: (session: SessionInfo) => boolean,
  deadlineAt?: number,
  abortOnStop = false,
): Promise<SessionInfo> {
  const deadline = deadlineAt ?? Date.now() + 60_000;
  let nextLogAt = 0;

  while (Date.now() < deadline) {
    if (abortOnStop) {
      throwIfStopping(`waiting for session ${sessionId} to become ready`, context);
    }

    const session = findRunningSession(context, sessionId);
    if (!session) {
      throw new Error(`session ${sessionId} is no longer running`);
    }

    if (session.input_needed || (readyCheck && readyCheck(session))) {
      log(context, `Session ${sessionId} is ready for input.`);
      return session;
    }

    const now = Date.now();
    if (now >= nextLogAt) {
      log(context, `Waiting for session ${sessionId} to become ready.`);
      nextLogAt = now + 10_000;
    }

    await wait(1_000, abortOnStop, `waiting for session ${sessionId} to become ready`, context);
  }

  throw new Error(`session ${sessionId} did not become ready before the deadline`);
}

async function waitForOutputEpochAdvance(
  context: HeartRuntimeContext,
  sessionId: string,
  previousEpochMarker: string,
  timeoutMs: number,
  abortOnStop = false,
): Promise<SessionInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abortOnStop) {
      throwIfStopping(`waiting for ${sessionId} output epoch to advance`, context);
    }

    const session = findRunningSession(context, sessionId);
    if (!session) {
      throw new Error(`session ${sessionId} is no longer running`);
    }

    if (getSessionOutputEpochMarker(session) !== previousEpochMarker) {
      return session;
    }

    await wait(250, abortOnStop, `waiting for ${sessionId} output epoch to advance`, context);
  }

  return null;
}

async function submitMessage(
  context: HeartRuntimeContext,
  sessionId: string,
  message: string,
  purpose: string,
  abortOnStop = false,
): Promise<boolean> {
  const sessionBeforeSubmit = findRunningSession(context, sessionId);
  if (!sessionBeforeSubmit) {
    throw new Error(`session ${sessionId} is no longer running`);
  }

  const initialOutputEpoch = getSessionOutputEpochMarker(sessionBeforeSubmit);
  const bodyResult = sendSessionInputChunked(context, sessionId, message);
  if (!bodyResult.ok) {
    log(context, `Error sending message body: ${bodyResult.error ?? "unknown error"}`);
    return false;
  }

  await wait(context.config.settings.submitDelayMs, abortOnStop, `delaying enter for ${purpose}`, context);

  for (let enterAttempt = 1; enterAttempt <= context.config.settings.enterRetryAttempts; enterAttempt += 1) {
    const enterResult = sendSessionKey(context, sessionId, "enter");
    if (enterResult.ok) {
      const acknowledgedSession = await waitForOutputEpochAdvance(
        context,
        sessionId,
        initialOutputEpoch,
        context.config.settings.enterOutputAckTimeoutMs,
        abortOnStop,
      );
      if (acknowledgedSession) {
        log(
          context,
          `Enter acknowledged for ${purpose}: session=${sessionId} last_output_epoch=${formatParsedTimestamp(acknowledgedSession.last_output_epoch, context.config.settings.logTimestampFractionDigits, context.config.settings.logicTimestampPrecisionMs) ?? "null"} attempt=${enterAttempt}/${context.config.settings.enterRetryAttempts}.`,
        );
        return true;
      }
    } else {
      log(context, `Error sending enter key for ${purpose}: ${enterResult.error ?? "unknown error"}`);
    }

    if (enterAttempt < context.config.settings.enterRetryAttempts) {
      await wait(context.config.settings.submitDelayMs, abortOnStop, `retrying enter for ${purpose}`, context);
    }
  }

  return false;
}

export async function sendMessageToAgent(
  context: HeartRuntimeContext,
  sessionId: string,
  purpose: string,
  body: string,
  maxRetry: number,
  deadlineAt?: number,
  abortOnStop = false,
  readyTimeoutMs?: number,
): Promise<boolean> {
  log(context, `Sending ${purpose}`);

  if (context.config.flags.readOnly) {
    log(context, "[read-only] Skipping live message send.");
    context.state.isAgentAbleToAcceptMessage = true;
    return true;
  }

  let retryCount = 0;
  let hasSentNotification = false;
  const preview = getMessagePreview(body);

  while (retryCount < maxRetry) {
    if (abortOnStop) {
      throwIfStopping(`sending ${purpose}`, context);
    }

    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      break;
    }

    try {
      const readyDeadlineAt =
        readyTimeoutMs === undefined
          ? deadlineAt
          : Math.min(
              deadlineAt ?? Number.POSITIVE_INFINITY,
              Date.now() + readyTimeoutMs,
            );
      await waitForSessionReady(
        context,
        sessionId,
        (session) => sessionIsWaiting(context, session),
        Number.isFinite(readyDeadlineAt) ? readyDeadlineAt : undefined,
        abortOnStop,
      );
    } catch (error) {
      log(context, `Error waiting for session readiness: ${toErrorMessage(error)}`);
      retryCount += 1;
      await wait(context.config.settings.retryDelayMs, abortOnStop, `retrying ${purpose}`, context);
      continue;
    }

    const submitAcknowledged = await submitMessage(context, sessionId, body, purpose, abortOnStop);
    if (submitAcknowledged) {
      context.state.isAgentAbleToAcceptMessage = true;
      return true;
    }

    retryCount += 1;
    if (retryCount >= 3 && !hasSentNotification && shouldSendSlowDeliveryNotification(context, sessionId, purpose)) {
      const localTime = formatLocalTimestamp(
        Date.now(),
        0,
        context.config.settings.logicTimestampPrecisionMs,
      );
      sendNotification(
        context,
        sessionId,
        context.config.identity.attentionNotificationTitle,
        `Delivery to session ${sessionId} stalled at ${localTime}.`,
        [
          `Local time: ${localTime}`,
          `Purpose: ${purpose}`,
          `Session: ${sessionId}`,
          `Attempted message: ${preview}`,
        ].join("\n"),
      );
      hasSentNotification = true;
    }

    await wait(context.config.settings.retryDelayMs, abortOnStop, `retrying ${purpose}`, context);
  }

  context.state.isAgentAbleToAcceptMessage = false;
  return false;
}

export async function waitForQuietOutput(
  context: HeartRuntimeContext,
  sessionId: string,
  quietPeriodMs: number,
  deadlineAt: number,
  purpose: string,
  stopOnInputNeeded: boolean,
  abortOnStop = false,
): Promise<SessionInfo | null> {
  let session = findRunningSession(context, sessionId);
  if (!session) {
    return null;
  }

  log(
    context,
    `Tracking ${purpose}: session=${sessionId} initial_last_output_epoch=${formatParsedTimestamp(session.last_output_epoch, context.config.settings.logTimestampFractionDigits, context.config.settings.logicTimestampPrecisionMs) ?? "null"}.`,
  );

  while (Date.now() < deadlineAt) {
    if (abortOnStop) {
      throwIfStopping(`waiting for ${purpose}`, context);
    }

    session = findRunningSession(context, sessionId);
    if (!session) {
      return null;
    }

    if (stopOnInputNeeded && session.input_needed) {
      return session;
    }

    const idleMs = getSessionIdleMs(context, session);
    if (idleMs >= quietPeriodMs) {
      log(context, `Session ${sessionId} stayed quiet for ${quietPeriodMs / 1_000}s for ${purpose}.`);
      return session;
    }

    await wait(1_000, abortOnStop, `waiting for ${purpose}`, context);
  }

  return null;
}

export async function waitForSessionStop(
  context: HeartRuntimeContext,
  sessionId: string,
  timeoutMs: number,
  abortOnStop = false,
): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (abortOnStop) {
      throwIfStopping(`waiting for session ${sessionId} to stop`, context);
    }

    if (!findRunningSession(context, sessionId)) {
      return true;
    }

    await wait(1_000, abortOnStop, `waiting for session ${sessionId} to stop`, context);
  }

  return !findRunningSession(context, sessionId);
}
