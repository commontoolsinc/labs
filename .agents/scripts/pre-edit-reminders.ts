#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/pre-edit-reminders.ts
 *
 * Claude Code Pre-Tool hook for Write|Edit.
 * - Provides context reminders BEFORE editing .tsx files (pattern development).
 * - Provides context reminders BEFORE editing packages/ui files (lit-component skill).
 * - Allows the edit but shows reminder context.
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

const reminders: string[] = [];

// Check for .tsx files (pattern development)
if (filePath.endsWith(".tsx")) {
  reminders.push(
    "Pattern docs: docs/common/patterns/, docs/common/components/COMPONENTS.md",
    "Test with /start-local-dev",
  );
}

// Check for packages/ui files
if (filePath.includes("packages/ui/")) {
  reminders.push(
    "UI components: use /lit-component skill for Lit, theme, and Cell guidance",
  );
}

// Output reminders if any - use PreToolUse schema
if (reminders.length > 0) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reminders.join(" | "),
    },
  }));
}

Deno.exit(0);
