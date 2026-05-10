import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatLocalTimestamp,
  parseTimestampMs,
  sanitizeLifeLessonField,
  toErrorMessage,
} from "../heart/utils.ts";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function formatHumanLocalTimestamp(timestampMs: number): string {
  return formatLocalTimestamp(timestampMs);
}

export { parseTimestampMs, toErrorMessage };
export const sanitize = sanitizeLifeLessonField;
