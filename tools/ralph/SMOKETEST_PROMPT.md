# Smoketest Ralph General Prompt

Goal: implement the unchecked item from `./tools/ralph/TASKS.md` that matches
your assigned RALPH_ID

1. Open `./tools/ralph/TASKS.md` and find the task numbered with your RALPH_ID.

2. If your assigned task is already checked `[x]`, exit with a message saying
   the task is already complete.

3. Use Claude Skills "recipe-dev" to work on the task that corresponds to your
   RALPH_ID number.

4. Format with `deno fmt` for the changed files.

5. Once all tests pass, use MCP playwright to test your work

6. check off the completed items in `TASKS.md`:

7. git stage and commit with a message

8. copy the files you created for the task to /app/smoketest/${RALPH_ID}/

9. create a summary of your work in the same directory, be sure to include
   playwright results and what you tested. file location:
   /app/smoketest/${RALPH_ID}/RESULTS.md

10. create a /app/smoketest/${RALPH_ID}/SCORE.txt which has one of the following
    values based on your results: SUCCESS, PARTIAL, FAILURE

11. Add feedback to documentation to `./tools/ralph/LEARNINGS.md`.

12. Exit

Please begin.
