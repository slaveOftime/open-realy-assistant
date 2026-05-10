import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { taskTrackerHook } from "./heart-hooks/tasks-hook.ts";
import {
  defaultHeartRuntimeFlags,
  defaultHeartRuntimeSettings,
  type HeartRuntimeConfig,
} from "./heart/types.ts";
import { readText } from "./heart/utils.ts";

const AssistantName = "gogo";
const PrimarySessionTitle = "gogo";
const SupervisedSessionTag = "gogo";

export const defaultAssistantCommand = "copilot";
export const defaultAssistantArguments = [
  "--model", "gpt-5.4",
  "--allow-all-urls",
  "--allow-all-tools",
  "--allow-all-paths",
] as const;

const repoRoot = dirname(fileURLToPath(import.meta.url));
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);

function createHeartConfig(): HeartRuntimeConfig {
  return {
    launch: {
      cwd: repoRoot,
      command: defaultAssistantCommand,
      arguments: defaultAssistantArguments,
    },
    identity: {
      agentName: AssistantName,
      primarySessionTitle: PrimarySessionTitle,
      childSessionTitlePrefixes: [`${PrimarySessionTitle}-`],
      supervisedSessionTag: SupervisedSessionTag,
      runtimeTitle: `${PrimarySessionTitle}-heart`,
      attentionNotificationTitle: `${AssistantName} needs attention`,
    },
    prompts: {
      initialPromptFile: join(repoRoot, "prompts", "soul.md"),
      sleepPromptFile: join(repoRoot, "prompts", "sleep.md"),
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
  readText(join(repoRoot, "heart-hooks", "tasks-hook.md"));
  readText(join(repoRoot, "heart-hooks", "tasks-hook-compact.md"));
}

if (isEntrypoint) {
  const { run } = await import("./heart/main.ts");
  const config = createHeartConfig();

  if (process.argv.includes("--check-config")) {
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
