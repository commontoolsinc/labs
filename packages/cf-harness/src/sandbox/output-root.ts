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
 * Where the host directory goes is chosen rather than fixed, because the
 * mount's SOURCE has to be somewhere the sandbox cannot reach by another
 * route: mounting a directory twice does not stop a workload writing it
 * through the first mount. The family's directory sits under the run's
 * artifact root when that is itself outside every writable mount, and beside
 * the workspace when it is not — which is the ordinary case, since the CLI's
 * artifact root defaults to a directory under the working directory and the
 * workspace defaults to that same directory. A run with neither has nowhere
 * to put one and cannot ingest, the same fail-closed answer a directory that
 * cannot be created gets.
 *
 * Only ONE child of that family directory is mounted. Everything else the
 * harness keeps for the family — its taint record among them — sits beside
 * that child and is therefore out of the sandbox's reach even though its
 * sibling is bound in read-write.
 *
 * The root belongs to the run FAMILY rather than to one engine. A delegated
 * child shares its parent's sandbox, so a child's sandbox write and its
 * parent's ingest have to meet in one directory and under one taint
 * accumulator; keying by the root run's id is what makes them the same. That
 * derivation is also what a resume is checked against: the path in a
 * persisted record is data, and where the directory belongs is recomputed
 * rather than read.
 */

import {
  join as joinHostPath,
  normalize as normalizeHostPath,
} from "@std/path";

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

/** The mounted directory's name inside the run family's own directory. */
const OUTPUT_ROOT_NAME = "sandbox-out";

/**
 * The directory a run family falls back to when its artifact root is
 * somewhere the sandbox can write. The CLI's default artifact root sits under
 * the working directory, which is also the default workspace, so the ordinary
 * configuration is exactly the one where the artifact root cannot hold it: a
 * source directory reachable through the workspace mount is a directory the
 * workload can write, and mounting it twice does not stop it.
 *
 * A sibling of the workspace rather than a child of it, so it is outside
 * every mount the workspace gives, and named after it so two workspaces do
 * not share one.
 */
export const familyDirBesideWorkspace = (
  workspaceHostPath: string,
  familyRunId: string,
): string =>
  joinHostPath(
    `${normalizeHostPath(workspaceHostPath).replace(/[\\/]+$/, "")}-cf-harness`,
    familyRunId,
  );

/**
 * Where a family's output directory sits on the host: inside the artifact
 * directory of the run that heads the family, so the artifact root's own
 * shape stays one directory per run and a delegated child — which is handed
 * its parent's artifact root and shares its family id — computes the same
 * path.
 */
export const sandboxOutputRootHostPath = (
  familyDirHostPath: string,
): string => joinHostPath(familyDirHostPath, OUTPUT_ROOT_NAME);

/**
 * The family's harness directory under an artifact root. Usable only when the
 * artifact root itself is outside every writable mount; the CLI's default
 * puts it under the working directory, which is also the default workspace.
 */
export const familyDirUnderArtifactRoot = (
  artifactRootHostPath: string,
  familyRunId: string,
): string => joinHostPath(artifactRootHostPath, familyRunId);

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

  /**
   * A value chosen when the directory was made, written inside it and
   * recorded here. Device and inode alone do not identify a directory ACROSS
   * TIME: on ext4 and tmpfs a directory removed and made again at the same
   * path frequently gets the same inode back, so a replacement is
   * indistinguishable from the original by number. A nonce is not reissued.
   *
   * This is the identity a RESUME checks, where the question is whether the
   * directory recorded by an earlier process is still the one standing there.
   * Within a run the load-bearing guarantee is the mount: a mount point
   * cannot be replaced from inside the sandbox, which is what stops the
   * workload doing the replacing. The marker lives inside that mount and is
   * therefore workload-writable — it can be destroyed, which refuses, but the
   * value it must be replaced WITH is one the workload was never told.
   */
  readonly nonce: string;
}

/** What the marker inside the directory carries. */
interface SandboxOutputRootMarker {
  type: "cf-harness.sandbox-output-root";
  version: 1;
  familyRunId: string;
  nonce: string;
}

/** The marker's name inside the output directory. */
const MARKER_NAME = ".cf-harness-output-root.json";

const readMarker = async (
  hostPath: string,
): Promise<SandboxOutputRootMarker> => {
  const parsed = JSON.parse(
    await Deno.readTextFile(joinHostPath(hostPath, MARKER_NAME)),
  ) as SandboxOutputRootMarker;
  if (
    parsed?.type !== "cf-harness.sandbox-output-root" ||
    parsed.version !== 1 || typeof parsed.nonce !== "string" ||
    typeof parsed.familyRunId !== "string"
  ) {
    throw new Error("marker does not describe a run family's output root");
  }
  return parsed;
};

const identityOf = async (
  hostPath: string,
  nonce: string,
): Promise<HarnessSandboxOutputRoot> => {
  const stat = await Deno.stat(hostPath);
  if (!stat.isDirectory || stat.dev === null || stat.ino === null) {
    throw new Error(
      `the run family's output directory is not a directory this host can ` +
        `identify: ${hostPath}`,
    );
  }
  return { hostPath, dev: stat.dev, ino: stat.ino, nonce };
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
  familyRunId: string,
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
  const nonce = crypto.randomUUID();
  await Deno.writeTextFile(
    joinHostPath(hostPath, MARKER_NAME),
    JSON.stringify(
      {
        type: "cf-harness.sandbox-output-root",
        version: 1,
        familyRunId,
        nonce,
      } satisfies SandboxOutputRootMarker,
    ),
  );
  return await identityOf(hostPath, nonce);
};

/**
 * Reads an existing output directory's identity from the directory itself.
 *
 * A delegated child shares only the PATH with the family that made the
 * directory — the recorded identity lives in its parent's run state — so it
 * reads the marker rather than being told. What it ends up pinned to is what
 * it can itself see, and the restore it performs afterwards re-checks it.
 *
 * @throws Error when the directory or its marker cannot be read.
 */
export const readSandboxOutputRootFromDisk = async (
  hostPath: string,
): Promise<HarnessSandboxOutputRoot> => {
  const marker = await readMarker(hostPath);
  return await identityOf(hostPath, marker.nonce);
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
  const current = await identityOf(recorded.hostPath, recorded.nonce)
    .catch((error) => {
      throw new Error(
        `the run family's output directory recorded by the run this resumes ` +
          `cannot be read: ${recorded.hostPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    });
  const marker = await readMarker(recorded.hostPath).catch((error) => {
    throw new Error(
      `the directory at the run family's recorded output path carries no ` +
        `marker this run can check it by: ${recorded.hostPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  });
  if (
    current.dev !== recorded.dev || current.ino !== recorded.ino ||
    marker.nonce !== recorded.nonce
  ) {
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
    const current = await identityOf(recorded.hostPath, recorded.nonce);
    const marker = await readMarker(recorded.hostPath);
    return current.dev === recorded.dev && current.ino === recorded.ino &&
      marker.nonce === recorded.nonce;
  } catch {
    return false;
  }
};
