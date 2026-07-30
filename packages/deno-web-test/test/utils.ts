import * as path from "@std/path";
import { copy } from "@std/fs";
import { parse as parseJsonc } from "@std/jsonc";

const dirname = import.meta.dirname as string;
const CLI_PATH = path.join(dirname, "..", "cli.ts");
const DenoWebTestCache: Map<string, Promise<Deno.CommandOutput>> = new Map();
const encoder = new TextEncoder();
const STDERR_BOUNDARY_ENV = "DENO_WEB_TEST_STDERR_BOUNDARY";
const DOWNLOAD_HTTP_PREFIX = encoder.encode("Download http://");
const DOWNLOAD_HTTPS_PREFIX = encoder.encode("Download https://");

function skipSgrSequences(
  value: Uint8Array,
  offset: number,
): number {
  let next = offset;
  while (value[next] === 0x1b && value[next + 1] === 0x5b) {
    let end = next + 2;
    while (
      end < value.length &&
      (
        value[end] >= 0x30 && value[end] <= 0x39 ||
        value[end] === 0x3a ||
        value[end] === 0x3b
      )
    ) {
      end++;
    }
    if (value[end] !== 0x6d) {
      break;
    }
    next = end + 1;
  }
  return next;
}

function startsWithVisibleBytes(
  value: Uint8Array,
  prefix: Uint8Array,
  offset: number,
): boolean {
  let valueIndex = offset;
  for (let i = 0; i < prefix.length; i++) {
    valueIndex = skipSgrSequences(value, valueIndex);
    if (value[valueIndex] !== prefix[i]) {
      return false;
    }
    valueIndex++;
  }
  return true;
}

function indexOfBytes(
  value: Uint8Array,
  target: Uint8Array,
): number {
  for (let start = 0; start <= value.length - target.length; start++) {
    let matches = true;
    for (let i = 0; i < target.length; i++) {
      if (value[start + i] !== target[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return -1;
}

function stripDenoDownloadDiagnostics(
  stderr: Uint8Array<ArrayBuffer>,
  boundary: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const boundaryStart = indexOfBytes(stderr, boundary);
  if (boundaryStart === -1) {
    return stderr;
  }

  const retained: Uint8Array[] = [];
  let retainedLength = stderr.length - boundary.length;
  let lineStart = 0;
  while (lineStart < boundaryStart) {
    const lineBreak = stderr.indexOf(0x0a, lineStart);
    const lineEnd = lineBreak === -1 || lineBreak >= boundaryStart
      ? boundaryStart
      : lineBreak + 1;
    if (
      startsWithVisibleBytes(stderr, DOWNLOAD_HTTP_PREFIX, lineStart) ||
      startsWithVisibleBytes(stderr, DOWNLOAD_HTTPS_PREFIX, lineStart)
    ) {
      retainedLength -= lineEnd - lineStart;
    } else {
      retained.push(stderr.subarray(lineStart, lineEnd));
    }
    lineStart = lineEnd;
  }
  retained.push(stderr.subarray(boundaryStart + boundary.length));

  const filtered = new Uint8Array(retainedLength);
  let offset = 0;
  for (const part of retained) {
    filtered.set(part, offset);
    offset += part.length;
  }
  return filtered;
}

export function sanitizeDenoWebTestOutput(
  output: Deno.CommandOutput,
  boundary: string,
): Deno.CommandOutput {
  return {
    ...output,
    stderr: stripDenoDownloadDiagnostics(
      output.stderr,
      encoder.encode(`${boundary}\n`),
    ),
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

  const stderrBoundary = `deno-web-test:${crypto.randomUUID()}`;
  const output = new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "test",
    ],
    cwd: tmpProjectPath,
    env: {
      [STDERR_BOUNDARY_ENV]: stderrBoundary,
    },
  }).output().then((output) =>
    sanitizeDenoWebTestOutput(output, stderrBoundary)
  );
  DenoWebTestCache.set(projectDir, output);
  return output;
};
