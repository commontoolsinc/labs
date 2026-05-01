import { ensureDir } from "@std/fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import type { HarnessRunState } from "./run-state.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import type { HarnessPolicyTrace } from "./contracts/policy-trace.ts";
import { createHarnessPolicyEvent } from "./contracts/policy.ts";
import type { HarnessRunManifest } from "./contracts/run-manifest.ts";
import type { HarnessRunReport } from "./contracts/run-report.ts";
import type {
  HarnessSkillActivations,
  HarnessSkillRegistry,
} from "./contracts/skill.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import type { ToolOutputId } from "./contracts/tool-result.ts";
import type { HarnessCapabilitySnapshot } from "./diagnostics.ts";

const sanitizeArtifactName = (input: string): string =>
  input.replace(/[^A-Za-z0-9._-]+/g, "_");

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const assertValidRunId = (runId: string): string => {
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new Error(
      "runId must be a simple path segment containing only letters, numbers, dots, underscores, or hyphens",
    );
  }
  return runId;
};

const isPathWithinRoot = (path: string, root: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== ".." &&
      !isAbsolute(relativePath));
};

const resolveTranscriptPathWithinRunRoot = (
  runRoot: string,
  transcriptPath: string | undefined,
  fallbackPath: string,
): string => {
  if (transcriptPath === undefined) {
    return fallbackPath;
  }
  const resolvedRunRoot = resolve(runRoot);
  const resolvedTranscriptPath = resolve(transcriptPath);
  return isPathWithinRoot(resolvedTranscriptPath, resolvedRunRoot)
    ? resolvedTranscriptPath
    : fallbackPath;
};

const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

export interface HarnessArtifactStore {
  readonly artifactRoot: string;
  readonly runRoot: string;
  persistRunState(state: HarnessRunState): Promise<string>;
  persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string>;
  persistCapabilitySnapshot(
    snapshot: HarnessCapabilitySnapshot,
  ): Promise<string>;
  persistCfcPolicySnapshot(
    snapshot: HarnessCfcPolicySnapshot,
  ): Promise<string>;
  persistPolicyTrace?(
    trace: HarnessPolicyTrace,
  ): Promise<string>;
  persistRunReport(
    report: HarnessRunReport,
  ): Promise<string>;
  persistRunManifest?(manifest: HarnessRunManifest): Promise<string>;
  persistSkillRegistry?(
    registry: HarnessSkillRegistry,
  ): Promise<string>;
  persistSkillActivations?(
    activations: HarnessSkillActivations,
  ): Promise<string>;
  persistToolOutput(
    toolId: string,
    outputId: ToolOutputId,
    output: unknown,
  ): Promise<string>;
}

export interface FileSystemHarnessArtifactStoreOptions {
  artifactRoot: string;
  runId: string;
}

export class FileSystemHarnessArtifactStore implements HarnessArtifactStore {
  readonly artifactRoot: string;
  readonly runRoot: string;

  constructor(options: FileSystemHarnessArtifactStoreOptions) {
    this.artifactRoot = resolve(options.artifactRoot);
    this.runRoot = join(this.artifactRoot, assertValidRunId(options.runId));
  }

  async persistRunState(state: HarnessRunState): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "run-state.json");
    await writeJsonFile(path, state);
    return path;
  }

  async persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "transcript.json");
    await writeJsonFile(path, transcript);
    return path;
  }

  async persistCapabilitySnapshot(
    snapshot: HarnessCapabilitySnapshot,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "capabilities.json");
    await writeJsonFile(path, snapshot);
    return path;
  }

  async persistCfcPolicySnapshot(
    snapshot: HarnessCfcPolicySnapshot,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "policy-snapshot.json");
    await writeJsonFile(path, snapshot);
    return path;
  }

  async persistPolicyTrace(
    trace: HarnessPolicyTrace,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "policy-trace.json");
    await writeJsonFile(path, trace);
    return path;
  }

  async persistRunReport(
    report: HarnessRunReport,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "run-report.json");
    await writeJsonFile(path, report);
    return path;
  }

  async persistRunManifest(manifest: HarnessRunManifest): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "run-manifest.json");
    await writeJsonFile(path, manifest);
    return path;
  }

  async persistSkillRegistry(
    registry: HarnessSkillRegistry,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "skill-registry.json");
    await writeJsonFile(path, registry);
    return path;
  }

  async persistSkillActivations(
    activations: HarnessSkillActivations,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "skill-activations.json");
    await writeJsonFile(path, activations);
    return path;
  }

  async persistToolOutput(
    toolId: string,
    outputId: ToolOutputId,
    output: unknown,
  ): Promise<string> {
    const directory = join(this.runRoot, "tool-outputs");
    await ensureDir(directory);
    const path = join(
      directory,
      `${sanitizeArtifactName(`${String(outputId)}-${toolId}`)}.json`,
    );
    await writeJsonFile(path, output);
    return path;
  }
}

export const createFileSystemHarnessArtifactStore = (
  options: FileSystemHarnessArtifactStoreOptions,
): FileSystemHarnessArtifactStore =>
  new FileSystemHarnessArtifactStore(options);

const normalizeHarnessRunState = (
  state: HarnessRunState,
): HarnessRunState => ({
  ...state,
  policyEvents: (state.policyEvents ?? []).map((event) =>
    event.type === "cf-harness.policy-event"
      ? event
      : createHarnessPolicyEvent(event)
  ),
  toolOutputs: [...(state.toolOutputs ?? [])],
  ...(state.policyDecisions !== undefined
    ? { policyDecisions: [...state.policyDecisions] }
    : {}),
  ...(state.subagentRuns !== undefined
    ? { subagentRuns: [...state.subagentRuns] }
    : {}),
  failureRecords: [...(state.failureRecords ?? [])],
});

export const readHarnessRunState = async (
  path: string,
): Promise<HarnessRunState> =>
  normalizeHarnessRunState(
    JSON.parse(await Deno.readTextFile(path)) as HarnessRunState,
  );

export const readHarnessTranscript = async (
  path: string,
): Promise<HarnessTranscriptMessage[]> =>
  JSON.parse(await Deno.readTextFile(path)) as HarnessTranscriptMessage[];

export const readHarnessRunReport = async (
  path: string,
): Promise<HarnessRunReport> =>
  JSON.parse(await Deno.readTextFile(path)) as HarnessRunReport;

export interface HarnessRunArtifacts {
  runRoot: string;
  runStatePath: string;
  transcriptPath?: string;
  runState: HarnessRunState;
  transcript?: HarnessTranscriptMessage[];
}

export const resolveHarnessRunPaths = (
  input: string,
): {
  runRoot: string;
  runStatePath: string;
  transcriptPath: string;
} => {
  const runStatePath = basename(input) === "run-state.json"
    ? input
    : join(input, "run-state.json");
  const runRoot = dirname(runStatePath);
  return {
    runRoot,
    runStatePath,
    transcriptPath: join(runRoot, "transcript.json"),
  };
};

export const readHarnessRunArtifacts = async (
  input: string,
): Promise<HarnessRunArtifacts> => {
  const paths = resolveHarnessRunPaths(input);
  const runState = await readHarnessRunState(paths.runStatePath);
  const transcriptPath = resolveTranscriptPathWithinRunRoot(
    paths.runRoot,
    runState.transcriptPath,
    paths.transcriptPath,
  );
  let transcript: HarnessTranscriptMessage[] | undefined;
  try {
    transcript = await readHarnessTranscript(transcriptPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return {
    runRoot: paths.runRoot,
    runStatePath: paths.runStatePath,
    ...(transcript !== undefined ? { transcriptPath } : {}),
    runState,
    ...(transcript !== undefined ? { transcript } : {}),
  };
};
