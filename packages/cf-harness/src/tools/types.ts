import type {
  CfcEnforcementMode,
  CfcLabelView,
} from "@commonfabric/runner/cfc";
import type {
  HarnessCfcInvocationContext,
  HarnessCfcInvocationInputLabelPath,
  HarnessCfcInvocationOperation,
} from "../contracts/cfc-invocation-context.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillAcquisition,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
  HarnessSkillScriptExecution,
  HarnessSkillScriptExecutionTarget,
} from "../contracts/skill.ts";
import type { HarnessBrowserAccessLease } from "../contracts/browser-access.ts";
import type { HarnessDocsCorpus } from "../docs-corpus/corpus.ts";
import type { HarnessExploreQueryRunner } from "../docs-corpus/explore.ts";
import type { HarnessHandleTable } from "../contracts/handle-table.ts";
import type { HarnessFabricSession } from "../fabric-session.ts";
import type { openProbeRuntime } from "../pattern-index/probe-runtime.ts";
import type { PatternIndexClient } from "../pattern-index/client.ts";
import type { PatternIndexPublicationLedger } from "../pattern-index/publish-ledger.ts";
import type { SkillsShAcquisitionClient } from "../skills-sh/acquisition.ts";
import type { SkillsShSearchClient } from "../skills-sh/search-client.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { ToolOutputId } from "../contracts/tool-result.ts";
import type { ProcessRunner } from "../sandbox/process-runner.ts";
import type { SandboxRuntime } from "../sandbox/types.ts";

export interface HarnessToolContext {
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  skillRegistry?: HarnessSkillRegistry;
  skillActivations?: HarnessSkillActivations;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;

  /**
   * Origins a value materialized from a handle may be sent to. Absent or
   * empty means none: materialization is default-deny by destination, and a
   * tool that would send a handle's value somewhere refuses rather than
   * asking the model where it meant.
   */
  handleValueOrigins?: readonly string[];

  /**
   * The run's handle table, as it stands at the invocation. Undefined until
   * the run mints its first handle. `describe_handle` reads it directly, and
   * value-handle consumers use it to prove membership and enforce entry
   * capabilities. Ordinary tool inputs see general tokens resolved to
   * addresses by the prompt loop; restricted tokens remain opaque.
   */
  handleTable?: HarnessHandleTable;

  /**
   * The run's trusted Fabric session, lazy and cached by the engine.
   * Undefined when the run has no fabric session configured, which also
   * keeps `run_pattern` and `acquire_skill` out of the tool surface.
   */
  getFabricSession?: () => Promise<HarnessFabricSession>;

  /**
   * Opens the render gate's probe runtime; `openProbeRuntime` by default. A
   * test replaces it to see what the gate opens the probe under.
   */
  openProbeRuntime?: typeof openProbeRuntime;

  /**
   * The run's pattern-index client, lazy and cached by the engine.
   * Undefined when the run has no pattern index configured, which also keeps
   * `search_patterns` and `record_feedback` out of the tool surface and
   * `run_pattern`'s `patternId` argument unusable.
   */
  getPatternIndexClient?: () => Promise<PatternIndexClient>;

  /**
   * The run's documentation corpus, lazy and cached by the engine. Undefined
   * when the run configures no corpus root, which also keeps `query_docs` out
   * of the tool surface.
   */
  getDocsCorpus?: () => Promise<HarnessDocsCorpus>;

  /**
   * Answers one documentation question out of the sections the tool selected,
   * on the trusted host side. The tool holds the corpus and the caller's
   * question; this holds the model. Undefined for an invocation outside a
   * prompt loop, which has no model to spend.
   */
  runExploreQuery?: HarnessExploreQueryRunner;

  /**
   * The run's skills.sh discovery client, lazy and cached by the engine.
   * Undefined when no remote skill registry is configured, which also keeps
   * `search_skills` out of the tool surface.
   */
  getSkillsShSearchClient?: () => Promise<SkillsShSearchClient>;

  /**
   * The run's host-side pinned acquisition client. Undefined when external
   * skill acquisition is not configured, which keeps `acquire_skill` absent.
   */
  getSkillsShAcquisitionClient?: () => Promise<SkillsShAcquisitionClient>;

  /**
   * Mints the sole capability that may enter delegate_task.skillHandle,
   * recording where the caller fetched the value from. The provenance is
   * mandatory because the mint is reachable only from the acquisition step,
   * which always knows it, and an entry without it could name no commit when
   * the handle is later delegated.
   */
  mintSkillContextHandle?(
    ref: string,
    acquisition: HarnessSkillAcquisition,
  ): Promise<string>;

  /**
   * Whether a pattern the model authored and ran successfully is published
   * back to the index. Absent or `false` makes the run a reader of the index
   * only; the client is still there, since a run that does not publish still
   * searches, runs, and votes.
   */
  patternIndexPublishEnabled?: boolean;

  /**
   * Whether a successful authored pattern is offered to search immediately.
   * Absent or `false` records it without making it discoverable.
   */
  patternIndexPublishDiscoverable?: boolean;

  /**
   * Where a pattern this run authored is held until the session ends. The
   * ledger publishes once per capability rather than once per successful run
   * — see `pattern-index/publish-ledger.ts`. Absent when the run has no
   * index, and absent for a tool invoked outside the engine, which publishes
   * as it goes instead.
   */
  patternIndexPublications?: PatternIndexPublicationLedger;

  /**
   * What this run was asked to do, in the words it was asked in. A published
   * pattern carries it as the request it answers, which is what the index
   * ranks a later search against. Absent when the run has no such text.
   */
  taskText?: string;

  /**
   * The prompt loop's run-level abort signal, when the invocation came
   * through the loop. The only cancellation source a tool may honor — no
   * tool-side timeout supplements it. Tools are free to ignore it.
   */
  signal?: AbortSignal;

  sandbox: SandboxRuntime;
  hostProcessRunner: ProcessRunner;
  currentDir: string;
  workspaceHostPath?: string;
  resolvePath(path: string): string;
  resolveHostPath(path: string): string;
  resolveHostRootPath(path: string): string;
  hostPathToWorkspacePath(path: string): string | undefined;
  isHostPathWithinWorkspace(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  isHostPathWithinArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;

  /**
   * Host directory for image-attachment snapshots (under the artifact
   * root). Undefined when the run has no artifact store; attachments then
   * stay locked to their source file's bytes.
   */
  imageAttachmentSnapshotDir?: string;

  doesHostPathIntersectArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  setCurrentDir(path: string): void;
  nextOutputId(toolId: string): ToolOutputId;
  now(): string;
  recordSkillResourceRead(read: HarnessSkillResourceRead): Promise<void>;
  recordSkillScriptExecution(
    execution: HarnessSkillScriptExecution,
  ): Promise<void>;
  createCfcInvocationContext(options: {
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
  }): Promise<HarnessCfcInvocationContext>;
}

export interface HarnessToolDefinition<Input = unknown, Output = unknown> {
  descriptor: HarnessToolDescriptor;
  invoke(context: HarnessToolContext, input: Input): Promise<Output>;
}

export const createUnimplementedToolError = (toolId: string): Error =>
  new Error(`${toolId} is not implemented yet`);
