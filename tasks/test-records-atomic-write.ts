/**
 * Replacing a file somebody else owns, in one step or not at all.
 *
 * The files this writes — shell profiles, an agent harness's settings —
 * belong to other programs and to the person, and a half-written one is
 * worse than an unwritten one: a shell startup file cut off in the
 * middle is a shell that will not start. So the new text goes to a
 * temporary file beside the target and is renamed over it, which the
 * kernel does in one step.
 *
 * Two properties of the file being replaced are carried over. Its
 * permissions, so a file kept readable only by its owner does not come
 * back readable by everyone; a mode that cannot be reproduced stops the
 * replacement rather than widening it. And a symbolic link, resolved
 * before anything is written, so a profile linked into somebody's
 * dotfiles repository stays a link and the file it points at is what
 * changes.
 */

import { dirname, join } from "@std/path";

/** Where a path leads once every link on it is followed. */
async function target(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    // Nothing there to follow: the path names the file to create.
    return path;
  }
}

/** The permission bits of a file that is already there. */
async function permissions(path: string): Promise<number | undefined> {
  try {
    const mode = (await Deno.stat(path)).mode;
    return mode === null || mode === undefined ? undefined : mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * Writes text over a file in one step. The file's own permissions and
 * any link leading to it survive; a failure leaves the file as it was.
 */
export async function replaceFile(path: string, text: string): Promise<void> {
  const real = await target(path);
  const temporary = join(
    dirname(real),
    `.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Deno.writeTextFile(temporary, text);
    const mode = await permissions(real);
    // A mode that cannot be put on the replacement is not a detail to
    // shrug off: renaming anyway is what would widen access to a file
    // somebody keeps to themselves.
    if (mode !== undefined) await Deno.chmod(temporary, mode);
    await Deno.rename(temporary, real);
  } finally {
    // The rename takes the temporary file's name away, so this removes
    // one only where the write or the rename did not get that far.
    await Deno.remove(temporary).catch(() => {});
  }
}
