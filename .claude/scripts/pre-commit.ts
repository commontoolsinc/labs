#!/usr/bin/env -S deno run --allow-read --allow-run
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code Pre-Tool hook.
 * - Intercepts `git commit` commands.
 * - Runs `deno check`, `deno fmt`, and `deno lint` scoped to staged files.
 * - Exits 2 to block the commit if checks fail.
 * - Tests are skipped (CI will run them).
 */

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
try {
  const payload = JSON.parse(rawInput);
  cmd = payload?.tool_input?.command ?? "";
} catch {
  // If the JSON is malformed we allow the call rather than choke the hook.
  Deno.exit(0);
}

// Only intercept git commit commands
if (!/\bgit\s+commit\b/.test(cmd)) {
  Deno.exit(0);
}

// Skip if using --no-verify
if (/--no-verify/.test(cmd)) {
  Deno.exit(0);
}

// Skip if this is an amend with no changes (e.g., just editing message)
if (/--amend\s+--no-edit/.test(cmd) || /--amend\s+-C/.test(cmd)) {
  Deno.exit(0);
}

// Get staged files to scope checks
const diffResult = await new Deno.Command("git", {
  args: ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
  stdout: "piped",
  stderr: "piped",
}).output();

const stagedFiles = new TextDecoder()
  .decode(diffResult.stdout)
  .trim()
  .split("\n")
  .filter((f) => f.length > 0);

if (stagedFiles.length === 0) {
  // Nothing staged, let git handle it
  Deno.exit(0);
}

const tsFiles = stagedFiles.filter((f) =>
  /\.(ts|tsx)$/.test(f) && !f.startsWith("packages/vendor-astral")
);
const fmtableFiles = stagedFiles.filter((f) =>
  /\.(ts|tsx|json|md|jsonc)$/.test(f)
);

// For type checking, scope to containing packages (not just individual files)
// so we catch breakage in files that depend on the staged changes.
const affectedPackages = new Set<string>();
for (const f of tsFiles) {
  const match = f.match(/^(packages\/[^/]+)\//);
  if (match) {
    affectedPackages.add(match[1]);
  }
}

console.error(
  `Running pre-commit checks on ${stagedFiles.length} staged files` +
    (affectedPackages.size > 0
      ? ` (type-checking ${affectedPackages.size} package(s): ${[...affectedPackages].join(", ")})`
      : "") +
    "...",
);

const errors: string[] = [];

// Auto-fix formatting on staged files (fast)
if (fmtableFiles.length > 0) {
  const fmtResult = await new Deno.Command("deno", {
    args: ["fmt", ...fmtableFiles],
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!fmtResult.success) {
    errors.push("Formatting failed (syntax error?):");
    errors.push(new TextDecoder().decode(fmtResult.stderr));
  }
}

// Run type check and lint in parallel
const promises: Promise<{ kind: string; result: Deno.CommandOutput }>[] = [];

if (affectedPackages.size > 0) {
  // Type-check entire affected packages to catch reverse-dependency breakage
  promises.push(
    new Deno.Command("deno", {
      args: ["check", ...[...affectedPackages]],
      stdout: "piped",
      stderr: "piped",
    }).output().then((result) => ({ kind: "check", result })),
  );
}

if (tsFiles.length > 0) {
  // Lint only the staged files (lint is per-file, no cross-file concerns)
  promises.push(
    new Deno.Command("deno", {
      args: ["lint", ...tsFiles],
      stdout: "piped",
      stderr: "piped",
    }).output().then((result) => ({ kind: "lint", result })),
  );
}

const results = await Promise.all(promises);

for (const { kind, result } of results) {
  if (!result.success) {
    if (kind === "check") {
      errors.push("Type check failed:");
      errors.push(new TextDecoder().decode(result.stderr));
    } else {
      errors.push("Lint errors found:");
      errors.push(new TextDecoder().decode(result.stdout));
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  Deno.exit(2);
}

console.error("All pre-commit checks passed.");
Deno.exit(0);
