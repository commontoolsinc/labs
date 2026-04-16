import { ensureDir } from "@std/fs";
import { basename, dirname, join } from "@std/path";
import type { HarnessRunState } from "./run-state.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import type { ToolOutputId } from "./contracts/tool-result.ts";

const sanitizeArtifactName = (input: string): string =>
  input.replace(/[^A-Za-z0-9._-]+/g, "_");

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
    this.artifactRoot = options.artifactRoot;
    this.runRoot = join(options.artifactRoot, options.runId);
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

export const readHarnessRunState = async (
  path: string,
): Promise<HarnessRunState> =>
  JSON.parse(await Deno.readTextFile(path)) as HarnessRunState;

export const readHarnessTranscript = async (
  path: string,
): Promise<HarnessTranscriptMessage[]> =>
  JSON.parse(await Deno.readTextFile(path)) as HarnessTranscriptMessage[];

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
  const transcriptPath = runState.transcriptPath ?? paths.transcriptPath;
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
