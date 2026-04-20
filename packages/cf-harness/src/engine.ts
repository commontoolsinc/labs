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
  appendHarnessPolicyEvent,
  appendHarnessToolOutput,
  createHarnessRunState,
  type HarnessRunState,
  setHarnessRunStatus,
  setHarnessTranscriptPath,
} from "./run-state.ts";
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
    this.#runState = options.runState ??
      createHarnessRunState({
        runId,
        cfcEnforcementMode: this.config.cfcEnforcementMode,
        model: this.config.model,
        artifactRoot: this.artifactStore?.runRoot,
        now: this.#now(),
      });
    this.#outputSequence = this.#runState.toolOutputs.length;
  }

  getRunState(): HarnessRunState {
    return structuredClone(this.#runState);
  }

  setRunStatus(status: HarnessRunState["status"]): HarnessRunState {
    this.#runState = setHarnessRunStatus(this.#runState, status, this.#now());
    return this.getRunState();
  }

  async recordPolicyEvent(
    event: Omit<HarnessPolicyEvent, "type" | "at">,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    this.#runState = appendHarnessPolicyEvent(
      this.#runState,
      createHarnessPolicyEvent({ ...event, at: now }),
      now,
    );
    await this.persistRunState();
    return this.getRunState();
  }

  async persistRunState(): Promise<string | undefined> {
    return await this.artifactStore?.persistRunState(this.#runState);
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

  async invokeBuiltinTool<TToolId extends BuiltinToolId>(
    toolId: TToolId,
    input: BuiltinToolInputMap[TToolId],
  ): Promise<BuiltinToolInvocationResult<TToolId>> {
    const tool = getBuiltinTool(toolId);
    if (tool === undefined) {
      throw new Error(`unknown builtin tool: ${toolId}`);
    }
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
      this.#runState = appendHarnessToolOutput(
        setHarnessRunStatus(this.#runState, "completed", this.#now()),
        resultRef,
        this.#now(),
      );
      await this.persistRunState();
      return {
        output,
        resultRef,
        runState: this.getRunState(),
      };
    } catch (error) {
      this.#runState = setHarnessRunStatus(
        this.#runState,
        "failed",
        this.#now(),
      );
      await this.persistRunState();
      throw error;
    }
  }

  #createToolContext() {
    return {
      runId: this.#runState.runId,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      sandbox: this.sandbox,
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
