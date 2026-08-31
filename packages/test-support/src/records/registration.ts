/**
 * What a test process learns about its own tests at registration time: the
 * file each `Deno.test` was registered from, and whether this invocation
 * was asked not to run it.
 *
 * Both come from wrapping `Deno.test` in a `--preload` module, which runs
 * before every test module and so needs nothing from the test files
 * themselves. The file is read out of the registration stack and written
 * into the run's spool beside the record fragments, where ingestion joins
 * it onto the identities a JUnit report names. The skip list is a file the
 * environment points at, holding the identities this invocation is not to
 * run; a listed test is registered as ignored rather than dropped, so it
 * appears in the report as skipped instead of vanishing.
 */

import { dirname, join, resolve } from "@std/path";
import { type Environment, readEnv, recordsDir } from "./paths.ts";

/** Name-map files are `names-<ulid>.json` inside the spool. */
export const NAME_MAP_PREFIX = "names-";
export const NAME_MAP_SUFFIX = ".json";

/** Variable naming the file holding this invocation's skip list. */
export const SKIP_LIST_VARIABLE = "CF_TEST_SKIP_LIST";

/**
 * The tail of this module's own path. Deno names a JUnit case's class
 * after the module that registered the test, so while the wrapper is
 * installed every case names this module; ingestion rejects a classname
 * ending here rather than reading it as a test file.
 */
export const REGISTRATION_MODULE_SUFFIX = "src/records/registration.ts";

/**
 * The separator a bdd runner joins a describe chain with, and so the
 * separator between a registered test's name and the leaf names beneath
 * it.
 */
export const NAME_SEPARATOR = " > ";

/**
 * A name map as it travels: the name each `Deno.test` was registered
 * under, against the repository-relative file that registered it.
 */
export type NameMap = Record<string, string>;

/**
 * A skip list: the names this invocation is not to run, under the
 * repository-relative file that registers them. Keyed by file as well as
 * name because the same test name occurs in more than one file.
 */
export type SkipList = Record<string, string[]>;

/**
 * Whether a stack frame's module is part of the test machinery rather
 * than the file under test. The registration wrapper and the bdd
 * re-exports both sit between a test file and `Deno.test`, so their
 * frames are passed over on the way out to the caller.
 */
const frameworkModules = new Set<string>([import.meta.url]);

/**
 * Declares a module as part of the test machinery, so that a test
 * registered through it is attributed to the file that called it. The bdd
 * re-export module registers itself.
 */
export function registerFrameworkModule(url: string): void {
  frameworkModules.add(url);
}

function isFrameworkModule(url: string): boolean {
  if (frameworkModules.has(url)) return true;
  return url.includes("/@std/testing/") || url.includes("/@std/testing@");
}

const FRAME_URL = /(file:\/\/\/[^\s)]+?):\d+:\d+\)?$/;

/**
 * The module that registered a test, given the stack captured inside the
 * wrapper. Frames belonging to the test machinery are passed over, and
 * the first `file:` frame beyond them is the caller. Returns undefined
 * when the stack names no such frame, which is what a run under a
 * hardened error taming produces.
 */
export function registeringModule(stack: string): string | undefined {
  for (const line of stack.split("\n")) {
    const match = line.trim().match(FRAME_URL);
    if (match === null) continue;
    const url = match[1]!;
    if (isFrameworkModule(url)) continue;
    return url;
  }
  return undefined;
}

/**
 * The repository-relative path of a `file:` URL, given the repository
 * root. A module outside the root keeps its whole path, which is what a
 * vendored or cached module produces and what the reader then declines to
 * join onto.
 */
export function relativeToRoot(url: string, root: string): string {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * The repository root enclosing a file, found by climbing to the
 * directory holding `.git`. Undefined outside any repository, and
 * undefined when the climb is not permitted to read the filesystem.
 */
function repositoryRootOf(path: string): string | undefined {
  let dir = dirname(resolve(path));
  for (;;) {
    try {
      Deno.statSync(join(dir, ".git"));
      return dir;
    } catch (error) {
      if (error instanceof Deno.errors.NotCapable) return undefined;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

/**
 * The file a leaf identity's name belongs to, given a name map. A leaf is
 * named as its describe chain, so the registered name is either the whole
 * of it or a prefix of it up to a separator; the longest such prefix wins,
 * because nested describes make several of them.
 */
export function fileForName(
  name: string,
  names: ReadonlyMap<string, string>,
): string | undefined {
  const exact = names.get(name);
  if (exact !== undefined) return exact;
  let best: string | undefined;
  let bestLength = -1;
  for (const [registered, file] of names) {
    if (registered.length <= bestLength) continue;
    if (!name.startsWith(registered + NAME_SEPARATOR)) continue;
    best = file;
    bestLength = registered.length;
  }
  return best;
}

/**
 * Merges the name maps a spool holds into one lookup. A name two files
 * both registered is dropped rather than attributed to either: the two
 * are one identity, and which file it came from is not a question the
 * spool can answer. Reading is best-effort, since a name map is metadata
 * and its absence costs only the file field.
 *
 * Every package of a workspace run writes into one spool, so a caller
 * ingesting one package's report passes `within` — the path its files sit
 * under. Names outside it are dropped before the ambiguity is judged
 * rather than after, or a name two packages happen to share would cost
 * both of them a file each had unambiguously.
 */
export async function readNameMaps(
  dir: string,
  options: { within?: string } = {},
): Promise<Map<string, string>> {
  const within = options.within === undefined
    ? undefined
    : `${options.within.replace(/\/$/, "")}/`;
  const names = new Map<string, string>();
  const ambiguous = new Set<string>();
  let entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile && entry.name.startsWith(NAME_MAP_PREFIX) &&
        entry.name.endsWith(NAME_MAP_SUFFIX)
      ) {
        entries.push(entry.name);
      }
    }
  } catch {
    entries = [];
  }
  entries.sort();
  for (const entry of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(join(dir, entry)));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    for (const [name, file] of Object.entries(parsed)) {
      if (typeof file !== "string" || file.length === 0) continue;
      if (within !== undefined && !file.startsWith(within)) continue;
      const known = names.get(name);
      if (known === undefined) {
        names.set(name, file);
        continue;
      }
      if (known !== file) ambiguous.add(name);
    }
  }
  for (const name of ambiguous) names.delete(name);
  return names;
}

/** Serializes a skip list for the file the environment points at. */
export function serializeSkipList(skips: SkipList): string {
  return JSON.stringify(skips, null, 2) + "\n";
}

/**
 * Parses a skip list. Returns undefined for anything that is not one: a
 * skip list is an instruction to run less, so a malformed one runs
 * everything rather than an arbitrary subset.
 */
export function parseSkipList(text: string): SkipList | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (Array.isArray(parsed)) return undefined;
  const skips: SkipList = {};
  for (const [file, names] of Object.entries(parsed)) {
    if (!Array.isArray(names)) return undefined;
    for (const name of names) {
      if (typeof name !== "string") return undefined;
    }
    skips[file] = names as string[];
  }
  return skips;
}

/** What one test process captured, and what it was told not to run. */
export interface RegistrationCapture {
  /** The file each registered name came from, repository-relative. */
  names: Map<string, string>;

  /** Whether a name registered from a file is on the skip list. */
  skipped(file: string | undefined, name: string): boolean;

  /** Writes the captured name map into the spool. */
  flush(): void;
}

let installed: RegistrationCapture | undefined;

/**
 * The capture this process installed, for the bdd re-exports to consult.
 * Undefined when no preload ran, which is every invocation that is not
 * recording.
 */
export function activeCapture(): RegistrationCapture | undefined {
  return installed;
}

/**
 * Wraps `Deno.test` so that every registration is attributed to its file
 * and checked against the skip list, and arranges for the captured map to
 * reach the spool when the process unloads. Returns undefined when there
 * was nothing to do and `Deno.test` was left alone.
 *
 * Called from a `--preload` module, so it runs before any test module and
 * needs nothing from the test files. Installing twice is a no-op: a
 * process that loads two preloads naming this module captures once.
 */
export function installRegistrationCapture(
  env: Environment = Deno.env.get,
): RegistrationCapture | undefined {
  if (installed !== undefined) return installed;

  const skips = loadSkipList(env);
  const spool = recordsDir(env);
  // Wrapping `Deno.test` costs the report its own file attribution: Deno
  // names each case's class after the module that registered it, so from
  // here on that is this module rather than the test file. Paying that is
  // right when there is a skip list to apply, or a spool this process can
  // write the replacement map into. With neither, the report is the
  // better source and nothing is wrapped.
  if (skips === undefined && !writableSpool(spool)) return undefined;

  const names = new Map<string, string>();
  let root: string | undefined;
  let rootResolved = false;

  const fileOf = (url: string | undefined): string | undefined => {
    if (url === undefined) return undefined;
    if (!rootResolved) {
      rootResolved = true;
      try {
        root = repositoryRootOf(decodeURIComponent(new URL(url).pathname));
      } catch {
        root = undefined;
      }
    }
    return root === undefined ? undefined : relativeToRoot(url, root);
  };

  const capture: RegistrationCapture = {
    names,
    skipped: (file, name) => {
      if (skips === undefined || file === undefined) return false;
      return skips[file]?.includes(name) ?? false;
    },
    flush: () => {
      if (spool === undefined || names.size === 0) return;
      const map: NameMap = {};
      for (const [name, file] of names) map[name] = file;
      try {
        Deno.mkdirSync(spool, { recursive: true });
        // A random name rather than a sortable one: nothing orders these,
        // and `crypto.randomUUID` is built in, where a sortable id would
        // be one more specifier a test task's own import map has to
        // carry for the preload to load at all.
        Deno.writeTextFileSync(
          join(
            spool,
            `${NAME_MAP_PREFIX}${crypto.randomUUID()}${NAME_MAP_SUFFIX}`,
          ),
          JSON.stringify(map),
        );
      } catch (error) {
        console.warn(`test records: cannot write a name map: ${error}`);
      }
    },
  };

  const realTest = Deno.test;
  const register = (
    through: (definition: Deno.TestDefinition) => void,
    extra: Partial<Deno.TestDefinition>,
  ) =>
  (...args: unknown[]): void => {
    const definition = asDefinition(args);
    if (definition === undefined) {
      // A shape this wrapper does not model reaches the real registrar
      // untouched and with its own arguments, so an unfamiliar overload
      // still runs and still reports its own error.
      // deno-lint-ignore no-explicit-any
      (through as any)(...args);
      return;
    }
    const file = fileOf(registeringModule(new Error().stack ?? ""));
    if (file !== undefined) names.set(definition.name, file);
    if (capture.skipped(file, definition.name)) {
      through({ ...definition, ...extra, ignore: true });
      return;
    }
    through({ ...definition, ...extra });
  };
  const capturingTest = register(realTest, {});
  Reflect.set(capturingTest, "ignore", register(realTest, { ignore: true }));
  Reflect.set(capturingTest, "only", register(realTest, { only: true }));
  Reflect.set(Deno, "test", capturingTest);

  globalThis.addEventListener("unload", () => capture.flush());
  installed = capture;
  return capture;
}

/**
 * One definition, whichever way `Deno.test` was called. It takes a name
 * and a body, an options object and a body, a name and options and a
 * body, a whole definition, or a named function alone, and the options
 * carry the sanitizer and permission settings a test needs — so reading
 * only the first two arguments drops the body of several of them and
 * builds a definition Deno rejects.
 *
 * Undefined for a shape this does not model, including an anonymous
 * function with no name to take. The caller passes those through
 * untouched, so Deno reports them as it would have.
 */
export function asDefinition(
  args: readonly unknown[],
): Deno.TestDefinition | undefined {
  const [first, second, third] = args;
  const isBody = (value: unknown): value is Deno.TestDefinition["fn"] =>
    typeof value === "function";
  const isOptions = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

  if (typeof first === "string") {
    if (isBody(second)) return { name: first, fn: second };
    if (isOptions(second) && isBody(third)) {
      return { ...second, name: first, fn: third } as Deno.TestDefinition;
    }
    return undefined;
  }
  if (isOptions(first)) {
    if (isBody(first.fn) && typeof first.name === "string") {
      return first as unknown as Deno.TestDefinition;
    }
    if (isBody(second)) {
      const name = typeof first.name === "string" ? first.name : second.name;
      if (name.length > 0) {
        return { ...first, name, fn: second } as Deno.TestDefinition;
      }
    }
    return undefined;
  }
  if (isBody(first) && first.name.length > 0) {
    return { name: first.name, fn: first };
  }
  return undefined;
}

/**
 * Whether this process may write into the spool. Querying a permission
 * needs no permission, so this answers before anything is attempted and
 * without a warning for a process that was never going to record.
 */
function writableSpool(spool: string | undefined): boolean {
  if (spool === undefined) return false;
  try {
    return Deno.permissions.querySync({ name: "write", path: spool }).state ===
      "granted";
  } catch {
    return false;
  }
}

function loadSkipList(env: Environment): SkipList | undefined {
  const path = readEnv(SKIP_LIST_VARIABLE, env);
  if (path === undefined || path.length === 0) return undefined;
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    console.warn(`test records: cannot read the skip list ${path}: ${error}`);
    return undefined;
  }
  const skips = parseSkipList(text);
  if (skips === undefined) {
    console.warn(`test records: the skip list ${path} is malformed`);
  }
  return skips;
}
