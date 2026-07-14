#!/usr/bin/env -S deno run --allow-read
//
// Guards against new use of the polling `waitFor` helper in integration tests.
//
// `waitFor` (defined in packages/integration/utils.ts, exported from
// "@commonfabric/integration") re-runs a predicate every 50 milliseconds — in a
// browser test each tick is a DevTools Protocol round-trip — and throws once a
// timeout elapses. An earlier change moved the browser suites off it and onto
// event-driven waits (`waitForCondition`, `awaitViewSettled`, and the wrappers
// in packages/patterns/integration/cfc-browser-helpers.ts). This check keeps new
// tests from importing the polling helper again.
//
// A file is in scope when it lives under an `integration/` directory somewhere
// beneath `packages/`, excluding the `@commonfabric/integration` package itself,
// which defines and re-exports `waitFor`. An in-scope file fails the check when
// it names `waitFor` in an import from "@commonfabric/integration" and is not on
// the ALLOWLIST below.
//
// The ALLOWLIST holds the files that are exempt from this check; the reason for
// each is recorded in the "Where a bounded poll is the right tool" section of
// docs/development/waiting-in-tests.md.
//
// Usage: deno run --allow-read ./tasks/check-no-waitfor.ts

import { walk } from "@std/fs/walk";
import { dirname, fromFileUrl, relative, resolve } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// Files exempt from this check: they keep the polling `waitFor` from
// "@commonfabric/integration". Each entry is a repo-relative path; the reason
// for each is documented under "Where a bounded poll is the right tool" in
// docs/development/waiting-in-tests.md.
export const ALLOWLIST: ReadonlySet<string> = new Set([
  // Headless cell pull: no page to attach an in-page waiter to.
  "packages/generated-patterns/integration/pattern-harness.ts",
  // Off-page piece-result cell reads through the in-process controller.
  "packages/shell/integration/piece.test.ts",
  // Cross-page joint condition: the wait spans two separate browser pages, which
  // a single-page in-page waiter cannot express.
  "packages/patterns/integration/lunch-poll-vote.test.ts",
  // Process-global Toolshed pool health has no subscription or page event; the
  // rollout profile must fence asynchronous drains before creating its demand.
  "packages/patterns/integration/server-primary-rollout-profile.test.ts",
  // MockDoc rendered-HTML reads and fresh cell.sync() round-trips, with no
  // completion callback the test can hook.
  "packages/runtime-client/integration/client.test.ts",
  // Instrumentation and profiling one-shots, shared button-click helpers used
  // both wrapped and bare, and render/source-state probe waits.
  "packages/patterns/integration/default-app.test.ts",
  "packages/patterns/integration/reload/default-app-notebook.test.ts",
  // Pre-existing OAuth end-to-end flow, predating the move to event-driven waits.
  "packages/patterns/google/core/integration/google-calendar-importer.test.ts",
  // Disabled tests: never run, so migrating them only churns dead code.
  "packages/patterns/integration/cf-checkbox.test.disabled.ts",
  "packages/patterns/integration/cf-code-editor.test.disabled.ts",
  "packages/patterns/integration/cf-render.test.disabled.ts",
]);

// Matches an import from exactly "@commonfabric/integration" and captures the
// named-imports clause between the braces. A leading default import and a
// `type` modifier are tolerated. The closing quote right after `integration`
// keeps subpath specifiers (".../shell-utils") from matching, and `[^}]*` keeps
// the capture from bleeding past the end of the clause.
const NAMED_IMPORT_RE =
  /import\s+(?:[\w$]+\s*,\s*)?(?:type\s+)?\{([^}]*)\}\s*from\s*["']@commonfabric\/integration["']/g;

// Removes `//` and `/* */` comments from a named-imports clause. Such a clause
// holds only identifiers, `as`, `type`, and commas, so a `waitFor` inside a
// comment is a commented-out member rather than a real import.
function stripComments(clause: string): string {
  return clause
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * Returns true when `source` imports the polling `waitFor` as a named import
 * from "@commonfabric/integration". `waitForCondition`, `waitForText`, and other
 * `waitFor`-prefixed names do not count; a `waitFor` on a subpath specifier or a
 * `harness.waitFor(...)` member call does not count either.
 */
export function importsPollingWaitFor(source: string): boolean {
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    if (/\bwaitFor\b/.test(stripComments(match[1]))) return true;
  }
  return false;
}

/**
 * Returns true when `relPath` (a repo-relative, forward-slash path) is an
 * integration test in scope for this check: under `packages/`, inside an
 * `integration/` directory, a `.ts` file, and not part of the
 * `@commonfabric/integration` package that defines `waitFor`.
 */
export function isIntegrationTestFile(relPath: string): boolean {
  const path = relPath.replaceAll("\\", "/");
  if (!path.startsWith("packages/")) return false;
  // The package that defines and re-exports `waitFor`.
  if (path.startsWith("packages/integration/")) return false;
  if (!path.includes("/integration/")) return false;
  return path.endsWith(".ts");
}

export interface ScanResult {
  /** In-scope files importing the polling `waitFor` that are not allowlisted. */
  violations: string[];
  /** In-scope files importing the polling `waitFor` that are allowlisted. */
  allowlisted: string[];
}

/** Scans integration tests under `root`/packages for polling-`waitFor` use. */
export async function scan(root: string = REPO_ROOT): Promise<ScanResult> {
  const violations: string[] = [];
  const allowlisted: string[] = [];
  const packagesDir = resolve(root, "packages");
  const walker = walk(packagesDir, {
    includeDirs: false,
    skip: [/\/node_modules\//, /\/dist\//, /\/\.cache\//, /\/coverage\//],
  });
  for await (const entry of walker) {
    const rel = relative(root, entry.path).replaceAll("\\", "/");
    if (!isIntegrationTestFile(rel)) continue;
    const source = await Deno.readTextFile(entry.path);
    if (!importsPollingWaitFor(source)) continue;
    (ALLOWLIST.has(rel) ? allowlisted : violations).push(rel);
  }
  violations.sort();
  allowlisted.sort();
  return { violations, allowlisted };
}

function reportViolations(violations: string[]): void {
  const lines = [
    "",
    'New use of the polling `waitFor` from "@commonfabric/integration" in ' +
    "integration test(s):",
    "",
    ...violations.map((path) => `  ${path}`),
    "",
    "The polling `waitFor` re-runs a predicate every 50ms, and in a browser test",
    "each tick is a DevTools round-trip, which makes tests slow and flaky. In a",
    "browser test, use an event-driven wait instead:",
    "",
    "  - waitForCondition(page, predicate, opts) — resolves the instant the DOM",
    "    reflects the new state.",
    "  - awaitViewSettled(page) — resolves once the view is interactive.",
    "  - waitForText / clickCfButton / clickCfButtonAndWaitForText / … in",
    "    packages/patterns/integration/cfc-browser-helpers.ts.",
    "",
    "In a test with no page, resolve a defer() from a callback the test already",
    "registers (a cell sink, a subscription's next, a scheduler onError) instead",
    "of polling.",
    "",
    "See docs/development/waiting-in-tests.md for the rationale and the full",
    "toolkit.",
    "",
    "If an event-driven wait genuinely cannot express this (for example a",
    "cross-page condition or a headless cell read), add the file to ALLOWLIST in",
    "tasks/check-no-waitfor.ts with a one-line reason and record it under",
    '"Where a bounded poll is the right tool" in docs/development/waiting-in-tests.md.',
    "",
  ];
  console.error(lines.join("\n"));
}

/** Runs the check over `root`/packages, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const { violations } = await scan(root);
  if (violations.length > 0) {
    reportViolations(violations);
    return 1;
  }
  console.log(
    `No new polling waitFor in integration tests ` +
      `(${ALLOWLIST.size} allowlisted exception(s)).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
