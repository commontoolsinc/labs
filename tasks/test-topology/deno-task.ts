/**
 * Reading a workspace member's `test` task well enough to run part of it.
 *
 * Selection needs the file to be the thing a lane can be pointed at, and
 * a member's task cannot be handed a subset: almost every one of them
 * lists its own paths, so appending more would add to what runs rather
 * than restrict it. What the task does carry is everything else the run
 * needs — the permissions, `--no-check`, a fake-clock preload, an `ENV`
 * assignment in front — so the task is read for those and its paths are
 * replaced with the chosen ones.
 *
 * Only the simple shape is read: leading `NAME=value` assignments, then
 * `deno test`, then flags and paths. A task carrying a shell
 * metacharacter or naming its own import map is not this shape, and the
 * member it belongs to is one unit that runs whole.
 */

import * as path from "@std/path";
import { expandGlob } from "@std/fs/expand-glob";
import { parse as parseJsonc } from "@std/jsonc";

/** A member's test task, taken apart. */
export interface ParsedTestTask {
  /** Environment the task sets in front of the command. */
  env: Record<string, string>;

  /** Flags between `deno test` and the paths, in their own order. */
  flags: string[];

  /** The paths and globs the task runs, as the member directory sees them. */
  paths: string[];

  /** Globs the task refuses, from every `--ignore`. */
  ignores: string[];
}

/** A metacharacter puts the flags and paths somewhere other than the test. */
const METACHARACTER = /[&;|<>`$()]/;

/**
 * The one command substitution the workspace writes, which several
 * members use to name the Deno they are running under in an
 * `--allow-run` list. It is resolved here rather than treated as a
 * metacharacter, because the alternative is those members losing file
 * granularity over a path this process already knows.
 */
const EXEC_PATH_SUBSTITUTION =
  /\$\(deno eval ["']console\.log\(Deno\.execPath\(\)\)["']\)/g;

/** `NAME=value` in front of the command. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Strips shell quoting from a task's argument.
 *
 * A quote may wrap the whole word or sit inside it: several members
 * write `--allow-env=API_URL,"TSC_*",NODE_ENV`, where the quotes are the
 * shell's and the permission the flag names is `TSC_*` without them.
 * Passing the word through as written would give `deno test` a
 * permission with literal quote characters in it, which matches no
 * variable at all.
 */
export function unquote(word: string): string {
  let out = "";
  let quote: string | undefined;
  for (const character of word) {
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * A member's test task as the pieces a subset run needs, or undefined for
 * a task this cannot read: one that is not a single `deno test`, one
 * carrying a shell metacharacter, or one naming its own import map. That
 * map governs every module of the invocation, the preload included, so a
 * specifier the preload needs and the map does not carry would fail the
 * whole run.
 */
export function parseTestTask(
  task: string,
  execPath: string = Deno.execPath(),
): ParsedTestTask | undefined {
  const resolved = task.replace(EXEC_PATH_SUBSTITUTION, execPath);
  if (METACHARACTER.test(resolved)) return undefined;
  if (/--import-map[= ]/.test(resolved)) return undefined;
  const words = resolved.trim().split(/\s+/).filter((word) => word.length > 0);
  const env: Record<string, string> = {};
  let index = 0;
  for (; index < words.length; index++) {
    const assignment = ASSIGNMENT.exec(words[index]!);
    if (assignment === null) break;
    env[assignment[1]!] = unquote(assignment[2]!);
  }
  if (words[index] !== "deno" || words[index + 1] !== "test") return undefined;
  index += 2;
  const flags: string[] = [];
  const paths: string[] = [];
  const ignores: string[] = [];
  for (; index < words.length; index++) {
    const word = words[index]!;
    if (word.startsWith("--ignore=")) {
      for (const glob of unquote(word.slice("--ignore=".length)).split(",")) {
        if (glob.length > 0) ignores.push(glob);
      }
      continue;
    }
    if (word.startsWith("-")) {
      flags.push(unquote(word));
      continue;
    }
    paths.push(unquote(word));
  }
  return { env, flags, paths, ignores };
}

/** What Deno takes for a test file when it walks a directory. */
export const DENO_TEST_FILE =
  /(^|[/\\])(test\.(ts|tsx|mts|js|mjs|jsx)|.*[._]test\.(ts|tsx|mts|js|mjs|jsx))$/;

/** Directories no walk descends into. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "coverage",
  "dist",
]);

async function walkTestFiles(
  directory: string,
  found: string[],
): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(directory);
  } catch (error) {
    // A directory the tree does not hold contributes nothing. Anything
    // else — a permission the walk does not have, a filesystem error —
    // would silently shorten the list of tests, so it is raised.
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for await (const entry of entries) {
    if (entry.isDirectory) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walkTestFiles(path.join(directory, entry.name), found);
      continue;
    }
    if (entry.isFile && DENO_TEST_FILE.test(entry.name)) {
      found.push(path.join(directory, entry.name));
    }
  }
}

/** The `exclude` lists a member's manifest carries, for tests and overall. */
async function memberExcludes(memberDir: string): Promise<string[]> {
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = await Deno.readTextFile(path.join(memberDir, manifest));
    } catch {
      continue;
    }
    const config = parseJsonc(text) as {
      exclude?: string[];
      test?: { exclude?: string[] };
    };
    return [...config?.exclude ?? [], ...config?.test?.exclude ?? []];
  }
  return [];
}

/** Whether a member-relative path is covered by one of these globs. */
function matchesAny(candidate: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    const pattern = path.globToRegExp(glob, { globstar: true });
    if (pattern.test(candidate)) return true;
    // A directory named as an exclusion covers everything under it, which
    // is how `--ignore=integration` and `"exclude": ["dist"]` are meant.
    return candidate.startsWith(`${glob.replace(/\/$/, "")}/`);
  });
}

/**
 * Every test file a member's task runs, member-relative and sorted. The
 * task's own paths are expanded — a directory the way Deno walks one, a
 * glob the way Deno expands one — and then its `--ignore` globs and the
 * member's `exclude` are applied. An explicit path reaches `deno test`
 * without passing through either, which is why they are applied here
 * rather than left to the command line.
 */
export async function memberTestFiles(
  memberDir: string,
  parsed: ParsedTestTask,
): Promise<string[]> {
  const found: string[] = [];
  // No path at all means the member's own directory, which is what
  // `deno test` with only flags walks.
  const targets = parsed.paths.length > 0 ? parsed.paths : ["."];
  for (const target of targets) {
    const absolute = path.resolve(memberDir, target);
    let directory = false;
    let named = false;
    try {
      const stat = await Deno.stat(absolute);
      directory = stat.isDirectory;
      named = stat.isFile;
    } catch {
      // Not a path in the tree, so it is a glob to expand.
    }
    if (directory) {
      await walkTestFiles(absolute, found);
      continue;
    }
    // A path the task names outright is a file the task runs, whatever
    // it is called. The naming rule is how Deno decides what to run when
    // it discovers files for itself, so it belongs to the walk above and
    // to a glob's matches, not to a file somebody wrote down.
    if (named) {
      found.push(absolute);
      continue;
    }
    for await (
      const entry of expandGlob(target, { root: memberDir, includeDirs: false })
    ) {
      found.push(entry.path);
    }
  }
  const excludes = [...parsed.ignores, ...await memberExcludes(memberDir)];
  const relative = found
    .map((file) => path.relative(memberDir, file))
    .filter((file) => !matchesAny(file, excludes));
  return [...new Set(relative)].sort();
}

/** What a member's manifest says about running its tests. */
export interface MemberTasks {
  /**
   * The Deno-only half a lane can be pointed at, taken apart. Undefined
   * where the member's task is not a shape this can read, in which case
   * the member is one unit that runs whole.
   */
  denoTest?: ParsedTestTask;

  /** The name of the task the Deno-only half comes from. */
  denoTestTask?: string;

  /** Whether the member names a browser half, which runs as one unit. */
  browserTest: boolean;

  /** Whether the member defines any test task at all. */
  present: boolean;
}

/** A manifest's tasks, whichever of the two file names carries them. */
async function readTasks(
  memberDir: string,
): Promise<
  Record<string, string | { command?: string; dependencies?: string[] }>
> {
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = await Deno.readTextFile(path.join(memberDir, manifest));
    } catch {
      continue;
    }
    const config = parseJsonc(text) as {
      tasks?: Record<
        string,
        string | { command?: string; dependencies?: string[] }
      >;
    };
    if (config?.tasks !== undefined) return config.tasks;
  }
  return {};
}

/**
 * A member's test tasks as the topology needs them.
 *
 * The Deno-only half is `deno-test` where a member names one and `test`
 * otherwise, which is the same rule the per-package coverage gate
 * measures by. A task written as a dependency list — several members
 * write `test` as a type check followed by `just-test` — resolves to
 * whichever of its dependencies is a readable `deno test`, so those
 * members keep their file granularity instead of running whole over a
 * wrapper task.
 */
export async function memberTasks(
  memberDir: string,
  execPath: string = Deno.execPath(),
): Promise<MemberTasks> {
  const tasks = await readTasks(memberDir);
  const commandOf = (name: string): string | undefined => {
    const task = tasks[name];
    if (task === undefined) return undefined;
    return typeof task === "string" ? task : task.command;
  };
  const dependenciesOf = (name: string): string[] => {
    const task = tasks[name];
    return typeof task === "string" ? [] : task?.dependencies ?? [];
  };
  const browserTest = tasks["browser-test"] !== undefined;
  const half = tasks["deno-test"] !== undefined ? "deno-test" : "test";
  if (tasks[half] === undefined) {
    // A member with only a browser half is still a test surface: it runs
    // whole, as one unit, and its records come from the browser harness.
    return { browserTest, present: browserTest };
  }
  const candidates = [half, ...dependenciesOf(half)];
  for (const name of candidates) {
    const command = commandOf(name);
    if (command === undefined) continue;
    const parsed = parseTestTask(command, execPath);
    if (parsed !== undefined) {
      return {
        denoTest: parsed,
        denoTestTask: name,
        browserTest,
        present: true,
      };
    }
  }
  return {
    browserTest,
    present: true,
    // A member whose only test task echoes that it has none is not a
    // test surface, and saying so here keeps it out of the enumeration.
    ...(candidates.some((name) => /deno (test|run)/.test(commandOf(name) ?? ""))
      ? {}
      : { present: false }),
  };
}
