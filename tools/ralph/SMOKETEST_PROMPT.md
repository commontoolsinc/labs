# Smoketest Ralph General Prompt

Goal: implement the unchecked item from `./tools/ralph/TASKS.md` that matches
your assigned RALPH_ID

1. Open `/app/labs/tools/ralph/TASKS.md` and find the task numbered with your
   RALPH_ID.

2. If your assigned task is already checked `[x]`, exit with a message saying
   the task is already complete.

3. Use Claude Skills "pattern-dev" to work on the task that corresponds to your
   RALPH_ID number.

   IMPORTANT:
   - Create your pattern files directly in /app/smoketest/${RALPH_ID}/
   - Use space name "ralph${RALPH_ID}" (e.g., ralph1, ralph2, ralph3) to avoid
     conflicts with other parallel smoketests

4. Format with `deno fmt` for the changed files.

5. Once tests pass, deploy it locally using
   `/app/labs/docs/common/PATTERN_DEV_DEPLOY.md` for info on how to deploy. It
   should deploy to http://localhost:8000. Servers are already running.

   Remember to use space name "ralph${RALPH_ID}" when deploying.

6. Once it is deployed locally, test your work using Playwright MCP tools
   directly.

   IMPORTANT: Use the MCP tools (like `mcp__playwright__browser_navigate`,
   `mcp__playwright__browser_click`, `mcp__playwright__browser_take_screenshot`)
   directly as regular tool calls. DO NOT use the Skill tool for Playwright.

   Testing steps: a. Navigate to
   http://localhost:8000/ralph${RALPH_ID}/<CHARM_ID> using
   `mcp__playwright__browser_navigate` b. If you see a login page (first time
   only), complete registration c. Test the charm's functionality using
   Playwright MCP tools:
   - Take screenshots to verify it loaded (name them
     ralph_${RALPH_ID}-<description>.png, e.g., ralph_1-initial.png)
   - Interact with buttons/inputs using `mcp__playwright__browser_click`
   - Verify behavior matches task requirements
   - Take final screenshot showing successful interactions

7. Create a summary of your work in /app/smoketest/${RALPH_ID}/RESULTS.md
   Include:
   - What pattern you implemented
   - Test results (deno test output)
   - Playwright test results and what you tested
   - Any issues or limitations

8. Create /app/smoketest/${RALPH_ID}/SCORE.txt with one of the following values
   based on your results:
   - SUCCESS: All tests pass, pattern works as expected
   - PARTIAL: Some tests pass, pattern partially works
   - FAILURE: Tests fail or pattern doesn't work

9. Exit

Please begin.
