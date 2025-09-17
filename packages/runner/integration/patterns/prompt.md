We’re in repo `labs-secondary`.

Goal: implement the next unchecked items from
`packages/runner/integration/patterns/test-ideas.md`, create their pattern
modules and harness scenarios, run `deno fmt` plus
`deno test --allow-env --allow-read --allow-write --allow-ffi packages/runner/integration/pattern-harness.test.ts`,
mark the checklist item as completed, and commit everything with a concise
message.

Steps:

1. Open `packages/runner/integration/patterns/test-ideas.md`, identify the first
   unchecked task, and for it:
   - Add `*.pattern.ts` + `*.ts` scenario files matching our existing
     conventions.
   - Use CTS APIs (`handler`, `recipe`, `lift`, etc.) to realize the described
     structure.
   - Keep patterns offline-friendly (no network or LLM).

2. Update `packages/runner/integration/pattern-harness.test.ts` to include new
   scenario modules if needed.

3. Format with `deno fmt` for the changed files.

4. Run
   `deno test --allow-env --allow-read --allow-write --allow-ffi packages/runner/integration/pattern-harness.test.ts`
   and ensure it passes.

5. Check off the completed ideas in `test-ideas.md`.

6. Stage and commit with a message like
   `Add pattern scenarios for toggle through rolling average`.

Please begin.
