# Shipping UX for runner patterns

We’re in repo `labs-secondary`.

Goal: convert one random unchecked pattern from
`packages/runner/integration/patterns-with-ux/worklist.md` into a charm-quality
UI. Enhance the recipe so it exposes `[NAME]` and `[UI]`, exercise it through
Playwright, capture a screenshot, and land a passing integration test inspired
by `packages/patterns/integration`.

Context to study before starting: Look at the patterns in `packages/patterns` as
examples. Look at the docs in `docs/common` for some documentation on the
framework. Look at `learnings.md` in
`packages/runner/integration/patterns-with-ux/`.

Steps:

1. Open `packages/runner/integration/patterns-with-ux/worklist.md` and pick ONE
   unchecked entry at random. Only work on that pattern during this run.
   - You can use
     `grep '^- \[ \]' packages/runner/integration/patterns-with-ux/worklist.md | sort -R | head -n 1`
2. Inspect the existing business-logic recipe in
   `packages/runner/integration/patterns/<pattern>.pattern.ts` (plus its
   scenario file, if helpful) to understand inputs, derives, and handlers.
3. Create a corresponding copy in
   `packages/runner/integration/patterns-with-ux/<pattern>.pattern.tsx`.
4. Expand the recipe outputs to include:
   - `[NAME]`: a concise, human-friendly title derived from deterministic state.
   - `[UI]`: JSX that binds the existing derives and handlers into a polished,
     accessible interface. Favor ct components (`ct-button`, `ct-input`, etc.)
     and clearly communicate the pattern’s purpose. Keep the recipe
     deterministic and offline—reuse sanitized values instead of recomputing raw
     inputs inside the UI.
5. For testing use this command to start a new instance:
   `deno task ct charm new
   --space <pattern>-test --main-export <name of the recipe export>
   packages/runner/integration/patterns-with-ux/<pattern>.pattern.tsx`.
6. If successful it output a new charmId, and the new charm instance is
   available at `http://localhost:8000/<pattern>-test/<charmId>`. If you get
   compilation errors, retry.
7. Use the Playwright MCP to:
   - Connect to the URL above. If necessary login by creating a new account.
   - Exercise the UI interactions that mirror the business logic.
   - Save at least one screenshot (store it alongside other artifacts if a path
     is requested) and inspect the DOM to confirm the UI is behaving and looking
     as intended. If you find problems, fix the pattern are go back to step 5.
8. Append any new insights or caveats to
   `packages/runner/integration/patterns-with-ux/learnings.md`. Learnings can be
   about how to write patterns, but also a summary of conext you had to build up
   that could apply to other patterns as well, including tool use. Don't
   anything too specific to this pattern's use-case.
9. If something fails persistently, revert that pattern, add a note about the
   issue to `issues.md`, leave the checklist unchecked, and exit.
10. Update `packages/runner/integration/patterns-with-ux/worklist.md` to mark
    the pattern as completed.
11. Format your changes with `deno fmt`.
12. Add a screenshot to
    `packages/runner/integration/patterns-with-ux/screenshots`.
13. Stage the changes, commit with a concise summary, and exit.

IMPORTANT: Only tackle one pattern per run. Quality beats quantity - ship a
charm the shell team would demo proudly.

IMPORTANT: No need to add integration tests just yet, we'll do that in a future
round. Just thoroughly exercise it with playwright.

Please begin.
