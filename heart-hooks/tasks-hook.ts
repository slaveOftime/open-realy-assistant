import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { HeartHookContext } from "../heart/phase20-hook.ts";
import type { SessionInfo } from "../heart/types.ts";
import { formatHumanLocalTimestamp, parseTimestampMs, repoRoot, sanitize, toErrorMessage } from "./shared.ts";

const tliContinuationSchema = z.object({
  next_step: z.string().nullish(),
  next_subtask: z.string().nullish(),
  next_task: z.string().nullish(),
}).passthrough();

const tliStateTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  updated_at: z.string(),
  ready_at: z.string().nullish(),
  continuation: tliContinuationSchema.optional(),
  next: tliContinuationSchema.optional(),
}).passthrough();

const tliStateSnapshotSchema = z.object({
  counts: z.object({
    ready: z.number().int().nonnegative().optional(),
    pending_dependencies: z.number().int().nonnegative().optional(),
    active: z.number().int().nonnegative().optional(),
  }).default({}),
  ready: z.array(tliStateTaskSchema).default([]),
  pending_dependencies: z.array(tliStateTaskSchema).default([]),
  active: z.array(tliStateTaskSchema).default([]),
}).passthrough();

type TliContinuation = z.infer<typeof tliContinuationSchema>;
type TliStateTask = z.infer<typeof tliStateTaskSchema>;
type TliStateSnapshot = z.infer<typeof tliStateSnapshotSchema>;

interface ManagedTaskEntry {
  taskId: string;
  title: string;
  status: string;
  updatedAt: string;
  readyAt?: string | null;
  continuation: TliContinuation;
  bucket: "ready" | "pending_dependencies" | "active";
}

const hooksDir = dirname(fileURLToPath(import.meta.url));
const fullPromptPath = join(hooksDir, "tasks-hook.md");
const compactPromptPath = join(hooksDir, "tasks-hook-compact.md");
const compactPromptWindowMs = 5 * 60_000;
const maxDueTasksInPrompt = 6;
const maxActiveTasksInPrompt = 6;
const tliStateLimit = Math.max(maxDueTasksInPrompt, maxActiveTasksInPrompt);
const ignoredTaskStatuses = new Set(["checkpoint", "review", "done"]);

let lastTaskHookSessionKey: string | null = null;
let lastTaskHookPromptAt = 0;

function getPromptMode(sessionKey: string, nowMs: number): "compact" | "full" {
  return lastTaskHookSessionKey === sessionKey
    && lastTaskHookPromptAt > 0
    && nowMs - lastTaskHookPromptAt < compactPromptWindowMs
    ? "compact"
    : "full";
}

function getCargoTliExecutable(): string | null {
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile) {
    return null;
  }

  const executable = join(userProfile, ".cargo", "bin", process.platform === "win32" ? "tli.exe" : "tli");
  return existsSync(executable) ? executable : null;
}

function getTliExecutableCandidates(): string[] {
  const candidates = ["tli"];
  const cargoExecutable = getCargoTliExecutable();
  if (cargoExecutable) {
    candidates.push(cargoExecutable);
  }
  return candidates;
}

function isSpawnLookupFailure(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code !== undefined
    && ["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function getCommandFailureOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = "stderr" in error ? (error as { stderr?: string | Buffer }).stderr : undefined;
  if (typeof stderr === "string") {
    return stderr;
  }
  if (stderr instanceof Buffer) {
    return stderr.toString("utf8");
  }

  return error.message;
}

function isMissingTliStoreError(error: unknown): boolean {
  return getCommandFailureOutput(error).includes("could not find '.tli'");
}

function readTliStateSnapshot(limit = tliStateLimit): TliStateSnapshot | null {
  let lastLookupFailure: unknown = null;

  for (const executable of getTliExecutableCandidates()) {
    try {
      const output = execFileSync(
        executable,
        ["--json", "state", "--limit", String(limit)],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );
      return tliStateSnapshotSchema.parse(JSON.parse(output));
    } catch (error) {
      if (isSpawnLookupFailure(error)) {
        lastLookupFailure = error;
        continue;
      }
      if (isMissingTliStoreError(error)) {
        return null;
      }

      console.error(`Error reading tli state via ${executable}: ${toErrorMessage(error)}`);
      return null;
    }
  }

  if (lastLookupFailure) {
    console.error(`Error reading tli state: ${toErrorMessage(lastLookupFailure)}`);
  }
  return null;
}

function toManagedTaskEntry(task: TliStateTask, bucket: ManagedTaskEntry["bucket"]): ManagedTaskEntry {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updated_at,
    readyAt: task.ready_at ?? null,
    continuation: task.next ?? task.continuation ?? {},
    bucket,
  };
}

function shouldIgnoreTask(task: TliStateTask): boolean {
  return ignoredTaskStatuses.has(task.status);
}

function readManagedTasks(): {
  readyTasks: ManagedTaskEntry[];
  readyCount: number;
  pendingDependencyTasks: ManagedTaskEntry[];
  pendingDependencyCount: number;
  activeTasks: ManagedTaskEntry[];
  activeCount: number;
} {
  const snapshot = readTliStateSnapshot();
  if (!snapshot) {
    return {
      readyTasks: [],
      readyCount: 0,
      pendingDependencyTasks: [],
      pendingDependencyCount: 0,
      activeTasks: [],
      activeCount: 0,
    };
  }

  const readyTasks = snapshot.ready
    .filter((task) => !shouldIgnoreTask(task))
    .map((task) => toManagedTaskEntry(task, "ready"));
  const pendingDependencyTasks = snapshot.pending_dependencies
    .filter((task) => !shouldIgnoreTask(task))
    .map((task) => toManagedTaskEntry(task, "pending_dependencies"));
  const activeTasks = snapshot.active
    .filter((task) => !shouldIgnoreTask(task))
    .map((task) => toManagedTaskEntry(task, "active"));

  return {
    readyTasks,
    readyCount: snapshot.counts.ready ?? readyTasks.length,
    pendingDependencyTasks,
    pendingDependencyCount: snapshot.counts.pending_dependencies ?? pendingDependencyTasks.length,
    activeTasks,
    activeCount: snapshot.counts.active ?? activeTasks.length,
  };
}

function compareUpdatedDesc(left: ManagedTaskEntry, right: ManagedTaskEntry): number {
  const leftUpdated = parseTimestampMs(left.updatedAt) ?? Number.MIN_SAFE_INTEGER;
  const rightUpdated = parseTimestampMs(right.updatedAt) ?? Number.MIN_SAFE_INTEGER;
  return rightUpdated - leftUpdated;
}

function compareReadyTasks(left: ManagedTaskEntry, right: ManagedTaskEntry): number {
  const leftReady = parseTimestampMs(left.readyAt) ?? Number.MIN_SAFE_INTEGER;
  const rightReady = parseTimestampMs(right.readyAt) ?? Number.MIN_SAFE_INTEGER;
  if (leftReady !== rightReady) {
    return leftReady - rightReady;
  }

  return compareUpdatedDesc(left, right);
}

function getTaskIdFromSessionTags(session: SessionInfo): string | null {
  const taskTag = session.tags?.find((tag) => tag.startsWith("task:"));
  return taskTag ? taskTag.slice("task:".length) : null;
}

function findRelatedLiveSession(task: ManagedTaskEntry, supervisedSessions: readonly SessionInfo[]): SessionInfo | null {
  return supervisedSessions.find((session) => getTaskIdFromSessionTags(session) === task.taskId) ?? null;
}

function getContinuationSummary(task: ManagedTaskEntry): string | null {
  const parts: string[] = [];
  if (task.continuation.next_step?.trim()) {
    parts.push(`step=${task.continuation.next_step.trim()}`);
  }
  if (task.continuation.next_subtask?.trim()) {
    parts.push(`subtask=${task.continuation.next_subtask.trim()}`);
  }
  if (task.continuation.next_task?.trim()) {
    parts.push(`task=${task.continuation.next_task.trim()}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

function getTaskNextInstruction(task: ManagedTaskEntry, relatedSession?: SessionInfo | null): string {
  if (relatedSession) {
    return `oly logs ${relatedSession.id} --tail 20 --no-truncate`;
  }

  if (getContinuationSummary(task)) {
    return `tli next ${task.taskId}`;
  }

  return `tli show ${task.taskId} --verbose`;
}

function formatTaskTimestamp(timestamp?: string | null): string | null {
  const parsed = parseTimestampMs(timestamp);
  return parsed === null ? null : formatHumanLocalTimestamp(parsed);
}

function getTaskBriefMetadata(task: ManagedTaskEntry, relatedSession?: SessionInfo | null): string {
  const parts: string[] = [`status=${task.status}`];
  const updatedAt = formatTaskTimestamp(task.updatedAt);
  parts.push(`updated=${updatedAt ?? task.updatedAt}`);
  if (task.readyAt) {
    const readyAt = formatTaskTimestamp(task.readyAt);
    parts.push(`ready_at=${readyAt ?? task.readyAt}`);
  }
  if (relatedSession) {
    parts.push(`session=${relatedSession.id}/live`);
  }
  return parts.join(" | ");
}

function buildTaskSection(
  title: string,
  tasks: readonly ManagedTaskEntry[],
  totalCount: number,
  supervisedSessions: readonly SessionInfo[],
  mode: "compact" | "full",
): string {
  if (totalCount === 0) {
    return "";
  }

  const titleLimit = mode === "compact" ? 60 : 120;
  const metaLimit = mode === "compact" ? 140 : 180;
  const hintLimit = mode === "compact" ? 160 : 220;

  const lines = tasks.map((task) => {
    const relatedSession = findRelatedLiveSession(task, supervisedSessions);
    const continuation = !relatedSession ? getContinuationSummary(task) : null;
    return [
      mode === "compact"
        ? `- ${task.taskId} | ${task.status} | ${sanitize(task.title, titleLimit)}`
        : `- ${task.taskId} | ${task.status}`,
      mode === "compact" ? null : `  title: ${sanitize(task.title, titleLimit)}`,
      `  meta: ${sanitize(getTaskBriefMetadata(task, relatedSession), metaLimit)}`,
      continuation ? `  next_hint: ${sanitize(continuation, hintLimit)}` : null,
      `  next: ${getTaskNextInstruction(task, relatedSession)}`,
    ].filter(Boolean).join("\n");
  });

  const hiddenCount = Math.max(0, totalCount - tasks.length);
  return [
    `${title}: ${totalCount}.`,
    ...lines,
    hiddenCount > 0 ? `- +${hiddenCount} more hidden items managed by tli.` : null,
  ].filter(Boolean).join("\n");
}

function readPromptTemplate(mode: "compact" | "full"): string | null {
  const promptPath = mode === "compact" ? compactPromptPath : fullPromptPath;
  try {
    return readFileSync(promptPath, "utf8").trim();
  } catch (error) {
    console.error(`Error reading task hook prompt template: ${toErrorMessage(error)}`);
    return null;
  }
}

function renderPromptTemplate(
  template: string,
  dueSection: string,
  pendingDependencySection: string,
  activeSection: string,
): string {
  return template
    .replace("{{due_tasks_section}}", dueSection)
    .replace("{{pending_dependency_tasks_section}}", pendingDependencySection)
    .replace("{{active_tasks_section}}", activeSection)
    .trim();
}

const taskTrackerHookImpl = (context: HeartHookContext): string | null => {
  void context.now;
  const nowMs = Date.now();
  const mode = getPromptMode(context.sessionKey, nowMs);
  const trackedTasks = readManagedTasks();
  const dueTasks = trackedTasks.readyTasks.sort(compareReadyTasks);
  const pendingDependencyTasks = trackedTasks.pendingDependencyTasks.sort(compareReadyTasks);
  const activeTasks = trackedTasks.activeTasks.sort(compareUpdatedDesc);

  if (dueTasks.length === 0 && pendingDependencyTasks.length === 0 && activeTasks.length === 0) {
    return null;
  }

  const dueSection = buildTaskSection(
    "Ready tasks",
    dueTasks.slice(0, maxDueTasksInPrompt),
    trackedTasks.readyCount,
    context.selection.supervisedSessions,
    mode,
  );
  const pendingDependencySection = buildTaskSection(
    "Pending dependency tasks",
    pendingDependencyTasks.slice(0, maxDueTasksInPrompt),
    trackedTasks.pendingDependencyCount,
    context.selection.supervisedSessions,
    mode,
  );
  const activeSection = buildTaskSection(
    "Active tli tasks",
    activeTasks.slice(0, maxActiveTasksInPrompt),
    trackedTasks.activeCount,
    context.selection.supervisedSessions,
    mode,
  );

  const template = readPromptTemplate(mode);
  if (!template) {
    return null;
  }

  return renderPromptTemplate(template, dueSection, pendingDependencySection, activeSection);
};

taskTrackerHookImpl.onSent = (context: HeartHookContext): void => {
  lastTaskHookSessionKey = context.sessionKey;
  lastTaskHookPromptAt = Date.now();
};

export const taskTrackerHook = taskTrackerHookImpl;
