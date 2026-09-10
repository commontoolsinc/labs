#!/usr/bin/env -S deno run --allow-read --allow-env

/**
 * .claude/scripts/deno-test-filter.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks `deno task test --filter`, which runs the whole workspace suite.
 * - Exits 2 so Claude blocks the tool call and shows the message.
 */

import {
  atCommandPosition,
  guardProjectDir,
  parseCommand,
  stripLiterals,
} from "./common/guard.ts";
guardProjectDir();

const cmd = stripLiterals(await parseCommand());
if (!cmd) Deno.exit(0);

// The characters excluded between `test` and `--filter` are the ones that end
// a command, so a `--filter` belonging to a later command is not read as part
// of this one.
const filtered = atCommandPosition(
  "deno\\s+task\\s+test\\s+[^\\n;&|]*--filter",
).exec(cmd);

// A command that changes directory first may run a package's own `test` task,
// where the flag does work. This hook covers the root task only, so it does
// not report on a command whose task it cannot identify. A `cd` inside a
// subshell leaves the directory unchanged for the command after it, and is
// read here as though it did not; telling the two apart means tracking which
// parentheses a command runs inside, which is parsing the shell.
const movedFirst = atCommandPosition("cd\\s").exec(cmd);

if (filtered && !(movedFirst && movedFirst.index < filtered.index)) {
  console.error(
    "`--filter` does nothing here. The root `test` task runs " +
      "`tasks/test.ts`, which reads no arguments, so the flag is dropped " +
      "and the whole workspace suite runs.\n" +
      "\n" +
      "Filter inside the package instead, where the package's own `test` " +
      "task carries the flags its tests need:\n" +
      "\n" +
      "  cd packages/<package-name>\n" +
      '  deno task test --filter "test name"\n' +
      "\n" +
      "`deno task` appends the flag to the end of the task's command " +
      "line, so the last command on that line receives it. A task that " +
      "chains two commands, or that only lists other tasks, has something " +
      "else last and runs its whole suite. " +
      "`docs/development/TESTING.md` says what to run in those cases.",
  );
  Deno.exit(2);
}

Deno.exit(0);
