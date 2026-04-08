#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/pattern-user-post-bash.ts
 *
 * Claude Code PostToolUse hook for Bash on pattern-user subagent.
 * - Parses legacy ct command output and suggests next steps.
 */

const rawInput = await new Response(Deno.stdin.readable).text();
let input: {
  tool_input?: { command?: string };
  tool_response?: { stdout?: string; stderr?: string };
} = {};

try {
  input = JSON.parse(rawInput);
} catch {
  Deno.exit(0);
}

const command = input.tool_input?.command || "";

// Only process cf commands and legacy ct commands
if (!command.includes("cf piece") && !command.includes("ct ")) {
  Deno.exit(0);
}

let suggestion = "";

if (command.includes("piece new")) {
  suggestion =
    "Piece created. Next: use 'cf piece inspect' to view state or 'cf piece call' to test handlers.";
} else if (command.includes("piece setsrc")) {
  suggestion =
    "Source updated. Next: use 'cf piece step' to trigger re-evaluation, then 'cf piece inspect' to verify.";
} else if (command.includes("piece set ")) {
  suggestion =
    "State set. Run 'cf piece step' to trigger re-evaluation before reading computed values.";
} else if (command.includes("piece inspect")) {
  suggestion =
    "State inspected. Use 'cf piece call handlerName' to test handlers or 'cf piece set' to modify state.";
}

if (suggestion) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: suggestion,
    },
  }));
}

Deno.exit(0);
