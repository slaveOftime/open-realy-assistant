import { spawnSync } from "node:child_process";
import { log } from "./logging.ts";
import type { CommandResult, HeartRuntimeContext } from "./types.ts";
import { toErrorMessage } from "./utils.ts";

const sessionInputChunkLength = 3_000;

export function runOly(context: HeartRuntimeContext, args: string[], check = true): CommandResult {
  const result = spawnSync("oly", args, {
    cwd: context.config.launch.cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, stdout: "", error: toErrorMessage(result.error) };
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (check && (result.status ?? 1) !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return { ok: false, stdout, error: detail || `oly exited with code ${result.status ?? "unknown"}.` };
  }

  return { ok: true, stdout };
}

export function runOlyOnNode(
  context: HeartRuntimeContext,
  nodeName: string | undefined,
  args: string[],
  check = true,
): CommandResult {
  if (!nodeName) {
    return runOly(context, args, check);
  }

  const [command, ...rest] = args;
  if (!command) {
    return { ok: false, stdout: "", error: "Missing oly command." };
  }

  return runOly(context, [command, "--node", nodeName, ...rest], check);
}

export function loadConnectedNodeNames(context: HeartRuntimeContext): string[] {
  const result = runOly(context, ["node", "ls"], false);
  if (!result.ok) {
    log(context, `Error retrieving connected oly nodes: ${result.error ?? "unknown error"}`);
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "NAME" && line !== "No secondary nodes connected.");
}

export function sendNotification(
  context: HeartRuntimeContext,
  sessionId: string,
  title: string,
  description: string,
  body: string,
): void {
  if (context.config.flags.readOnly) {
    log(context, `[read-only] Would send notification '${title}' to session ${sessionId}.`);
    return;
  }

  const result = runOly(context, [
    "notify",
    "send",
    "--title",
    title,
    "--description",
    description.slice(0, 120),
    "--body",
    body,
    sessionId,
  ]);
  if (!result.ok) {
    log(context, `Error sending notification: ${result.error ?? "unknown error"}`);
  }
}

export function sendSessionInput(
  context: HeartRuntimeContext,
  sessionId: string,
  message: string,
  pressEnter: boolean,
): CommandResult {
  if (context.config.flags.readOnly) {
    const action = pressEnter ? "with enter" : "without enter";
    log(context, `[read-only] Would send input ${action} to ${sessionId}: ${JSON.stringify(message)}`);
    return { ok: true, stdout: "" };
  }

  return runOly(context, pressEnter ? ["send", sessionId, message, "key:enter"] : ["send", sessionId, message]);
}

function splitSessionInput(message: string, maxChunkLength: number): string[] {
  if (message.length <= maxChunkLength) {
    return [message];
  }

  const chunks: string[] = [];
  let remaining = message;
  while (remaining.length > maxChunkLength) {
    let splitAt = remaining.lastIndexOf("\n", maxChunkLength);
    if (splitAt <= 0 || splitAt < maxChunkLength / 2) {
      splitAt = maxChunkLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function sendSessionInputChunked(
  context: HeartRuntimeContext,
  sessionId: string,
  message: string,
): CommandResult {
  if (context.config.flags.readOnly) {
    log(context, `[read-only] Would send chunked input to ${sessionId}: ${JSON.stringify(message)}`);
    return { ok: true, stdout: "" };
  }

  for (const chunk of splitSessionInput(message, sessionInputChunkLength)) {
    const result = sendSessionInput(context, sessionId, chunk, false);
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true, stdout: "" };
}

export function sendSessionKey(context: HeartRuntimeContext, sessionId: string, key: string): CommandResult {
  if (context.config.flags.readOnly) {
    log(context, `[read-only] Would send key ${key} to ${sessionId}.`);
    return { ok: true, stdout: "" };
  }

  return runOly(context, ["send", sessionId, `key:${key}`]);
}

export function stopSession(context: HeartRuntimeContext, sessionId: string): CommandResult {
  if (context.config.flags.readOnly) {
    log(context, `[read-only] Would stop session ${sessionId}.`);
    return { ok: true, stdout: "" };
  }

  return runOly(context, ["stop", sessionId]);
}
