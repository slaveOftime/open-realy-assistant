import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDirectoryExists, formatLocalTime, formatLocalTimestamp } from "./utils.ts";
import type { HeartRuntimeContext } from "./types.ts";

function pickConsoleIcon(message: string): string {
  if (message === "Heart beat") {
    return "💓";
  }
  if (message.startsWith("Primary session uptime derived from session start timestamp:")) {
    return "🕒";
  }
  if (message.startsWith("Primary session is running with session ID:")) {
    return "🤖";
  }
  if (message.startsWith("Error") || message.startsWith("Heart cycle failed")) {
    return "❌";
  }
  if (message.startsWith("Warning")) {
    return "⚠️";
  }
  if (message.includes("accepted") || message.includes("ready for input")) {
    return "✅";
  }
  if (message.includes("Sending")) {
    return "📨";
  }
  if (message.includes("waiting")) {
    return "⏳";
  }
  if (message.includes("sleep")) {
    return "😴";
  }
  return "›";
}

function formatConsoleLine(context: HeartRuntimeContext, timestampMs: number, message: string): string {
  const precisionMs = context.config.settings.logicTimestampPrecisionMs;
  const time = formatLocalTime(timestampMs, context.config.settings.logTimestampFractionDigits, precisionMs);
  const icon = pickConsoleIcon(message);
  if (message === "Heart beat") {
    return `\n[${time}] ${icon} ═══════ Heartbeat ═══════\n`;
  }

  return `[${time}] ${icon} ${message}`;
}

export function log(context: HeartRuntimeContext, message: string): void {
  const timestampMs = Date.now();
  const precisionMs = context.config.settings.logicTimestampPrecisionMs;
  const logFile = context.config.artifacts.logFile;
  ensureDirectoryExists(dirname(logFile));
  console.log(formatConsoleLine(context, timestampMs, message));
  appendFileSync(
    logFile,
    `[${formatLocalTimestamp(timestampMs, context.config.settings.logTimestampFractionDigits, precisionMs)}] ${message}\n`,
  );
}

export function appendBoundedLogLine(filePath: string, line: string, maxEntries: number): void {
  ensureDirectoryExists(dirname(filePath));
  const existingLines = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
  existingLines.push(line);
  writeFileSync(filePath, `${existingLines.slice(Math.max(0, existingLines.length - maxEntries)).join("\n")}\n`, "utf8");
}

export function appendLifeEvent(
  context: HeartRuntimeContext,
  event: string,
  details: Record<string, string | number | boolean | null | undefined> = {},
  timestampMs = Date.now(),
): void {
  const precisionMs = context.config.settings.logicTimestampPrecisionMs;
  const { lifeFile, lifeHeader } = context.config.artifacts;
  ensureDirectoryExists(dirname(lifeFile));
  if (!existsSync(lifeFile)) {
    appendFileSync(lifeFile, `${lifeHeader}\n\n`);
  }

  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  appendFileSync(
    lifeFile,
    `- ${formatLocalTimestamp(timestampMs, 0, precisionMs)} ${event}${fields.length > 0 ? ` ${fields.join(" ")}` : ""}\n`,
  );
}
