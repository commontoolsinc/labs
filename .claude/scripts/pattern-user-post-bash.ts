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
if (!command.includes("ct charm") && !command.includes("ct ")) {
  Deno.exit(0);
}

let suggestion = "";

if (command.includes("charm new")) {
  suggestion =
    "Charm created. Next: use 'ct charm inspect' to view state or 'ct charm call' to test handlers.";
} else if (command.includes("charm setsrc")) {
  suggestion =
    "Source updated. Next: use 'ct charm step' to trigger re-evaluation, then 'ct charm inspect' to verify.";
} else if (command.includes("charm set ")) {
  suggestion =
    "State set. Run 'ct charm step' to trigger re-evaluation before reading computed values.";
} else if (command.includes("charm inspect")) {
  suggestion =
    "State inspected. Use 'ct charm call handlerName' to test handlers or 'ct charm set' to modify state.";
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
