# Smoketest Ralph General Prompt

Goal: implement the task below

<SMOKETEST_TASK>

1. Use Claude Skills "pattern-dev" to work on the task above.

   IMPORTANT:
   - Create your pattern files directly in /app/smoketest/${RALPH_ID}/
   - Use space name "ralph${RALPH_ID}" (e.g., ralph1, ralph2, ralph3) to avoid
     conflicts with other parallel smoketests

2. Format with `deno fmt` for the changed files.

3. Once tests pass, deploy it locally using Claude Skill "ct" for deployment
   commands. It should deploy to http://localhost:8000. Servers are already
   running.

   Remember to use space name "ralph${RALPH_ID}" when deploying.

4. Once it is deployed locally, test your work using Playwright MCP tools
   directly.

   IMPORTANT: Use the MCP tools (like `mcp__playwright__browser_navigate`,
   `mcp__playwright__browser_click`, `mcp__playwright__browser_take_screenshot`)
   directly as regular tool calls. DO NOT use the Skill tool for Playwright.

   Testing steps: a. Navigate to
   http://localhost:8000/ralph${RALPH_ID}/<PIECE_ID> using
   `mcp__playwright__browser_navigate` b. If you see a login page (first time
   only), complete registration c. Test the piece's functionality using
   Playwright MCP tools:
   - Take screenshots to verify it loaded (name them
     ralph_${RALPH_ID}-<description>.png, e.g., ralph_1-initial.png)
   - Interact with buttons/inputs using `mcp__playwright__browser_click`
   - Verify behavior matches task requirements
   - Take final screenshot showing successful interactions

5. Create a summary of your work in /app/smoketest/${RALPH_ID}/RESULTS.md
   Include:
   - What pattern you implemented
   - Test results (deno test output)
   - Playwright test results and what you tested
   - Any issues or limitations

6. Create /app/smoketest/${RALPH_ID}/SCORE.txt with one of the following values
   based on your results:
   - SUCCESS: All tests pass, pattern works as expected
   - PARTIAL: Some tests pass, pattern partially works
   - FAILURE: Tests fail or pattern doesn't work

7. Exit

Please begin.
