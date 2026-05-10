import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
};

type SessionInfo = {
  id: string;
  title?: string | null;
  tags?: string[];
  command?: string;
  status?: string;
  input_needed?: boolean;
  created_at?: string;
  started_at?: string;
  last_output_epoch?: string | null;
};

type SessionListResponse = {
  items: SessionInfo[];
};

type RuntimeState = {
  initializedSessionKey?: string;
  lastHookSignature?: string;
  sleepPromptedSessionKey?: string;
};

type Config = {
  repoRoot: string;
  assistantName: string;
  sessionTitle: string;
  sessionTag: string;
  launchCommand: string;
  launchArgs: string[];
  assistantCwd: string;
  olyCommand: string;
  tliCommand: string;
  initialPromptFile: string;
  taskHookPromptFile: string;
  sleepPromptFile: string;
  logFile: string;
  stateFile: string;
  checkIntervalMs: number;
  startupWaitMs: number;
  sleepAfterMs: number;
  maxTliOutputChars: number;
  runOnce: boolean;
  readOnly: boolean;
  checkConfig: boolean;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  const file = join(repoRoot, ".env");
  if (!existsSync(file)) {
    return;
  }

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    process.env[key] ??= value;
  }
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "assistant";
}

function splitArgs(value: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  for (const match of value.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

function loadConfig(): Config {
  loadDotEnv();
  const assistantName = env("ASSISTANT_NAME", "Gogo");
  return {
    repoRoot,
    assistantName,
    sessionTitle: env("ASSISTANT_SESSION_TITLE", assistantName),
    sessionTag: env("ASSISTANT_SESSION_TAG", normalizeTag(assistantName)),
    launchCommand: env("ASSISTANT_COMMAND", "copilot"),
    launchArgs: splitArgs(env("ASSISTANT_ARGS", "")),
    assistantCwd: resolve(env("ASSISTANT_CWD", repoRoot)),
    olyCommand: env("OLY_COMMAND", "oly"),
    tliCommand: env("TLI_COMMAND", "tli"),
    initialPromptFile: resolve(repoRoot, env("INITIAL_PROMPT_FILE", "prompts\\soul.md")),
    taskHookPromptFile: resolve(repoRoot, env("TASK_HOOK_PROMPT_FILE", "prompts\\task-hook.md")),
    sleepPromptFile: resolve(repoRoot, env("SLEEP_PROMPT_FILE", "prompts\\sleep.md")),
    logFile: resolve(repoRoot, env("HEART_LOG_FILE", "runtime\\logs\\heart.log")),
    stateFile: resolve(repoRoot, env("HEART_STATE_FILE", "runtime\\state\\heart-state.json")),
    checkIntervalMs: envInt("HEART_CHECK_INTERVAL_MS", 5_000),
    startupWaitMs: envInt("HEART_STARTUP_WAIT_MS", 2_000),
    sleepAfterMs: envInt("HEART_SLEEP_AFTER_MS", 3 * 60 * 60_000),
    maxTliOutputChars: envInt("HEART_MAX_TLI_OUTPUT_CHARS", 12_000),
    runOnce: process.argv.includes("--once"),
    readOnly: process.argv.includes("--read-only"),
    checkConfig: process.argv.includes("--check-config"),
  };
}

function ensureParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function log(config: Config, message: string): void {
  ensureParent(config.logFile);
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  writeFileSync(config.logFile, `${line}\n`, { flag: "a" });
}

function quoteWindowsArg(arg: string): string {
  return `"${arg.replaceAll('"', '""')}"`;
}

function run(command: string, args: string[], cwd: string): CommandResult {
  const useCmdShim = process.platform === "win32";
  const result = useCmdShim
    ? spawnSync([command, ...args].map(quoteWindowsArg).join(" "), {
      cwd,
      encoding: "utf8",
      shell: true,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    : spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    return { ok: false, stdout, stderr, error: result.error.message };
  }
  if ((result.status ?? 1) !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      error: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `${command} exited with ${result.status}`,
    };
  }
  return { ok: true, stdout, stderr };
}

function readPrompt(config: Config, file: string): string {
  const template = readFileSync(file, "utf8");
  return template.replaceAll("{{assistant_name}}", config.assistantName).trim();
}

function loadState(config: Config): RuntimeState {
  if (!existsSync(config.stateFile)) {
    return {};
  }
  return JSON.parse(readFileSync(config.stateFile, "utf8")) as RuntimeState;
}

function saveState(config: Config, state: RuntimeState): void {
  ensureParent(config.stateFile);
  writeFileSync(config.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function parseSessions(config: Config, stdout: string): SessionInfo[] {
  const parsed = JSON.parse(stdout) as SessionListResponse;
  if (!Array.isArray(parsed.items)) {
    throw new Error("oly session list did not contain an items array.");
  }
  return parsed.items.filter((session) => session.tags?.includes(config.sessionTag) || session.title === config.sessionTitle);
}

function listSessions(config: Config): SessionInfo[] {
  const result = run(config.olyCommand, ["ls", "--json", "--status", "running", "--tag", config.sessionTag, "--limit", "100"], config.assistantCwd);
  if (!result.ok) {
    throw new Error(`Unable to list oly sessions: ${result.error ?? "unknown error"}`);
  }
  return parseSessions(config, result.stdout);
}

function sessionKey(session: SessionInfo): string {
  return `${session.id}:${session.started_at ?? session.created_at ?? "unknown"}`;
}

function sessionStartMs(session: SessionInfo): number | null {
  const raw = session.started_at ?? session.created_at;
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionCanAcceptMessage(session: SessionInfo): boolean {
  return session.input_needed === true || (session.status ?? "").toLowerCase().includes("input");
}

function sendToSession(config: Config, sessionId: string, message: string): void {
  if (config.readOnly) {
    log(config, `[read-only] Would send prompt to ${sessionId}: ${message.slice(0, 120)}`);
    return;
  }
  const result = run(config.olyCommand, ["send", sessionId, message, "key:enter"], config.assistantCwd);
  if (!result.ok) {
    throw new Error(`Unable to send prompt to ${sessionId}: ${result.error ?? "unknown error"}`);
  }
}

function startPrimarySession(config: Config): void {
  if (config.readOnly) {
    throw new Error("Primary session is missing and --read-only prevents starting it.");
  }
  const result = run(
    config.olyCommand,
    [
      "start",
      "--title",
      config.sessionTitle,
      "--tag",
      config.sessionTag,
      "--cwd",
      config.assistantCwd,
      "--disable-notifications",
      "--detach",
      config.launchCommand,
      ...config.launchArgs,
    ],
    config.assistantCwd,
  );
  if (!result.ok) {
    throw new Error(`Unable to start primary session: ${result.error ?? "unknown error"}`);
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function getOrStartPrimary(config: Config): Promise<SessionInfo | null> {
  let primary = listSessions(config).find((session) => session.title === config.sessionTitle) ?? null;
  if (primary) {
    return primary;
  }
  log(config, `Starting ${config.assistantName} primary session '${config.sessionTitle}'.`);
  startPrimarySession(config);
  await wait(config.startupWaitMs);
  primary = listSessions(config).find((session) => session.title === config.sessionTitle) ?? null;
  if (!primary) {
    log(config, "Primary session was started but is not visible yet.");
  }
  return primary;
}

function boundedTli(config: Config, args: string[]): string {
  const result = run(config.tliCommand, args, config.assistantCwd);
  if (!result.ok) {
    return `Unavailable: ${result.error ?? "unknown error"}`;
  }
  const output = result.stdout.trim();
  return output.length > config.maxTliOutputChars ? `${output.slice(0, config.maxTliOutputChars)}\n...[truncated]` : output || "(no output)";
}

function buildTaskHookPrompt(config: Config): string {
  const template = readPrompt(config, config.taskHookPromptFile);
  return template
    .replaceAll("{{tli_state}}", boundedTli(config, ["state"]))
    .replaceAll("{{tli_ready}}", boundedTli(config, ["ready"]));
}

function shouldSendTaskHook(state: RuntimeState, prompt: string): boolean {
  const signature = String(prompt.length) + ":" + prompt.slice(0, 4000);
  if (state.lastHookSignature === signature) {
    return false;
  }
  state.lastHookSignature = signature;
  return true;
}

async function runCycle(config: Config, state: RuntimeState): Promise<void> {
  const primary = await getOrStartPrimary(config);
  if (!primary) {
    return;
  }

  const key = sessionKey(primary);
  if (state.initializedSessionKey !== key && sessionCanAcceptMessage(primary)) {
    const prompt = [`HEART-WAKE ${new Date().toLocaleString()}`, readPrompt(config, config.initialPromptFile)].join("\n\n");
    sendToSession(config, primary.id, prompt);
    state.initializedSessionKey = key;
    saveState(config, state);
    log(config, "Sent wake prompt.");
    return;
  }

  if (!sessionCanAcceptMessage(primary)) {
    log(config, "Primary session is busy; skipping this pass.");
    return;
  }

  const hookPrompt = buildTaskHookPrompt(config);
  if (shouldSendTaskHook(state, hookPrompt)) {
    sendToSession(config, primary.id, [`HEART-TASK-HOOK ${new Date().toLocaleString()}`, hookPrompt].join("\n\n"));
    saveState(config, state);
    log(config, "Sent bounded tli task hook.");
    return;
  }

  const startedAt = sessionStartMs(primary);
  if (startedAt && Date.now() - startedAt >= config.sleepAfterMs && state.sleepPromptedSessionKey !== key) {
    sendToSession(config, primary.id, [`HEART-SLEEP ${new Date().toLocaleString()}`, readPrompt(config, config.sleepPromptFile)].join("\n\n"));
    state.sleepPromptedSessionKey = key;
    saveState(config, state);
    log(config, "Sent sleep handoff prompt.");
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.checkConfig) {
    readPrompt(config, config.initialPromptFile);
    readPrompt(config, config.taskHookPromptFile);
    readPrompt(config, config.sleepPromptFile);
    console.log(`Configuration OK for ${config.assistantName}; title=${config.sessionTitle}; tag=${config.sessionTag}`);
    return;
  }

  const state = loadState(config);
  log(config, `Heart starting for ${config.assistantName}; tag=${config.sessionTag}; cwd=${config.assistantCwd}`);

  do {
    await runCycle(config, state);
    saveState(config, state);
    if (config.runOnce) {
      break;
    }
    await wait(config.checkIntervalMs);
  } while (true);
}

main().catch((error: unknown) => {
  const config = loadConfig();
  log(config, `Heart failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
