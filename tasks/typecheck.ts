/**
 * The repository type check, run per package. Each owning scope's paths are
 * checked as their own `deno check` invocation, timed and recorded as that
 * scope's `typecheck`-kind test, the way cfcheck already shards pattern
 * type-checking; the invocations run concurrently and any failure fails
 * the whole task. tasks/check.sh owns the Deno version gate and delegates
 * here.
 *
 * This list is the single type-checking point for the paths it names: the
 * CI test jobs and the package test tasks that cover these paths run
 * `deno test --no-check` and rely on this task (via the Check job's
 * "Type check codebase" step) for type safety. Before adding --no-check to
 * a test invocation, make sure every file it loads is under a path listed
 * here. Removing a path from this list removes its type checking entirely.
 */

import { expandGlob } from "@std/fs";
import { FragmentWriter } from "@commonfabric/test-support/records";

// Directory paths (no glob expansion needed).
const DIRS = [
  "packages/api",
  "packages/background-piece-service",
  "packages/cf-harness",
  "packages/cli",
  "packages/connectors/agents/connector",
  "packages/connectors/agents/debug-view",
  "packages/connectors/agents/host",
  "packages/connectors/github/activity-view",
  "packages/connectors/github/connector",
  "packages/connectors/github/host",
  "packages/content-hash",
  "packages/dashboard",
  "packages/data-model",
  "packages/data-model-schema",
  "packages/deno-web-test",
  "packages/felt",
  "packages/fuse",
  "packages/generated-patterns",
  "packages/home-schemas",
  "packages/html",
  "packages/identity",
  "packages/iframe-sandbox",
  "packages/integration",
  "packages/js-compiler",
  "packages/leb128",
  "packages/lib-shell",
  "packages/llm",
  "packages/memory",
  "packages/navigation",
  "packages/patterns/auth",
  "packages/patterns/battleship",
  "packages/patterns/budget-tracker",
  "packages/patterns/contacts",
  "packages/patterns/examples",
  "packages/patterns/gideon-tests",
  "packages/patterns/google/core/integration",
  "packages/patterns/google/core/util",
  "packages/patterns/integration",
  "packages/patterns/notes",
  "packages/patterns/scrabble",
  "packages/patterns/system",
  "packages/patterns/test",
  "packages/patterns/tools",
  "packages/patterns/weekly-calendar",
  "packages/piece",
  "packages/pure-json",
  "packages/runner",
  "packages/runtime-client",
  "packages/schema-generator/src",
  "packages/shell",
  "packages/shuttle",
  "packages/spec-model",
  "packages/state-inspector",
  "packages/static/scripts",
  "packages/static/test",
  "packages/test-support",
  "packages/toolshed",
  "packages/ts-transformers/lint-plugins",
  "packages/ts-transformers/src",
  "packages/ts-transformers/test/diagnostics",
  "packages/ts-transformers/test/reactive",
  "packages/ui",
  "packages/utils",
  "tasks",
];

// Glob patterns, expanded the way the shell used to expand them.
const GLOBS = [
  "scripts/*.ts",
  "packages/static/*.ts",
  "packages/patterns/*.ts",
  "packages/patterns/*.tsx",
  // Iframe guests compile as ordinary browser modules. Their generated
  // pattern wrappers remain under the classic JSX environment owned by
  // `deno task cfcheck`.
  "packages/patterns/*/guest.ts",
  "packages/patterns/*/guest.tsx",
  // The transformer test trees are reached by glob rather than as directory
  // entries because each holds a `test/fixtures` subtree that `deno check`
  // must not open, and `deno check` takes no exclusion. The pair of patterns
  // per tree covers the test files at any depth and the helper modules
  // sitting beside them at the top level; `UNCHECKED_TREES` records the
  // fixtures the patterns leave behind.
  "packages/ts-transformers/test/*.ts",
  "packages/ts-transformers/test/**/*.test.ts",
  "packages/schema-generator/test/*.ts",
  "packages/schema-generator/test/**/*.test.ts",
  "packages/patterns/google/core/*.ts",
  "packages/patterns/google/core/*.tsx",
  "packages/patterns/google/core/experimental/*.ts",
  "packages/patterns/google/core/experimental/*.tsx",
  "packages/patterns/google/extractors/*.ts",
  "packages/patterns/google/extractors/*.tsx",
  "packages/patterns/google/WIP/*.ts",
  "packages/patterns/google/WIP/*.tsx",
];

/** A tree of TypeScript files the checked paths leave out, and why. */
export interface UncheckedTree {
  /** Repository-relative directory no checked path names. */
  readonly tree: string;

  /** Why this task does not type-check it. */
  readonly because: string;
}

/**
 * Every tree the checked paths deliberately leave out.
 *
 * A list of what is checked cannot on its own distinguish a tree somebody
 * decided to leave out from one the list forgot: both are simply absent, and
 * the task reports a clean run over either. Recording the decision is what
 * tells them apart, and `typecheck.test.ts` holds the pair to being
 * exhaustive — a workspace file that is neither checked nor named by an entry
 * here fails that test, naming the file.
 */
export const UNCHECKED_TREES: readonly UncheckedTree[] = [
  {
    tree: "packages/patterns",
    because:
      "patterns compile under the classic-`h` JSX runtime rather than the " +
      "automatic-JSX environment this task uses, and the two disagree on " +
      "some pattern types, so `deno task cfcheck` is their type check. The " +
      "checked paths reaching into this tree name the harness and tooling " +
      "beside the patterns, which do compile under this environment.",
  },
  {
    tree: "packages/schema-generator/test/fixtures",
    because: "transformer inputs name the ambient wrappers (Cell, Stream, " +
      "Writable) that the transformer supplies rather than importing them, " +
      "so they do not compile on their own.",
  },
  {
    tree: "packages/ts-transformers/test/fixtures",
    because: "transformer inputs naming ambient wrappers the transformer " +
      "supplies, which do not compile on their own.",
  },
  {
    tree: "packages/static/assets/types",
    because:
      "the declaration bundles handed to the in-memory pattern compiler. " +
      "They redeclare what `packages/html` declares and use " +
      "ambient-context forms that do not compile beside the tree they " +
      "describe.",
  },
];

/** The owning scope of a checked path: the workspace member's name. */
export function scopeOfPath(checkPath: string): string {
  const parts = checkPath.split("/");
  if (parts[0] === "packages") {
    if (parts[1] === "connectors") {
      return parts.slice(1, 4).join("/");
    }
    return parts[1] ?? "repo";
  }
  return parts[0] ?? "repo";
}

/** Every checked path, repository-relative, grouped by owning scope. */
export async function collectPathsByScope(
  root: string = Deno.cwd(),
): Promise<Map<string, string[]>> {
  const paths: string[] = [...DIRS];
  for (const pattern of GLOBS) {
    for await (
      const entry of expandGlob(pattern, { root, includeDirs: false })
    ) {
      paths.push(
        entry.path.startsWith(root)
          ? entry.path.slice(root.length + 1)
          : entry.path,
      );
    }
  }
  const byScope = new Map<string, string[]>();
  for (const checkPath of paths.sort()) {
    const scope = scopeOfPath(checkPath);
    const group = byScope.get(scope);
    if (group === undefined) {
      byScope.set(scope, [checkPath]);
    } else {
      group.push(checkPath);
    }
  }
  return byScope;
}

interface GroupResult {
  scope: string;
  durationMs: number;
  success: boolean;
  output: string;
}

/** Runs one scope's `deno check`; a spawn failure is that group's failure. */
export async function checkGroup(
  scope: string,
  paths: string[],
  reload: boolean,
  execPath: string = Deno.execPath(),
  cwd: string = Deno.cwd(),
): Promise<GroupResult> {
  const startedAt = performance.now();
  const args = ["check", ...(reload ? ["--reload"] : []), ...paths];
  let success = false;
  let output = "";
  try {
    // The paths are collected relative to the tree they were found in,
    // so the check runs there. Without this a caller pointing at another
    // tree would collect that tree's paths and check this one's.
    const result = await new Deno.Command(execPath, {
      args,
      cwd,
      env: { DENO_V8_FLAGS: "--max-old-space-size=8192" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    success = result.success;
    output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
  } catch (error) {
    output = String(error);
  }
  return {
    scope,
    durationMs: performance.now() - startedAt,
    success,
    output,
  };
}

export interface TypecheckOptions {
  list?: boolean;
  reload?: boolean;
  check?: typeof checkGroup;

  /** The tree the paths were collected from, and so the tree to check. */
  root?: string;

  /**
   * Spool one typecheck record per scope.
   *
   * The task's entry point sets this: the scopes it collected are the
   * repository's packages. A caller inside another test leaves it unset,
   * because the scopes it hands over are that test's fixtures, and a
   * fixture is data rather than a check of this repository.
   */
  recordResults?: boolean;
}

/**
 * Checks every group over a bounded worker pool, recording each scope's
 * verdict, and returns whether all of them passed.
 */
export async function runTypecheck(
  byScope: ReadonlyMap<string, string[]>,
  options: TypecheckOptions = {},
): Promise<boolean> {
  if (options.list === true) {
    // Prints every checked path with its scope, for auditing what the
    // groups cover.
    for (const [scope, paths] of byScope) {
      for (const checkPath of paths) {
        console.log(`${scope}\t${checkPath}`);
      }
    }
    return true;
  }
  const check = options.check ?? checkGroup;
  const reload = options.reload === true;
  const total = [...byScope.values()].reduce(
    (sum, group) => sum + group.length,
    0,
  );
  if (total === 0) {
    console.error("No files to check?! (Project is in an odd state.)");
    return false;
  }
  if (reload) {
    console.log("Reloading Deno dependencies before checking...");
  }
  console.log(
    `Type checking ${total} paths in ${byScope.size} package groups...`,
  );

  const recordsFragment = options.recordResults === true
    ? FragmentWriter.openForRun()
    : undefined;
  const scopes = [...byScope.keys()];
  const results: GroupResult[] = [];
  let next = 0;
  // Capped: each worker is a deno check with an 8 GB heap ceiling, and a
  // many-core workstation does not want eight of those at once.
  const workerCount = Math.min(
    4,
    Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)),
    scopes.length,
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < scopes.length) {
      const scope = scopes[next++]!;
      const result = await check(
        scope,
        byScope.get(scope)!,
        reload,
        Deno.execPath(),
        options.root ?? Deno.cwd(),
      );
      results.push(result);
      recordsFragment?.append({
        line: "record",
        test: { k: "typecheck", s: scope, n: "deno-check" },
        outcome: result.success ? "pass" : "fail",
        durationMs: Math.round(result.durationMs),
      });
      console.log(
        `${result.success ? "ok" : "FAILED"}  ${scope} ` +
          `(${(result.durationMs / 1000).toFixed(1)}s)`,
      );
    }
  });
  await Promise.all(workers);
  recordsFragment?.close();

  const failed = results.filter((result) => !result.success);
  for (const result of failed) {
    console.error(`\nType errors in ${result.scope}:`);
    console.error(result.output.trimEnd());
  }
  if (failed.length > 0) {
    console.error(
      `\nType check failed in ${failed.length} of ${results.length} groups.`,
    );
    return false;
  }
  console.log("Type check complete.");
  return true;
}

/**
 * The scopes named on the command line, or every scope when none are.
 * A continuous-integration lane is given part of the repository to check
 * and names the groups it was given; a person running the task names
 * none and checks the whole tree.
 */
export function selectScopes(
  byScope: ReadonlyMap<string, string[]>,
  args: readonly string[],
): Map<string, string[]> {
  const named = args
    .filter((arg) => arg.startsWith("--scope="))
    .map((arg) => arg.slice("--scope=".length));
  if (named.length === 0) return new Map(byScope);
  const selected = new Map<string, string[]>();
  for (const scope of named) {
    const paths = byScope.get(scope);
    if (paths === undefined) {
      throw new Error(`no such type-check scope: ${scope}`);
    }
    selected.set(scope, paths);
  }
  return selected;
}

/**
 * Runs the check the way the command line runs it, and answers with the
 * status it would exit with rather than exiting from inside itself.
 */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = Deno.cwd(),
  options: TypecheckOptions = {},
): Promise<number> {
  const passed = await runTypecheck(
    selectScopes(await collectPathsByScope(root), args),
    {
      list: args.includes("--list"),
      reload: (Deno.env.get("DENO_CHECK_RELOAD") ?? "") !== "",
      recordResults: true,
      root,
      ...options,
    },
  );
  return passed ? 0 : 1;
}

// `Deno.exitCode` rather than `Deno.exit`, which would end the process
// before the unload handlers run — and one of those is what writes a
// test run's name map into its spool.
if (import.meta.main) Deno.exitCode = await main();
