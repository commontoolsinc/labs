// Build metadata baked into the cf binary at compile time.
//
// `tasks/build-binaries.ts` writes `packages/cli/COMPILED` and includes it in
// the binary via `deno compile --include`, mirroring the toolshed binary's
// marker. Compiled binaries report the commit they were built from; source
// runs (`bin/cf`, `deno task cf`) instead ask git for the HEAD of the
// checkout the running module actually lives in — which is what matters when
// multiple checkouts are involved. `Deno.build.standalone` is the
// discriminator: the marker file also exists on disk in a checkout while a
// binary build is in flight (or after an interrupted one), so its presence
// says nothing about how this invocation is running.

import {
  type BuildInfo,
  readBuildInfoFrom,
} from "@commonfabric/utils/build-info";
import { dirname, fromFileUrl, join } from "@std/path";

const COMPILED_PATH = new URL("../COMPILED", import.meta.url);

export const buildInfo: BuildInfo = Deno.build.standalone
  ? readBuildInfoFrom(COMPILED_PATH)
  : { commitSha: null, builtAt: null };

/**
 * HEAD of the labs checkout whose `packages/cli/lib` directory is `dir`, or
 * null when that cannot be determined (git unavailable, no repository, no
 * run permission). Never throws.
 *
 * The toplevel guard matters for vendored layouts: a `<host>/vendor/labs`
 * tree with no git directory of its own would otherwise resolve to the HOST
 * repository's HEAD — an unrelated commit that would falsely mismatch every
 * labs server. Only a toplevel that actually contains the running module at
 * its expected location is trusted; anything else reports unknown.
 */
export async function gitShaForCliLibDir(dir: string): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD", "--show-toplevel"],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!success) return null;
    const [sha, toplevel] = new TextDecoder().decode(stdout).trim().split(
      "\n",
    );
    if (!sha || !toplevel) return null;
    const expected = Deno.realPathSync(
      join(toplevel, "packages", "cli", "lib"),
    );
    if (expected !== Deno.realPathSync(dir)) return null;
    return sha;
  } catch {
    return null;
  }
}

/**
 * The commit this cf invocation is running: the baked build marker for
 * compiled binaries, the checkout's HEAD for source runs, else null. A
 * compiled binary built without COMMIT_SHA stays unknown rather than
 * guessing from the build machine's checkout.
 */
export async function resolveCliGitSha(): Promise<string | null> {
  if (Deno.build.standalone) return buildInfo.commitSha;
  if (!import.meta.url.startsWith("file://")) return null;
  return await gitShaForCliLibDir(dirname(fromFileUrl(import.meta.url)));
}
