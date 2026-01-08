#!/usr/bin/env -S deno run --allow-read --allow-run
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code Pre-Tool hook.
 * - Intercepts `git commit` commands.
 * - Runs `deno task check` and `deno task test` before allowing the commit.
 * - Exits 2 to block the commit if checks fail.
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

// Skip if this is an amend with no changes (e.g., just editing message)
if (/--amend\s+--no-edit/.test(cmd) || /--amend\s+-C/.test(cmd)) {
  Deno.exit(0);
}

console.error("Running pre-commit checks...");

// Run type checking
const check = new Deno.Command("deno", {
  args: ["task", "check"],
  stdout: "piped",
  stderr: "piped",
});
const checkResult = await check.output();

if (!checkResult.success) {
  console.error("Type check failed. Please fix type errors before committing:");
  console.error(new TextDecoder().decode(checkResult.stderr));
  Deno.exit(2);
}

// Run tests
const test = new Deno.Command("deno", {
  args: ["task", "test"],
  stdout: "piped",
  stderr: "piped",
});
const testResult = await test.output();

if (!testResult.success) {
  console.error("Tests failed. Please fix failing tests before committing:");
  console.error(new TextDecoder().decode(testResult.stderr));
  console.error(new TextDecoder().decode(testResult.stdout));
  Deno.exit(2);
}

console.error("All pre-commit checks passed.");
Deno.exit(0);
