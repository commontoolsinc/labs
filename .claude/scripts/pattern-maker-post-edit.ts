#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/pattern-maker-post-edit.ts
 *
 * Claude Code PostToolUse hook for Write|Edit on pattern-maker subagent.
 * - Suggests running tests after pattern file modifications.
 */

const rawInput = await new Response(Deno.stdin.readable).text();
let input: { tool_input?: { file_path?: string } } = {};

try {
  input = JSON.parse(rawInput);
} catch {
  Deno.exit(0);
}

const filePath = input.tool_input?.file_path || "";

// Only suggest for pattern .tsx files (not test files)
if (
  filePath.includes("/patterns/") &&
  filePath.endsWith(".tsx") &&
  !filePath.endsWith(".test.tsx")
) {
  const testFile = filePath.replace(".tsx", ".test.tsx");
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `Pattern file modified. Run tests: deno task ct test ${testFile}`,
    },
  }));
}

Deno.exit(0);
