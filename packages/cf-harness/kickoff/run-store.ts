/**
 * Reading the run artifacts a turn left behind. The harness writes each run to
 * `<artifact-root>/<run-id>/`, and this is the only thing that opens that tree
 * for the page: a run id and a tool-output name both arrive from a URL, so
 * both are checked against a path segment here rather than trusted into a
 * `join`.
 */

import { join } from "@std/path";
import type { HarnessRunState } from "../src/run-state.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import {
  type KickoffRunLens,
  kickoffRunLens,
  type KickoffRunSummary,
  sortKickoffRuns,
  summarizeKickoffRun,
} from "./runs.ts";
import {
  type KickoffHandle,
  kickoffRunHandles,
  kickoffRunSteps,
  type KickoffStep,
} from "./steps.ts";

/**
 * A single path segment of the characters the artifact store itself writes.
 * Anything else — a separator, a dot segment, an empty string — names
 * something outside the run tree and is refused rather than resolved.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const isSafeSegment = (segment: string): boolean =>
  SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..";

/** The run directory, or `undefined` for a name that is not one. */
const runRoot = (
  artifactRoot: string,
  runId: string,
): string | undefined =>
  isSafeSegment(runId) ? join(artifactRoot, runId) : undefined;

const readJson = async <Value>(path: string): Promise<Value | undefined> => {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Value;
  } catch {
    // A run still being written, or one whose optional artifact was never
    // produced, is a run to describe from what it does have.
    return undefined;
  }
};

/** Everything `/api/runs/<run-id>` answers with. */
export interface KickoffRunDetail {
  summary: KickoffRunSummary;
  runState: HarnessRunState;
  transcript: readonly HarnessTranscriptMessage[];
  lens: KickoffRunLens;
  /** The run as a timeline, which is what the step scrubber reads. */
  steps: readonly KickoffStep[];
  /** Every handle the run introduced, resolved against its own table. */
  handles: readonly KickoffHandle[];
  /** The artifacts this run wrote, by name, for the raw pane to fetch. */
  artifactNames: readonly string[];
  /** The files under `tool-outputs/`, newest call last. */
  toolOutputNames: readonly string[];
}

/**
 * The named artifacts a run root holds, other than its tool outputs. Each is
 * optional: a run that failed before it wrote one is still a run to read.
 */
const RUN_ARTIFACT_NAMES = [
  "run-state.json",
  "transcript.json",
  "run-report.json",
  "run-manifest.json",
  "policy-snapshot.json",
  "policy-trace.json",
  "capabilities.json",
  "skill-registry.json",
  "skill-activations.json",
  "skill-resource-reads.json",
  "skill-script-executions.json",
] as const;

const namesPresent = async (
  root: string,
  candidates: readonly string[],
): Promise<string[]> => {
  const present: string[] = [];
  for (const name of candidates) {
    try {
      const info = await Deno.stat(join(root, name));
      if (info.isFile) {
        present.push(name);
      }
    } catch {
      // Absent, which is the ordinary case for most of them.
    }
  }
  return present;
};

const toolOutputNames = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(root, "tool-outputs"))) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        names.push(entry.name);
      }
    }
  } catch {
    // A run that called no tool wrote no directory.
  }
  // The output id leads each name and carries the call's sequence, so sorting
  // by name is sorting by the order the run made the calls — except that the
  // sequence is not zero-padded, so a run with ten calls would otherwise put
  // the tenth before the second.
  return names.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true })
  );
};

/** Every run under the artifact root, most recently touched first. */
export const listKickoffRuns = async (
  artifactRoot: string,
): Promise<readonly KickoffRunSummary[]> => {
  const summaries: KickoffRunSummary[] = [];
  try {
    // `Deno.readDir` reports a missing directory on its first step rather than
    // at the call, so an artifact root that no run has been written to yet is
    // caught around the walk rather than around the call.
    for await (const entry of Deno.readDir(artifactRoot)) {
      if (!entry.isDirectory || !isSafeSegment(entry.name)) {
        continue;
      }
      const root = join(artifactRoot, entry.name);
      const runState = await readJson<HarnessRunState>(
        join(root, "run-state.json"),
      );
      if (runState === undefined) {
        continue;
      }
      const transcript = await readJson<HarnessTranscriptMessage[]>(
        join(root, "transcript.json"),
      ) ??
        [];
      summaries.push(summarizeKickoffRun(runState, transcript));
    }
  } catch {
    // No run has been made yet, so there is no tree to list.
    return [];
  }
  return sortKickoffRuns(summaries);
};

/** One run read whole, or `undefined` when the artifact root holds no such run. */
export const readKickoffRun = async (
  artifactRoot: string,
  runId: string,
): Promise<KickoffRunDetail | undefined> => {
  const root = runRoot(artifactRoot, runId);
  if (root === undefined) {
    return undefined;
  }
  const runState = await readJson<HarnessRunState>(
    join(root, "run-state.json"),
  );
  if (runState === undefined) {
    return undefined;
  }
  const transcript =
    await readJson<HarnessTranscriptMessage[]>(join(root, "transcript.json")) ??
      [];
  const steps = kickoffRunSteps(
    transcript,
    runState.policyDecisions ?? [],
    runState.policyEvents,
    runState.cfcInvocationContexts ?? [],
  );
  return {
    summary: summarizeKickoffRun(runState, transcript),
    runState,
    transcript,
    lens: kickoffRunLens(transcript),
    steps,
    handles: kickoffRunHandles(steps, runState.handleTable),
    artifactNames: await namesPresent(root, RUN_ARTIFACT_NAMES),
    toolOutputNames: await toolOutputNames(root),
  };
};

/**
 * One artifact of a run, as its own text, for the pane that shows a run's raw
 * JSON. Only the names a run is known to write are readable — an arbitrary
 * name is refused rather than resolved, so this route reads run artifacts and
 * nothing else on the host.
 */
export const readKickoffRunArtifact = async (
  artifactRoot: string,
  runId: string,
  name: string,
): Promise<string | undefined> => {
  const root = runRoot(artifactRoot, runId);
  if (
    root === undefined || !isSafeSegment(name) ||
    !(RUN_ARTIFACT_NAMES as readonly string[]).includes(name)
  ) {
    return undefined;
  }
  try {
    return await Deno.readTextFile(join(root, name));
  } catch {
    return undefined;
  }
};

/**
 * One tool output, untruncated. This is the payload the feed shows elided and
 * the model itself read in full, which is the whole reason the inspector
 * exists.
 */
export const readKickoffToolOutput = async (
  artifactRoot: string,
  runId: string,
  name: string,
): Promise<string | undefined> => {
  const root = runRoot(artifactRoot, runId);
  if (root === undefined || !isSafeSegment(name) || !name.endsWith(".json")) {
    return undefined;
  }
  try {
    return await Deno.readTextFile(join(root, "tool-outputs", name));
  } catch {
    return undefined;
  }
};
