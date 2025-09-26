# Shipping UX for runner patterns

We’re in repo `labs-secondary`.

Goal: convert one random unchecked pattern from
`packages/runner/integration/patterns-with-ux/worklist.md` into a charm-quality
UI. Enhance the recipe so it exposes `[NAME]` and `[UI]`, exercise it through
Playwright, capture a screenshot, and land a passing integration test inspired
by `packages/patterns/integration`.

Steps:

1. Open `packages/runner/integration/patterns-with-ux/worklist.md` and pick ONE
   unchecked entry at random. Only work on that pattern during this run.
2. Inspect the existing business-logic recipe in
   `packages/runner/integration/patterns/<pattern>.pattern.ts` (plus its
   scenario file, if helpful) to understand inputs, derives, and handlers.
3. Create a corresponding copy in
   `packages/runner/integration/patterns-with-ux/<pattern>.pattern.tsx`.
4. Expand the recipe outputs to include:
   - `[NAME]`: a concise, human-friendly title derived from deterministic state.
   - `[UI]`: JSX that binds the existing derives and handlers into a polished,
     accessible interface. Favor ct components (`ct-button`, `ct-field`, etc.)
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
8. Author a dedicated integration test in
   `packages/patterns/integration/<pattern>.test.ts`. Follow the existing tests
   for structure: bootstrap a charm, drive it with Playwright, assert DOM state,
   and inspect any derived summaries. Prefer descriptive `describe`/`it` names.
9. Update `packages/runner/integration/patterns-with-ux/worklist.md` to mark the
   pattern as completed. Append any new insights or caveats to
   `packages/runner/integration/patterns-with-ux/learnins.md`.
10. Format your changes with `deno fmt`. Run `deno task check` plus the targeted
    integration test (e.g.
    `deno test --allow-env --allow-read --allow-write --allow-ffi \
packages/patterns/integration/<pattern>.test.ts`).
11. If something fails persistently, revert that pattern, add a note about the
    issue to `learnins.md`, leave the checklist unchecked, and exit.
12. Otherwise stage the changes, commit with a concise summary, and exit.

IMPORTANT: Only tackle one pattern per run. Quality beats quantity - ship a
charm the shell team would demo proudly.

Please begin.
