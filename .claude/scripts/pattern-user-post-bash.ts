#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/pattern-user-post-bash.ts
 *
 * Claude Code PostToolUse hook for Bash on pattern-user subagent.
 * - Parses ct command output and suggests next steps.
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

// Only process ct commands
if (!command.includes("ct piece") && !command.includes("ct ")) {
  Deno.exit(0);
}

let suggestion = "";

if (command.includes("piece new")) {
  suggestion =
    "Piece created. Next: use 'ct piece inspect' to view state or 'ct piece call' to test handlers.";
} else if (command.includes("piece setsrc")) {
  suggestion =
    "Source updated. Next: use 'ct piece step' to trigger re-evaluation, then 'ct piece inspect' to verify.";
} else if (command.includes("piece set ")) {
  suggestion =
    "State set. Run 'ct piece step' to trigger re-evaluation before reading computed values.";
} else if (command.includes("piece inspect")) {
  suggestion =
    "State inspected. Use 'ct piece call handlerName' to test handlers or 'ct piece set' to modify state.";
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
