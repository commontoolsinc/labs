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
 * The runner's test files read a global `clock`, declared ambiently in
 * packages/runner/test/clock.d.ts with no import anywhere. `tasks/check.sh`
 * sees that declaration because it checks the package directory as one
 * program; checking a handful of files on their own does not, and every such
 * file then fails with "Cannot find name 'clock'". Pass the declaration
 * alongside so the check matches what CI does.
 *
 * This differs from the two skips above in what the file needs, not in how
 * much it deserves checking. Those files are checked by machinery better
 * suited to them and could only be checked worse here; these need one more
 * file in the same invocation, which is cheap and exact.
 */
const AMBIENT_DECLARATIONS: Array<[prefix: string, declaration: string]> = [
  ["packages/runner/test/", "packages/runner/test/clock.d.ts"],
];

function ambientDeclarationsFor(paths: string[]): string[] {
  return AMBIENT_DECLARATIONS
    .filter(([prefix, declaration]) =>
      paths.some((p) => p.startsWith(prefix) && p !== declaration)
    )
    .map(([, declaration]) => declaration);
}

/** Files `deno check` can be pointed at individually. */
export function typeCheckable(files: string[]): string[] {
  return files.filter((f) =>
    /\.(ts|tsx)$/.test(f) && !isSchemaFixtureInput(f) && !isStaticTypeAsset(f)
  );
}

async function runDeno(
  worktree: string,
  label: string,
  args: string[],
): Promise<string | null> {
  const result = await new Deno.Command("deno", {
    args,
    cwd: worktree,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) return null;
  const stderr = new TextDecoder().decode(result.stderr);
  // Every path was excluded by deno.jsonc — nothing was actually checked.
  if (stderr.includes("No target files found")) return null;
  const stdout = new TextDecoder().decode(result.stdout);
  return `${label}:\n${stdout || stderr}`;
}

/**
 * Run fmt/lint/check over `files`, relative to `worktree`. Returns one string
 * per failing check, empty when everything passed.
 *
 * `deno fmt --check`, never `deno fmt`: the caller is told what to reformat and
 * decides whether to do it.
 */
export async function checkFiles(
  worktree: string,
  candidates: string[],
): Promise<string[]> {
  // A path that is not there cannot be checked, and pointing deno at one turns
  // into a reported failure that reads like a real defect. Callers legitimately
  // arrive with such paths: a subagent's transcript records every file it ever
  // wrote, including scratch files it went on to delete.
  const files = candidates.filter((f) => {
    try {
      Deno.statSync(`${worktree}/${f}`);
      return true;
    } catch {
      return false;
    }
  });
  if (files.length === 0) return [];
  const tsFiles = typeCheckable(files);

  const results = await Promise.all([
    runDeno(worktree, "Formatting issues found", ["fmt", "--check", ...files]),
    runDeno(worktree, "Lint errors", ["lint", ...files]),
    tsFiles.length > 0
      ? runDeno(worktree, "Type check failed", [
        "check",
        ...ambientDeclarationsFor(tsFiles),
        ...tsFiles,
      ])
      : null,
  ]);

  const errors = results.filter((e): e is string => e !== null);

  // Formatting is the one failure with a one-command remedy, and `--check`
  // names the files but not the fix. Spell it out, scoped to these files, so
  // the fix stays as narrow as the report.
  if (errors.some((e) => e.startsWith("Formatting issues found"))) {
    errors.push(`To fix formatting:\n  deno fmt ${files.join(" ")}`);
  }

  return errors;
}
