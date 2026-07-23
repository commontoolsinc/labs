import {
  type HarnessConfig,
  type ResolvedHarnessConfig,
  resolveHarnessConfig,
  type ResolveHarnessConfigOptions,
} from "./config.ts";
import {
  createFileSystemHarnessArtifactStore,
  type HarnessArtifactStore,
} from "./artifacts.ts";
import {
  appendHarnessCfcInvocationContext,
  appendHarnessCfcModelContextObservations,
  appendHarnessFailureRecord,
  appendHarnessPolicyDecision,
  appendHarnessPolicyEvent,
  appendHarnessSubagentRun,
  appendHarnessToolOutput,
  createHarnessRunState,
  type HarnessRunState,
  type HarnessRunTerminalReason,
  setHarnessCapabilitySnapshot,
  setHarnessCfcPolicySnapshot,
  setHarnessPolicyTrace,
  setHarnessPromptSlotBinding,
  setHarnessRunCurrentDir,
  setHarnessRunManifestPath,
  setHarnessRunReportPath,
  setHarnessRunStatus,
  setHarnessSkillActivations,
  setHarnessSkillRegistry,
  setHarnessSkillResourceReads,
  setHarnessSkillScriptExecutions,
  setHarnessTranscriptPath,
} from "./run-state.ts";
import type { HarnessCfcModelContextObservationInput } from "./contracts/cfc-model-context.ts";
import {
  classifyBuiltinToolFailure,
  classifyHarnessPolicyEventFailure,
  classifyHarnessRunError,
  type ClassifyHarnessRunErrorOptions,
  collectHarnessCapabilitySnapshot,
  createHarnessFailureRecord,
  type HarnessFailureRecord,
} from "./diagnostics.ts";
import {
  createHarnessPolicyEvent,
  type HarnessPolicyEvent,
} from "./contracts/policy.ts";
import {
  createHarnessCfcInvocationContext,
  type HarnessCfcInvocationContext,
  type HarnessCfcInvocationInputLabelPath,
  type HarnessCfcInvocationOperation,
  summarizeCfcInvocationRunManifest,
} from "./contracts/cfc-invocation-context.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import {
  createHarnessPolicyDecisionRecord,
  type HarnessPolicyDecisionRecord,
  type HarnessPolicyTrace,
} from "./contracts/policy-trace.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import type { HarnessRunReport } from "./contracts/run-report.ts";
import type {
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
  HarnessSkillScriptExecution,
} from "./contracts/skill.ts";
import type { HarnessSubagentRunRef } from "./contracts/subagent.ts";
import {
  createToolResultRef,
  type ToolOutputId,
  type ToolResultRef,
} from "./contracts/tool-result.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import type { CfcLabelView } from "@commonfabric/runner/cfc";
import {
  assertDockerRunscCfcTransportForMode,
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "./sandbox/docker-runsc.ts";
import {
  dirname,
  join as joinHostPath,
  normalize as normalizeHostPath,
  relative as relativeHostPath,
} from "@std/path";
import { normalize as normalizeSandboxPath } from "@std/path/posix";
import {
  DenoProcessRunner,
  type ProcessRunner,
} from "./sandbox/process-runner.ts";
import type {
  DockerRunscAdditionalMountConfig,
  DockerRunscSandboxConfig,
  HarnessSandboxConfig,
  SandboxRuntime,
} from "./sandbox/types.ts";
import { type BashToolInput, type BashToolOutput } from "./tools/bash.ts";
import {
  type DelegateTaskToolInput,
  type DelegateTaskToolOutput,
} from "./contracts/subagent.ts";
import {
  type EditFileToolInput,
  type EditFileToolOutput,
} from "./tools/edit-file.ts";
import {
  type ReadFileToolInput,
  type ReadFileToolOutput,
} from "./tools/read-file.ts";
import {
  type ViewImageToolInput,
  type ViewImageToolOutput,
} from "./tools/view-image.ts";
import {
  type WebFetchToolInput,
  type WebFetchToolOutput,
} from "./tools/web-fetch.ts";
import {
  type ReadSkillResourceToolInput,
  type ReadSkillResourceToolOutput,
} from "./tools/read-skill-resource.ts";
import {
  type RunSkillScriptToolInput,
  type RunSkillScriptToolOutput,
} from "./tools/run-skill-script.ts";
import {
  type WriteFileToolInput,
  type WriteFileToolOutput,
} from "./tools/write-file.ts";
import { getBuiltinTool } from "./tools/registry.ts";

export interface BuiltinToolInputMap {
  bash: BashToolInput;
  "bash-no-sandbox": BashToolInput;
  read_file: ReadFileToolInput;
  view_image: ViewImageToolInput;
  web_fetch: WebFetchToolInput;
  read_skill_resource: ReadSkillResourceToolInput;
  run_skill_script: RunSkillScriptToolInput;
  edit_file: EditFileToolInput;
  write_file: WriteFileToolInput;
  delegate_task: DelegateTaskToolInput;
}

export interface BuiltinToolOutputMap {
  bash: BashToolOutput;
  "bash-no-sandbox": BashToolOutput;
  read_file: ReadFileToolOutput;
  view_image: ViewImageToolOutput;
  web_fetch: WebFetchToolOutput;
  read_skill_resource: ReadSkillResourceToolOutput;
  run_skill_script: RunSkillScriptToolOutput;
  edit_file: EditFileToolOutput;
  write_file: WriteFileToolOutput;
  delegate_task: DelegateTaskToolOutput;
}

interface ToolOutputWithId {
  outputId: string;
}

export interface CreateHarnessEngineOptions
  extends ResolveHarnessConfigOptions {
  runId?: string;
  runState?: HarnessRunState;
  workspaceHostPath?: string;
  sandboxImage?: string;
  sandboxDockerRuntime?: string;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
  sandboxRuntime?: SandboxRuntime;
  artifactStore?: HarnessArtifactStore;
  processRunner?: ProcessRunner;
  now?: () => string;
}

export interface BuiltinToolInvocationResult<
  TToolId extends BuiltinToolId,
> {
  output: BuiltinToolOutputMap[TToolId];
  resultRef: ToolResultRef;
  runState: HarnessRunState;
}

const isToolOutputWithId = (value: unknown): value is ToolOutputWithId =>
  typeof value === "object" &&
  value !== null &&
  "outputId" in value &&
  typeof value.outputId === "string";

interface ResolveSandboxConfigOptions {
  workspaceHostPath?: string;
  sandboxImage?: string;
  sandboxDockerRuntime?: string;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
}

const resolveSandboxConfig = (
  config: HarnessConfig,
  options: ResolveSandboxConfigOptions,
): HarnessSandboxConfig => {
  if (config.sandbox !== undefined) {
    return config.sandbox;
  }
  if (options.workspaceHostPath === undefined) {
    throw new Error(
      "sandbox config is required when no workspaceHostPath default is provided",
    );
  }
  return resolveDockerRunscSandboxConfig({
    workspaceHostPath: options.workspaceHostPath,
    ...(options.sandboxImage !== undefined
      ? { image: options.sandboxImage }
      : {}),
    ...(options.sandboxDockerRuntime !== undefined
      ? { runtimeName: options.sandboxDockerRuntime }
      : {}),
    ...(options.additionalMounts !== undefined &&
        options.additionalMounts.length > 0
      ? { additionalMounts: options.additionalMounts }
      : {}),
    ...(options.cfcResultDir !== undefined
      ? { cfcResultDir: options.cfcResultDir }
      : {}),
    ...(options.cfcInvocationContextDir !== undefined
      ? { cfcInvocationContextDir: options.cfcInvocationContextDir }
      : {}),
  });
};

const createSandboxRuntime = (
  config: HarnessSandboxConfig,
  processRunner?: ProcessRunner,
): SandboxRuntime => {
  switch (config.kind) {
    case "docker-runsc-cfc":
      return new DockerRunscSandboxRuntime(config, processRunner);
  }
};

const resolveInitialCurrentDir = (
  sandbox: SandboxRuntime,
  config: HarnessConfig,
  runState?: HarnessRunState,
): string => {
  if (runState !== undefined) {
    if (runState.currentDir === undefined) {
      throw new Error(
        "run state is missing currentDir; older cf-harness runs cannot be resumed",
      );
    }
    return runState.currentDir;
  }
  if (config.cwd !== undefined) {
    return sandbox.resolvePath(config.cwd);
  }
  return sandbox.defaultWorkingDirectory();
};

const normalizeSandboxRoot = (path: string): string => {
  const normalized = normalizeSandboxPath(path);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const isHostPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relativeHostPath(
    normalizeHostPath(root),
    normalizeHostPath(path),
  );
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
};

const isSandboxPathWithinRoot = (root: string, path: string): boolean => {
  const normalizedRoot = normalizeSandboxRoot(root);
  const normalizedPath = normalizeSandboxRoot(path);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
};

type HostSandboxMount = {
  kind: string;
  name?: string;
  hostPath: string;
  sandboxPath: string;
  readOnly?: boolean;
};

export class CfHarnessEngine {
  readonly config: ResolvedHarnessConfig;
  readonly sandbox: SandboxRuntime;
  readonly artifactStore?: HarnessArtifactStore;
  readonly hostProcessRunner: ProcessRunner;
  readonly workspaceHostPath?: string;
  readonly workspaceMountPath: string;

  #runState: HarnessRunState;
  #outputSequence: number;
  readonly #now: () => string;
  readonly #hostMounts: readonly HostSandboxMount[];
  readonly #ownedRunscConfig?: DockerRunscSandboxConfig;
  #cfcTransportChecked = false;

  constructor(options: CreateHarnessEngineOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    const recordedProvider = options.runState?.modelProvider ??
      "openai-compatible-gateway";
    if (
      options.runState !== undefined && options.modelProvider !== undefined &&
      options.modelProvider !== recordedProvider
    ) {
      throw new Error(
        `resumed run provider ${recordedProvider} does not match requested provider ${options.modelProvider}`,
      );
    }
    if (
      options.runState !== undefined && recordedProvider === "openai-codex" &&
      options.runState.credentialOwnerKey !== undefined &&
      options.credentialOwnerKey !== undefined &&
      options.credentialOwnerKey !== options.runState.credentialOwnerKey
    ) {
      throw new Error(
        "resumed run credential owner does not match requested credential owner",
      );
    }
    this.config = resolveHarnessConfig({
      ...options,
      modelProvider: options.runState === undefined
        ? options.modelProvider
        : recordedProvider,
      ...(options.runState !== undefined && recordedProvider === "openai-codex"
        ? {
          credentialOwnerKey: options.runState.credentialOwnerKey ??
            options.credentialOwnerKey,
        }
        : {}),
    });
    const runId = options.runState?.runId ?? options.runId ??
      crypto.randomUUID();
    const sandboxConfig = options.sandboxRuntime === undefined
      ? resolveSandboxConfig(this.config, {
        workspaceHostPath: options.workspaceHostPath,
        sandboxImage: options.sandboxImage,
        sandboxDockerRuntime: options.sandboxDockerRuntime,
        additionalMounts: options.additionalMounts,
        cfcResultDir: options.cfcResultDir,
        cfcInvocationContextDir: options.cfcInvocationContextDir,
      })
      : this.config.sandbox;
    // Capture the engine-owned docker-runsc config so we can refuse to *run*
    // enforce-mode sandbox work — capability probes or tools — whose sandbox
    // lacks the CFC sidecar transports (the check fires at run start, not
    // construction — see #assertCfcTransportReady).
    // Only when the engine constructs the runtime itself: an injected
    // sandboxRuntime is the thing that actually executes and carries its own
    // enforcement guarantees, while `sandboxConfig` in that branch is the
    // unused resolved config and may describe a different sandbox entirely.
    this.#ownedRunscConfig = options.sandboxRuntime === undefined &&
        sandboxConfig?.kind === "docker-runsc-cfc"
      ? sandboxConfig
      : undefined;
    this.hostProcessRunner = options.processRunner ?? new DenoProcessRunner();
    this.sandbox = options.sandboxRuntime ??
      createSandboxRuntime(sandboxConfig!, options.processRunner);
    this.workspaceHostPath = sandboxConfig?.workspaceHostPath ??
      options.workspaceHostPath;
    this.workspaceMountPath = normalizeSandboxRoot(
      sandboxConfig?.workspaceMountPath ??
        this.sandbox.defaultWorkingDirectory(),
    );
    this.#hostMounts = sandboxConfig !== undefined
      ? [
        {
          kind: "workspace",
          hostPath: sandboxConfig.workspaceHostPath,
          sandboxPath: sandboxConfig.workspaceMountPath,
          readOnly: false,
        },
        ...sandboxConfig.additionalMounts.map((mount) => ({
          kind: mount.kind,
          ...(mount.kind === "host-bind" ? { name: mount.name } : {}),
          hostPath: mount.hostPath,
          sandboxPath: mount.sandboxPath,
          readOnly: mount.readOnly,
        })),
      ]
      : this.workspaceHostPath !== undefined
      ? [{
        kind: "workspace",
        hostPath: this.workspaceHostPath,
        sandboxPath: this.workspaceMountPath,
        readOnly: false,
      }]
      : [];
    this.artifactStore = options.artifactStore ??
      ((this.config.artifactRoot ?? options.runState?.artifactRoot) !==
          undefined
        ? createFileSystemHarnessArtifactStore({
          artifactRoot: this.config.artifactRoot ??
            dirname(options.runState!.artifactRoot!),
          runId,
        })
        : undefined);
    const currentDir = resolveInitialCurrentDir(
      this.sandbox,
      this.config,
      options.runState,
    );
    this.#runState = options.runState ??
      createHarnessRunState({
        runId,
        cfcEnforcementMode: this.config.cfcEnforcementMode,
        currentDir,
        model: this.config.model,
        modelProvider: this.config.modelProvider,
        modelAuthSource: this.config.modelProvider === "openai-codex"
          ? "owner-bound-oauth"
          : this.config.gatewayAuthMode === "none"
          ? "none"
          : "api-key",
        credentialOwnerKey: this.config.credentialOwnerKey,
        artifactRoot: this.artifactStore?.runRoot,
        runManifest: this.config.runManifest,
        runManifestPath: this.config.runManifestPath,
        now: this.#now(),
      });
    this.#outputSequence = this.#runState.toolOutputs.length;
  }

  getRunState(): HarnessRunState {
    return structuredClone(this.#runState);
  }

  appendFailureRecord(failure: HarnessFailureRecord): HarnessRunState {
    this.#runState = appendHarnessFailureRecord(
      this.#runState,
      failure,
      this.#now(),
    );
    return this.getRunState();
  }

  appendFailureFromError(
    error: unknown,
    options: Omit<ClassifyHarnessRunErrorOptions, "at"> = {},
  ): HarnessRunState {
    return this.appendFailureRecord(
      classifyHarnessRunError(error, {
        ...options,
        at: this.#now(),
      }),
    );
  }

  setRunStatus(
    status: HarnessRunState["status"],
    terminalReason?: HarnessRunTerminalReason,
  ): HarnessRunState {
    this.#runState = setHarnessRunStatus(
      this.#runState,
      status,
      this.#now(),
      terminalReason,
    );
    return this.getRunState();
  }

  setPromptSlotBinding(
    promptSlotBinding: PromptSlotBinding,
  ): HarnessRunState {
    this.#runState = setHarnessPromptSlotBinding(
      this.#runState,
      promptSlotBinding,
      this.#now(),
    );
    return this.getRunState();
  }

  async recordPolicyEvent(
    event: Omit<HarnessPolicyEvent, "type" | "at">,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    const policyEvent = createHarnessPolicyEvent({ ...event, at: now });
    this.#runState = appendHarnessPolicyEvent(
      this.#runState,
      policyEvent,
      now,
    );
    const failure = classifyHarnessPolicyEventFailure(policyEvent);
    if (failure !== undefined) {
      this.#runState = appendHarnessFailureRecord(this.#runState, failure, now);
    }
    await this.persistRunState();
    return this.getRunState();
  }

  async recordPolicyDecision(
    decision: Omit<
      HarnessPolicyDecisionRecord,
      "type" | "sequence" | "runId" | "at"
    >,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    const policyDecision = createHarnessPolicyDecisionRecord({
      ...decision,
      runId: this.#runState.runId,
      sequence: (this.#runState.policyDecisions ?? []).length + 1,
      at: now,
    });
    this.#runState = appendHarnessPolicyDecision(
      this.#runState,
      policyDecision,
      now,
    );
    await this.persistRunState();
    return this.getRunState();
  }

  async recordCfcModelContextObservations(
    observations: readonly HarnessCfcModelContextObservationInput[],
  ): Promise<HarnessRunState> {
    this.#runState = appendHarnessCfcModelContextObservations(
      this.#runState,
      observations,
      this.#now(),
    );
    await this.persistRunState();
    return this.getRunState();
  }

  async persistRunState(): Promise<string | undefined> {
    return await this.artifactStore?.persistRunState(this.#runState);
  }

  async ensureRunManifestPersisted(): Promise<string | undefined> {
    if (this.#runState.runManifest === undefined) {
      return this.#runState.runManifestPath;
    }
    const manifestPath = await this.artifactStore?.persistRunManifest?.(
      this.#runState.runManifest,
    );
    if (manifestPath !== undefined) {
      this.#runState = setHarnessRunManifestPath(
        this.#runState,
        manifestPath,
        this.#now(),
      );
      await this.persistRunState();
    }
    return manifestPath ?? this.#runState.runManifestPath;
  }

  async persistSkillRegistry(
    registry: HarnessSkillRegistry,
  ): Promise<string | undefined> {
    const skillRegistryPath = await this.artifactStore
      ?.persistSkillRegistry?.(registry);
    this.#runState = setHarnessSkillRegistry(
      this.#runState,
      registry,
      skillRegistryPath,
      this.#now(),
    );
    await this.persistRunState();
    return skillRegistryPath;
  }

  async persistSkillActivations(
    activations: HarnessSkillActivations,
  ): Promise<string | undefined> {
    const skillActivationsPath = await this.artifactStore
      ?.persistSkillActivations?.(activations);
    this.#runState = setHarnessSkillActivations(
      this.#runState,
      activations,
      skillActivationsPath,
      this.#now(),
    );
    await this.persistRunState();
    return skillActivationsPath;
  }

  async recordSkillResourceRead(
    read: HarnessSkillResourceRead,
  ): Promise<string | undefined> {
    const generatedAt = this.#now();
    const skillResourceReads = {
      type: "cf-harness.skill-resource-reads" as const,
      version: 1 as const,
      generatedAt,
      reads: [...(this.#runState.skillResourceReads?.reads ?? []), read],
    };
    const skillResourceReadsPath = await this.artifactStore
      ?.persistSkillResourceReads?.(skillResourceReads);
    this.#runState = setHarnessSkillResourceReads(
      this.#runState,
      skillResourceReads,
      skillResourceReadsPath,
      generatedAt,
    );
    await this.persistRunState();
    return skillResourceReadsPath;
  }

  async recordSkillScriptExecution(
    execution: HarnessSkillScriptExecution,
  ): Promise<string | undefined> {
    const generatedAt = this.#now();
    const skillScriptExecutions = {
      type: "cf-harness.skill-script-executions" as const,
      version: 1 as const,
      generatedAt,
      executions: [
        ...(this.#runState.skillScriptExecutions?.executions ?? []),
        execution,
      ],
    };
    const skillScriptExecutionsPath = await this.artifactStore
      ?.persistSkillScriptExecutions?.(skillScriptExecutions);
    this.#runState = setHarnessSkillScriptExecutions(
      this.#runState,
      skillScriptExecutions,
      skillScriptExecutionsPath,
      generatedAt,
    );
    await this.persistRunState();
    return skillScriptExecutionsPath;
  }

  nextToolOutputId(toolId: string): ToolOutputId {
    this.#outputSequence += 1;
    return `${this.#runState.runId}:${toolId}:${this.#outputSequence}` as ToolOutputId;
  }

  async recordSubagentRun(
    subagentRun: HarnessSubagentRunRef,
  ): Promise<HarnessRunState> {
    this.#runState = appendHarnessSubagentRun(
      this.#runState,
      subagentRun,
      this.#now(),
    );
    await this.persistRunState();
    return this.getRunState();
  }

  async terminalizeInterruptedRun(
    signalName: string,
  ): Promise<HarnessRunState> {
    const currentState = this.#runState;
    if (
      currentState.status === "failed" ||
      currentState.terminalReason === "assistant_completed"
    ) {
      return this.getRunState();
    }
    const now = this.#now();
    this.#runState = appendHarnessFailureRecord(
      this.#runState,
      createHarnessFailureRecord({
        kind: "harness_error",
        source: "run_error",
        detail:
          `process received ${signalName} before the prompt loop completed`,
        at: now,
      }),
      now,
    );
    this.#runState = setHarnessRunStatus(
      this.#runState,
      "failed",
      now,
      "process_interrupted",
    );
    await this.persistRunState();
    return this.getRunState();
  }

  async persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string | undefined> {
    const transcriptPath = await this.artifactStore?.persistTranscript(
      transcript,
    );
    if (transcriptPath !== undefined) {
      this.#runState = setHarnessTranscriptPath(
        this.#runState,
        transcriptPath,
        this.#now(),
      );
      await this.persistRunState();
    }
    return transcriptPath;
  }

  async persistRunReport(
    report: HarnessRunReport,
  ): Promise<string | undefined> {
    const runReportPath = await this.artifactStore?.persistRunReport(report);
    if (runReportPath !== undefined) {
      this.#runState = setHarnessRunReportPath(
        this.#runState,
        runReportPath,
        this.#now(),
      );
      await this.persistRunState();
    }
    return runReportPath;
  }

  async persistCfcPolicySnapshot(
    snapshot: HarnessCfcPolicySnapshot,
  ): Promise<string | undefined> {
    let cfcPolicySnapshotPath: string | undefined;
    try {
      cfcPolicySnapshotPath = await this.artifactStore
        ?.persistCfcPolicySnapshot(
          snapshot,
        );
    } catch (error) {
      const now = this.#now();
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: now,
          source: "policy_snapshot",
        }),
        now,
      );
    }
    this.#runState = setHarnessCfcPolicySnapshot(
      this.#runState,
      snapshot,
      cfcPolicySnapshotPath,
      this.#now(),
    );
    await this.persistRunState();
    return cfcPolicySnapshotPath;
  }

  async persistPolicyTrace(
    trace: HarnessPolicyTrace,
  ): Promise<string | undefined> {
    let policyTracePath: string | undefined;
    try {
      policyTracePath = await this.artifactStore?.persistPolicyTrace?.(trace);
    } catch (error) {
      const now = this.#now();
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: now,
          source: "policy_trace",
        }),
        now,
      );
    }
    this.#runState = setHarnessPolicyTrace(
      this.#runState,
      trace,
      policyTracePath,
      this.#now(),
    );
    await this.persistRunState();
    return policyTracePath;
  }

  // Fail fast before any sandbox execution under enforcement on a sandbox that
  // lacks the CFC sidecar transports — capability probes included, since they
  // run scripts inside the same sandbox (not just builtin tools). Checked at
  // run start rather than construction so an engine can be built and inspected
  // (config threading, --describe-capabilities) without a live CFC wiring.
  // Idempotent so the cost is paid once per run.
  #assertCfcTransportReady(): void {
    if (this.#cfcTransportChecked || this.#ownedRunscConfig === undefined) {
      return;
    }
    assertDockerRunscCfcTransportForMode(
      this.#runState.cfcEnforcementMode,
      this.#ownedRunscConfig,
    );
    this.#cfcTransportChecked = true;
  }

  async ensureDiagnosticsInitialized(): Promise<HarnessRunState> {
    // The capability probes below execute scripts inside the sandbox, so the
    // enforce-mode transport floor applies here too — and must throw before
    // the try block below, which records probe errors instead of propagating.
    this.#assertCfcTransportReady();
    if (this.#runState.capabilitySnapshot !== undefined) {
      return this.getRunState();
    }
    await this.ensureRunManifestPersisted();
    const now = this.#now();
    try {
      const capabilitySnapshot = await collectHarnessCapabilitySnapshot(
        this.sandbox,
        this.#runState.currentDir,
        now,
        {
          cfcEnforcementMode: this.#runState.cfcEnforcementMode,
          runManifest: this.#runState.runManifest,
          runManifestPath: this.#runState.runManifestPath,
          modelProvider: this.config.modelProvider,
          ...(this.config.modelProvider === "openai-compatible-gateway"
            ? { gatewayAuthMode: this.config.gatewayAuthMode }
            : {}),
        },
      );
      let capabilitiesPath: string | undefined;
      try {
        capabilitiesPath = await this.artifactStore?.persistCapabilitySnapshot(
          capabilitySnapshot,
        );
      } catch (error) {
        this.#runState = appendHarnessFailureRecord(
          this.#runState,
          classifyHarnessRunError(error, {
            at: this.#now(),
            source: "capability_snapshot",
          }),
          this.#now(),
        );
      }
      this.#runState = setHarnessCapabilitySnapshot(
        this.#runState,
        capabilitySnapshot,
        capabilitiesPath,
        this.#now(),
      );
    } catch (error) {
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: now,
          source: "capability_snapshot",
        }),
        now,
      );
    }
    return this.getRunState();
  }

  async invokeBuiltinTool<TToolId extends BuiltinToolId>(
    toolId: TToolId,
    input: BuiltinToolInputMap[TToolId],
  ): Promise<BuiltinToolInvocationResult<TToolId>> {
    const tool = getBuiltinTool(toolId);
    if (tool === undefined) {
      throw new Error(`unknown builtin tool: ${toolId}`);
    }
    this.#assertCfcTransportReady();
    await this.ensureDiagnosticsInitialized();
    this.#runState = setHarnessRunStatus(
      this.#runState,
      "running",
      this.#now(),
    );
    try {
      const output = await tool.invoke(
        this.#createToolContext(),
        input,
      ) as BuiltinToolOutputMap[TToolId];
      return await this.recordBuiltinToolOutput(toolId, input, output);
    } catch (error) {
      const failureTime = this.#now();
      this.#runState = setHarnessRunStatus(
        this.#runState,
        "failed",
        failureTime,
        "tool_error",
      );
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: failureTime,
          toolId,
          source: "run_error",
        }),
        failureTime,
      );
      await this.persistRunState();
      throw error;
    }
  }

  async recordBuiltinToolOutput<TToolId extends BuiltinToolId>(
    toolId: TToolId,
    input: BuiltinToolInputMap[TToolId],
    output: BuiltinToolOutputMap[TToolId],
  ): Promise<BuiltinToolInvocationResult<TToolId>> {
    if (!isToolOutputWithId(output)) {
      throw new Error(`builtin tool did not return an outputId: ${toolId}`);
    }
    const artifactPath = await this.artifactStore?.persistToolOutput(
      toolId,
      output.outputId as ToolOutputId,
      output,
    );
    const resultRef = createToolResultRef(
      output.outputId as ToolOutputId,
      toolId,
      this.#runState.runId,
      artifactPath,
    );
    const completionTime = this.#now();
    this.#runState = appendHarnessToolOutput(
      setHarnessRunStatus(
        this.#runState,
        "completed",
        completionTime,
        "tool_completed",
      ),
      resultRef,
      completionTime,
    );
    const failure = classifyBuiltinToolFailure(
      toolId,
      input,
      output,
      completionTime,
      this.#runState.capabilitySnapshot,
    );
    if (failure !== undefined) {
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        failure,
        completionTime,
      );
    }
    await this.persistRunState();
    return {
      output,
      resultRef,
      runState: this.getRunState(),
    };
  }

  #resolveHostMount(path: string): {
    hostPath: string;
    mount: HostSandboxMount;
  } {
    if (this.#hostMounts.length === 0) {
      throw new Error(
        "bash-no-sandbox requires a host mount path to map sandbox paths",
      );
    }
    const sandboxPath = this.sandbox.resolvePath(
      path,
      this.#runState.currentDir,
    );
    const mount = this.#hostMounts.find((candidate) =>
      isSandboxPathWithinRoot(candidate.sandboxPath, sandboxPath)
    );
    if (mount === undefined) {
      throw new Error(`path escapes host-backed sandbox roots: ${path}`);
    }
    const sandboxRoot = normalizeSandboxRoot(mount.sandboxPath);
    if (sandboxPath === sandboxRoot) {
      return { hostPath: normalizeHostPath(mount.hostPath), mount };
    }
    return {
      hostPath: normalizeHostPath(
        joinHostPath(
          mount.hostPath,
          sandboxPath.slice(sandboxRoot.length + 1),
        ),
      ),
      mount,
    };
  }

  #resolveHostPath(path: string): string {
    return this.#resolveHostMount(path).hostPath;
  }

  #resolveHostRootPath(path: string): string {
    return normalizeHostPath(this.#resolveHostMount(path).mount.hostPath);
  }

  #hostPathToWorkspacePath(path: string): string | undefined {
    const hostPath = normalizeHostPath(path);
    for (const mount of this.#hostMounts) {
      const hostRoot = normalizeHostPath(mount.hostPath);
      if (!isHostPathWithinRoot(hostRoot, hostPath)) {
        continue;
      }
      const relativePath = relativeHostPath(hostRoot, hostPath);
      if (relativePath === "") {
        return normalizeSandboxRoot(mount.sandboxPath);
      }
      return normalizeSandboxPath(
        `${normalizeSandboxRoot(mount.sandboxPath)}/${
          relativePath.replaceAll("\\", "/")
        }`,
      );
    }
    return undefined;
  }

  async #isHostPathWithinWorkspace(
    path: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    if (this.workspaceHostPath === undefined) {
      return false;
    }
    const normalizedPath = normalizeHostPath(path);
    try {
      const hostRoot = await Deno.realPath(this.workspaceHostPath);
      const hostPath = await Deno.realPath(normalizedPath);
      return isHostPathWithinRoot(hostRoot, hostPath);
    } catch (error) {
      if (!options.allowMissing || !(error instanceof Deno.errors.NotFound)) {
        return false;
      }
      return await this.#missingHostPathCanResolveWithinWorkspace(
        normalizedPath,
      );
    }
  }

  async #missingHostPathCanResolveWithinWorkspace(path: string): Promise<
    boolean
  > {
    if (this.workspaceHostPath === undefined) {
      return false;
    }
    const lexicalRoot = normalizeHostPath(this.workspaceHostPath);
    let realRoot: string;
    try {
      realRoot = await Deno.realPath(this.workspaceHostPath);
    } catch {
      return false;
    }
    let candidate = normalizeHostPath(path);
    while (isHostPathWithinRoot(lexicalRoot, candidate)) {
      try {
        const realCandidate = await Deno.realPath(candidate);
        return isHostPathWithinRoot(realRoot, realCandidate);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          return false;
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return false;
      }
      candidate = parent;
    }
    return false;
  }

  async #realHostPath(path: string): Promise<string | undefined> {
    try {
      return normalizeHostPath(await Deno.realPath(path));
    } catch {
      return undefined;
    }
  }

  async #nearestExistingRealHostPath(
    path: string,
  ): Promise<string | undefined> {
    let candidate = normalizeHostPath(path);
    while (true) {
      const realPath = await this.#realHostPath(candidate);
      if (realPath !== undefined) {
        return realPath;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return undefined;
      }
      candidate = parent;
    }
  }

  async #isHostPathWithinArtifactRoot(
    path: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    const root = this.artifactStore?.artifactRoot;
    if (root === undefined) {
      return false;
    }
    const normalizedRoot = normalizeHostPath(root);
    const normalizedPath = normalizeHostPath(path);
    if (isHostPathWithinRoot(normalizedRoot, normalizedPath)) {
      return true;
    }
    const realRoot = await this.#realHostPath(normalizedRoot);
    if (realRoot === undefined) {
      return false;
    }
    const realPath = options.allowMissing === true
      ? await this.#nearestExistingRealHostPath(normalizedPath)
      : await this.#realHostPath(normalizedPath);
    return realPath !== undefined && isHostPathWithinRoot(realRoot, realPath);
  }

  async #doesHostPathIntersectArtifactRoot(
    path: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    const root = this.artifactStore?.artifactRoot;
    if (root === undefined) {
      return false;
    }
    const normalizedRoot = normalizeHostPath(root);
    const normalizedPath = normalizeHostPath(path);
    if (
      isHostPathWithinRoot(normalizedRoot, normalizedPath) ||
      isHostPathWithinRoot(normalizedPath, normalizedRoot)
    ) {
      return true;
    }
    const realRoot = await this.#realHostPath(normalizedRoot);
    if (realRoot === undefined) {
      return false;
    }
    const realPath = options.allowMissing === true
      ? await this.#nearestExistingRealHostPath(normalizedPath)
      : await this.#realHostPath(normalizedPath);
    return realPath !== undefined &&
      (isHostPathWithinRoot(realRoot, realPath) ||
        isHostPathWithinRoot(realPath, realRoot));
  }

  async #createCfcInvocationContext(options: {
    toolId: string;
    toolOutputId?: ToolOutputId;
    operation: HarnessCfcInvocationOperation;
    cwd: string;
    command?: string;
    argv?: readonly string[];
    args?: readonly string[];
    stdinText?: string;
    env?: Record<string, string>;
    cfcInputLabels?: CfcLabelView;
    cfcInputLabelPaths?: readonly HarnessCfcInvocationInputLabelPath[];
    cfcPromptSlotInputLabelPaths?:
      readonly HarnessCfcInvocationInputLabelPath[];
    cfcModelContextInputLabelPaths?:
      readonly HarnessCfcInvocationInputLabelPath[];
  }): Promise<HarnessCfcInvocationContext> {
    const now = this.#now();
    const invocation = await createHarnessCfcInvocationContext({
      sequence: (this.#runState.cfcInvocationContexts ?? []).length + 1,
      runId: this.#runState.runId,
      createdAt: now,
      toolId: options.toolId,
      ...(options.toolOutputId !== undefined
        ? { toolOutputId: options.toolOutputId }
        : {}),
      operation: options.operation,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      cwd: options.cwd,
      ...(this.#runState.promptSlotBinding !== undefined
        ? { promptSlot: this.#runState.promptSlotBinding }
        : {}),
      runManifest: summarizeCfcInvocationRunManifest(
        this.#runState.runManifest,
        this.#runState.runManifestPath,
      ),
      ...(options.command !== undefined ? { command: options.command } : {}),
      ...(options.argv !== undefined ? { argv: options.argv } : {}),
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.stdinText !== undefined
        ? { stdinText: options.stdinText }
        : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cfcInputLabels !== undefined
        ? { cfcInputLabels: options.cfcInputLabels }
        : {}),
      ...(options.cfcInputLabelPaths !== undefined
        ? { cfcInputLabelPaths: options.cfcInputLabelPaths }
        : {}),
      ...(options.cfcPromptSlotInputLabelPaths !== undefined
        ? { cfcPromptSlotInputLabelPaths: options.cfcPromptSlotInputLabelPaths }
        : {}),
      ...(options.cfcModelContextInputLabelPaths !== undefined
        ? {
          cfcModelContextInputLabelPaths:
            options.cfcModelContextInputLabelPaths,
        }
        : {}),
      ...(this.#runState.cfcModelContext !== undefined
        ? { cfcModelContext: this.#runState.cfcModelContext }
        : {}),
    });
    this.#runState = appendHarnessCfcInvocationContext(
      this.#runState,
      invocation,
      now,
    );
    await this.persistRunState();
    return invocation;
  }

  #createToolContext() {
    return {
      runId: this.#runState.runId,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      currentDir: this.#runState.currentDir,
      workspaceHostPath: this.workspaceHostPath,
      skillRegistry: this.#runState.skillRegistry,
      skillActivations: this.#runState.skillActivations,
      allowedSkillScripts: this.config.allowedSkillScripts,
      skillScriptExecutionTarget: this.config.skillScriptExecutionTarget,
      browserAccess: this.config.browserAccess,
      sandbox: this.sandbox,
      hostProcessRunner: this.hostProcessRunner,
      resolvePath: (path: string) =>
        this.sandbox.resolvePath(path, this.#runState.currentDir),
      resolveHostPath: (path: string) => this.#resolveHostPath(path),
      resolveHostRootPath: (path: string) => this.#resolveHostRootPath(path),
      hostPathToWorkspacePath: (path: string) =>
        this.#hostPathToWorkspacePath(path),
      isHostPathWithinWorkspace: (
        path: string,
        options?: { allowMissing?: boolean },
      ) => this.#isHostPathWithinWorkspace(path, options),
      isHostPathWithinArtifactRoot: (
        path: string,
        options?: { allowMissing?: boolean },
      ) => this.#isHostPathWithinArtifactRoot(path, options),
      doesHostPathIntersectArtifactRoot: (
        path: string,
        options?: { allowMissing?: boolean },
      ) => this.#doesHostPathIntersectArtifactRoot(path, options),
      setCurrentDir: (path: string) => {
        const resolved = this.sandbox.resolvePath(
          path,
          this.#runState.currentDir,
        );
        this.#runState = setHarnessRunCurrentDir(
          this.#runState,
          resolved,
          this.#now(),
        );
      },
      nextOutputId: (toolId: string) => {
        return this.nextToolOutputId(toolId);
      },
      now: () => this.#now(),
      recordSkillResourceRead: async (read: HarnessSkillResourceRead) => {
        await this.recordSkillResourceRead(read);
      },
      recordSkillScriptExecution: async (
        execution: HarnessSkillScriptExecution,
      ) => {
        await this.recordSkillScriptExecution(execution);
      },
      createCfcInvocationContext: (options: {
        toolId: string;
        toolOutputId?: ToolOutputId;
        operation: HarnessCfcInvocationOperation;
        cwd: string;
        command?: string;
        argv?: readonly string[];
        args?: readonly string[];
        stdinText?: string;
        env?: Record<string, string>;
        cfcInputLabels?: CfcLabelView;
        cfcInputLabelPaths?: readonly HarnessCfcInvocationInputLabelPath[];
        cfcPromptSlotInputLabelPaths?:
          readonly HarnessCfcInvocationInputLabelPath[];
        cfcModelContextInputLabelPaths?:
          readonly HarnessCfcInvocationInputLabelPath[];
      }) => this.#createCfcInvocationContext(options),
    };
  }
}

export const createHarnessEngine = (
  options: CreateHarnessEngineOptions = {},
): CfHarnessEngine => new CfHarnessEngine(options);
