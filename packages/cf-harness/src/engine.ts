import {
  dirname,
  join as joinHostPath,
  normalize as normalizeHostPath,
  relative as relativeHostPath,
} from "@std/path";
import { normalize as normalizeSandboxPath } from "@std/path/posix";

import type { CfcLabelView } from "@commonfabric/runner/cfc";

import {
  createFileSystemHarnessArtifactStore,
  type HarnessArtifactStore,
} from "./artifacts.ts";
import {
  type HarnessConfig,
  type ResolvedHarnessConfig,
  resolveHarnessConfig,
  type ResolveHarnessConfigOptions,
} from "./config.ts";
import {
  createHarnessCfcInvocationContext,
  type HarnessCfcInvocationContext,
  type HarnessCfcInvocationInputLabelPath,
  type HarnessCfcInvocationOperation,
  summarizeCfcInvocationRunManifest,
} from "./contracts/cfc-invocation-context.ts";
import type { HarnessCfcModelContextObservationInput } from "./contracts/cfc-model-context.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import {
  createHarnessPolicyDecisionRecord,
  type HarnessPolicyDecisionRecord,
  type HarnessPolicyTrace,
} from "./contracts/policy-trace.ts";
import {
  createHarnessPolicyEvent,
  type HarnessPolicyEvent,
} from "./contracts/policy.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import { harnessCredentialOwnersEqual } from "./contracts/run-manifest.ts";
import type { HarnessRunReport } from "./contracts/run-report.ts";
import type {
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
  HarnessSkillScriptExecution,
} from "./contracts/skill.ts";
import type {
  HarnessSubagentLineage,
  HarnessSubagentResumeContext,
  HarnessSubagentRunRef,
} from "./contracts/subagent.ts";
import {
  type DelegateTaskToolInput,
  type DelegateTaskToolOutput,
} from "./contracts/subagent.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import {
  createToolResultRef,
  type ToolOutputId,
  type ToolResultRef,
} from "./contracts/tool-result.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
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
  cacheHarnessFabricSessionFactory,
  createHarnessFabricSessionFactory,
  type HarnessFabricSessionFactory,
} from "./fabric-session.ts";
import { assertValidHarnessHandleTable } from "./handle-table.ts";
import {
  cacheHarnessPatternIndexClientFactory,
  createHarnessPatternIndexClientFactory,
  type HarnessPatternIndexClientFactory,
} from "./pattern-index/client.ts";
import {
  createPatternIndexPublicationLedger,
  type PatternIndexPublicationLedger,
} from "./pattern-index/publish-ledger.ts";
import type { HandleValueResolutionContext } from "./tools/handle-values.ts";
import type { HarnessWellKnownGrant } from "./contracts/well-known-grants.ts";
import {
  mintWellKnownGrants,
  resolveWellKnownGrantRefs,
} from "./well-known-grants.ts";
import type {
  HarnessInputCell,
  HarnessInputCellSpec,
} from "./contracts/input-cells.ts";
import { mintInputCellHandles } from "./input-cells.ts";
import type { HarnessCellLabels } from "./contracts/cell-labels.ts";
import {
  appendHarnessCfcModelContextObservations,
  appendHarnessFailureRecord,
  appendToHarnessRunState,
  createHarnessRunState,
  type HarnessRunState,
  type HarnessRunTerminalReason,
  patchHarnessRunState,
  setHarnessRunStatus,
  setHarnessSubagentRun,
} from "./run-state.ts";
import {
  assertDockerRunscCfcTransportForMode,
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "./sandbox/docker-runsc.ts";
import {
  DenoProcessRunner,
  type ProcessRunner,
} from "./sandbox/process-runner.ts";
import type {
  DockerRunscAdditionalMountConfig,
  DockerRunscSandboxConfig,
  SandboxRuntime,
} from "./sandbox/types.ts";
import { type BashToolInput, type BashToolOutput } from "./tools/bash.ts";
import {
  type BrowserToolInput,
  type BrowserToolOutput,
} from "./tools/browser.ts";
import {
  type DescribeHandleToolInput,
  type DescribeHandleToolOutput,
} from "./tools/describe-handle.ts";
import {
  type EditFileToolInput,
  type EditFileToolOutput,
} from "./tools/edit-file.ts";
import {
  type ReadFileToolInput,
  type ReadFileToolOutput,
} from "./tools/read-file.ts";
import {
  type ReadSkillResourceToolInput,
  type ReadSkillResourceToolOutput,
} from "./tools/read-skill-resource.ts";
import type {
  RecordFeedbackToolInput,
  RecordFeedbackToolOutput,
} from "./tools/record-feedback.ts";
import { getBuiltinTool } from "./tools/registry.ts";
import {
  type RunPatternToolInput,
  type RunPatternToolOutput,
} from "./tools/run-pattern.ts";
import type {
  AssignSlugToolInput,
  AssignSlugToolOutput,
} from "./tools/assign-slug.ts";
import {
  type RunSkillScriptToolInput,
  type RunSkillScriptToolOutput,
} from "./tools/run-skill-script.ts";
import type {
  SearchPatternsToolInput,
  SearchPatternsToolOutput,
} from "./tools/search-patterns.ts";
import {
  type ViewImageToolInput,
  type ViewImageToolOutput,
} from "./tools/view-image.ts";
import {
  type WebFetchToolInput,
  type WebFetchToolOutput,
} from "./tools/web-fetch.ts";
import {
  type WriteFileToolInput,
  type WriteFileToolOutput,
} from "./tools/write-file.ts";

export interface BuiltinToolInputMap {
  bash: BashToolInput;
  browser: BrowserToolInput;
  read_file: ReadFileToolInput;
  view_image: ViewImageToolInput;
  web_fetch: WebFetchToolInput;
  read_skill_resource: ReadSkillResourceToolInput;
  run_skill_script: RunSkillScriptToolInput;
  edit_file: EditFileToolInput;
  write_file: WriteFileToolInput;
  delegate_task: DelegateTaskToolInput;
  run_pattern: RunPatternToolInput;
  assign_slug: AssignSlugToolInput;
  describe_handle: DescribeHandleToolInput;
  search_patterns: SearchPatternsToolInput;
  record_feedback: RecordFeedbackToolInput;
}

export interface BuiltinToolOutputMap {
  bash: BashToolOutput;
  browser: BrowserToolOutput;
  read_file: ReadFileToolOutput;
  view_image: ViewImageToolOutput;
  web_fetch: WebFetchToolOutput;
  read_skill_resource: ReadSkillResourceToolOutput;
  run_skill_script: RunSkillScriptToolOutput;
  edit_file: EditFileToolOutput;
  write_file: WriteFileToolOutput;
  delegate_task: DelegateTaskToolOutput;
  run_pattern: RunPatternToolOutput;
  assign_slug: AssignSlugToolOutput;
  describe_handle: DescribeHandleToolOutput;
  search_patterns: SearchPatternsToolOutput;
  record_feedback: RecordFeedbackToolOutput;
}

interface ToolOutputWithId {
  outputId: string;
}

export interface CreateHarnessEngineOptions
  extends ResolveHarnessConfigOptions {
  runId?: string;
  runState?: HarnessRunState;
  lineage?: HarnessSubagentLineage;
  subagentResumeContext?: HarnessSubagentResumeContext;
  workspaceHostPath?: string;
  sandboxImage?: string;
  sandboxDockerRuntime?: string;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
  sandboxRuntime?: SandboxRuntime;
  artifactStore?: HarnessArtifactStore;
  processRunner?: ProcessRunner;

  /**
   * Injection seam for the `run_pattern` fabric session, mirroring how
   * `sandboxRuntime` replaces the engine-built sandbox. When absent, a
   * factory is built from `fabricSession` in the resolved config; when both
   * are absent, `run_pattern` has no session and stays out of the parent
   * tool surface.
   */
  fabricSessionFactory?: HarnessFabricSessionFactory;

  /**
   * Injection seam for the pattern-index client, mirroring
   * `fabricSessionFactory`. When absent, a factory is built from
   * `patternIndex` in the resolved config; when both are absent, the run has
   * no index — `search_patterns` stays out of the tool surface and
   * `run_pattern` refuses a `patternId`.
   */
  patternIndexClientFactory?: HarnessPatternIndexClientFactory;

  /**
   * What this run was asked to do, in the words it was asked in — the CLI
   * prompt for a parent run, the delegated goal for a subagent. A pattern
   * published from this run carries it as the request the pattern answers,
   * which is what the index ranks a search against. Absent when the run has
   * no single such text, and nothing invents one.
   */
  taskText?: string;

  /**
   * Operator input cells to mint handles for at run start; see
   * `establishInputCells`. Requires a fabric session — the cells live in
   * its space.
   */
  inputCells?: readonly HarnessInputCellSpec[];

  /**
   * The space database `snapshotCellLabels` reads, for a host where the
   * store is not where the discovery walk looks. Absent, the space named by
   * the fabric session is resolved against the caches on this host.
   */
  spaceDbPath?: string;
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
): DockerRunscSandboxConfig => {
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
  readonly #fabricSessionFactory?: HarnessFabricSessionFactory;
  readonly #patternIndexClientFactory?: HarnessPatternIndexClientFactory;
  #patternIndexPublications?: PatternIndexPublicationLedger;
  readonly #taskText?: string;
  readonly #inputCells: readonly HarnessInputCellSpec[];
  readonly #spaceDbPath?: string;
  readonly #hostMounts: readonly HostSandboxMount[];
  readonly #ownedRunscConfig?: DockerRunscSandboxConfig;
  readonly #resumedRun: boolean;
  #runModelBound: boolean;
  #cfcTransportChecked = false;

  constructor(options: CreateHarnessEngineOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#resumedRun = options.runState !== undefined;
    this.#runModelBound = this.#resumedRun;
    const resumedLineage = options.runState?.lineage;
    if (resumedLineage !== undefined) {
      const resumeContext = options.subagentResumeContext;
      if (resumeContext === undefined) {
        throw new Error(
          `resumed subagent run ${
            options.runState!.runId
          } requires trusted parent resume context`,
        );
      }
      if (
        resumeContext.type !== "cf-harness.subagent-resume-context" ||
        resumeContext.version !== 1 ||
        resumeContext.rootRunId !== resumedLineage.rootRunId ||
        resumeContext.parentRunId !== resumedLineage.parentRunId ||
        resumeContext.parentToolCallId !== resumedLineage.parentToolCallId
      ) {
        throw new Error(
          `resumed subagent run ${
            options.runState!.runId
          } does not match trusted parent resume context`,
        );
      }
    }
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
      options.model !== undefined && options.runState.model !== undefined &&
      options.model !== options.runState.model
    ) {
      throw new Error(
        `resumed openai-codex run model ${options.runState.model} does not match requested model ${options.model}`,
      );
    }
    const recordedOwner = options.runState?.credentialOwner ??
      options.runState?.runManifest?.credentialOwner;
    const requestedOwner = options.credentialOwner ??
      options.runManifest?.credentialOwner;
    if (
      options.runState !== undefined && recordedOwner !== undefined &&
      requestedOwner !== undefined &&
      !harnessCredentialOwnersEqual(recordedOwner, requestedOwner)
    ) {
      throw new Error(
        "resumed run credential owner does not match requested credential owner",
      );
    }
    const recordedHomeIdentity = options.runState?.harnessHomeIdentity ??
      options.runState?.runManifest?.harnessHomeIdentity;
    const requestedHomeIdentity = options.harnessHomeIdentity ??
      options.runManifest?.harnessHomeIdentity;
    if (
      options.runState !== undefined && recordedHomeIdentity !== undefined &&
      requestedHomeIdentity !== undefined &&
      recordedHomeIdentity !== requestedHomeIdentity
    ) {
      throw new Error(
        "resumed run harness home does not match requested harness home",
      );
    }
    const recordedAuthSource = options.runState?.modelAuthSource ??
      options.runState?.runManifest?.modelAuthSource;
    const requestedAuthSource = options.modelAuthSource ??
      options.runManifest?.modelAuthSource;
    if (
      options.runState !== undefined && recordedAuthSource !== undefined &&
      requestedAuthSource !== undefined &&
      recordedAuthSource !== requestedAuthSource
    ) {
      throw new Error(
        "resumed run model auth source does not match requested model auth source",
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
    if (options.runState?.handleTable !== undefined) {
      assertValidHarnessHandleTable(options.runState.handleTable);
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
      ...(options.runState !== undefined && recordedOwner !== undefined
        ? { credentialOwner: recordedOwner }
        : {}),
      ...(options.runState !== undefined && recordedHomeIdentity !== undefined
        ? { harnessHomeIdentity: recordedHomeIdentity }
        : {}),
      ...(options.runState !== undefined && recordedAuthSource !== undefined
        ? { modelAuthSource: recordedAuthSource }
        : {}),
    });
    const runId = options.runState?.runId ?? options.runId ??
      crypto.randomUUID();
    // The session behind `run_pattern` is expensive and remote, so it is
    // built lazily on the tool's first invocation and cached for the run
    // while healthy; a failed construction is retried on the next call.
    const fabricSessionFactory = options.fabricSessionFactory ??
      (this.config.fabricSession !== undefined
        ? createHarnessFabricSessionFactory(this.config.fabricSession)
        : undefined);
    this.#fabricSessionFactory = fabricSessionFactory === undefined
      ? undefined
      : cacheHarnessFabricSessionFactory(fabricSessionFactory);
    // The index client loads the fabric identity from disk to sign with, so
    // it is built lazily and cached for the run on the same terms.
    const patternIndexClientFactory = options.patternIndexClientFactory ??
      (this.config.patternIndex !== undefined &&
          this.config.fabricSession !== undefined
        ? createHarnessPatternIndexClientFactory(
          this.config.patternIndex,
          this.config.fabricSession.identityKeyPath,
        )
        : undefined);
    this.#patternIndexClientFactory = patternIndexClientFactory === undefined
      ? undefined
      : cacheHarnessPatternIndexClientFactory(patternIndexClientFactory);
    this.#taskText = options.taskText;
    this.#inputCells = options.inputCells ?? [];
    this.#spaceDbPath = options.spaceDbPath;
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
    this.#ownedRunscConfig = options.sandboxRuntime === undefined
      ? sandboxConfig
      : undefined;
    this.hostProcessRunner = options.processRunner ?? new DenoProcessRunner();
    this.sandbox = options.sandboxRuntime ??
      new DockerRunscSandboxRuntime(sandboxConfig!, options.processRunner);
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
    // The posture the fabric session's runtime will actually run at, resolved
    // from the same config the session factory reads. The pin/default values
    // restate what `runtimePresets.remoteClient` and the Runtime constructor
    // supply when the dial is unset (`coreOptions` in
    // `packages/runner/src/runtime-presets.ts`).
    const fabricSessionCfc = this.config.fabricSession !== undefined
      ? {
        enforcementMode: this.config.fabricSession.cfcEnforcementMode ??
          "enforce-explicit" as const,
        enforcementModeSource:
          this.config.fabricSession.cfcEnforcementMode !== undefined
            ? "configured" as const
            : "preset-pin" as const,
        flowLabels: this.config.fabricSession.cfcFlowLabels ??
          (this.config.fabricSession.cfcPosture === "max-enforcement"
            ? "persist" as const
            : "off" as const),
        flowLabelsSource: this.config.fabricSession.cfcFlowLabels !== undefined
          ? "configured" as const
          : this.config.fabricSession.cfcPosture === "max-enforcement"
          ? "posture" as const
          : "default" as const,
        ...(this.config.fabricSession.cfcPosture !== undefined
          ? { posture: this.config.fabricSession.cfcPosture }
          : {}),
      }
      : undefined;
    // A resumed run keeps its recorded fabric-session posture, so a session
    // config that resolves to a DIFFERENT posture would put the artifacts in
    // contradiction with the Runtime that executes: refuse rather than let
    // either record win silently. A run resumed without a session keeps its
    // record as history (no runtime exists for it to contradict). A LEGACY
    // record — one that never captured a posture — stays absent rather than
    // being backfilled, and stays frozen as history: resuming such a run
    // with plain session dials is allowed (the flags may simply restate the
    // original invocation, which the record predates), but resuming it under
    // the named posture bundle is refused — no legacy run can have run the
    // bundle, so that resume would execute enforcement the artifacts cannot
    // attest.
    if (options.runState !== undefined && fabricSessionCfc !== undefined) {
      const recorded = options.runState.fabricSessionCfc;
      if (recorded === undefined) {
        if (fabricSessionCfc.posture !== undefined) {
          throw new Error(
            `fabric session CFC posture mismatch on resume: run state ` +
              `records no fabric-session posture, so it cannot attest the ` +
              `${fabricSessionCfc.posture} bundle the session ` +
              `configuration resolves`,
          );
        }
      } else if (
        recorded.enforcementMode !== fabricSessionCfc.enforcementMode ||
        recorded.flowLabels !== fabricSessionCfc.flowLabels ||
        recorded.posture !== fabricSessionCfc.posture
      ) {
        throw new Error(
          `fabric session CFC posture mismatch on resume: run state records ` +
            `${JSON.stringify(recorded)} but the session configuration ` +
            `resolves ${JSON.stringify(fabricSessionCfc)}`,
        );
      }
    }
    this.#runState = options.runState ??
      createHarnessRunState({
        runId,
        cfcEnforcementMode: this.config.cfcEnforcementMode,
        ...(fabricSessionCfc !== undefined ? { fabricSessionCfc } : {}),
        currentDir,
        model: this.config.model,
        modelProvider: this.config.modelProvider,
        modelAuthSource: this.config.modelAuthSource ??
          (this.config.modelProvider === "openai-codex"
            ? "owner-bound-oauth"
            : this.config.gatewayAuthMode === "none"
            ? "none"
            : "api-key"),
        credentialOwnerKey: this.config.credentialOwnerKey,
        credentialOwner: this.config.credentialOwner,
        harnessHomeIdentity: this.config.harnessHomeIdentity,
        artifactRoot: this.artifactStore?.runRoot,
        runManifest: this.config.runManifest,
        runManifestPath: this.config.runManifestPath,
        lineage: options.lineage,
        now: this.#now(),
      });
    this.#outputSequence = this.#runState.toolOutputs.length;
  }

  getRunState(): HarnessRunState {
    return structuredClone(this.#runState);
  }

  /**
   * Whether the run can build a fabric session for `run_pattern` — either
   * an injected factory or `fabricSession` connection config. The prompt
   * loop offers `run_pattern` in the default parent tool surface exactly
   * when this holds.
   */
  get fabricSessionAvailable(): boolean {
    return this.#fabricSessionFactory !== undefined;
  }

  /**
   * The run's cached fabric-session factory, or `undefined` when the run has
   * none. A delegating parent hands its factory to the child engine, so a
   * subagent's `run_pattern` shares the one session the parent built rather
   * than opening a second one against the same space.
   */
  get fabricSessionFactory(): HarnessFabricSessionFactory | undefined {
    return this.#fabricSessionFactory;
  }

  /**
   * Whether the run can reach the pattern index — either an injected factory
   * or `patternIndex` connection config. The prompt loop offers
   * `search_patterns` and `record_feedback` exactly when this holds.
   */
  get patternIndexAvailable(): boolean {
    return this.#patternIndexClientFactory !== undefined;
  }

  /**
   * Whether a pattern this run authored and ran is published back to the
   * index. A run that can reach an index publishes to it unless the operator
   * said otherwise, so an injected factory with no connection config — a test
   * harness, a delegating parent — publishes like a configured one.
   */
  get patternIndexPublishEnabled(): boolean {
    return this.patternIndexAvailable &&
      this.config.patternIndex?.publish !== false;
  }

  /**
   * Where this run's authored patterns wait to be published. One ledger per
   * engine, and therefore one per session: a delegating parent and its child
   * each publish once per capability of their own, which is the grain the
   * duplicates were being produced at. Created on first use and only when the
   * run can reach an index at all.
   */
  get patternIndexPublications(): PatternIndexPublicationLedger | undefined {
    const factory = this.#patternIndexClientFactory;
    if (factory === undefined) return undefined;
    this.#patternIndexPublications ??= createPatternIndexPublicationLedger(
      factory,
    );
    return this.#patternIndexPublications;
  }

  /**
   * Sends everything this session's ledger still holds. Called once, when the
   * session's prompt loop finishes; a session that never reaches it publishes
   * nothing, which `publish-ledger.ts` states as the cost it is.
   */
  async flushPatternIndexPublications(): Promise<void> {
    await this.#patternIndexPublications?.flush();
  }

  /**
   * The run's cached pattern-index factory, or `undefined` when the run has
   * none. A delegating parent hands its factory to the child engine, so a
   * subagent searches and runs indexed patterns through the one client the
   * parent built.
   */
  get patternIndexClientFactory():
    | HarnessPatternIndexClientFactory
    | undefined {
    return this.#patternIndexClientFactory;
  }

  bindRunModel(model: string): HarnessRunState {
    const recordedModel = this.#runState.model;
    if (
      this.#runState.modelProvider === "openai-codex" &&
      this.#runModelBound &&
      recordedModel !== undefined && recordedModel !== model
    ) {
      throw new Error(
        `${
          this.#resumedRun ? "resumed " : ""
        }openai-codex run model ${recordedModel} does not match requested model ${model}`,
      );
    }
    if (recordedModel !== model) {
      this.#runState = patchHarnessRunState(
        this.#runState,
        { model },
        this.#now(),
      );
    }
    this.#runModelBound = true;
    return this.getRunState();
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
    this.#runState = patchHarnessRunState(
      this.#runState,
      { promptSlotBinding },
      this.#now(),
    );
    return this.getRunState();
  }

  async recordPolicyEvent(
    event: Omit<HarnessPolicyEvent, "type" | "at">,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    const policyEvent = createHarnessPolicyEvent({ ...event, at: now });
    this.#runState = appendToHarnessRunState(
      this.#runState,
      "policyEvents",
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
    this.#runState = appendToHarnessRunState(
      this.#runState,
      "policyDecisions",
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

  /**
   * The run's session-local handle table, or `undefined` while none has been
   * recorded. A defensive copy, like `getRunState()`.
   */
  get handleTable(): HarnessHandleTable | undefined {
    return this.#runState.handleTable === undefined
      ? undefined
      : structuredClone(this.#runState.handleTable);
  }

  /**
   * What `resolveHandleValue` needs from this run: the handle table and the
   * fabric session, when the run has one. For trusted-side resolutions the
   * prompt loop performs itself (a `delegate_task` skillHandle), where no
   * tool context exists to carry them.
   */
  get handleValueResolutionContext(): HandleValueResolutionContext {
    return {
      handleTable: this.handleTable,
      ...(this.#fabricSessionFactory !== undefined
        ? { getFabricSession: this.#fabricSessionFactory }
        : {}),
    };
  }

  /**
   * Records `table` as the run's handle table and persists the run state.
   *
   * @throws Error when `table` is not a well-formed version-1 handle table.
   */
  async recordHandleTable(table: HarnessHandleTable): Promise<void> {
    assertValidHarnessHandleTable(table);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { handleTable: structuredClone(table) },
      this.#now(),
    );
    await this.persistRunState();
  }

  async persistRunState(): Promise<string | undefined> {
    return await this.artifactStore?.persistRunState(this.#runState);
  }

  /**
   * Establishes the run's well-known grants: seeds the handle table with a
   * token for each reference every Fabric-configured run is entitled to
   * hold, records the grants in run state, and returns them. Establishing
   * the Fabric session is the cost of resolving the references, so this
   * connects eagerly — callers invoke it only on runs configured for a
   * session. Idempotent across resume: grants already recorded are returned
   * as they stand, without connecting again.
   *
   * A run without a session factory has nothing to grant and answers `[]`.
   * A session that cannot be established propagates its failure — the caller
   * decides whether a run proceeds without its grants, and says so.
   */
  async establishWellKnownGrants(): Promise<HarnessWellKnownGrant[]> {
    if (this.#runState.wellKnownGrants !== undefined) {
      return structuredClone(this.#runState.wellKnownGrants);
    }
    if (this.#fabricSessionFactory === undefined) {
      return [];
    }
    const session = await this.#fabricSessionFactory();
    const refs = await resolveWellKnownGrantRefs(session);
    const minted = await mintWellKnownGrants(
      this.handleTable,
      this.#runState.runId,
      refs,
    );
    await this.recordHandleTable(minted.table);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { wellKnownGrants: structuredClone(minted.grants) },
      this.#now(),
    );
    await this.persistRunState();
    return minted.grants;
  }

  /**
   * Establishes the run's operator input cells: mints a token for each
   * `--input-cell` reference into the handle table, records the cells in
   * run state, and returns them. Idempotent across resume, like the
   * well-known grants: cells already recorded are returned as they stand.
   *
   * Unlike a grant, an input cell is explicit operator configuration, so
   * failure is closed and loud rather than tolerated: cells configured on a
   * run with no fabric session, a reference that does not parse, and a
   * reference targeting another space all throw before anything is recorded.
   */
  async establishInputCells(): Promise<HarnessInputCell[]> {
    if (this.#runState.inputCells !== undefined) {
      return structuredClone(this.#runState.inputCells);
    }
    if (this.#inputCells.length === 0) {
      return [];
    }
    if (this.#fabricSessionFactory === undefined) {
      throw new Error(
        "--input-cell requires a fabric session; configure --fabric-space",
      );
    }
    const session = await this.#fabricSessionFactory();
    const minted = await mintInputCellHandles(
      this.handleTable,
      this.#runState.runId,
      this.#inputCells,
      session.pieces.getSpace(),
    );
    await this.recordHandleTable(minted.table);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { inputCells: structuredClone(minted.inputCells) },
      this.#now(),
    );
    await this.persistRunState();
    return minted.inputCells;
  }

  /**
   * Reads the run's space for what it holds about the cells this run touched,
   * and records the answer beside the run.
   *
   * The run's own artifacts say which cells it made and read and what the
   * sandbox decided about each call; the space says what each of those cells
   * is labelled. Nothing else joins the two, so a reader working from the
   * tree alone sees an unlabelled cell whatever the run was enforcing. The
   * snapshot is that join, taken at the run's own space, over every cell the
   * handle table names.
   *
   * Read-only and best-effort by construction: the space database is opened
   * read-only, and a host that holds no copy of it yields an unavailable
   * snapshot rather than a failed run. What it must never do is yield a bare
   * one — "the space holds no label for this cell" and "nobody asked" are
   * different findings, and the snapshot's `status` is what keeps them apart.
   *
   * A run with no fabric session names no space and touches no cell, so it
   * takes no snapshot at all.
   */
  async snapshotCellLabels(): Promise<HarnessCellLabels | undefined> {
    const space = this.config.fabricSession?.space;
    const refs = (this.#runState.handleTable?.entries ?? []).map((entry) =>
      entry.ref
    );
    if (space === undefined || refs.length === 0) {
      return undefined;
    }
    const generatedAt = this.#now();
    // deno-lint-ignore cf-imports/no-inline-module-import -- costs at import time: reading a space database is the one thing the engine does through a native library, and a process that never takes a snapshot must not load one to run
    const { readSpaceCellLabels } = await import("./space-labels.ts");
    const cellLabels = await readSpaceCellLabels({
      space,
      ...(this.#spaceDbPath !== undefined ? { dbPath: this.#spaceDbPath } : {}),
      refs,
      generatedAt,
    });
    const cellLabelsPath = await this.artifactStore?.persistCellLabels?.(
      cellLabels,
    );
    this.#runState = patchHarnessRunState(
      this.#runState,
      { cellLabels, cellLabelsPath },
      generatedAt,
    );
    await this.persistRunState();
    return cellLabels;
  }

  async ensureRunManifestPersisted(): Promise<string | undefined> {
    if (this.#runState.runManifest === undefined) {
      return this.#runState.runManifestPath;
    }
    const manifestPath = await this.artifactStore?.persistRunManifest?.(
      this.#runState.runManifest,
    );
    if (manifestPath !== undefined) {
      this.#runState = patchHarnessRunState(
        this.#runState,
        { runManifestPath: manifestPath },
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
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillRegistry: registry, skillRegistryPath },
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
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillActivations: activations, skillActivationsPath },
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
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillResourceReads, skillResourceReadsPath },
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
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillScriptExecutions, skillScriptExecutionsPath },
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
    this.#runState = setHarnessSubagentRun(
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
      this.#runState = patchHarnessRunState(
        this.#runState,
        { transcriptPath },
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
      this.#runState = patchHarnessRunState(
        this.#runState,
        { runReportPath },
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
    this.#runState = patchHarnessRunState(
      this.#runState,
      { cfcPolicySnapshot: snapshot, cfcPolicySnapshotPath },
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
    this.#runState = patchHarnessRunState(
      this.#runState,
      { policyTrace: trace, policyTracePath },
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
      this.#runState = patchHarnessRunState(
        this.#runState,
        { capabilitySnapshot, capabilitiesPath },
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
    options: { signal?: AbortSignal } = {},
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
        this.#createToolContext(options.signal),
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
    this.#runState = appendToHarnessRunState(
      setHarnessRunStatus(
        this.#runState,
        "completed",
        completionTime,
        "tool_completed",
      ),
      "toolOutputs",
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
        "host execution requires a host mount path to map sandbox paths",
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
    this.#runState = appendToHarnessRunState(
      this.#runState,
      "cfcInvocationContexts",
      invocation,
      now,
    );
    await this.persistRunState();
    return invocation;
  }

  #createToolContext(signal?: AbortSignal) {
    return {
      runId: this.#runState.runId,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      currentDir: this.#runState.currentDir,
      workspaceHostPath: this.workspaceHostPath,
      ...(signal !== undefined ? { signal } : {}),
      skillRegistry: this.#runState.skillRegistry,
      skillActivations: this.#runState.skillActivations,
      allowedSkillScripts: this.config.allowedSkillScripts,
      skillScriptExecutionTarget: this.config.skillScriptExecutionTarget,
      browserAccess: this.config.browserAccess,
      handleValueOrigins: this.config.handleValueOrigins,
      handleTable: this.handleTable,
      ...(this.#fabricSessionFactory !== undefined
        ? { getFabricSession: this.#fabricSessionFactory }
        : {}),
      ...(this.#patternIndexClientFactory !== undefined
        ? {
          getPatternIndexClient: this.#patternIndexClientFactory,
          patternIndexPublishEnabled: this.patternIndexPublishEnabled,
          patternIndexPublications: this.patternIndexPublications,
        }
        : {}),
      ...(this.#taskText !== undefined ? { taskText: this.#taskText } : {}),
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
      imageAttachmentSnapshotDir: this.artifactStore
        ?.imageAttachmentSnapshotDir,
      doesHostPathIntersectArtifactRoot: (
        path: string,
        options?: { allowMissing?: boolean },
      ) => this.#doesHostPathIntersectArtifactRoot(path, options),
      setCurrentDir: (path: string) => {
        const resolved = this.sandbox.resolvePath(
          path,
          this.#runState.currentDir,
        );
        this.#runState = patchHarnessRunState(
          this.#runState,
          { currentDir: resolved },
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
