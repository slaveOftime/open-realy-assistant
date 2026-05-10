import { mkdirSync, readFileSync } from "node:fs";
import { defaultHeartRuntimeSettings, type HeartRuntimeContext } from "./types.ts";

export class StopRequestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopRequestedError";
  }
}

export function throwIfStopping(reason: string, context?: HeartRuntimeContext): void {
  if (context?.state.shouldStop) {
    throw new StopRequestedError(`stop requested while ${reason}`);
  }
}

export async function wait(
  delayMs: number,
  abortOnStop: boolean,
  reason: string,
  context?: HeartRuntimeContext,
): Promise<void> {
  if (delayMs <= 0) {
    if (abortOnStop) {
      throwIfStopping(reason, context);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abortOnStop && context?.state.shouldStop) {
        reject(new StopRequestedError(`stop requested while ${reason}`));
        return;
      }
      resolve();
    }, delayMs);

    if (abortOnStop && context?.state.shouldStop) {
      clearTimeout(timer);
      reject(new StopRequestedError(`stop requested while ${reason}`));
    }
  });
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function extractSessionId(text: string): string {
  const match = text.match(/\b([0-9a-f]{7,})\b/i);
  if (!match) {
    throw new Error(`Could not find session id in: ${JSON.stringify(text)}`);
  }

  return match[1];
}

export function normalizeTimestampMs(
  timestampMs: number,
  precisionMs = defaultHeartRuntimeSettings.logicTimestampPrecisionMs,
): number {
  return Math.floor(timestampMs / precisionMs) * precisionMs;
}

export function parseTimestampMs(timestamp?: string | null): number | null {
  if (!timestamp) {
    return null;
  }

  const isoLike = timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T");
  const parsed = Date.parse(isoLike);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseOlyTimestamp(
  timestamp?: string | null,
  precisionMs = defaultHeartRuntimeSettings.logicTimestampPrecisionMs,
): number | null {
  const parsed = parseTimestampMs(timestamp);
  return parsed === null ? null : normalizeTimestampMs(parsed, precisionMs);
}

export function getMessagePreview(text: string, maxLength = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.slice(0, maxLength) || "(empty)";
}

export function readText(filePath: string): string {
  return readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

export function ensureDirectoryExists(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true });
}

function padNumber(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatLocalTime(
  timestampMs = Date.now(),
  fractionalDigits = 0,
  precisionMs = defaultHeartRuntimeSettings.logicTimestampPrecisionMs,
): string {
  const normalizedTimestampMs =
    fractionalDigits <= 0
      ? normalizeTimestampMs(timestampMs, precisionMs)
      : normalizeTimestampMs(timestampMs, Math.max(1, Math.floor(1_000 / 10 ** fractionalDigits)));
  const timestamp = new Date(normalizedTimestampMs);
  const hours = padNumber(timestamp.getHours());
  const minutes = padNumber(timestamp.getMinutes());
  const seconds = padNumber(timestamp.getSeconds());
  const milliseconds = padNumber(timestamp.getMilliseconds(), 3);
  const fraction =
    fractionalDigits <= 0
      ? ""
      : `.${milliseconds.slice(0, Math.min(3, fractionalDigits)).padEnd(fractionalDigits, "0")}`;

  return `${hours}:${minutes}:${seconds}${fraction}`;
}

export function formatLocalTimestamp(
  timestampMs = Date.now(),
  fractionalDigits = 0,
  precisionMs = defaultHeartRuntimeSettings.logicTimestampPrecisionMs,
): string {
  const normalizedTimestampMs =
    fractionalDigits <= 0
      ? normalizeTimestampMs(timestampMs, precisionMs)
      : normalizeTimestampMs(timestampMs, Math.max(1, Math.floor(1_000 / 10 ** fractionalDigits)));
  const timestamp = new Date(normalizedTimestampMs);
  const year = timestamp.getFullYear();
  const month = padNumber(timestamp.getMonth() + 1);
  const day = padNumber(timestamp.getDate());
  const hours = padNumber(timestamp.getHours());
  const minutes = padNumber(timestamp.getMinutes());
  const seconds = padNumber(timestamp.getSeconds());
  const milliseconds = padNumber(timestamp.getMilliseconds(), 3);
  const absoluteOffsetMinutes = Math.abs(timestamp.getTimezoneOffset());
  const offsetSign = timestamp.getTimezoneOffset() <= 0 ? "+" : "-";
  const offsetHours = padNumber(Math.floor(absoluteOffsetMinutes / 60));
  const offsetMinutes = padNumber(absoluteOffsetMinutes % 60);
  const fraction =
    fractionalDigits <= 0
      ? ""
      : `.${milliseconds.slice(0, Math.min(3, fractionalDigits)).padEnd(fractionalDigits, "0")}`;

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${fraction}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

export function formatParsedTimestamp(
  timestamp?: string | null,
  fractionalDigits = 0,
  precisionMs = defaultHeartRuntimeSettings.logicTimestampPrecisionMs,
): string | null {
  const parsed = parseTimestampMs(timestamp);
  if (parsed === null) {
    return timestamp ?? null;
  }

  return formatLocalTimestamp(parsed, fractionalDigits, precisionMs);
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join("");
}

export function sanitizeLifeLessonField(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "unavailable";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}
