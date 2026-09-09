/**
 * The run family's output directory: a host directory of the harness's own,
 * mounted into the sandbox at a fixed path, and the only place
 * `ingest_sandbox_file` will read from.
 *
 * Containment in the workspace is not provenance, and neither is a directory
 * INSIDE the workspace. The workspace is mounted read-write, so a workload
 * can replace any name in it — including the output directory's own name,
 * with a symlink to somewhere holding files that predate the family. Both
 * sides of a real-path comparison then move together and the check passes.
 * The mount is what closes that: a mount point cannot be replaced from
 * inside, a hard link cannot cross into it from the workspace because the two
 * are different filesystems, and a symlink inside it still resolves outside
 * its real path and is refused.
 *
 * The host directory lives under the run's artifact root rather than the
 * workspace, so nothing the sandbox can write reaches it except through the
 * mount. A run with no artifact root has nowhere to put one and cannot
 * ingest; that is the same fail-closed answer a workspace that cannot hold
 * one gets.
 *
 * The root belongs to the run FAMILY rather than to one engine. A delegated
 * child shares its parent's sandbox, so a child's sandbox write and its
 * parent's ingest have to meet in one directory and under one taint
 * accumulator; keying by the root run's id is what makes them the same.
 */

import { join as joinHostPath } from "@std/path";

/**
 * The environment variable naming the output directory inside the sandbox.
 * A workload writes `$CF_HARNESS_OUTPUT_DIR/total.txt` and the ingest takes
 * the same path, so neither side spells the directory itself and the two
 * cannot drift apart.
 */
export const SANDBOX_OUTPUT_DIR_ENV = "CF_HARNESS_OUTPUT_DIR";

/**
 * Where the output directory appears inside the sandbox. Fixed, and outside
 * the workspace mount: a path under the workspace would be a name the
 * workload could shadow.
 */
export const SANDBOX_OUTPUT_MOUNT_PATH = "/cf-harness/out";

/** The mount's name, for the runtime's own mount bookkeeping. */
export const SANDBOX_OUTPUT_MOUNT_NAME = "cf-harness-out";

/** The directory's name inside the run family's own artifact directory. */
const OUTPUT_ROOT_NAME = "sandbox-out";

/**
 * Where a family's output directory sits on the host: inside the artifact
 * directory of the run that heads the family, so the artifact root's own
 * shape stays one directory per run and a delegated child — which is handed
 * its parent's artifact root and shares its family id — computes the same
 * path.
 */
export const sandboxOutputRootHostPath = (
  artifactRootHostPath: string,
  familyRunId: string,
): string => joinHostPath(artifactRootHostPath, familyRunId, OUTPUT_ROOT_NAME);

/**
 * What identifies the directory the family created, beyond its name.
 *
 * A name can be re-pointed; an inode cannot be talked into being a different
 * inode. Recorded when the directory is made and checked before every read
 * out of it, so a directory swapped for another — however the swap was
 * achieved — is refused rather than read.
 */
export interface HarnessSandboxOutputRoot {
  readonly hostPath: string;
  readonly dev: number;
  readonly ino: number;
}

const identityOf = async (
  hostPath: string,
): Promise<HarnessSandboxOutputRoot> => {
  const stat = await Deno.stat(hostPath);
  if (!stat.isDirectory || stat.dev === null || stat.ino === null) {
    throw new Error(
      `the run family's output directory is not a directory this host can ` +
        `identify: ${hostPath}`,
    );
  }
  return { hostPath, dev: stat.dev, ino: stat.ino };
};

/**
 * Creates the family's output directory and records what it is, or throws
 * when one is already there.
 *
 * The refusal is the point. `recursive: true` on the leaf would accept an
 * existing directory, and an existing directory is exactly the case this
 * guards: its contents were written by something this family cannot account
 * for, which is the provenance claim the label rests on.
 *
 * @throws Error naming the directory when it already exists.
 */
export const createSandboxOutputRoot = async (
  hostPath: string,
): Promise<HarnessSandboxOutputRoot> => {
  await Deno.mkdir(joinHostPath(hostPath, ".."), { recursive: true });
  try {
    await Deno.mkdir(hostPath);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `the run family's output directory already exists, so nothing in it ` +
          `can be attributed to this run: ${hostPath}`,
      );
    }
    throw error;
  }
  return await identityOf(hostPath);
};

/**
 * Re-establishes a directory a previous process recorded, for a resumed run.
 *
 * A resumed run must not create the directory again — its own earlier
 * invocations wrote there, and refusing it as "already exists" would disable
 * ingest for the rest of the run. What it must do is check that the directory
 * it is about to read from is the one that was recorded, so a resume cannot
 * be pointed at a directory something else made in the meantime.
 *
 * @throws Error when the recorded directory is absent or is no longer the
 * same directory.
 */
export const restoreSandboxOutputRoot = async (
  recorded: HarnessSandboxOutputRoot,
): Promise<HarnessSandboxOutputRoot> => {
  const current = await identityOf(recorded.hostPath).catch((error) => {
    throw new Error(
      `the run family's output directory recorded by the run this resumes ` +
        `cannot be read: ${recorded.hostPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  });
  if (current.dev !== recorded.dev || current.ino !== recorded.ino) {
    throw new Error(
      `the directory at the run family's recorded output path is not the one ` +
        `the run this resumes created: ${recorded.hostPath}`,
    );
  }
  return current;
};

/**
 * Whether `hostPath` is still the directory that was recorded. Checked before
 * every read out of it rather than once at creation, because the window that
 * matters is between the two.
 */
export const sandboxOutputRootIsIntact = async (
  recorded: HarnessSandboxOutputRoot,
): Promise<boolean> => {
  try {
    const current = await identityOf(recorded.hostPath);
    return current.dev === recorded.dev && current.ino === recorded.ino;
  } catch {
    return false;
  }
};
