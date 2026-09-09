/**
 * The run family's output directory: the one place in the workspace whose
 * creation the harness can vouch for, and therefore the only place
 * `ingest_sandbox_file` will read from.
 *
 * Containment in the workspace is not provenance. A workspace is an ordinary
 * directory the operator names — it defaults to the process's own working
 * directory — so a file in it may predate the run entirely, and the taint the
 * run accumulated says nothing about who wrote it. A directory the harness
 * creates fresh, and refuses to reuse, carries the one fact the label rests
 * on: nothing in it predates the family that created it.
 *
 * The root belongs to the run FAMILY rather than to one engine. A delegated
 * child shares its parent's workspace and sandbox, so a child's sandbox write
 * and its parent's ingest have to meet in one directory and under one taint
 * accumulator; keying by the root run's id is what makes them the same.
 */

import { join as joinHostPath } from "@std/path";
import { join as joinSandboxPath } from "@std/path/posix";

/**
 * The environment variable naming the output directory inside the sandbox.
 * A workload writes `$CF_HARNESS_OUTPUT_DIR/total.txt` and the ingest takes
 * the same path, so neither side spells the directory itself and the two
 * cannot drift apart.
 */
export const SANDBOX_OUTPUT_DIR_ENV = "CF_HARNESS_OUTPUT_DIR";

/** Path components under a workspace that hold harness-created directories. */
const OUTPUT_ROOT_SEGMENTS = [".cf-harness", "out"] as const;

/** Where a family's output directory sits on the host. */
export const sandboxOutputRootHostPath = (
  workspaceHostPath: string,
  familyRunId: string,
): string =>
  joinHostPath(workspaceHostPath, ...OUTPUT_ROOT_SEGMENTS, familyRunId);

/** The same directory as the sandbox addresses it. */
export const sandboxOutputRootSandboxPath = (
  workspaceMountPath: string,
  familyRunId: string,
): string =>
  joinSandboxPath(workspaceMountPath, ...OUTPUT_ROOT_SEGMENTS, familyRunId);

/**
 * Creates the family's output directory, or throws when one is already there.
 *
 * The refusal is the point. `recursive: true` on the leaf would accept an
 * existing directory, and an existing directory is exactly the case this
 * guards: its contents were written by something this family cannot account
 * for, which is the provenance claim the label rests on. Only the parents are
 * made recursively.
 *
 * @throws Error naming the directory when it already exists.
 */
export const createSandboxOutputRoot = async (
  hostPath: string,
): Promise<void> => {
  await Deno.mkdir(
    joinHostPath(hostPath, ".."),
    { recursive: true },
  );
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
};
