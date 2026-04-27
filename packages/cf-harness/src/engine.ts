import {
  type HarnessConfig,
  resolveHarnessConfig,
  type ResolveHarnessConfigOptions,
} from "./config.ts";
import {
  createFileSystemHarnessArtifactStore,
  type HarnessArtifactStore,
} from "./artifacts.ts";
import {
  appendHarnessFailureRecord,
  appendHarnessPolicyEvent,
  appendHarnessToolOutput,
  createHarnessRunState,
  type HarnessRunState,
  type HarnessRunTerminalReason,
  setHarnessCapabilitySnapshot,
  setHarnessRunCurrentDir,
  setHarnessRunStatus,
  setHarnessTranscriptPath,
} from "./run-state.ts";
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
  createToolResultRef,
  type ToolOutputId,
  type ToolResultRef,
} from "./contracts/tool-result.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import {
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "./sandbox/docker-runsc.ts";
import { dirname } from "@std/path";
import type { ProcessRunner } from "./sandbox/process-runner.ts";
import type { HarnessSandboxConfig, SandboxRuntime } from "./sandbox/types.ts";
import { type BashToolInput, type BashToolOutput } from "./tools/bash.ts";
import {
  type ReadFileToolInput,
  type ReadFileToolOutput,
} from "./tools/read-file.ts";
import {
  type WriteFileToolInput,
  type WriteFileToolOutput,
} from "./tools/write-file.ts";
import { getBuiltinTool } from "./tools/registry.ts";

export interface BuiltinToolInputMap {
  bash: BashToolInput;
  read_file: ReadFileToolInput;
  write_file: WriteFileToolInput;
}

export interface BuiltinToolOutputMap {
  bash: BashToolOutput;
  read_file: ReadFileToolOutput;
  write_file: WriteFileToolOutput;
}

interface ToolOutputWithId {
  outputId: string;
}

export interface CreateHarnessEngineOptions
  extends ResolveHarnessConfigOptions {
  runId?: string;
  runState?: HarnessRunState;
  workspaceHostPath?: string;
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

const resolveSandboxConfig = (
  config: HarnessConfig,
  workspaceHostPath?: string,
): HarnessSandboxConfig => {
  if (config.sandbox !== undefined) {
    return config.sandbox;
  }
  if (workspaceHostPath === undefined) {
    throw new Error(
      "sandbox config is required when no workspaceHostPath default is provided",
    );
  }
  return resolveDockerRunscSandboxConfig({ workspaceHostPath });
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

export class CfHarnessEngine {
  readonly config: HarnessConfig;
  readonly sandbox: SandboxRuntime;
  readonly artifactStore?: HarnessArtifactStore;

  #runState: HarnessRunState;
  #outputSequence: number;
  readonly #now: () => string;

  constructor(options: CreateHarnessEngineOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.config = resolveHarnessConfig(options);
    const runId = options.runState?.runId ?? options.runId ??
      crypto.randomUUID();
    this.sandbox = options.sandboxRuntime ??
      createSandboxRuntime(
        resolveSandboxConfig(this.config, options.workspaceHostPath),
        options.processRunner,
      );
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
        artifactRoot: this.artifactStore?.runRoot,
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

  async persistRunState(): Promise<string | undefined> {
    return await this.artifactStore?.persistRunState(this.#runState);
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

  async ensureDiagnosticsInitialized(): Promise<HarnessRunState> {
    if (this.#runState.capabilitySnapshot !== undefined) {
      return this.getRunState();
    }
    const now = this.#now();
    try {
      const capabilitySnapshot = await collectHarnessCapabilitySnapshot(
        this.sandbox,
        this.#runState.currentDir,
        now,
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

  #createToolContext() {
    return {
      runId: this.#runState.runId,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      currentDir: this.#runState.currentDir,
      sandbox: this.sandbox,
      resolvePath: (path: string) =>
        this.sandbox.resolvePath(path, this.#runState.currentDir),
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
        this.#outputSequence += 1;
        return `${this.#runState.runId}:${toolId}:${this.#outputSequence}` as ToolOutputId;
      },
    };
  }
}

export const createHarnessEngine = (
  options: CreateHarnessEngineOptions = {},
): CfHarnessEngine => new CfHarnessEngine(options);
