# Smoketest Ralph General Prompt

Goal: implement the unchecked item from `./tools/ralph/TASKS.md` that matches
your assigned RALPH_ID

1. Open `./tools/ralph/TASKS.md` and find the task numbered with your RALPH_ID.

2. If your assigned task is already checked `[x]`, exit with a message saying
   the task is already complete.

3. Use Claude Skills "recipe-dev" to work on the task that corresponds to your
   RALPH_ID number.

4. Format with `deno fmt` for the changed files.

5. Once tests pass, deploy it locally using `./docs/common/RECIPE_DEV_DEPLOY.md`
   for info on how to deploy. It should deploy to http://localhost:8080 and not
   to toolshed. Servers are already running.

6. Once it is deployed locally, use a subagent to test your work with MCP
   playwright

7. Check off the completed items in `TASKS.md`:

8. git stage and commit with a message

9. Copy the files you created for the task to /app/smoketest/${RALPH_ID}/

10. Create a summary of your work in the same directory, be sure to include
    playwright results and what you tested. file location:
    /app/smoketest/${RALPH_ID}/RESULTS.md

11. Create a /app/smoketest/${RALPH_ID}/SCORE.txt which has one of the following
    values based on your results: SUCCESS, PARTIAL, FAILURE

12. Add feedback to documentation to `./tools/ralph/LEARNINGS.md`.

13. Exit

Please begin.
