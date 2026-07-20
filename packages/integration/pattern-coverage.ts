/**
 * Authored-pattern coverage for the browser-driven integration suites.
 *
 * The pattern's statements execute in the shell's runtime Web Worker, which has
 * no filesystem, so the hits have to come back across two boundaries before this
 * process can write LCOV: the worker's (a `GetPatternCoverage` request) and the
 * browser's (a `page.evaluate`). Both are crossed once per page at teardown —
 * the worker accumulates hits locally and hands over the whole report, rather
 * than reporting each hit as it happens.
 *
 * See docs/development/COVERAGE.md.
 */
import { fromFileUrl, join, resolve } from "@std/path";
import {
  PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  PatternCoverageCollector,
  type PatternCoverageData,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import type { Page } from "./page.ts";
// Declares the `commonfabric` page global the dump below reads.
import "../shell/src/globals.ts";

/**
 * The authored patterns' root. Span file names are relative to it, so it is what
 * turns them back into repository paths the coverage gate can match against its
 * source walk. Resolved from this module rather than the working directory,
 * which differs between the two integration jobs.
 */
export const PATTERNS_ROOT: string = fromFileUrl(
  new URL("../patterns", import.meta.url),
);

/**
 * The URL prefix Toolshed serves patterns under (PATTERNS_ROUTE_PREFIX in
 * packages/toolshed/routes/patterns/patterns-server.ts). A pattern the worker
 * fetched over HTTP is named by its URL pathname, so its spans carry this
 * prefix; a pattern resolved from disk by the test process is named relative to
 * the patterns root already. Stripping the prefix maps the first shape onto the
 * second, and both then resolve against PATTERNS_ROOT.
 */
const PATTERNS_ROUTE_PREFIX = "/api/patterns/";

/**
 * Every page's hits merge here. Realms share one span-id keyspace — they run the
 * same instrumented bytes, which carry the file name and span id of whichever
 * realm compiled them — so a page that only warm-loaded bytes still reports hits
 * that land on another page's spans.
 */
const collector = new PatternCoverageCollector();

/** Where to write the LCOV, or undefined when this run collects no coverage. */
export function patternCoverageDir(): string | undefined {
  const dir = Deno.env.get("CF_PATTERN_COVERAGE_DIR");
  return dir ? resolve(Deno.cwd(), dir) : undefined;
}

/**
 * The collector for a runtime this test process runs itself, or undefined when
 * the run collects no coverage. It is the same collector the browser dumps merge
 * into, so both realms' hits reach one report.
 *
 * Handing this to a pieces controller matters for more than its own coverage:
 * the pieces it creates are stored under the instrumented cached variant, so a
 * browser collecting coverage against that space warm-loads them. Without it
 * every browser misses the ordinary variant and cold-compiles each pattern —
 * including the space-root default pattern that `ensureDefaultPattern` exists to
 * compile once — which wedges each worker's event loop for seconds.
 */
export function patternCoverageCollector():
  | PatternCoverageCollector
  | undefined {
  return patternCoverageDir() === undefined ? undefined : collector;
}

/** One file per test process; `deno test` runs a shard's files in one process. */
function outputPath(dir: string): string {
  return join(dir, `pattern-integration-${Deno.pid}.pattern-coverage.lcov`);
}

export function withRepositoryFileNames(
  data: PatternCoverageData,
): PatternCoverageData {
  const rename = (fileName: string) =>
    fileName.startsWith(PATTERNS_ROUTE_PREFIX)
      ? `/${fileName.slice(PATTERNS_ROUTE_PREFIX.length)}`
      : fileName;
  return {
    spans: data.spans.map((span) => ({
      ...span,
      fileName: rename(span.fileName),
    })),
    hits: data.hits.map((hit) => ({ ...hit, fileName: rename(hit.fileName) })),
  };
}

/**
 * Turn on worker pattern coverage for this page. Read before the worker runtime
 * is constructed (at login), so this must run after navigation and before the
 * page logs in. A no-op unless the run collects coverage.
 */
export async function enablePatternCoverage(page: Page): Promise<void> {
  if (patternCoverageDir() === undefined) return;
  await page.evaluate(() => {
    globalThis.localStorage.setItem("patternCoverage", "true");
  });
}

/**
 * Pull one page's accumulated hits and rewrite the merged LCOV. Must run before
 * the page's runtime is disposed, which takes the worker's collector with it.
 *
 * Best-effort: a page that never booted a runtime, or whose worker is already
 * gone, contributes nothing rather than failing the test it is tearing down.
 * Rewriting the whole merged report on every dump keeps the file complete
 * without needing a process-exit hook.
 */
export async function collectPatternCoverage(page: Page): Promise<void> {
  const dir = patternCoverageDir();
  if (dir === undefined) return;

  // `noRuntime` and a null report are different failures: the first is a page
  // that never booted a runtime (nothing to collect, and normal), the second is
  // a worker built without a collector — i.e. the flag above never reached it,
  // which would otherwise look exactly like a pattern that ran no lines.
  let result: { noRuntime: true } | { data: PatternCoverageData | null };
  try {
    result = await page.evaluate(async () => {
      const rt = globalThis.commonfabric?.rt;
      if (!rt?.getPatternCoverage) return { noRuntime: true as const };
      return { data: await rt.getPatternCoverage() };
    }) as { noRuntime: true } | { data: PatternCoverageData | null };
  } catch {
    return;
  }
  if ("noRuntime" in result) return;

  const data = result.data;
  if (data === null) {
    console.warn(
      "[pattern-coverage] CF_PATTERN_COVERAGE_DIR is set but this page's " +
        "worker was built without a collector, so its pattern coverage is " +
        "lost. The host flag did not reach the worker's InitializationData.",
    );
    return;
  }
  if (data.spans.length === 0) return;

  collector.ingest(data);
  await writeMergedPatternCoverage(dir);
}

/**
 * Write every realm's hits as one LCOV.
 *
 * The rename happens here rather than as each realm reports, because the realms
 * do not all arrive through `ingest`: a runtime this process runs registers its
 * spans into the shared collector directly, as it compiles. Renaming on the way
 * in would cover the browser dumps and miss those.
 */
async function writeMergedPatternCoverage(dir: string): Promise<void> {
  const renamed = new PatternCoverageCollector();
  renamed.ingest(withRepositoryFileNames(collector.toData()));
  await writePatternCoverageLcov(renamed, outputPath(dir), {
    root: PATTERNS_ROOT,
    testName: PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  });
  await warnOnUnmappedRecords(outputPath(dir));
}

/**
 * Report any record whose source path does not exist in the checkout. The gate
 * matches records to files it walked, so such a record is not wrong-looking —
 * it simply matches nothing, and the coverage it carries is dropped silently.
 * Synthetic `cf-mount/` paths name a mounted module by identity and have no
 * file to find, so they are not checked.
 */
async function warnOnUnmappedRecords(lcovPath: string): Promise<void> {
  const paths = (await Deno.readTextFile(lcovPath))
    .split("\n")
    .filter((line) => line.startsWith("SF:"))
    .map((line) => line.slice(3))
    .filter((path) => path.startsWith("/"));

  const missing: string[] = [];
  for (const path of paths) {
    if (!await Deno.stat(path).then((s) => s.isFile).catch(() => false)) {
      missing.push(path);
    }
  }
  if (missing.length === 0) return;
  console.warn(
    `[pattern-coverage] ${missing.length} record(s) name a file that is not ` +
      `in this checkout, so the gate will not credit their coverage:\n` +
      missing.map((path) => `  ${path}`).join("\n"),
  );
}
