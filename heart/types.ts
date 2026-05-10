export interface CommandResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

export interface HeartRuntimeSettings {
  checkIntervalMs: number;
  retryDelayMs: number;
  startRetryDelayMs: number;
  startCooldownMs: number;
  initializationReadyTimeoutMs: number;
  initializationSettleMs: number;
  idleBeforeSupervisionMs: number;
  promptReadySilentMs: number;
  conservativeIdleQuietPeriodMs: number;
  idleOutputQuietPeriodMs: number;
  idleTailStablePeriodMs: number;
  idleTailCheckMinIntervalMs: number;
  idleLogTailLines: string;
  sleepAfterMs: number;
  sleepQuietPeriodMs: number;
  maxSleepSequenceMs: number;
  sleepBusyNotificationAfterMs: number;
  sleepInterruptSettleMs: number;
  sessionRotationWaitMs: number;
  postSleepDelayMs: number;
  submitDelayMs: number;
  enterRetryAttempts: number;
  enterOutputAckTimeoutMs: number;
  slowDeliveryNotificationCooldownMs: number;
  logicTimestampPrecisionMs: number;
  logTimestampFractionDigits: number;
  lifecycleFailureLogMaxEntries: number;
}

export const defaultHeartRuntimeSettings: HeartRuntimeSettings = {
  checkIntervalMs: 5_000,
  retryDelayMs: 1_000,
  startRetryDelayMs: 5_000,
  startCooldownMs: 120_000,
  initializationReadyTimeoutMs: 15_000,
  initializationSettleMs: 15_000,
  idleBeforeSupervisionMs: 10_000,
  promptReadySilentMs: 15_000,
  conservativeIdleQuietPeriodMs: 15_000,
  idleOutputQuietPeriodMs: 15_000,
  idleTailStablePeriodMs: 15_000,
  idleTailCheckMinIntervalMs: 3_000,
  idleLogTailLines: "15",
  sleepAfterMs: 3 * 60 * 60_000,
  sleepQuietPeriodMs: 15_000,
  maxSleepSequenceMs: 15 * 60_000,
  sleepBusyNotificationAfterMs: 30 * 60_000,
  sleepInterruptSettleMs: 5_000,
  sessionRotationWaitMs: 15_000,
  postSleepDelayMs: 30_000,
  submitDelayMs: 500,
  enterRetryAttempts: 3,
  enterOutputAckTimeoutMs: 3_000,
  slowDeliveryNotificationCooldownMs: 15 * 60_000,
  logicTimestampPrecisionMs: 1_000,
  logTimestampFractionDigits: 1,
  lifecycleFailureLogMaxEntries: 80,
};

export interface HeartRuntimeFlags {
  runOnce: boolean;
  readOnly: boolean;
}

export const defaultHeartRuntimeFlags: HeartRuntimeFlags = {
  runOnce: false,
  readOnly: false,
};

export interface HeartLaunchConfig {
  cwd: string;
  command: string;
  arguments: readonly string[];
}

export interface HeartIdentityConfig {
  agentName: string;
  primarySessionTitle: string;
  childSessionTitlePrefixes: readonly string[];
  supervisedSessionTag: string;
  runtimeTitle: string;
  attentionNotificationTitle: string;
}

export interface HeartPromptFiles {
  initialPromptFile: string;
  sleepPromptFile: string;
}

export interface HeartArtifactFiles {
  logFile: string;
  lifecycleStateFile: string;
  lifecycleFailureLogFile: string;
  lifeFile: string;
  lifeHeader: string;
}

export interface HeartRuntimeConfig {
  launch: HeartLaunchConfig;
  identity: HeartIdentityConfig;
  prompts: HeartPromptFiles;
  artifacts: HeartArtifactFiles;
  settings: HeartRuntimeSettings;
  flags: HeartRuntimeFlags;
}

export interface SessionInfo {
  id: string;
  title?: string | null;
  tags?: string[];
  command: string;
  input_needed: boolean;
  status: string;
  pid?: number;
  created_at?: string;
  started_at?: string;
  ended_at?: string | null;
  last_output_epoch?: string | null;
  current_working_directory?: string;
  arguments?: string[];
  nodeName?: string;
}

export interface SessionSelection {
  primarySessionId: string;
  primarySession: SessionInfo;
  supervisedSessions: SessionInfo[];
  allSessions: SessionInfo[];
}

export interface SessionListResponse {
  items: SessionInfo[];
}

export interface SessionIdleState {
  lastObservedOutputEpoch: string;
  lastObservedTailSignature: string | null;
  lastObservedTailPreview: string | null;
  lastObservedTailError: string | null;
  lastObservedInputNeeded: boolean;
  lastOutputEpochChangedAt: number;
  lastTailChangedAt: number;
  lastInputNeededChangedAt: number;
  lastTailCheckedAt: number | null;
  lastSuccessfulTailCheckAt: number | null;
}

export interface IdleSupervisedPromptState {
  lastPromptAt: number;
  lastActivityMarker: string;
}

export interface RuntimeState {
  isAgentAbleToAcceptMessage: boolean;
  shouldStop: boolean;
  lastStartAttemptAt: number;
  lastInitializedSessionKey: string | null;
  lastInitializationPendingSessionKey: string | null;
  lastInitializationSentAt: number;
  lastSleepHandoffActivityMarker: string | null;
  lastHookPromptMarker: string | null;
  lastSleepAttemptSessionKey: string | null;
  lastSleepAttemptAt: number;
  lastSleepBlockedBusySessionKey: string | null;
  lastSleepBlockedBusySinceAt: number;
  lastSleepBlockedBusyNotified: boolean;
  lastSlowDeliveryNotificationAt: Map<string, number>;
  sessionIdleStates: Map<string, SessionIdleState>;
  idleSupervisedPromptStates: Map<string, IdleSupervisedPromptState>;
}

export interface HeartRuntimeContext {
  config: HeartRuntimeConfig;
  state: RuntimeState;
}
