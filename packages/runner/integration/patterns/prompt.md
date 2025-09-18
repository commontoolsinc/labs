# Generating comprehensive test coverage

We’re in repo `labs-secondary`.

Goal: implement a random unchecked item from
`packages/runner/integration/patterns/test-ideas.md`, create its pattern module
and harness scenarios, run `deno fmt` plus
`deno test --allow-env --allow-read --allow-write --allow-ffi packages/runner/integration/pattern-harness.test.ts`,
mark the checklist item as completed, and commit everything with a concise
message.

Steps:

1. Open `packages/runner/integration/patterns/test-ideas.md`, pick a random
   unchecked task, and for it:
   - Add `*.pattern.ts` + `*.ts` scenario files matching our existing
     conventions in `packages/runner/integration/patterns/`.
   - Use CTS APIs (`handler`, `recipe`, `lift`, `derive`, `str`, `cell`,
     `createCell`) to realize the described structure.
   - Do not use `compute` and `render` as they'll be deprecated.
   - Don't use `.setDefault`, instead use `Default<type, value>` in the type
     declaration.
   - Keep patterns offline-friendly (no network or LLM).
   - Read `packages/runner/integration/patterns/learnings.md` for any other
     tips.

2. Update `packages/runner/integration/pattern-harness.test.ts` to include new
   scenario modules if needed.

3. Format with `deno fmt` for the changed files.

4. Run
   `deno test --allow-env --allow-read --allow-write --allow-ffi packages/runner/integration/pattern-harness.test.ts`
   and ensure it passes.

5. Once it passes, check off the completed ideas in `test-ideas.md`. If you
   can't get it to pass after too many attempts, git stash it with an message
   noting the issue and exit.

6. Add any learnings about the API or otherwise to
   `packages/runner/integration/patterns/learnings.md`.

7. Stage and commit with a message like
   `Add pattern scenarios for toggle through rolling average`.

Please begin.
