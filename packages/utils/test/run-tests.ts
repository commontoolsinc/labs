import * as path from "@std/path";
import { parseShard, type Shard } from "../../../tasks/shard-utils.ts";

const TEST_DIR = "test";
const SHARD_ENV = "UTILS_TEST_SHARD";

const TWO_WAY_SHARD_ASSIGNMENTS: Readonly<Partial<Record<string, number>>> = {
  "test/bigint.test.ts": 2,
};

export async function listUtilsTestFiles(root = Deno.cwd()): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(path.join(root, TEST_DIR))) {
    if (!entry.isFile || !entry.name.endsWith(".test.ts")) continue;
    files.push(path.join(TEST_DIR, entry.name));
  }
  return files.sort();
}

export function selectUtilsTestFiles(
  files: string[],
  shard: Shard | undefined,
): string[] {
  if (!shard) return files;

  let unassignedIndex = 0;
  return files.filter((file) => {
    const assignment = shard.total === 2
      ? TWO_WAY_SHARD_ASSIGNMENTS[file]
      : undefined;
    const selectedShard = assignment ?? (unassignedIndex++ % shard.total) + 1;
    return selectedShard === shard.index;
  });
}

export function buildDenoTestArgs(
  files: string[],
  extraArgs: string[],
): string[] {
  const forwardedArgs = extraArgs[0] === "--" ? extraArgs.slice(1) : extraArgs;
  return ["test", "--no-check", ...forwardedArgs, ...files];
}

export async function main(): Promise<void> {
  const rawShard = Deno.env.get(SHARD_ENV);
  const shard = rawShard ? parseShard(rawShard) : undefined;
  const files = selectUtilsTestFiles(await listUtilsTestFiles(), shard);
  if (files.length === 0) {
    console.error(
      `No utils tests selected for ${SHARD_ENV}=${rawShard ?? "<unset>"}.`,
    );
    Deno.exit(1);
  }

  const status = await new Deno.Command(Deno.execPath(), {
    args: buildDenoTestArgs(files, Deno.args),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  Deno.exit(status.code);
}

if (import.meta.main) {
  await main();
}
