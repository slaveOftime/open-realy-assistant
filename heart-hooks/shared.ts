import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const tliRoot = join(repoRoot, ".tli");

export function parseTimestampMs(timestamp?: string | null): number | null {
  if (!timestamp) {
    return null;
  }

  const isoLike = timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T");
  const parsed = Date.parse(isoLike);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatLocalTimestamp(timestampMs = Date.now(), fractionalDigits = 0): string {
  const timestamp = new Date(timestampMs);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const milliseconds = pad(timestamp.getMilliseconds(), 3);
  const fraction =
    fractionalDigits <= 0
      ? ""
      : `.${milliseconds.slice(0, Math.min(3, fractionalDigits)).padEnd(fractionalDigits, "0")}`;
  const absoluteOffsetMinutes = Math.abs(timestamp.getTimezoneOffset());
  const offsetSign = timestamp.getTimezoneOffset() <= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(absoluteOffsetMinutes / 60));
  const offsetMinutes = pad(absoluteOffsetMinutes % 60);

  return `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}T${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}${fraction}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

export function formatHumanLocalTimestamp(timestampMs = Date.now()): string {
  const timestamp = new Date(timestampMs);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const absoluteOffsetMinutes = Math.abs(timestamp.getTimezoneOffset());
  const offsetSign = timestamp.getTimezoneOffset() <= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(absoluteOffsetMinutes / 60));
  const offsetMinutes = pad(absoluteOffsetMinutes % 60);

  return `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())} ${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())} ${offsetSign}${offsetHours}:${offsetMinutes}`;
}

export function sanitize(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "unavailable";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}
