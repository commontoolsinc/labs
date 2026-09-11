/**
 * What a caller appends to a `deno test` invocation to make it record:
 * where the registration preload lives on disk, and the write permission
 * that preload needs to leave its name map behind.
 *
 * `deno test --preload` takes a path rather than an import-map
 * specifier, and a test task runs with its own package as the working
 * directory, so every caller needs an absolute path rather than a
 * relative one.
 */

import { fromFileUrl, isAbsolute } from "@std/path";

/** Absolute path of the module `--preload` is pointed at. */
export function preloadModulePath(): string {
  return fromFileUrl(new URL("./preload.ts", import.meta.url));
}

/** The `--preload=<path>` argument naming that module. */
export function preloadArgument(): string {
  return `--preload=${preloadModulePath()}`;
}

/**
 * Whether a flag list grants one permission over the whole filesystem,
 * given the long flag naming it and the letter it takes as a short one.
 * Short flags cluster, so `-RW` grants read and write together, and `-A`
 * grants everything however it is written.
 */
function grantsEverything(
  flags: readonly string[],
  long: string,
  letter: string,
): boolean {
  return flags.some((flag) => {
    if (flag === long || flag === "--allow-all") return true;
    if (!/^-[A-Za-z]+$/.test(flag)) return false;
    return flag.includes(letter) || flag.includes("A");
  });
}

/**
 * The `--allow-write` an invocation needs so the preload can leave its
 * name map in the spool, or undefined where the invocation would be no
 * better for having one.
 *
 * The spool is wherever the run owner put it, which is a path only the
 * environment knows and a test task cannot name: `deno task` expands
 * `$VAR` but not `${VAR:-default}`, and `--allow-write=` with an unset
 * variable ends the run. So the caller appending the preload appends the
 * permission beside it, for the invocation that needs it and no other.
 *
 * Deno merges two `--allow-write` path lists, so an invocation carrying
 * a list of its own takes this one on top of it and one carrying no
 * write flag takes it alone. An invocation already permitted to write
 * everywhere is given nothing. Beside `-A` or `--allow-all`, a path list
 * ends the run before it starts, with `the argument '--allow-all...'
 * cannot be used with '--allow-write[=<PATH>...]'`. Beside a bare
 * `--allow-write`, `-W`, or a cluster holding one of them, it cuts that
 * grant down to the list.
 *
 * An invocation that cannot read the filesystem is given nothing either.
 * A writable spool is what makes the preload wrap `Deno.test`, and
 * wrapping costs the report the class names it names each case's file
 * by. What replaces them is found by climbing from each test file to the
 * directory holding `.git`, and that climb needs read permission, so the
 * write is worth granting only beside the read.
 */
export function spoolWriteArgument(
  flags: readonly string[],
  spool: string,
): string | undefined {
  if (!isAbsolute(spool)) {
    throw new Error(
      `test records: the spool to grant must be an absolute path: "${spool}"`,
    );
  }
  // A comma is what separates one path from the next inside
  // `--allow-write=`, and Deno offers no way to write one that is part of a
  // path, so a spool holding one is granted as two paths that are not it.
  if (spool.includes(",")) {
    throw new Error(
      `test records: the spool to grant cannot hold a comma: "${spool}"`,
    );
  }
  if (grantsEverything(flags, "--allow-write", "W")) return undefined;
  if (!grantsEverything(flags, "--allow-read", "R")) return undefined;
  return `--allow-write=${spool}`;
}
