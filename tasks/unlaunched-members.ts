/**
 * The record a workspace test run leaves of the packages it selected and never
 * launched. The runner stops handing packages to its workers once one fails,
 * so a run that fails early measures a subset of what it selected, and what it
 * never launched has unknown coverage rather than none.
 *
 * The record travels with the coverage report it qualifies: the runner writes
 * it into the run's coverage profile directory, the LCOV conversion copies it
 * beside the report that directory converts into, and whatever scores that
 * report reads it back. A run that launched everything it selected writes no
 * record, so the file's presence is itself the statement that something went
 * unmeasured.
 *
 * The record names members rather than source files, and it says only that a
 * member never started. A member whose test process started and then failed is
 * not in it: that member is named in the run's own failure report, and its
 * coverage is measured as far as it got.
 */

import * as path from "@std/path";

/**
 * Name of the record's file, the same in the coverage profile directory the
 * runner writes it to and in the artifact directory the LCOV conversion copies
 * it to. One name is what lets a reader of either directory recognize it.
 */
export const UNLAUNCHED_MEMBERS_FILE = "unlaunched-members.txt";

/**
 * The members named by `content`, which is one member path per line. Blank
 * lines and surrounding whitespace are ignored, so a record written by hand
 * while reproducing a run reads the same as one the runner wrote.
 */
export function parseUnlaunchedMembers(content: string): string[] {
  return content.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}

/**
 * Writes the record naming `members` into `dir`, creating the directory when
 * it is absent. Writes nothing at all when `members` is empty, which is what
 * keeps the file's presence meaningful.
 */
export async function writeUnlaunchedMembers(
  dir: string,
  members: readonly string[],
): Promise<void> {
  if (members.length === 0) return;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    path.join(dir, UNLAUNCHED_MEMBERS_FILE),
    members.map((member) => `${member}\n`).join(""),
  );
}

/**
 * The members named by the record in `dir`, and none where `dir` holds no
 * record. An empty result therefore means either that the run launched
 * everything it selected or that nothing wrote a record there at all; the two
 * are the same to a caller, since both leave every group scorable.
 */
export async function readUnlaunchedMembers(dir: string): Promise<string[]> {
  try {
    return parseUnlaunchedMembers(
      await Deno.readTextFile(path.join(dir, UNLAUNCHED_MEMBERS_FILE)),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}
