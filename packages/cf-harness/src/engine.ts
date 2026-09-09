import type {
  LoomAuthoringToolOutput,
  LoomComposeToolInput,
  LoomReadToolInput,
} from "./tools/loom-authoring.ts";
import {
  dirname,
  join as joinHostPath,
  normalize as normalizeHostPath,
  relative as relativeHostPath,
} from "@std/path";
import { normalize as normalizeSandboxPath } from "@std/path/posix";

import { isObjectNotArray } from "@commonfabric/utils/types";

import { familySandboxRuntime } from "./sandbox/family-sandbox.ts";
import {
  createSandboxOutputRoot,
  familyDirBesideWorkspace,
  familyDirUnderArtifactRoot,
  type HarnessSandboxOutputRoot,
  readSandboxOutputRootFromDisk,
  restoreSandboxOutputRoot,
  SANDBOX_OUTPUT_DIR_ENV,
  SANDBOX_OUTPUT_MOUNT_NAME,
  SANDBOX_OUTPUT_MOUNT_PATH,
  sandboxOutputRootHostPath,
} from "./sandbox/output-root.ts";
import {
  type HarnessWorkspaceTaint,
  joinWorkspaceTaint,
  poisonWorkspaceTaint,
  seedWorkspaceTaint,
  useWorkspaceTaintRecord,
  workspaceTaint,
} from "./workspace-taint.ts";

import {
  type CfcConfClause,
  type CfcLabelView,
  type CfcPostureReport,
  type IFCLabel,
  inheritedCfcPostureReport,
} from "@commonfabric/runner/cfc";

import {
  createFileSystemHarnessArtifactStore,
  type HarnessArtifactStore,
} from "./artifacts.ts";
import {
  fabricSessionCfcEnforcementMode,
  type HarnessConfig,
  type ResolvedHarnessConfig,
  resolveHarnessConfig,
  type ResolveHarnessConfigOptions,
} from "./config.ts";
import { harnessFabricSessionPosture } from "./cfc-posture.ts";
import {
  type HarnessDocsCorpus,
  loadHarnessDocsCorpus,
} from "./docs-corpus/corpus.ts";
import type { HarnessExploreQueryRunner } from "./docs-corpus/explore.ts";
import type { HarnessToolContext } from "./tools/types.ts";
import type { HarnessDocsCorpusRecord } from "./contracts/docs-corpus.ts";
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
  HarnessSkillAcquisition,
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
import { harnessResumeRefusal } from "./control-errors.ts";
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
import {
  assertValidHarnessHandleTable,
  createHarnessHandleTable,
  mintAddressHandle,
} from "./handle-table.ts";
import {
  cacheHarnessPatternIndexClientFactory,
  createHarnessPatternIndexClientFactory,
  type HarnessPatternIndexClientFactory,
} from "./pattern-index/client.ts";
import {
  createPatternIndexPublicationLedger,
  type PatternIndexPublicationLedger,
} from "./pattern-index/publish-ledger.ts";
import {
  cacheHarnessSkillsShAcquisitionClientFactory,
  createHarnessSkillsShAcquisitionClientFactory,
  type HarnessSkillsShAcquisitionClientFactory,
} from "./skills-sh/acquisition.ts";
import {
  cacheHarnessSkillsShSearchClientFactory,
  createHarnessSkillsShSearchClientFactory,
  type HarnessSkillsShSearchClientFactory,
} from "./skills-sh/search-client.ts";
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
import type {
  HarnessPatternRef,
  HarnessPatternRefSpec,
} from "./contracts/pattern-refs.ts";
import { resolvePatternRefs } from "./pattern-refs.ts";
import {
  addHarnessDocsQueryFailures,
  appendHarnessCfcModelContextObservations,
  appendHarnessFailureRecord,
  appendToHarnessRunState,
  createHarnessRunState,
  type HarnessRunState,
  type HarnessRunTerminalReason,
  isTerminalHarnessRunStatus,
  patchHarnessRunState,
  setHarnessRunStatus,
  setHarnessSubagentRun,
  setHarnessWorkspaceTaint,
} from "./run-state.ts";
import {
  assertDockerRunscCfcTransportForMode,
  DockerRunscSandboxRuntime,
  isHostDirWithinMount,
  resolveDockerRunscSandboxConfig,
} from "./sandbox/docker-runsc.ts";
import {
  DenoProcessRunner,
  type ProcessRunner,
} from "./sandbox/process-runner.ts";
import type {
  DockerRunscAdditionalMountConfig,
  DockerRunscSandboxConfig,
  SandboxCommandResult,
  SandboxRuntime,
} from "./sandbox/types.ts";
import { type BashToolInput, type BashToolOutput } from "./tools/bash.ts";
import type {
  AcquireSkillToolInput,
  AcquireSkillToolOutput,
} from "./tools/acquire-skill.ts";
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
import type {
  SearchSkillsToolInput,
  SearchSkillsToolOutput,
} from "./tools/search-skills.ts";
import {
  type QueryDocsToolInput,
  type QueryDocsToolOutput,
} from "./tools/query-docs.ts";
import {
  type ViewImageToolInput,
  type ViewImageToolOutput,
} from "./tools/view-image.ts";
import {
  type WebFetchToolInput,
  type WebFetchToolOutput,
} from "./tools/web-fetch.ts";
import {
  type IngestSandboxFileToolInput,
  type IngestSandboxFileToolOutput,
} from "./tools/ingest-sandbox-file.ts";
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
  ingest_sandbox_file: IngestSandboxFileToolInput;
  describe_handle: DescribeHandleToolInput;
  search_patterns: SearchPatternsToolInput;
  record_feedback: RecordFeedbackToolInput;
  search_skills: SearchSkillsToolInput;
  acquire_skill: AcquireSkillToolInput;
  query_docs: QueryDocsToolInput;
  loom_compose: LoomComposeToolInput;
  loom_inspect: LoomReadToolInput;
  loom_authoring_context: LoomReadToolInput;
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
  ingest_sandbox_file: IngestSandboxFileToolOutput;
  describe_handle: DescribeHandleToolOutput;
  search_patterns: SearchPatternsToolOutput;
  record_feedback: RecordFeedbackToolOutput;
  search_skills: SearchSkillsToolOutput;
  acquire_skill: AcquireSkillToolOutput;
  query_docs: QueryDocsToolOutput;
  loom_compose: LoomAuthoringToolOutput;
  loom_inspect: LoomAuthoringToolOutput;
  loom_authoring_context: LoomAuthoringToolOutput;
}

/**
 * How deep a label's own data may nest.
 *
 * A CFC label is a list of atoms, and an atom is a small flat record; nothing
 * this reads has any use for depth. The bound is what keeps BOTH walks over
 * one finite: this one, and the serializer that compares two labels
 * afterwards. A structure deeper than this is not something the format
 * describes, so refusing it costs nothing real and removes the last way a
 * label can end a read by raising instead of answering.
 */
const MAX_LABEL_DEPTH = 64;

/**
 * Whether `value` is plain JSON data this can carry: bounded in depth, free
 * of cycles, and holding nothing a serializer would refuse or silently drop.
 *
 * Walked with an explicit stack rather than by recursion, and bounded rather
 * than merely guarded against cycles. Both of those are about the same thing:
 * this must ANSWER for every input. A recursive walk raises `RangeError` on
 * deep input, and an exception raised while reading a container's taint
 * leaves the family recorded as it was — which is to say clean. A shape this
 * cannot read has to come back as `false`.
 *
 * The visited set holds the containers on the CURRENT path, so an object
 * appearing twice in sequence — one atom named in both clauses — is not
 * mistaken for a cycle, which is an object appearing inside itself.
 */
const isRepresentableJsonValue = (value: unknown): boolean => {
  type Frame = { value: unknown; depth: number; open: boolean };
  const path = new Set<object>();
  const stack: Frame[] = [{ value, depth: 0, open: true }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (!frame.open) {
      path.delete(frame.value as object);
      continue;
    }
    const entry = frame.value;
    if (entry === null) {
      continue;
    }
    switch (typeof entry) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (!Number.isFinite(entry)) {
          return false;
        }
        continue;
      case "object":
        break;
      default:
        return false;
    }
    const container = entry as object;
    if (path.has(container) || frame.depth >= MAX_LABEL_DEPTH) {
      return false;
    }
    path.add(container);
    // A closing frame under the children, so the container leaves the current
    // path once everything below it has been read.
    stack.push({ value: container, depth: frame.depth, open: false });
    const children = Array.isArray(container)
      ? container
      : Object.values(container);
    for (const child of children) {
      if (child !== undefined) {
        stack.push({ value: child, depth: frame.depth + 1, open: true });
      }
    }
  }
  return true;
};

/**
 * Whether `value` is an IFC label this can represent: clauses that are lists
 * of data this can carry, and nothing else carrying content. A label whose
 * `confidentiality` is a string survives an equality comparison and is then
 * dropped by the merge, leaving a family that carried a requirement recorded
 * as carrying none — and one holding a cycle anywhere inside it would throw
 * out of the comparison instead.
 */
const isRepresentableIfcLabel = (value: unknown): boolean => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  return Object.entries(value).every(([clause, entry]) =>
    (clause === "confidentiality" || clause === "integrity")
      ? Array.isArray(entry) && isRepresentableJsonValue(entry)
      : entry === undefined || entry === null
  );
};

/** Whether one stream observation is complete for the policy it declares. */
const isCompleteStreamObservation = (
  value: unknown,
  channel: "stdout" | "stderr",
): boolean => {
  if (!isObjectNotArray(value) || value.channel !== channel) {
    return false;
  }
  if (!isRepresentableIfcLabel(value.label)) {
    return false;
  }
  switch (value.policy) {
    case "observed":
      return Array.isArray(value.segments);
    case "opaque":
    case "denied":
      return true;
    default:
      return false;
  }
};

/** Whether the exit-code observation is complete for the policy it declares. */
const isCompleteExitCodeObservation = (value: unknown): boolean => {
  if (!isObjectNotArray(value) || !isRepresentableIfcLabel(value.label)) {
    return false;
  }
  switch (value.policy) {
    case "observed":
      return typeof value.value === "number" || value.value === null;
    case "opaque":
    case "denied":
      return true;
    default:
      return false;
  }
};

/**
 * Whether two labels state the same requirement.
 *
 * Both are known representable before this runs, so serializing them cannot
 * meet a cycle. That order is the whole point: a cyclic label reaching
 * `JSON.stringify` would throw out of the taint reader, and an exception
 * there leaves the family recorded as clean.
 */
const sameLabel = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});

/**
 * The container taint a sandbox invocation reported, or `undefined` when it
 * established none.
 *
 * Only a COMPLETE result runsc itself reported counts, and completeness is
 * checked over the whole union rather than over the one field the label is
 * read from. A result the runtime synthesized because it could not read the
 * sidecar is rendered as a `denied` observation with an EMPTY label, shaped
 * exactly like a public container; the origin is what tells them apart, and
 * its absence is read as synthetic. Beyond that: an observation missing, a
 * policy or channel outside the ones defined, a policy whose own fields are
 * absent, a label this cannot represent, or three observations that disagree
 * about the container's label — each describes no container, and reading one
 * anyway is how an empty label gets minted from a tainted run.
 */
const cfcSandboxTaintOfResult = (
  result: SandboxCommandResult | undefined,
): IFCLabel | undefined => {
  if (result?.cfcResultOrigin !== "runsc-taint") {
    return undefined;
  }
  const cfcResult = result.cfcResult;
  if (!isObjectNotArray(cfcResult) || cfcResult.version !== 1) {
    return undefined;
  }
  const { stdout, stderr, exitCode } = cfcResult;
  if (
    !isCompleteStreamObservation(stdout, "stdout") ||
    !isCompleteStreamObservation(stderr, "stderr") ||
    !isCompleteExitCodeObservation(exitCode)
  ) {
    return undefined;
  }
  // One decision covers the whole invocation: every branch of
  // `cfcResultFromRunscSidecar` gives all three observations the same policy,
  // because whether the container's output may be read is a fact about the
  // container. Three that disagree were assembled by something else.
  const policy = (stdout as { policy: unknown }).policy;
  if (
    (stderr as { policy: unknown }).policy !== policy ||
    (exitCode as { policy: unknown }).policy !== policy
  ) {
    return undefined;
  }
  // One container has one taint, and `cfcResultFromRunscSidecar` puts it on
  // all three observations. Three that disagree describe no container.
  const label = (stdout as { label: unknown }).label;
  if (
    !sameLabel(label, (stderr as { label: unknown }).label) ||
    !sameLabel(label, (exitCode as { label: unknown }).label)
  ) {
    return undefined;
  }
  return label as IFCLabel;
};

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

  /**
   * The run family's harness directory, for a delegated child.
   *
   * A child is handed its parent's runtime and workspace but not its mounts,
   * so re-deriving the directory could put it somewhere the parent did not
   * choose — and the family's taint record lives there, so two derivations
   * mean two records and a family that cannot see its own evidence. The
   * parent's choice is inherited rather than recomputed.
   */
  familyDirHostPath?: string;
  artifactStore?: HarnessArtifactStore;
  processRunner?: ProcessRunner;

  /**
   * Injection seam for the `run_pattern` fabric session, mirroring how
   * `sandboxRuntime` replaces the engine-built sandbox. When absent, a
   * factory is built from `fabricSession` in the resolved config; when both
   * are absent, `run_pattern` and `acquire_skill` have no session and stay out
   * of the parent tool surface.
   */
  fabricSessionFactory?: HarnessFabricSessionFactory;

  /**
   * The posture record of the run whose fabric session `fabricSessionFactory`
   * hands this one — a delegating parent's, for the child that shares it.
   *
   * Only a caller that knows the injected factory returns a session it
   * already published a record for can supply this; a host injecting a
   * session this engine knows nothing about has no record to pass and its run
   * publishes none. Ignored when no factory is injected, because the config
   * then describes the session this engine builds and the record comes from
   * it.
   */
  inheritedFabricSessionPosture?: CfcPostureReport;

  /**
   * Injection seam for the render gate's probe runtime, mirroring
   * `fabricSessionFactory`: a test supplies one to see what the gate opens
   * the probe under. When absent, the gate opens a real isolated runtime.
   */
  openProbeRuntime?: HarnessToolContext["openProbeRuntime"];

  /**
   * Injection seam for the pattern-index client, mirroring
   * `fabricSessionFactory`. When absent, a factory is built from
   * `patternIndex` in the resolved config; when both are absent, the run has
   * no index — `search_patterns` stays out of the tool surface and
   * `run_pattern` refuses a `patternId`.
   */
  patternIndexClientFactory?: HarnessPatternIndexClientFactory;

  /**
   * Injection seam for skills.sh discovery. When absent, a factory is built
   * from `skillsSh` in the resolved config; when both are absent,
   * `search_skills` stays out of the tool surface. Pinned acquisition has its
   * own fetch seam below because it is a separate effect.
   */
  skillsShSearchClientFactory?: HarnessSkillsShSearchClientFactory;

  /**
   * Injection seam for pinned external-skill acquisition. Production builds
   * it whenever `skillsSh` is configured; tests may replace the host fetch.
   */
  skillsShAcquisitionClientFactory?: HarnessSkillsShAcquisitionClientFactory;

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
   * Published patterns to resolve against the index at run start; see
   * `establishPatternRefs`. Requires a pattern index — the ids name entries
   * it holds.
   */
  patternRefs?: readonly HarnessPatternRefSpec[];

  /**
   * The space database the run's cell-label snapshot reads as it ends, for a
   * host where the store is not where the discovery walk looks. Absent, the
   * space named by the fabric session is resolved against the caches on this
   * host.
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
  artifactRootHostPath?: string;
}

/**
 * The mounts a pre-resolved sandbox configuration already carries, or the
 * ones this run was asked for. Family placement is decided against these, so
 * a caller that supplied a whole configuration is answered from ITS mounts
 * rather than from the option that configuration replaced.
 */
const configuredMounts = (
  config: HarnessConfig,
  options: ResolveSandboxConfigOptions,
): {
  workspaceHostPath?: string;
  additionalMounts: readonly DockerRunscAdditionalMountConfig[];
} => ({
  ...(config.sandbox?.workspaceHostPath ?? options.workspaceHostPath) !==
      undefined
    ? {
      workspaceHostPath: config.sandbox?.workspaceHostPath ??
        options.workspaceHostPath!,
    }
    : {},
  additionalMounts: config.sandbox?.additionalMounts ??
    options.additionalMounts ?? [],
});

/**
 * The sandbox configuration this run actually gets, with the family's output
 * mount in it and every check run over the list that results.
 *
 * A pre-resolved `config.sandbox` is RE-RESOLVED rather than passed through.
 * Passing it through was the hole: the output mount never reached the
 * runtime, and the non-overlap and sidecar-isolation checks never saw the
 * final mount set, so a caller supplying a whole configuration got neither
 * the directory nor the guarantees. Re-resolving states every field it
 * already carried, so nothing is defaulted back out from under it.
 */
const resolveSandboxConfig = (
  config: HarnessConfig,
  options: ResolveSandboxConfigOptions,
  outputMount?: DockerRunscAdditionalMountConfig,
): DockerRunscSandboxConfig => {
  const preResolved = config.sandbox;
  const workspaceHostPath = preResolved?.workspaceHostPath ??
    options.workspaceHostPath;
  if (workspaceHostPath === undefined) {
    throw new Error(
      "sandbox config is required when no workspaceHostPath default is provided",
    );
  }
  const additionalMounts = [
    ...(preResolved?.additionalMounts ?? options.additionalMounts ?? []),
    ...(outputMount === undefined ? [] : [outputMount]),
  ];
  const image = options.sandboxImage ?? preResolved?.image;
  const runtimeName = options.sandboxDockerRuntime ?? preResolved?.runtimeName;
  const cfcResultDir = preResolved?.cfcResultDir ?? options.cfcResultDir;
  const cfcInvocationContextDir = preResolved?.cfcInvocationContextDir ??
    options.cfcInvocationContextDir;
  return resolveDockerRunscSandboxConfig({
    workspaceHostPath,
    ...(image !== undefined ? { image } : {}),
    ...(runtimeName !== undefined ? { runtimeName } : {}),
    ...(preResolved?.dockerBinary !== undefined
      ? { dockerBinary: preResolved.dockerBinary }
      : {}),
    ...(preResolved?.containerUser !== undefined
      ? { containerUser: preResolved.containerUser }
      : {}),
    ...(preResolved?.workspaceMountPath !== undefined
      ? { workspaceMountPath: preResolved.workspaceMountPath }
      : {}),
    ...(preResolved?.shellPath !== undefined
      ? { shellPath: preResolved.shellPath }
      : {}),
    ...(preResolved?.dockerNetworkMode !== undefined
      ? { dockerNetworkMode: preResolved.dockerNetworkMode }
      : {}),
    ...(preResolved?.extraDockerArgs !== undefined
      ? { extraDockerArgs: preResolved.extraDockerArgs }
      : {}),
    ...(additionalMounts.length > 0 ? { additionalMounts } : {}),
    ...(cfcResultDir !== undefined ? { cfcResultDir } : {}),
    ...(cfcInvocationContextDir !== undefined
      ? { cfcInvocationContextDir }
      : {}),
    ...(options.artifactRootHostPath !== undefined
      ? { artifactRootHostPath: options.artifactRootHostPath }
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
      throw harnessResumeRefusal(
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
  readonly #openProbeRuntime?: HarnessToolContext["openProbeRuntime"];
  readonly #patternIndexClientFactory?: HarnessPatternIndexClientFactory;
  readonly #skillsShSearchClientFactory?: HarnessSkillsShSearchClientFactory;
  readonly #skillsShAcquisitionClientFactory?:
    HarnessSkillsShAcquisitionClientFactory;
  #docsCorpus?: Promise<HarnessDocsCorpus>;
  #exploreQueryRunner?: HarnessExploreQueryRunner;
  #patternIndexPublications?: PatternIndexPublicationLedger;
  readonly #taskText?: string;
  readonly #inputCells: readonly HarnessInputCellSpec[];
  readonly #patternRefs: readonly HarnessPatternRefSpec[];
  readonly #spaceDbPath?: string;
  #hostMounts: readonly HostSandboxMount[];
  readonly #ownedRunscConfig?: DockerRunscSandboxConfig;
  /**
   * The run family this engine belongs to: the root run's id, which a
   * delegated child inherits. The sandbox output directory and the taint
   * accumulated over it are both the family's, because a child shares its
   * parent's workspace and sandbox and the two have to meet in one place.
   */
  readonly #familyRunId: string;

  /**
   * The family's output directory on the host, when a place outside every
   * writable mount could be found for it. Deliberately not in the workspace,
   * nor under an artifact root that is itself inside one: a name the workload
   * can reach is a name it can re-point.
   */
  readonly #sandboxOutputRootHostPath?: string;

  /** The directory's recorded identity, once it has been established. */
  #sandboxOutputRoot?: HarnessSandboxOutputRoot;

  /** The family's harness directory, when one could be placed. */
  readonly #familyDirHostPath?: string;

  /** Why the family has no usable output directory, once that is settled. */
  #sandboxOutputRootFailure?: string;

  /**
   * The sandbox as it was supplied, before this family's instrumentation.
   *
   * A delegated child builds its own instrumented view, and it belongs to the
   * same family, so wrapping the parent's wrapped runtime would report every
   * one of the child's invocations twice — one container counted as two in
   * the family's record. The child is handed this instead.
   */
  readonly #sandboxForDelegation: SandboxRuntime;

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
        throw harnessResumeRefusal(
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
        throw harnessResumeRefusal(
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
      throw harnessResumeRefusal(
        `resumed run provider ${recordedProvider} does not match requested provider ${options.modelProvider}`,
      );
    }
    if (
      options.runState !== undefined && recordedProvider === "openai-codex" &&
      options.model !== undefined && options.runState.model !== undefined &&
      options.model !== options.runState.model
    ) {
      throw harnessResumeRefusal(
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
      throw harnessResumeRefusal(
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
      throw harnessResumeRefusal(
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
      throw harnessResumeRefusal(
        "resumed run model auth source does not match requested model auth source",
      );
    }
    if (
      options.runState !== undefined && recordedProvider === "openai-codex" &&
      options.runState.credentialOwnerKey !== undefined &&
      options.credentialOwnerKey !== undefined &&
      options.credentialOwnerKey !== options.runState.credentialOwnerKey
    ) {
      throw harnessResumeRefusal(
        "resumed openai-codex run credential owner key does not match requested credential owner key",
      );
    }
    if (
      options.runState !== undefined &&
      options.runState.cfcEnforcementMode === undefined
    ) {
      throw harnessResumeRefusal(
        "run state is missing cfcEnforcementMode; older cf-harness runs cannot be resumed",
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
      // A resumed run goes on executing at the mode it recorded, so that
      // mode is what this resolution inherits.
      ...(options.runState !== undefined
        ? { inheritedCfcEnforcementMode: options.runState.cfcEnforcementMode }
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
    // A resume that states its own enforcement dials, or that introduces a
    // fabric session whose raise outranks the recorded mode, resolves a mode
    // the run cannot move to: the recorded mode is what the rest of the run
    // enforces at. Refusing names both, rather than running at one and
    // labelling the artifacts with the other. A resume that resolves the
    // recorded mode passes silently, whether it restated it or inherited it.
    if (
      options.runState !== undefined &&
      this.config.cfcEnforcementMode !== options.runState.cfcEnforcementMode
    ) {
      throw harnessResumeRefusal(
        this.config.cfcEnforcementModeSource === "fabric-session"
          ? `resumed run CFC enforcement mode ${options.runState.cfcEnforcementMode} does not match the ${this.config.cfcEnforcementMode} its fabric session raises the harness dial to; lower --fabric-cfc-enforcement-mode to resume this run`
          : `resumed run CFC enforcement mode ${options.runState.cfcEnforcementMode} does not match requested CFC enforcement mode ${this.config.cfcEnforcementMode}`,
      );
    }
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
    this.#openProbeRuntime = options.openProbeRuntime;
    this.#patternIndexClientFactory = patternIndexClientFactory === undefined
      ? undefined
      : cacheHarnessPatternIndexClientFactory(patternIndexClientFactory);
    const skillsShSearchClientFactory = options.skillsShSearchClientFactory ??
      (this.config.skillsSh !== undefined
        ? createHarnessSkillsShSearchClientFactory(
          this.config.skillsSh.baseUrl,
        )
        : undefined);
    this.#skillsShSearchClientFactory =
      skillsShSearchClientFactory === undefined
        ? undefined
        : cacheHarnessSkillsShSearchClientFactory(skillsShSearchClientFactory);
    const skillsShAcquisitionClientFactory =
      options.skillsShAcquisitionClientFactory ??
        (this.config.skillsSh !== undefined
          ? createHarnessSkillsShAcquisitionClientFactory()
          : undefined);
    this.#skillsShAcquisitionClientFactory =
      skillsShAcquisitionClientFactory === undefined
        ? undefined
        : cacheHarnessSkillsShAcquisitionClientFactory(
          skillsShAcquisitionClientFactory,
        );
    this.#taskText = options.taskText;
    this.#inputCells = options.inputCells ?? [];
    this.#patternRefs = options.patternRefs ?? [];
    this.#spaceDbPath = options.spaceDbPath;
    // Both are needed before the sandbox exists: the family's output
    // directory is a mount the sandbox is built with, not a directory found
    // inside one it already has.
    // The resumed run's own record first: a child resumed from state keys its
    // family by the root it belonged to, not by its own id, or it would come
    // back as a family of one and read none of its parent's evidence.
    const constructionLineage = options.runState?.lineage ?? options.lineage;
    const familyRunId = constructionLineage?.rootRunId ?? runId;
    const artifactRootHostPath = this.config.artifactRoot ??
      (options.runState?.artifactRoot !== undefined
        ? dirname(options.runState.artifactRoot)
        : undefined);
    // The mount's SOURCE must be somewhere the sandbox cannot reach by
    // another route. Mounting a directory twice does not stop the workload
    // writing it through the first mount, and the CLI's default artifact root
    // sits under the working directory, which is also the default workspace —
    // so the ordinary configuration is exactly the one the artifact root
    // cannot serve. A sibling of the workspace is used instead, and a host
    // that offers neither gets no output directory and no ingest.
    // From the configuration this run will actually get, so a caller that
    // supplied a whole sandbox config is answered from ITS mounts rather than
    // from the options that config replaced.
    const configured = configuredMounts(this.config, {
      ...(options.workspaceHostPath !== undefined
        ? { workspaceHostPath: options.workspaceHostPath }
        : {}),
      ...(options.additionalMounts !== undefined
        ? { additionalMounts: options.additionalMounts }
        : {}),
    });
    const writableMountHostPaths = [
      ...(configured.workspaceHostPath !== undefined
        ? [configured.workspaceHostPath]
        : []),
      ...configured.additionalMounts
        .filter((mount) => !mount.readOnly)
        .map((mount) => mount.hostPath),
    ].filter((path): path is string => path !== undefined);
    const outsideEveryWritableMount = (candidate: string): boolean =>
      !writableMountHostPaths.some((mount) =>
        isHostDirWithinMount(candidate, mount)
      );
    // One directory per family, chosen where the sandbox cannot reach it.
    // Its `out` child is what gets mounted; everything else the harness keeps
    // for the family — the taint record among them — sits beside that child
    // and is therefore out of reach even though its sibling is bound in.
    const familyDirHostPath = options.familyDirHostPath ?? [
      ...(artifactRootHostPath === undefined ? [] : [
        familyDirUnderArtifactRoot(artifactRootHostPath, familyRunId),
      ]),
      ...(configured.workspaceHostPath === undefined ? [] : [
        familyDirBesideWorkspace(configured.workspaceHostPath, familyRunId),
      ]),
    ].find(outsideEveryWritableMount);
    const sandboxOutputRootHost = familyDirHostPath === undefined
      ? undefined
      : sandboxOutputRootHostPath(familyDirHostPath);
    const sandboxConfig = options.sandboxRuntime === undefined
      ? resolveSandboxConfig(
        this.config,
        {
          workspaceHostPath: options.workspaceHostPath,
          sandboxImage: options.sandboxImage,
          sandboxDockerRuntime: options.sandboxDockerRuntime,
          additionalMounts: options.additionalMounts,
          cfcResultDir: options.cfcResultDir,
          cfcInvocationContextDir: options.cfcInvocationContextDir,
          ...(artifactRootHostPath !== undefined
            ? { artifactRootHostPath }
            : {}),
        },
        sandboxOutputRootHost === undefined ? undefined : {
          kind: "host-bind",
          name: SANDBOX_OUTPUT_MOUNT_NAME,
          hostPath: sandboxOutputRootHost,
          sandboxPath: SANDBOX_OUTPUT_MOUNT_PATH,
          readOnly: false,
        },
      )
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
    const sandbox = options.sandboxRuntime ??
      new DockerRunscSandboxRuntime(sandboxConfig!, options.processRunner);
    this.workspaceHostPath = sandboxConfig?.workspaceHostPath ??
      options.workspaceHostPath;
    this.workspaceMountPath = normalizeSandboxRoot(
      sandboxConfig?.workspaceMountPath ?? sandbox.defaultWorkingDirectory(),
    );
    this.#familyRunId = familyRunId;
    this.#familyDirHostPath = familyDirHostPath;
    this.#sandboxOutputRootHostPath = sandboxOutputRootHost;
    // Every invocation carries the output directory, so a workload names it
    // the same way the ingest does and neither spells it out — and every one
    // reports what it left, so no tool can lose the family's evidence.
    // One record per family, wherever the family's own directory is, so what
    // a child learns reaches its parent's export and the next process's
    // resume without depending on which engine happened to write last.
    const familyRecord = familyDirHostPath === undefined
      ? undefined
      : useWorkspaceTaintRecord(
        this.#familyRunId,
        joinHostPath(familyDirHostPath, "family-taint.json"),
      );
    if (options.runState !== undefined && familyRecord?.found !== true) {
      // Resumed with no family record to read — one written before the
      // family kept its own, or a family whose directory is gone. This run's
      // own record is then all there is, and an entry this process has never
      // seen reads as clean unless that record says otherwise.
      seedWorkspaceTaint(this.#familyRunId, options.runState.cfcWorkspaceTaint);
    }
    this.#sandboxForDelegation = sandbox;
    this.sandbox = familySandboxRuntime(
      sandbox,
      { [SANDBOX_OUTPUT_DIR_ENV]: SANDBOX_OUTPUT_MOUNT_PATH },
      (result) => this.#recordSandboxEvidence(result),
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
    // The output mount is a host mount whether or not this engine built the
    // runtime: a delegated child is handed its parent's sandbox and still has
    // to map the mount's sandbox path back to the host to read out of it.
    if (
      sandboxOutputRootHost !== undefined &&
      !this.#hostMounts.some((mount) =>
        mount.sandboxPath === SANDBOX_OUTPUT_MOUNT_PATH
      )
    ) {
      this.#hostMounts = [...this.#hostMounts, {
        kind: "host-bind",
        name: SANDBOX_OUTPUT_MOUNT_NAME,
        hostPath: sandboxOutputRootHost,
        sandboxPath: SANDBOX_OUTPUT_MOUNT_PATH,
        readOnly: false,
      }];
    }
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
    // A host that supplies its own session factory overrides the config the
    // projection is computed from, so `config.fabricSession` no longer
    // describes the runtime that will execute. Publishing a record from it
    // would assert a posture nothing honors — the very shape this record
    // exists to make visible — so the record is omitted and the two itemized
    // dials stand alone, which is what the config still truthfully says was
    // asked for.
    // Unless the caller says whose runtime it handed over. A delegating
    // parent passes the record it published for the session it shares, and
    // the child republishes it as `inherited`: the posture of a run executing
    // on a runtime someone else built is not unknown, it is that runtime's,
    // and a child recording nothing is what leaves the run that actually
    // exercises the sinks unauditable (CT-2205).
    const sessionFactoryOverridesConfig = options.fabricSessionFactory !==
      undefined;
    const sessionRecord = sessionFactoryOverridesConfig
      ? (options.inheritedFabricSessionPosture === undefined
        ? undefined
        : inheritedCfcPostureReport(options.inheritedFabricSessionPosture))
      : this.config.fabricSession === undefined
      ? undefined
      : harnessFabricSessionPosture(this.config.fabricSession);
    const fabricSessionCfc = this.config.fabricSession !== undefined
      ? {
        enforcementMode: fabricSessionCfcEnforcementMode(
          this.config.fabricSession,
        ),
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
        ...(this.config.fabricSession.cfcReadMaxConfidentiality !== undefined
          ? {
            readMaxConfidentiality:
              this.config.fabricSession.cfcReadMaxConfidentiality,
          }
          : {}),
        ...(this.config.fabricSession.cfcReadOnExceed !== undefined
          ? { readOnExceed: this.config.fabricSession.cfcReadOnExceed }
          : {}),
        ...(this.config.fabricSession.readCeilingSource !== "none"
          ? {
            readMaxConfidentialitySource:
              this.config.fabricSession.readCeilingSource,
          }
          : {}),
        ...(sessionRecord !== undefined ? { record: sessionRecord } : {}),
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
          throw harnessResumeRefusal(
            `fabric session CFC posture mismatch on resume: run state ` +
              `records no fabric-session posture, so it cannot attest the ` +
              `${fabricSessionCfc.posture} bundle the session ` +
              `configuration resolves`,
          );
        }
      } else {
        // A ceiling is compared by its clauses and stated by their count: a
        // clause is a confidentiality label atom, which names spaces and
        // carries field commitments, and this message leaves the harness.
        const clauseCount = (clauses?: readonly CfcConfClause[]) =>
          clauses === undefined
            ? "none"
            : `${clauses.length} clause${clauses.length === 1 ? "" : "s"}`;
        const differences = [
          ...([
            [
              "enforcement mode",
              recorded.enforcementMode,
              fabricSessionCfc.enforcementMode,
            ],
            ["flow labels", recorded.flowLabels, fabricSessionCfc.flowLabels],
            [
              "posture bundle",
              recorded.posture ?? "none",
              fabricSessionCfc.posture ?? "none",
            ],
            [
              "read ceiling overflow",
              recorded.readOnExceed ?? "none",
              fabricSessionCfc.readOnExceed ?? "none",
            ],
          ] as const)
            .filter(([, recordedDial, resolved]) => recordedDial !== resolved)
            .map(([dial, recordedDial, resolved]) =>
              `${dial} (${recordedDial} against ${resolved})`
            ),
          // The read ceiling too: a resume that would read wider (or under
          // another ceiling) than the artifacts attest is the same
          // contradiction as a moved dial.
          ...(JSON.stringify(recorded.readMaxConfidentiality) !==
              JSON.stringify(fabricSessionCfc.readMaxConfidentiality)
            ? [
              `read ceiling (${
                clauseCount(recorded.readMaxConfidentiality)
              } against ${
                clauseCount(fabricSessionCfc.readMaxConfidentiality)
              })`,
            ]
            : []),
        ];
        // The whole record too, where the run recorded one. The two dials
        // above can agree while a dial neither of them names has moved under
        // the run — a changed runtime default, a changed posture bundle — and
        // a resume that kept the recorded record would attest a posture the
        // executing runtime is not at. A run that recorded no record predates
        // one and is compared on the dials alone. This is also what refuses a
        // resume that drops the session the record came from: a run that
        // recorded an inherited record and is resumed without the parent
        // session behind it resolves a different record, or none, and either
        // way the artifacts would stop describing what executes. The record
        // is named rather than printed: it lists every sink the runtime
        // governs and every deviation it publishes, which is a security
        // posture rather than a dial an operator moves, and this message
        // leaves the harness.
        if (
          recorded.record !== undefined &&
          JSON.stringify(recorded.record) !==
            JSON.stringify(fabricSessionCfc.record)
        ) {
          differences.push("the runtime posture record the dials resolve to");
        }
        if (differences.length > 0) {
          throw harnessResumeRefusal(
            `fabric session CFC posture mismatch on resume: the run and the ` +
              `session configuration differ on ${differences.join(", ")}`,
          );
        }
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
        docsCorpus: this.config.docsCorpus,
        skillsRoot: this.config.skillsRootRecord,
        lineage: options.lineage,
        now: this.#now(),
      });
    this.#outputSequence = this.#runState.toolOutputs.length;
  }

  getRunState(): HarnessRunState {
    return structuredClone(this.#syncFamilyTaint());
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
   * The space database the run's cell-label snapshot reads, or `undefined`
   * when the space is found by discovery. A delegating parent hands it to
   * the child engine, so a subagent that ends in the same space reads the
   * same store.
   */
  get spaceDbPath(): string | undefined {
    return this.#spaceDbPath;
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
   * index. A run that can reach an index records to it unless the operator
   * said otherwise, so an injected factory with no connection config — a test
   * harness, a delegating parent — publishes like a configured one.
   */
  get patternIndexPublishEnabled(): boolean {
    return this.patternIndexAvailable &&
      this.config.patternIndex?.publish !== false;
  }

  /**
   * Whether a successful authored pattern is offered to search immediately.
   * The default publication records it without making it discoverable.
   */
  get patternIndexPublishDiscoverable(): boolean {
    return this.config.patternIndex?.publishDiscoverable === true;
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

  /** Whether this run can search the configured skills.sh registry. */
  get skillsShSearchAvailable(): boolean {
    return this.#skillsShSearchClientFactory !== undefined;
  }

  /** The run's cached skills.sh search-client factory, when configured. */
  get skillsShSearchClientFactory():
    | HarnessSkillsShSearchClientFactory
    | undefined {
    return this.#skillsShSearchClientFactory;
  }

  /** Whether this run configures a documentation corpus for `query_docs`. */
  get docsCorpusAvailable(): boolean {
    return (this.docsCorpus?.roots ?? []).length > 0;
  }

  /**
   * The corpus this run answers out of. A resumed run keeps the corpus it was
   * created with, whatever this process was configured with: the run recorded
   * which documentation shaped it, and answering later questions out of a
   * different tree — or offering the tool on a run that disabled it — would
   * make that record a lie. Configuration answers only for a state that
   * carries no record of its own.
   */
  get docsCorpus(): HarnessDocsCorpusRecord | undefined {
    return this.#runState.docsCorpus ?? this.config.docsCorpus;
  }

  /**
   * The run's documentation corpus, loaded once. The load walks the operator's
   * roots on the host, so it is held for the run rather than repeated per
   * question: the roots are read-only reference material, and a query that
   * reloaded them would pay a filesystem walk to learn the same thing.
   */
  getDocsCorpus(): Promise<HarnessDocsCorpus> {
    this.#docsCorpus ??= loadHarnessDocsCorpus(this.docsCorpus?.roots ?? []);
    return this.#docsCorpus;
  }

  /**
   * Gives this run a way to answer a documentation question. The model belongs
   * to the prompt loop, so the loop supplies the runner and the engine carries
   * it to the tool.
   */
  setExploreQueryRunner(runner: HarnessExploreQueryRunner): void {
    this.#exploreQueryRunner = runner;
  }

  /** Whether this run can acquire a pinned external skill. */
  get skillsShAcquisitionAvailable(): boolean {
    return this.#skillsShAcquisitionClientFactory !== undefined;
  }

  /** The run's cached pinned-acquisition factory, when configured. */
  get skillsShAcquisitionClientFactory():
    | HarnessSkillsShAcquisitionClientFactory
    | undefined {
    return this.#skillsShAcquisitionClientFactory;
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

  /**
   * Counts documentation queries this run could not get an answer for, its
   * descendants' included. A `query_docs` failure is a normal tool error to
   * the model that asked, so without this a docs-blind run leaves no trace in
   * the one place an operator reads.
   */
  recordDocsQueryFailures(count: number): HarnessRunState {
    this.#runState = addHarnessDocsQueryFailures(
      this.#runState,
      count,
      this.#now(),
    );
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

  /**
   * Takes the run: `running`, with any earlier outcome cleared. The run's
   * driver calls this when it begins bringing the run up, and again on
   * resume, when a run re-enters its loop from a terminal record. The
   * driver's next persist carries it to disk; a run that ends before one is
   * persisted by the transition that ends it.
   */
  startRun(): HarnessRunState {
    this.#runState = setHarnessRunStatus(
      this.#runState,
      "running",
      this.#now(),
    );
    return this.getRunState();
  }

  /**
   * Ends the run as `completed` for `terminalReason`, persisted. A run has
   * one outcome and its driver writes it once, and the labels its space
   * holds for the cells it touched land in that same write; see
   * `#withCellLabels()`.
   *
   * @throws Error when the run already has its outcome.
   */
  async completeRun(
    terminalReason: HarnessRunTerminalReason,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    this.#runState = await this.#withCellLabels(
      setHarnessRunStatus(this.#runState, "completed", now, terminalReason),
      now,
    );
    await this.persistRunState();
    return this.getRunState();
  }

  /**
   * Ends the run as `failed` for `terminalReason`, persisted, recording
   * `error` as the failure when one is given. A run has one outcome and its
   * driver writes it once, and the labels its space holds for the cells it
   * touched land in that same write; see `#withCellLabels()`.
   *
   * @throws Error when the run already has its outcome.
   */
  async failRun(
    terminalReason: HarnessRunTerminalReason,
    error?: unknown,
    options: Omit<ClassifyHarnessRunErrorOptions, "at"> = {},
  ): Promise<HarnessRunState> {
    const now = this.#now();
    if (error !== undefined) {
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, { ...options, at: now }),
        now,
      );
    }
    this.#runState = await this.#withCellLabels(
      setHarnessRunStatus(this.#runState, "failed", now, terminalReason),
      now,
    );
    await this.persistRunState();
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
   * Records what one sandbox invocation left behind, at the boundary that ran
   * it rather than from the tool output that reports it.
   *
   * The container's taint joins the family's; an invocation that returned no
   * readable CFC result poisons it to `unknown`, and it stays there, because
   * nothing later can establish what an invocation whose evidence was lost
   * wrote into the output directory. Whichever policy the result took is
   * irrelevant — an opaque stream is precisely the case where a taint exists.
   *
   * A run configured without the runsc CFC result transport produces no
   * evidence at all, so its first sandbox invocation poisons the family and
   * `ingest_sandbox_file` refuses for the rest of it. That is the intended
   * reading: a run with no trusted taint source has no honest label to mint.
   */
  #recordSandboxEvidence(
    result: SandboxCommandResult | undefined,
  ): Promise<void> {
    const taint = cfcSandboxTaintOfResult(result);
    const next = taint === undefined
      ? poisonWorkspaceTaint(
        this.#familyRunId,
        "a sandbox invocation returned no readable CFC result, so what it " +
          "may have written cannot be established",
      )
      : joinWorkspaceTaint(this.#familyRunId, taint);
    // The family map is the state; every record picks it up on its way out
    // (`#syncFamilyTaint`), so nothing is written here. Reading the clock
    // here would also make the run's timestamps depend on how many containers
    // a tool happened to start.
    void next;
    return Promise.resolve();
  }

  /** What is known about the family's sandbox work, and how completely. */
  get workspaceTaint(): HarnessWorkspaceTaint {
    return workspaceTaint(this.#familyRunId);
  }

  /**
   * Brings this run's record up to date with the family's taint, on the way
   * out to a reader or to disk.
   *
   * The state that decides is the family's, and the engine that learns
   * something is whichever one ran the container. A delegated child updating
   * only its own record leaves its parent's saying the family was clean — and
   * the parent's record is what a later resume reads. Synchronizing at every
   * export is what makes "the family saw this" true of every record the
   * family writes, rather than of the one engine that was there.
   */
  #syncFamilyTaint(): HarnessRunState {
    const taint = workspaceTaint(this.#familyRunId);
    // A family that has seen nothing yet says nothing: the default state is
    // "known, and nothing accumulated", which is what an absent field already
    // means. Recording it would put a line in every run's record that carries
    // no information, and make the field's presence stop meaning anything.
    if (taint.kind === "known" && taint.label === undefined) {
      return this.#runState;
    }
    if (
      JSON.stringify(taint) === JSON.stringify(this.#runState.cfcWorkspaceTaint)
    ) {
      return this.#runState;
    }
    this.#runState = setHarnessWorkspaceTaint(
      this.#runState,
      taint,
      this.#runState.updatedAt,
    );
    return this.#runState;
  }

  /**
   * Establishes the run family's sandbox output directory, once per family.
   *
   * The ROOT run creates it and refuses a directory that is already there;
   * that refusal is the whole provenance claim, since a directory this family
   * did not create holds files it cannot account for. A delegated child does
   * not create one — it shares its parent's, established before the child
   * existed.
   *
   * A failure here is recorded, not thrown. The directory is what
   * `ingest_sandbox_file` reads from and nothing else depends on it, so a
   * workspace that is read-only, absent, or already holds one still runs
   * every other tool; what it loses is the ability to ingest, and the reason
   * travels to that refusal rather than ending the run. Ingest stays closed
   * either way: it reads only from a directory this family made.
   */
  async ensureSandboxOutputRoot(): Promise<void> {
    if (
      this.#sandboxOutputRoot !== undefined || this.#sandboxOutputRootFailure
    ) {
      return;
    }
    const hostPath = this.#sandboxOutputRootHostPath;
    if (hostPath === undefined) {
      this.#sandboxOutputRootFailure =
        "this run has nowhere to put one: the output directory is " +
        "deliberately outside every mount the sandbox can write, and neither " +
        "this run's artifact root nor a directory beside its workspace is";
      return;
    }
    const recorded = this.#runState.sandboxOutputRoot;
    // A record is data, not authority. The path a resume reads out of one
    // arrives from disk, and a record naming a directory the family layout
    // would never choose — inside the workspace, say — is self-consistent
    // about a directory that was never this family's. Where the directory
    // BELONGS is recomputed here by the same derivation creation uses, and
    // the record is only allowed to say which directory at that path it was.
    if (recorded !== undefined && recorded.hostPath !== hostPath) {
      this.#sandboxOutputRootFailure =
        `the run this resumes recorded its output directory at ` +
        `${recorded.hostPath}, which is not where this family's output ` +
        `directory goes (${hostPath}); nothing at the recorded path can be ` +
        `attributed to this family`;
      return;
    }
    try {
      // A run that already recorded one — a resume, or a delegated child
      // whose parent made it — restores it rather than making it again.
      // Creating would refuse its own directory as somebody else's; restoring
      // checks it is still the directory that was recorded.
      this.#sandboxOutputRoot = recorded !== undefined
        ? await restoreSandboxOutputRoot(recorded)
        : this.#runState.lineage?.role === "subagent"
        ? await restoreSandboxOutputRoot(
          await this.#familyRootFromDisk(hostPath),
        )
        : await createSandboxOutputRoot(hostPath, this.#familyRunId);
    } catch (error) {
      this.#sandboxOutputRootFailure = error instanceof Error
        ? error.message
        : String(error);
      return;
    }
    // Without advancing the run's clock: establishing the directory is setup
    // the run does before it does anything, and reading the clock here would
    // make every later timestamp depend on whether the run had one to make.
    this.#runState = patchHarnessRunState(
      this.#runState,
      { sandboxOutputRoot: this.#sandboxOutputRoot },
      this.#runState.updatedAt,
    );
    await this.persistRunState();
  }

  /**
   * A child's view of the directory its parent made: read from disk, because
   * the parent's identity record lives in the parent's run state and the
   * child shares only the path. Restoring it re-reads and re-checks, so what
   * the child ends up pinned to is what it can itself see.
   */
  async #familyRootFromDisk(
    hostPath: string,
  ): Promise<HarnessSandboxOutputRoot> {
    const found = await readSandboxOutputRootFromDisk(hostPath).catch(() =>
      undefined
    );
    if (found === undefined) {
      throw new Error(
        "the run family's output directory is missing, so this child cannot " +
          `write where its parent reads: ${hostPath}`,
      );
    }
    return found;
  }

  /**
   * The run family's harness directory, for handing to a delegated child so
   * it inherits this choice rather than making its own.
   */
  get familyDirHostPath(): string | undefined {
    return this.#familyDirHostPath;
  }

  /** Why this family cannot ingest, or `undefined` while it can. */
  get sandboxOutputRootFailure(): string | undefined {
    return this.#sandboxOutputRootFailure;
  }

  /**
   * The sandbox to hand a delegated child: the supplied runtime, without this
   * engine's instrumentation, which the child adds for itself.
   */
  get sandboxForDelegation(): SandboxRuntime {
    return this.#sandboxForDelegation;
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

  /**
   * Mints and records a handle consumable only as delegated skill context,
   * carrying `acquisition` as the entry's record of where the value came
   * from. Only a host step that performed the fetch can supply that record,
   * and it is what a later delegation's activation names.
   */
  async mintSkillContextHandle(
    ref: string,
    acquisition: HarnessSkillAcquisition,
  ): Promise<string> {
    const minted = await mintAddressHandle(
      this.handleTable ?? createHarnessHandleTable(this.#runState.runId),
      ref,
      { capability: "skill-context", acquisition },
    );
    await this.recordHandleTable(minted.table);
    return minted.token;
  }

  async persistRunState(): Promise<string | undefined> {
    return await this.artifactStore?.persistRunState(this.#syncFamilyTaint());
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
   * Establishes the run's task pattern references: resolves each id against
   * the pattern index, records the results in run state, and returns them.
   * Idempotent across resume, like the input cells: references already
   * recorded are returned as they stand.
   *
   * Failure is closed and loud for the same reason an input cell's is —
   * references are explicit caller configuration — so a run configured with
   * them and no index, an id outside the index's grammar, and an id the index
   * does not hold all throw before anything is recorded.
   */
  async establishPatternRefs(): Promise<HarnessPatternRef[]> {
    if (this.#runState.patternRefs !== undefined) {
      return structuredClone(this.#runState.patternRefs);
    }
    if (this.#patternRefs.length === 0) {
      return [];
    }
    if (this.#patternIndexClientFactory === undefined) {
      throw new Error(
        "patternRefs requires a pattern index; configure --pattern-index-url",
      );
    }
    const client = await this.#patternIndexClientFactory();
    const resolved = await resolvePatternRefs(client, this.#patternRefs);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { patternRefs: structuredClone(resolved) },
      this.#now(),
    );
    await this.persistRunState();
    return resolved;
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

  /**
   * Fails the run as `process_interrupted` when the process is going down
   * before its loop ended. A run that already has its outcome keeps it: the
   * signal raced the loop's own end, and the record stands as written.
   */
  async terminalizeInterruptedRun(
    signalName: string,
  ): Promise<HarnessRunState> {
    if (isTerminalHarnessRunStatus(this.#runState.status)) {
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
    return await this.failRun("process_interrupted");
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

  /**
   * Helper for `completeRun()` and `failRun()`, which reads the run's space
   * for what it holds about the cells the run touched and returns `state`
   * with the answer recorded on it and written beside the run.
   *
   * The run's own artifacts say which cells it made and read and what the
   * sandbox decided about each call; the space says what each of those cells
   * is labelled. Nothing else joins the two, so a reader working from the
   * tree alone sees an unlabelled cell whatever the run was enforcing. The
   * snapshot is that join, taken at the run's own space, over every cell the
   * handle table names — and taken as the run ends, once its cells are
   * settled, so the outcome and the labels reach the disk in one write and
   * whoever waits on the outcome finds the labels beside it.
   *
   * Read-only and best-effort by construction: the space database is opened
   * read-only, and a host that holds no copy of it yields an unavailable
   * snapshot rather than a failed run. What it must never do is yield a bare
   * one — "the space holds no label for this cell" and "nobody asked" are
   * different findings, and the snapshot's `status` is what keeps them apart.
   * A snapshot that could not be taken or written at all is a third finding,
   * recorded as a failure record on the run so a reader can tell it from a
   * run nobody asked about; the run's outcome stands either way.
   *
   * A run with no fabric session names no space and touches no cell, so it
   * takes no snapshot at all.
   */
  async #withCellLabels(
    state: HarnessRunState,
    now: string,
  ): Promise<HarnessRunState> {
    const space = this.config.fabricSession?.space;
    const refs = (state.handleTable?.entries ?? []).map((entry) => entry.ref);
    if (space === undefined || refs.length === 0) {
      return state;
    }
    try {
      // deno-lint-ignore cf-imports/no-inline-module-import -- costs at import time: reading a space database is the one thing the engine does through a native library, and a process that never takes a snapshot must not load one to run
      const { readSpaceCellLabels } = await import("./space-labels.ts");
      const cellLabels = await readSpaceCellLabels({
        space,
        ...(this.#spaceDbPath !== undefined
          ? { dbPath: this.#spaceDbPath }
          : {}),
        refs,
        generatedAt: now,
      });
      const cellLabelsPath = await this.artifactStore?.persistCellLabels?.(
        cellLabels,
      );
      return patchHarnessRunState(state, { cellLabels, cellLabelsPath }, now);
    } catch (error) {
      return appendHarnessFailureRecord(
        state,
        createHarnessFailureRecord({
          kind: "harness_error",
          source: "cell_labels",
          detail: `cell label snapshot failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          at: now,
        }),
        now,
      );
    }
  }

  /**
   * Fails fast before any sandbox execution under enforcement on a sandbox
   * that lacks the CFC sidecar transports — capability probes included, since
   * they run scripts inside the same sandbox (not just builtin tools). Checked
   * at run start rather than construction so an engine can be built and
   * inspected (config threading, `--describe-capabilities`) without a live CFC
   * wiring. Idempotent so the cost is paid once per run.
   */
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

  /**
   * Runs one builtin tool and records its output on the run. A tool call is
   * one step of a run, not the run: the run's status is the driver's to
   * write, and this touches neither it nor `endedAt`. A tool that throws is
   * recorded as a failure and rethrown for the driver to end the run on.
   *
   * @throws Error from the tool, after the failure is recorded.
   */
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
    // Before the tool runs, so a sandbox invocation writes into a directory
    // this family established rather than one it found. The prompt loop
    // establishes it at family start; this covers an engine driven directly.
    await this.ensureSandboxOutputRoot();
    try {
      const output = await tool.invoke(
        this.#createToolContext(options.signal),
        input,
      ) as BuiltinToolOutputMap[TToolId];
      return await this.recordBuiltinToolOutput(toolId, input, output);
    } catch (error) {
      const failureTime = this.#now();
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
      this.#runState,
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

  /**
   * Whether `path` is the run family's output directory or something inside
   * it.
   *
   * The reservation that keeps tools out of the run's own artifacts must not
   * keep them out of the one directory the run exists to have them write
   * into. That reservation protects the record a run writes ABOUT itself;
   * this directory is the run's output, and the model is told to put files
   * there by name. It matters only when the two overlap — the family's
   * directory sits under the artifact root when that is outside every
   * writable mount, and beside the workspace when it is not — and the
   * exemption is stated for the directory itself rather than for a layout.
   */
  #isWithinSandboxOutputRoot(path: string): boolean {
    const root = this.#sandboxOutputRootHostPath;
    if (root === undefined) {
      return false;
    }
    const normalizedRoot = normalizeHostPath(root);
    const normalizedPath = normalizeHostPath(path);
    return normalizedPath === normalizedRoot ||
      isHostPathWithinRoot(normalizedRoot, normalizedPath);
  }

  async #isHostPathWithinArtifactRoot(
    path: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    const root = this.artifactStore?.artifactRoot;
    if (root === undefined || this.#isWithinSandboxOutputRoot(path)) {
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
    if (root === undefined || this.#isWithinSandboxOutputRoot(path)) {
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
      workspaceTaint: this.workspaceTaint,
      ...(this.#sandboxOutputRoot !== undefined
        ? { sandboxOutputRoot: this.#sandboxOutputRoot }
        : {}),
      ...(this.#sandboxOutputRootFailure !== undefined
        ? { sandboxOutputRootFailure: this.#sandboxOutputRootFailure }
        : {}),
      sandboxOutputMountPath: SANDBOX_OUTPUT_MOUNT_PATH,
      ...(this.#fabricSessionFactory !== undefined
        ? { getFabricSession: this.#fabricSessionFactory }
        : {}),
      ...(this.#openProbeRuntime !== undefined
        ? { openProbeRuntime: this.#openProbeRuntime }
        : {}),
      ...(this.#patternIndexClientFactory !== undefined
        ? {
          getPatternIndexClient: this.#patternIndexClientFactory,
          patternIndexPublishEnabled: this.patternIndexPublishEnabled,
          patternIndexPublishDiscoverable: this.patternIndexPublishDiscoverable,
          patternIndexPublications: this.patternIndexPublications,
        }
        : {}),
      ...(this.docsCorpusAvailable
        ? { getDocsCorpus: () => this.getDocsCorpus() }
        : {}),
      ...(this.#exploreQueryRunner !== undefined
        ? { runExploreQuery: this.#exploreQueryRunner }
        : {}),
      ...(this.#skillsShSearchClientFactory !== undefined
        ? { getSkillsShSearchClient: this.#skillsShSearchClientFactory }
        : {}),
      ...(this.#skillsShAcquisitionClientFactory !== undefined
        ? {
          getSkillsShAcquisitionClient: this.#skillsShAcquisitionClientFactory,
        }
        : {}),
      mintSkillContextHandle: (
        ref: string,
        acquisition: HarnessSkillAcquisition,
      ) => this.mintSkillContextHandle(ref, acquisition),
      ...(this.#taskText !== undefined ? { taskText: this.#taskText } : {}),
      sandbox: this.sandbox,
      hostProcessRunner: this.hostProcessRunner,
      loomAuthoring: this.config.loomAuthoring,
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
