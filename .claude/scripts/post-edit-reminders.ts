#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/post-edit-reminders.ts
 *
 * Claude Code Post-Tool hook for Write|Edit.
 * - Provides context reminders for .tsx files (pattern development).
 * - Provides context reminders for packages/ui files (lit-component skill).
 * - Uses JSON output with additionalContext.
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
    "Pattern development: Documentation is available in docs/common/PATTERNS.md and docs/common/COMPONENTS.md.",
    "Use /start-local-dev to start local dev servers for testing patterns.",
  );
}

// Check for packages/ui files
if (filePath.includes("packages/ui/")) {
  reminders.push(
    "UI component development: The `lit-component` skill provides guidance for Common UI v2 components.",
    "Use /lit-component to load the skill if you need help with Lit components, theme integration, or Cell abstractions.",
  );
}

// Output reminders if any
if (reminders.length > 0) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminders.join("\n"),
    },
  }));
}

Deno.exit(0);
