import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logging.ts";
import { recordHookPrompt } from "./state.ts";
import { getSessionActivityMarker, getSessionPromptReadiness, isSessionQuietForPrompt, sendMessageToAgent } from "./sessions.ts";
import type { HeartRuntimeContext, SessionSelection } from "./types.ts";
import { formatDuration, formatLocalTimestamp, sanitizeLifeLessonField } from "./utils.ts";

export type HeartHookContext = {
  now: string;
  sessionKey: string;
  runtimeContext: HeartRuntimeContext;
  selection: SessionSelection;
};

export type HeartHook = ((context: HeartHookContext) => string | null) & {
  onSent?: (context: HeartHookContext) => void;
};

const normalSessionPromptReadyMs = 10 * 60_000;
const hiddenIdleTaskStatuses = new Set(["review", "done"]);
const idleSupervisedRepromptMs = 15 * 60_000;

function getTaskIdFromSessionTags(selectionSession: SessionSelection["supervisedSessions"][number]): string | null {
  const taskTag = selectionSession.tags?.find((tag) => tag.startsWith("task:"));
  return taskTag ? taskTag.slice("task:".length) : null;
}

function readLinkedTaskStatus(
  context: HeartRuntimeContext,
  selectionSession: SessionSelection["supervisedSessions"][number],
): string | null {
  const taskId = getTaskIdFromSessionTags(selectionSession);
  if (!taskId) {
    return null;
  }

  const taskFile = join(context.config.launch.cwd, ".tli", "tasks", `${taskId}.json`);
  if (!existsSync(taskFile)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(taskFile, "utf8")) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : null;
  } catch {
    return null;
  }
}

function buildIdleSupervisedSessionsSection(
  context: HeartRuntimeContext,
  selection: SessionSelection,
): { prompt: string | null; promptedSessionStates: Map<string, string> } {
  const now = Date.now();
  const idleSessions = selection.supervisedSessions
    .map((session) => ({
      session,
      readiness: getSessionPromptReadiness(context, session, normalSessionPromptReadyMs),
      linkedTaskStatus: readLinkedTaskStatus(context, session),
      activityMarker: getSessionActivityMarker(context, session),
    }))
    .filter(({ readiness }) => readiness.state !== "busy")
    .filter(({ linkedTaskStatus }) => !linkedTaskStatus || !hiddenIdleTaskStatuses.has(linkedTaskStatus))
    .filter(({ session, activityMarker }) => {
      const previous = context.state.idleSupervisedPromptStates.get(session.id);
      if (!previous) {
        return true;
      }

      if (previous.lastActivityMarker !== activityMarker) {
        return true;
      }

      return now - previous.lastPromptAt >= idleSupervisedRepromptMs;
    })
    .sort((left, right) => right.readiness.idleMs - left.readiness.idleMs);

  if (idleSessions.length === 0) {
    return {
      prompt: null,
      promptedSessionStates: new Map(),
    };
  }

  const promptedSessionStates = new Map(idleSessions.map(({ session, activityMarker }) => [session.id, activityMarker]));
  const lines = idleSessions.map(({ session, readiness, linkedTaskStatus }) => {
    const title = sanitizeLifeLessonField(session.title ?? session.command, 80);
    const parts = [
      `- ${session.id}`,
      title,
      `state=${readiness.state}`,
      `idle=${formatDuration(readiness.idleMs)}`,
    ];
    if (linkedTaskStatus) {
      parts.push(`task=${linkedTaskStatus}`);
    }
    return parts.join(" | ");
  });

  return {
    prompt: [`Idle supervised sessions: ${idleSessions.length}.`, ...lines].join("\n"),
    promptedSessionStates,
  };
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

function buildHookSessionKey(selection: SessionSelection): string {
  return `${selection.primarySessionId}::${selection.primarySession.started_at ?? selection.primarySession.created_at ?? "unknown"}`;
}

function buildHookPrompt(
  context: HeartRuntimeContext,
  selection: SessionSelection,
  hooks: readonly HeartHook[],
): {
  hookContext: HeartHookContext;
  promptBody: string | null;
  sentHooks: HeartHook[];
  promptedIdleSessionStates: Map<string, string>;
} {
  const hookContext = {
    now: formatLocalTimestamp(
      Date.now(),
      0,
      context.config.settings.logicTimestampPrecisionMs,
    ),
    sessionKey: buildHookSessionKey(selection),
    runtimeContext: context,
    selection,
  } as const;
  const sentHooks: HeartHook[] = [];
  const idleSessionsSection = buildIdleSupervisedSessionsSection(context, selection);
  const sections = hooks
    .map((hook) => {
      const prompt = hook(hookContext);
      if (typeof prompt === "string" && prompt.trim().length > 0) {
        sentHooks.push(hook);
        return prompt;
      }
      return null;
    })
    .filter((prompt): prompt is string => typeof prompt === "string" && prompt.trim().length > 0);

  return {
    hookContext,
    promptBody: [...sections, idleSessionsSection.prompt]
      .filter((section): section is string => typeof section === "string" && section.trim().length > 0)
      .join("\n\n") || null,
    sentHooks,
    promptedIdleSessionStates: idleSessionsSection.promptedSessionStates,
  };
}

export async function runHeartbeatHooks(
  context: HeartRuntimeContext,
  selection: SessionSelection,
  hooks: readonly HeartHook[],
): Promise<boolean> {
  const { hookContext, promptBody, sentHooks, promptedIdleSessionStates } = buildHookPrompt(context, selection, hooks);
  if (!promptBody) {
    context.state.lastHookPromptMarker = null;
    return false;
  }

  if (promptBody === context.state.lastHookPromptMarker) {
    return false;
  }

  const quietPeriodMs = Math.max(
    context.config.settings.idleBeforeSupervisionMs,
    context.config.settings.conservativeIdleQuietPeriodMs,
  );
  if (!isSessionQuietForPrompt(context, selection.primarySession, "hook", quietPeriodMs)) {
    log(context, "Deferring hook because the primary session is not quiet enough yet.");
    return false;
  }

  const sent = await sendMessageToAgent(
    context,
    selection.primarySessionId,
    "hook",
    buildEnvelope("hook", promptBody, context),
    3,
    undefined,
    true,
  );
  if (!sent) {
    return false;
  }

  recordHookPrompt(context, promptBody);
  const promptedAt = Date.now();
  for (const [sessionId, activityMarker] of promptedIdleSessionStates) {
    context.state.idleSupervisedPromptStates.set(sessionId, {
      lastPromptAt: promptedAt,
      lastActivityMarker: activityMarker,
    });
  }
  for (const hook of sentHooks) {
    hook.onSent?.(hookContext);
  }
  log(context, "Queued hook.");
  return true;
}
