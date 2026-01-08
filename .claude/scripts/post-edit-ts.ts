#!/usr/bin/env -S deno run --allow-read --allow-run
/**
 * .claude/scripts/post-edit-ts.ts
 *
 * Claude Code Post-Tool hook for Write|Edit.
 * - Runs `deno check <file>` on TypeScript files after editing.
 * - Runs `deno fmt <file>` to auto-format.
 * - Reports type errors via exit code 2.
 */

const rawInput = await new Response(Deno.stdin.readable).text();

let filePath = "";
try {
  const payload = JSON.parse(rawInput);
  filePath = payload?.tool_input?.file_path ?? "";
} catch {
  // If the JSON is malformed we allow the call.
  Deno.exit(0);
}

// Only process .ts files (not .d.ts, not .tsx which has its own handling)
if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) {
  Deno.exit(0);
}

// Skip if the file is in node_modules or vendor
if (filePath.includes("node_modules") || filePath.includes("/vendor/")) {
  Deno.exit(0);
}

// Run deno check on the file
const check = new Deno.Command("deno", {
  args: ["check", filePath],
  stdout: "piped",
  stderr: "piped",
});
const checkResult = await check.output();

if (!checkResult.success) {
  const stderr = new TextDecoder().decode(checkResult.stderr);
  console.error(`Type errors in ${filePath}:\n${stderr}`);
  Deno.exit(2); // Block and show error to Claude
}

// Auto-format the file (non-blocking - we don't fail on format issues)
const fmt = new Deno.Command("deno", {
  args: ["fmt", filePath],
  stdout: "piped",
  stderr: "piped",
});
await fmt.output();

Deno.exit(0);
