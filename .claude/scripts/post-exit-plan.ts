#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/post-exit-plan.ts
 *
 * Claude Code Post-Tool hook for ExitPlanMode.
 * - Reminds Claude to use Task() subagents for implementation.
 * - Suggests implementing in committable chunks.
 * - Encourages parallel Task() agents for concurrent changes.
 */

// We don't need to parse input for this hook - it always fires after ExitPlanMode

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `Implementation reminder:
- Use Task() subagents to implement this plan in committable chunks
- Consider which changes can be made concurrently and use parallel Task() agents
- Each Task() agent should complete a logical unit of work that can be committed independently
- After each Task() completes, consider committing the changes before proceeding`,
  },
}));

Deno.exit(0);
