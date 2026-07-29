import * as path from "@std/path";
import { copy } from "@std/fs";
import { parse as parseJsonc } from "@std/jsonc";

const dirname = import.meta.dirname as string;
const CLI_PATH = path.join(dirname, "..", "cli.ts");
const DenoWebTestCache: Map<string, Promise<Deno.CommandOutput>> = new Map();
const encoder = new TextEncoder();
const TASK_PREFIX = encoder.encode("Task ");
const DOWNLOAD_HTTP_PREFIX = encoder.encode("Download http://");
const DOWNLOAD_HTTPS_PREFIX = encoder.encode("Download https://");

function startsWithBytes(
  value: Uint8Array,
  prefix: Uint8Array,
  offset: number,
): boolean {
  if (offset + prefix.length > value.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (value[offset + i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function stripDenoDownloadDiagnostics(
  stderr: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const taskLineEnd = stderr.indexOf(0x0a);
  if (
    taskLineEnd === -1 ||
    !startsWithBytes(stderr, TASK_PREFIX, 0)
  ) {
    return stderr;
  }

  const downloadsStart = taskLineEnd + 1;
  let downloadsEnd = downloadsStart;
  while (
    startsWithBytes(stderr, DOWNLOAD_HTTP_PREFIX, downloadsEnd) ||
    startsWithBytes(stderr, DOWNLOAD_HTTPS_PREFIX, downloadsEnd)
  ) {
    const lineEnd = stderr.indexOf(0x0a, downloadsEnd);
    downloadsEnd = lineEnd === -1 ? stderr.length : lineEnd + 1;
  }

  if (downloadsEnd === downloadsStart) {
    return stderr;
  }

  const filtered = new Uint8Array(
    stderr.length - (downloadsEnd - downloadsStart),
  );
  filtered.set(stderr.subarray(0, downloadsStart));
  filtered.set(stderr.subarray(downloadsEnd), downloadsStart);
  return filtered;
}

export function sanitizeDenoWebTestOutput(
  output: Deno.CommandOutput,
): Deno.CommandOutput {
  return {
    ...output,
    stderr: stripDenoDownloadDiagnostics(output.stderr),
  };
}

// Runs deno-web-test in `projectDir` and caches
// the results for multiple test usages.
//
// Due to running within a workspace, these test subprojects
// need to be workspace members in order to run deno tasks.
// This is untenable, so move the test package to a temp dir
// before running tests.
export const runDenoWebTest = async (
  projectDir: string,
): Promise<Deno.CommandOutput> => {
  const fromCache = DenoWebTestCache.get(projectDir);
  if (fromCache) {
    return fromCache;
  }

  // Copy over test project to temp directory.
  const tmp = await Deno.makeTempDir();
  const projectPath = path.join(dirname, projectDir);
  const tmpProjectPath = path.join(tmp, projectDir);
  await copy(projectPath, tmpProjectPath);

  // Overwrite the test project's "test" task with the
  // absolute path of deno-web-test's `cli.ts` export.
  const manifestPath = path.join(tmpProjectPath, "deno.jsonc");
  const manifest = parseJsonc(await Deno.readTextFile(manifestPath)) as {
    tasks: { test: string };
  };
  manifest.tasks.test =
    `deno run --allow-env --allow-read --allow-write --allow-run --allow-net ${CLI_PATH} *.test.ts`;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

  // Populate the cache for the harness and each test entrypoint before the task.
  const testEntrypoints = [...Deno.readDirSync(tmpProjectPath)]
    .filter((entry) => entry.isFile && entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(tmpProjectPath, entry.name))
    .sort();
  const { success: installSuccess } = await new Deno.Command(Deno.execPath(), {
    args: [
      "install",
      "--entrypoint",
      CLI_PATH,
      ...testEntrypoints,
    ],
    cwd: tmpProjectPath,
  }).output();
  if (!installSuccess) {
    throw new Error("Failed to run `deno install`");
  }

  const output = new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "test",
    ],
    cwd: tmpProjectPath,
  }).output().then(sanitizeDenoWebTestOutput);
  DenoWebTestCache.set(projectDir, output);
  return output;
};
