import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { taskTrackerHook } from "./heart-hooks/tasks-hook.ts";
import {
  defaultHeartRuntimeFlags,
  defaultHeartRuntimeSettings,
  type HeartRuntimeConfig,
} from "./heart/types.ts";
import { readText } from "./heart/utils.ts";

const assistantName = "gogo";
const primarySessionTitle = "gogo";
const supervisedSessionTag = "gogo";
const assistantCommand = "copilot";
const assistantArguments = [
  "--model",
  "gpt-5.4",
  "--allow-all-urls",
  "--allow-all-tools",
  "--allow-all-paths",
] as const;

const repoRoot = dirname(fileURLToPath(import.meta.url));
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
const checkConfig = process.argv.includes("--check-config");

const promptFiles = {
  initialPromptFile: join(repoRoot, "prompts", "soul.md"),
  sleepPromptFile: join(repoRoot, "prompts", "sleep.md"),
  taskHookPromptFile: join(repoRoot, "heart-hooks", "tasks-hook.md"),
  compactTaskHookPromptFile: join(repoRoot, "heart-hooks", "tasks-hook-compact.md"),
} as const;

function createHeartConfig(): HeartRuntimeConfig {
  return {
    launch: {
      cwd: repoRoot,
      command: assistantCommand,
      arguments: assistantArguments,
    },
    identity: {
      agentName: assistantName,
      primarySessionTitle,
      childSessionTitlePrefixes: [`${primarySessionTitle}-`],
      supervisedSessionTag,
      runtimeTitle: `${primarySessionTitle}-heart`,
      attentionNotificationTitle: `${assistantName} needs attention`,
    },
    prompts: {
      initialPromptFile: promptFiles.initialPromptFile,
      sleepPromptFile: promptFiles.sleepPromptFile,
    },
    artifacts: {
      logFile: join(repoRoot, "heart", "logs", "heart.log"),
      lifecycleStateFile: join(repoRoot, "heart", "logs", "heart-lifecycle.json"),
      lifecycleFailureLogFile: join(repoRoot, "heart", "logs", "heart-lifecycle-failures.log"),
      lifeFile: join(repoRoot, "heart", "logs", "life.md"),
      lifeHeader: "# Heart Life",
    },
    settings: {
      ...defaultHeartRuntimeSettings,
    },
    flags: {
      ...defaultHeartRuntimeFlags,
      runOnce: process.argv.includes("--once"),
      readOnly: process.argv.includes("--read-only"),
    },
  };
}

function validateHeartConfig(config: HeartRuntimeConfig): void {
  readText(config.prompts.initialPromptFile);
  readText(config.prompts.sleepPromptFile);
  readText(promptFiles.taskHookPromptFile);
  readText(promptFiles.compactTaskHookPromptFile);
}

if (isEntrypoint) {
  const { run } = await import("./heart/main.ts");
  const config = createHeartConfig();

  if (checkConfig) {
    validateHeartConfig(config);
    console.log(
      `Configuration OK for ${config.identity.agentName}; title=${config.identity.primarySessionTitle}; tag=${config.identity.supervisedSessionTag}; cwd=${config.launch.cwd}`,
    );
  } else {
    await run(config, {
      hooks: [taskTrackerHook],
    });
  }
}
