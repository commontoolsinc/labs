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
  type ConsoleRunLens,
  consoleRunLens,
  type ConsoleRunSummary,
  sortConsoleRuns,
  summarizeConsoleRun,
} from "./runs.ts";
import {
  type ConsoleHandle,
  consoleRunHandles,
  consoleRunSteps,
  type ConsoleStep,
} from "./steps.ts";
import {
  type ConsoleGraph,
  type ConsoleGraphRunInput,
  consoleRunFamilyGraph,
} from "./graph.ts";

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
export interface ConsoleRunDetail {
  summary: ConsoleRunSummary;
  runState: HarnessRunState;
  transcript: readonly HarnessTranscriptMessage[];
  lens: ConsoleRunLens;
  /** The run as a timeline, which is what the step scrubber reads. */
  steps: readonly ConsoleStep[];
  /** Every handle the run introduced, resolved against its own table. */
  handles: readonly ConsoleHandle[];
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

/**
 * The call this output belongs to. The artifact store names a file for its
 * output id and the tool that wrote it, `<run-id>_<tool>_<sequence>-<tool>`,
 * with the id's separators rewritten — so the sequence is the digits before
 * the trailing tool name, and the leading run id may carry digits and hyphens
 * of its own. The last such group is therefore the one that counts. A name of
 * some other shape sorts after every call rather than in among them.
 */
const toolOutputSequence = (name: string): number => {
  let sequence: number | undefined;
  for (const match of name.matchAll(/_(\d+)-/g)) {
    sequence = Number(match[1]);
  }
  return sequence ?? Number.MAX_SAFE_INTEGER;
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
  // The sequence a name carries counts every call the run made, whichever tool
  // made it, so it is the run's own order and the only thing worth sorting on:
  // the name leads with the tool, and sorting on that groups a mixed run by
  // tool instead of laying it out as it happened.
  return names.sort((left, right) => {
    const bySequence = toolOutputSequence(left) - toolOutputSequence(right);
    return bySequence !== 0
      ? bySequence
      : left.localeCompare(right, undefined, { numeric: true });
  });
};

/** Every run under the artifact root, most recently touched first. */
export const listConsoleRuns = async (
  artifactRoot: string,
): Promise<readonly ConsoleRunSummary[]> => {
  const summaries: ConsoleRunSummary[] = [];
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
      summaries.push(summarizeConsoleRun(runState, transcript));
    }
  } catch {
    // No run has been made yet, so there is no tree to list.
    return [];
  }
  return sortConsoleRuns(summaries);
};

/** One run read whole, or `undefined` when the artifact root holds no such run. */
export const readConsoleRun = async (
  artifactRoot: string,
  runId: string,
): Promise<ConsoleRunDetail | undefined> => {
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
  const steps = consoleRunSteps(
    transcript,
    runState.policyDecisions ?? [],
    runState.policyEvents,
    runState.cfcInvocationContexts ?? [],
  );
  return {
    summary: summarizeConsoleRun(runState, transcript),
    runState,
    transcript,
    lens: consoleRunLens(transcript),
    steps,
    handles: consoleRunHandles(steps, runState.handleTable),
    artifactNames: await namesPresent(root, RUN_ARTIFACT_NAMES),
    toolOutputNames: await toolOutputNames(root),
  };
};

/**
 * The data-flow graph of a run and the `delegate_task` children beneath it.
 *
 * The family rather than the run alone, because that is where the routing
 * lives: a parent commonly names a cell its child produced, and a graph drawn
 * per run shows that cell arriving from nowhere. A subagent run asked for
 * directly graphs its own subtree, which is what someone who opened a child
 * asked to see.
 *
 * Descendants are found by name — the harness ids a child `<parent>.subagent.N`
 * — so this reads one directory listing rather than every run's state.
 */
export const readConsoleRunFamilyGraph = async (
  artifactRoot: string,
  runId: string,
): Promise<ConsoleGraph | undefined> => {
  const root = await readConsoleRun(artifactRoot, runId);
  if (root === undefined) {
    return undefined;
  }
  const descendants: ConsoleGraphRunInput[] = [];
  try {
    for await (const entry of Deno.readDir(artifactRoot)) {
      if (!entry.isDirectory || !entry.name.startsWith(`${runId}.`)) {
        continue;
      }
      const child = await readConsoleRun(artifactRoot, entry.name);
      if (child !== undefined) {
        descendants.push({
          runId: entry.name,
          steps: child.steps,
          handles: child.handles,
        });
      }
    }
  } catch {
    // A run with no siblings on disk is a family of one.
  }
  const neighbours = await neighbouringHandles(artifactRoot);
  // A run's own table wins, so it is appended last.
  const withNeighbours = (run: ConsoleGraphRunInput): ConsoleGraphRunInput => ({
    ...run,
    handles: [...neighbours, ...run.handles],
  });
  return consoleRunFamilyGraph(
    withNeighbours({ runId, steps: root.steps, handles: root.handles }),
    descendants.map(withNeighbours),
  );
};

/**
 * Every handle any run on disk minted, by token.
 *
 * A handle table is salted per run, so a token minted in one turn resolves to
 * nothing in the next turn's table — and a later turn that wires the earlier
 * turn's cell by link would draw two nodes for the one cell. Reading the
 * neighbours' tables lets the token resolve to the address it always stood
 * for, which is what merges them.
 *
 * The salt makes a token effectively unique to the run that minted it, so a
 * token meaning two addresses across runs would be a coincidence rather than
 * the ordinary case; a run's own table is consulted first regardless.
 */
const neighbouringHandles = async (
  artifactRoot: string,
): Promise<ConsoleHandle[]> => {
  const handles: ConsoleHandle[] = [];
  try {
    for await (const entry of Deno.readDir(artifactRoot)) {
      if (!entry.isDirectory || !isSafeSegment(entry.name)) {
        continue;
      }
      const runState = await readJson<HarnessRunState>(
        join(artifactRoot, entry.name, "run-state.json"),
      );
      for (const entryHandle of runState?.handleTable?.entries ?? []) {
        handles.push({
          token: entryHandle.token,
          ref: entryHandle.ref,
          addressKey: entryHandle.addressKey,
          introducedAtStep: 0,
        });
      }
    }
  } catch {
    // No neighbours to read is simply no extra resolution.
  }
  return handles;
};

/**
 * One artifact of a run, as its own text, for the pane that shows a run's raw
 * JSON. Only the names a run is known to write are readable — an arbitrary
 * name is refused rather than resolved, so this route reads run artifacts and
 * nothing else on the host.
 */
export const readConsoleRunArtifact = async (
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
export const readConsoleToolOutput = async (
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
