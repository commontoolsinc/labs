#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/pattern-user-post-bash.ts
 *
 * Claude Code PostToolUse hook for Bash on pattern-user subagent.
 * - Parses cf command output and suggests next steps.
 */

function suggestionForCommandSegment(command: string): string {
  const attachedTests = /(?:^|\s)--test(?:=|\s)/.test(command);
  const testSuggestion = attachedTests
    ? "Attached tests are packaged, not run. Confirm every entry passed with 'cf test'."
    : "No tests were attached. For new or changed source, write and run pattern tests, then deploy with repeatable '--test'.";

  if (command.includes("piece new")) {
    if (!attachedTests && /\.test\.[cm]?[jt]sx?["']?(?:\s|$)/.test(command)) {
      return "Test pattern deployed as the executable diagnostic entry. Next, inspect its action and assertion cells.";
    }
    return `${testSuggestion} Next, use 'cf piece inspect' to view state or 'cf piece call' to test handlers.`;
  }
  if (command.includes("piece setsrc")) {
    return `${testSuggestion} Next, use 'cf piece step' to trigger re-evaluation, then 'cf piece inspect' to verify.`;
  }
  if (command.includes("piece set-home") && !command.includes("--reset")) {
    return `${testSuggestion} Next, open the home space and verify the custom home pattern.`;
  }
  if (command.includes("piece set ")) {
    return "State set. Run 'cf piece step' to trigger re-evaluation before reading computed values.";
  }
  if (command.includes("piece inspect")) {
    return "State inspected. Use 'cf piece call handlerName' to test handlers or 'cf piece set' to modify state.";
  }
  return "";
}

export function suggestionForPatternUserCommand(command: string): string {
  if (!command.includes("cf piece")) return "";

  return command
    .replace(/\\\r?\n/g, " ")
    .split(/&&|\|\||[;\r\n]/)
    .map((segment) => suggestionForCommandSegment(segment))
    .filter(Boolean)
    .join(" ");
}

if (import.meta.main) {
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

  const suggestion = suggestionForPatternUserCommand(
    input.tool_input?.command || "",
  );
  if (suggestion) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: suggestion,
      },
    }));
  }
}
