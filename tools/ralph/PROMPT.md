# Ralph General Prompt

# Note to User: you can edit this and commit to a branch for tailored Ralph runs

Goal: implement a random unchecked item from `./tools/ralph/TASKS.md`

To implement, create its pattern module and harness scenarios, run `deno fmt`
plus
`deno test --allow-env --allow-read --allow-write --allow-ffi ./tools/ralph/patterns/pattern-harness.test.ts`,
mark the checklist item as completed, and commit everything with a concise
message.

Steps:

1. Open `./tools/ralph/TASKS.md` and pick ONE random unchecked task that is
   eligible. A task is eligible if and only if:
   - It is unchecked (has `[]` not `[x]`), AND
   - Either it has no parent task (is at the top level), OR all its parent tasks
     are checked `[x]`

   IMPORTANT: The hierarchy can be N levels deep. You MUST trace all the way up
   the indentation tree and verify EVERY ancestor is checked before selecting a
   task.

   Example: If you see this structure:
   ```
   - [x] Parent task
     - [] Child task 1
       - [] Grandchild task A  <- NOT ELIGIBLE (child task 1 is unchecked)
     - [x] Child task 2
       - [] Grandchild task B  <- ELIGIBLE (all ancestors checked)
   ```

   For the selected task:
   - If this is a child task (indented under a parent), EXTEND the existing
     pattern files from the parent task rather than creating new ones. Build
     upon the existing functionality by adding new features to the same files.
   - If this is a top-level task, create new `*.pattern.ts` + `*.ts` scenario
     files matching our existing conventions in `./tools/ralph/patterns/`.
   - Use CTS APIs (`handler`, `pattern`, `lift`, `str`, `cell`, `createCell`) to
     realize the described structure. You can use `derive` as well, it is just a
     convenience wrapper around lift: `derive(x, x => x+1)` is the same as
     `lift(x => x+1)(x)`.
   - Do not use `compute` and `render` as they'll be deprecated.
   - Don't use `.setDefault`, instead use `Default<type, value>` in the type
     declaration.
   - Keep patterns offline-friendly (no network or LLM).
   - Read `./tools/ralph/LEARNINGS.md` for any other tips.
   - Read .md files in ./tutorials for best practices
   - If the item in TASKS.md appears to be implemented but unchecked, verify
     that it actually passes all criteria
   - When implementing UI interactions (buttons, inputs, etc.):
     - FIRST search `./packages/patterns/` for similar patterns (use grep to
       find examples)
     - Study how they pass data to handlers - data is passed via handler binding
       parameters, NOT via event.target or DOM attributes
     - Key pattern: Runtime values (like loop index) are passed as binding
       parameters
       ```tsx
       items.map((item, index) => (
         <ct-button onClick={removeItem({ items, index })}>Remove</ct-button>
       ));
       ```

2. Update `./tools/ralph/patterns/pattern-harness.test.ts` to include the new
   scenario modules if needed.

3. Format with `deno fmt` for the changed files.

4. Run
   `deno test --allow-env --allow-read --allow-write --allow-ffi ./tools/ralph/patterns/pattern-harness.test.ts`
   and ensure it passes.

5. If the task involved the pattern's [UI] section, use Playwright MCP to test
   it:
   - Deploy locally according to `./tools/ralph/DEPLOY.md`
   - Test the UI interactions work as expected
   - Use patterns in ./packages/patterns/ as references for UI elements
   - Read tutorials/common_ui.md for component use
6. Once all tests pass, check off the completed items in `TASKS.md`:
   - Required: the previously mentioned `deno test` must pass
   - If UI present: Playwright tests must also pass
   - If you can't get tests to pass after multiple attempts, git stash with a
     message noting the issue and exit

7. Add any learnings about the API or otherwise to `./tools/ralph/LEARNINGS.md`.
   Keep learnings general, not specific to the use-case you tackled. This is for
   future instances of you that are working on different use-cases, but in the
   same framework and with the same tools.

8. Stage and commit with a message like
   `Add pattern scenarios for toggle through rolling average`.

9. Exit

IMPORTANT: Only build one test case at a time! See `tools/ralph/DEPLOY.md` for
Playwright MCP testing and server restart instructions. When developing UI for
components, DOM access is not allowed. You also cannot access the event from the
JSX components. Please look at `packages/patterns/` for examples on how the JSX
components work, how events work, and how handlers work with them.

Please begin.
