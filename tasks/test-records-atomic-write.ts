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
 * back readable by everyone; the temporary file is private from the
 * moment it exists and takes the target's mode before the rename,
 * because what it holds is a copy of the target, and a profile can hold
 * anything a person has put in it. And a symbolic link, resolved before
 * anything is written, so a profile linked into somebody's dotfiles
 * repository stays a link and the file it points at is what changes.
 *
 * A file this cannot read the state of is a file it does not replace.
 * Only a path with nothing at it counts as absent; every other failure
 * stops the replacement, because the alternative is guessing, and the
 * guess that goes wrong is the one that widens access.
 */

import { dirname, isAbsolute, join } from "@std/path";

/**
 * Asks the filesystem something, answering undefined only where there
 * is no file to answer about. Every other failure is raised: a file
 * this cannot read the state of is a file it does not replace, because
 * the alternative is guessing, and the guess that goes wrong is the one
 * that widens access.
 */
async function ifPresent<T>(ask: () => Promise<T>): Promise<T | undefined> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/**
 * Where a path leads once every link on it is followed. A link that
 * points at nothing leads to what it names, so writing follows the link
 * rather than replacing it.
 */
async function target(path: string): Promise<string> {
  const real = await ifPresent(() => Deno.realPath(path));
  if (real !== undefined) return real;
  const itself = await ifPresent(() => Deno.lstat(path));
  if (itself === undefined) return path;
  // Something is there that realPath would not follow: a link with
  // nothing at the end of it, which still says where the file goes.
  const named = await Deno.readLink(path);
  return isAbsolute(named) ? named : join(dirname(path), named);
}

/** The permission bits of the file at a path, or undefined for no file. */
async function permissions(path: string): Promise<number | undefined> {
  const mode = (await ifPresent(() => Deno.stat(path)))?.mode;
  return mode === null || mode === undefined ? undefined : mode & 0o7777;
}

/**
 * Writes text over a file in one step. The file's own permissions and
 * any link leading to it survive; a failure leaves the file as it was.
 * A file this creates is readable only by its owner, which is the safe
 * end of the choice for something a person's environment is read from.
 */
export async function replaceFile(path: string, text: string): Promise<void> {
  const real = await target(path);
  const mode = await permissions(real);
  const temporary = join(dirname(real), `.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(temporary, text, { mode: 0o600, createNew: true });
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
