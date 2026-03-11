# Generating comprehensive test coverage

We're in repo `labs-secondary`.

Goal: implement a random unchecked item from
`packages/generated-patterns/integration/patterns/test-ideas.md`, create its
pattern module and test scenarios, run `deno fmt` plus `deno task integration`,
mark the checklist item as completed, and commit everything with a concise
message.

Steps:

1. Open `packages/generated-patterns/integration/patterns/test-ideas.md`, pick
   ONE random unchecked task, and for it:
   - Add `*.pattern.ts` + `*.test.ts` files matching our existing conventions in
     `packages/generated-patterns/integration/patterns/`.
   - The `.test.ts` file should import `runPatternScenario` and
     `PatternIntegrationScenario` from `../pattern-harness.ts`, define
     scenarios, export them, and run them in a `describe`/`it` block. See any
     existing `.test.ts` file (e.g. `echo.test.ts`) for the pattern.
   - Use CTS APIs (`handler`, `pattern`, `lift`, `str`, `cell`, `createCell`) to
     realize the described structure. You can use `derive` as well, it is just a
     convenience wrapper around lift: `derive(x, x => x+1)` is the same as
     `lift(x => x+1)(x)`.
   - Do not use `compute` and `render` as they'll be deprecated.
   - Don't use `.setDefault`, instead use `Default<type, value>` in the type
     declaration.
   - Keep patterns offline-friendly (no network or LLM).
   - Read `packages/generated-patterns/integration/patterns/learnings.md` for
     any other tips.

2. Format with `deno fmt` for the changed files.

3. Run `deno task integration` in `packages/generated-patterns/` and ensure it
   passes.

4. Once it passes, check off the completed ideas in `test-ideas.md`. If you
   can't get it to pass after too many attempts, git stash it with an message
   noting the issue and exit.

5. Add any learnings about the API or otherwise to
   `packages/generated-patterns/integration/patterns/learnings.md`. Keep
   learnings general, not specific to the use-case you tackled. This is for
   future instances of you that are working on different use-cases, but in the
   same framework and with the same tools.

6. Stage and commit with a message like
   `Add pattern scenarios for toggle through rolling average`.

7. Exit

IMPORTANT: Only build one test case at a time!

Please begin.
