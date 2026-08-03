// Build metadata baked into the cf binary at compile time.
//
// `tasks/build-binaries.ts` writes `packages/cli/COMPILED` and includes it in
// the binary via `deno compile --include`, mirroring the toolshed binary's
// marker. Compiled binaries report the commit they were built from; source
// runs (`bin/cf`, `deno task cf`) have no marker and instead ask git for the
// HEAD of the checkout the running module actually lives in — which is what
// matters when multiple checkouts are involved.

import {
  type BuildInfo,
  readBuildInfoFrom,
} from "@commonfabric/utils/build-info";
import { dirname, fromFileUrl } from "@std/path";

const COMPILED_PATH = new URL("../COMPILED", import.meta.url);

export const buildInfo: BuildInfo = readBuildInfoFrom(COMPILED_PATH);

/** The marker file travels only inside compiled binaries — prepareWorkspace
 * always writes it (even when COMMIT_SHA is unset at build time), so its
 * presence distinguishes a compiled run from a source run. */
function isCompiledRun(): boolean {
  try {
    Deno.statSync(COMPILED_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * HEAD of the checkout containing this module, or null when that cannot be
 * determined (git unavailable, no repository, no run permission). Never
 * throws.
 */
export async function gitShaFromCheckout(): Promise<string | null> {
  if (!import.meta.url.startsWith("file://")) return null;
  try {
    const cwd = dirname(fromFileUrl(import.meta.url));
    const { success, stdout } = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!success) return null;
    const sha = new TextDecoder().decode(stdout).trim();
    return sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The commit this cf invocation is running: the baked build marker for
 * compiled binaries, the checkout's HEAD for source runs, else null. A
 * compiled binary whose marker carries no commit (built without COMMIT_SHA)
 * stays null rather than guessing from the build machine's checkout.
 */
export async function resolveCliGitSha(): Promise<string | null> {
  if (buildInfo.commitSha) return buildInfo.commitSha;
  if (isCompiledRun()) return null;
  return await gitShaFromCheckout();
}
