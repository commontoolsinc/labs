import * as path from "@std/path";
import { copy } from "@std/fs";

const dirname = import.meta.dirname as string;
const CLI_PATH = path.join(dirname, "..", "cli.ts");
const DenoWebTestCache: Map<string, Promise<Deno.CommandOutput>> = new Map();

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
  const manifestPath = path.join(tmpProjectPath, "deno.json");
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
  manifest.tasks.test =
    `deno run --allow-env --allow-read --allow-write --allow-run --allow-net ${CLI_PATH} *.test.ts`;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

  // Run `deno install` first to not clutter up stderr
  // with downloading messages in CI.
  const { success: installSuccess } = await new Deno.Command(Deno.execPath(), {
    args: [
      "install",
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
  }).output();
  DenoWebTestCache.set(projectDir, output);
  return output;
};
