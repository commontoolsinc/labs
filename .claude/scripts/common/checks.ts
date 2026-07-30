/**
 * The fmt/lint/check battery, scoped to a file list and a worktree.
 *
 * Shared by the pre-commit and subagent-stop hooks so that the two agree on
 * which files a check can meaningfully be pointed at. Every check here is
 * read-only: a hook that reformats the tree it is inspecting turns a report
 * into an edit, and an edit nobody asked for in a tree nobody is working in.
 */

/**
 * Schema-generator fixture inputs use bare Cell/Stream/Writable types injected
 * by a custom TypeScript compiler host (CELL_BRAND_PRELUDE in
 * schema-generator/test/utils.ts), so `deno check` cannot resolve them: the
 * prelude is a template string, not a file it can be pointed at.
 *
 * They are checked, just not here. `test/fixtures-runner.test.ts` batch
 * type-checks every one of them through that same host on each run of the
 * package's tests, on by default and disabled only with SKIP_INPUT_CHECK. That
 * is the stricter of the two checks, because it is the compiler the generator
 * itself uses. Skip them rather than teaching this hook a second, weaker way to
 * check them — a copy of the prelude here would be a second source of truth
 * free to drift from the one that matters.
 */
function isSchemaFixtureInput(path: string): boolean {
  return path.includes("schema-generator/test/fixtures/") &&
    path.endsWith(".input.ts");
}

/**
 * The static type assets are what the pattern compiler serves to authored code
 * as its standard library and type modules, not modules of this repo. `.d.ts`
 * ends in `.ts`, so they reach this filter. Checking them declares a second
 * standard library alongside Deno's own: `es2023.d.ts` redeclares `lib.es5`
 * members with different types, and `jsx.d.ts` and `commonfabric.d.ts` fail on
 * their own too. `deno.jsonc` keeps this directory out of fmt and lint, and
 * `tasks/check.sh` never lists it.
 *
 * The one file here that is not a declaration, `types/cfc.ts`, is also covered
 * elsewhere and in a way that matters more: it is generated from
 * packages/api/cfc-authoring.ts, and `deno task check-cfc-types` regenerates it
 * and fails on any difference. CI runs that. A `deno check` here would say only
 * that it parses, never that it still mirrors the authoring surface.
 */
function isStaticTypeAsset(path: string): boolean {
  return path.includes("packages/static/assets/");
}

/**
 * Test files read globals — `clock`, `TestContext.settle` — declared ambiently
 * in a `.d.ts` beside them with no import anywhere. `tasks/check.sh` sees those
 * declarations because it checks the package directory as one program; checking
 * a handful of files on their own does not, and every such file then fails with
 * "Cannot find name 'clock'". Pass the declarations alongside so the check
 * matches what CI does.
 *
 * This differs from the two skips above in what the file needs, not in how much
 * it deserves checking. Those files are checked by machinery better suited to
 * them and could only be checked worse here; these need one more file in the
 * same invocation, which is cheap and exact.
 *
 * Discovered from the tree rather than listed. A hardcoded list named only
 * packages/runner, so editing a test under packages/background-piece-service or
 * packages/html — both of which have their own test/clock.d.ts — failed the
 * check for a global that is in fact declared. A list is also a thing to
 * forget: the next package to grow a test/*.d.ts would break the same way.
 */
function ambientDeclarationsFor(
  worktree: string,
  paths: string[],
): string[] {
  const declarations = new Set<string>();
  const testDirs = new Set(
    paths.map((p) => p.match(/^(.*\/test)\//)?.[1]).filter((d) =>
      d !== undefined
    ),
  );
  for (const dir of testDirs) {
    let entries: Iterable<Deno.DirEntry>;
    try {
      entries = Deno.readDirSync(`${worktree}/${dir}`);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".d.ts")) continue;
      const declaration = `${dir}/${entry.name}`;
      // Already being checked in its own right; passing it twice is an error.
      if (!paths.includes(declaration)) declarations.add(declaration);
    }
  }
  return [...declarations].sort();
}

/** Files `deno check` can be pointed at individually. */
export function typeCheckable(files: string[]): string[] {
  return files.filter((f) =>
    /\.(ts|tsx)$/.test(f) && !isSchemaFixtureInput(f) && !isStaticTypeAsset(f)
  );
}

const FORMATTING_LABEL = "Formatting issues found";

/**
 * What one `deno` invocation did: failed with output, passed over a known number
 * of files, or ran on nothing.
 *
 * The count matters. deno silently narrows a file list to what its config
 * includes, so a mixed list — one excluded path, one real one — exits 0 having
 * looked at half of it. Reporting that as a clean pass over the whole list is
 * the exact laundering this type was introduced to stop, and it went on
 * happening because only the *all*-excluded case was detected.
 */
type Ran =
  | { failure: string; soft?: boolean }
  | { passed: true; sawFiles: number | null }
  | "no-targets";

/** deno's own tally of what it looked at, when it prints one. */
function filesSeen(output: string): number | null {
  const m = output.match(/Checked (\d+) file/);
  return m ? Number(m[1]) : null;
}

async function runDeno(
  worktree: string,
  label: string,
  args: string[],
): Promise<Ran> {
  let result: Deno.CommandOutput;
  try {
    result = await new Deno.Command("deno", {
      args,
      cwd: worktree,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    // Spawning can throw outright — argv past ARG_MAX is the reachable case.
    // An uncaught throw here exits non-zero, which for a PreToolUse hook is a
    // failure report on a commit that may be perfectly fine. Report and pass.
    return {
      failure: `${label} could not run:\n${
        error instanceof Error ? error.message : String(error)
      }`,
      soft: true,
    };
  }
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.success) {
    return { passed: true, sawFiles: filesSeen(stdout) ?? filesSeen(stderr) };
  }
  // Every path was excluded by config — nothing was actually checked. Not a
  // failure, but not a pass either, and the caller has to be able to say so.
  if (stderr.includes("No target files found")) return "no-targets";
  return { failure: `${label}:\n${stdout || stderr}` };
}

/** What `checkFiles` actually did — never just "it was fine". */
export interface CheckOutcome {
  /** Files that exist and were handed to deno. */
  checked: string[];
  /** Candidates that are not on disk, so could not be checked. */
  missing: string[];
  /** Checks that ran on nothing at all — no file here is theirs to look at. */
  inapplicable: string[];
  /** Checks that saw only some of the files, as "fmt (2 of 5)". */
  partial: string[];
  /** Checks that could not be launched at all. Report, never block. */
  unavailable: Array<{ check: string; message: string }>;
  /** One entry per failing check, plus a remedy line for formatting. */
  errors: string[];
}

function quoteForShell(path: string): string {
  return /^[\w./@:+-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Run fmt/lint/check over `candidates`, relative to `worktree`.
 *
 * `deno fmt --check`, never `deno fmt`: the caller is told what to reformat and
 * decides whether to do it.
 *
 * The outcome distinguishes checked from skipped from partial from inapplicable,
 * because the alternative is a gate that says "all checks passed" when it checked
 * nothing — which is how an unchecked change gets laundered into an approved one.
 * That is not hypothetical for this repo: `deno.jsonc` excludes `docs/` and
 * `packages/static/assets/` from fmt, so any commit mixing those with code gets a
 * partial pass that used to report as a whole one.
 */
export async function checkFiles(
  worktree: string,
  candidates: string[],
): Promise<CheckOutcome> {
  // A path that is not there cannot be checked, and pointing deno at one turns
  // into a reported failure that reads like a real defect. Callers legitimately
  // arrive with such paths: a subagent's transcript records every file it ever
  // wrote, including scratch files it went on to delete.
  const checked: string[] = [];
  const missing: string[] = [];
  for (const f of candidates) {
    try {
      Deno.statSync(`${worktree}/${f}`);
      checked.push(f);
    } catch (error) {
      // Only absence means "not ours to check". A permission or I/O error is a
      // real condition; dropping it here would delete a check silently, so let
      // the file through and let deno report whatever it finds.
      if (error instanceof Deno.errors.NotFound) missing.push(f);
      else checked.push(f);
    }
  }
  if (checked.length === 0) {
    return {
      checked,
      missing,
      inapplicable: [],
      partial: [],
      unavailable: [],
      errors: [],
    };
  }
  const tsFiles = typeCheckable(checked);

  const runs: Array<[label: string, expected: number, result: Ran]> = [];
  const [fmt, lint, check] = await Promise.all([
    runDeno(worktree, FORMATTING_LABEL, ["fmt", "--check", ...checked]),
    runDeno(worktree, "Lint errors", ["lint", ...checked]),
    tsFiles.length > 0
      ? runDeno(worktree, "Type check failed", [
        "check",
        ...ambientDeclarationsFor(worktree, tsFiles),
        ...tsFiles,
      ])
      : "no-targets" as Ran,
  ]);
  runs.push(["fmt", checked.length, fmt]);
  runs.push(["lint", checked.length, lint]);
  runs.push(["check", tsFiles.length, check]);

  const errors: string[] = [];
  const inapplicable: string[] = [];
  const partial: string[] = [];
  const unavailable: Array<{ check: string; message: string }> = [];
  for (const [label, expected, result] of runs) {
    if (result === "no-targets") {
      inapplicable.push(label);
    } else if ("passed" in result) {
      // A pass over fewer files than we asked about is a pass over fewer files
      // than we asked about, and has to read that way.
      if (result.sawFiles !== null && result.sawFiles < expected) {
        partial.push(`${label} (${result.sawFiles} of ${expected})`);
      }
    } else if (result.soft) {
      // A check that could not be launched is not a verdict on the code. Surface
      // it, but never block on it.
      unavailable.push({ check: label, message: result.failure });
    } else {
      errors.push(result.failure);
    }
  }

  // Formatting is the one failure with a one-command remedy, and `--check`
  // names the files but not the fix. Spell it out, scoped to these files, so
  // the fix stays as narrow as the report.
  if (errors.some((e) => e.startsWith(FORMATTING_LABEL))) {
    errors.push(
      `To fix formatting:\n  deno fmt ${checked.map(quoteForShell).join(" ")}`,
    );
  }

  return { checked, missing, inapplicable, partial, unavailable, errors };
}
