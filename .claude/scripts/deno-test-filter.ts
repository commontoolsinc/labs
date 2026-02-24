#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * .claude/scripts/deno-test-filter.ts
 *
 * Claude Code Pre-Tool hook.
 * - Catches `deno task test --filter` which doesn't work as expected.
 * - Explains the correct pattern: run `deno test` directly in a package.
 */

import { guardProjectDir } from "./common/guard.ts";
guardProjectDir();

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
try {
  const payload = JSON.parse(rawInput);
  cmd = payload?.tool_input?.command ?? "";
} catch {
  // Allow if JSON is malformed
}

// Check for `deno task test` with --filter flag
// Must start with deno or follow a command separator, and --filter must follow test
// Exclude matches inside heredocs/strings (command starting with git commit)
if (
  !cmd.startsWith("git ") &&
  /(?:^|[;&|])\s*deno\s+task\s+test\b/.test(cmd) &&
  /deno\s+task\s+test\s+.*--filter/.test(cmd)
) {
  console.error(`The --filter flag doesn't work with \`deno task test\`.

To run filtered tests, use \`deno test\` directly within a package:

  cd packages/<package-name>
  deno test --allow-env --allow-ffi --allow-read --allow-write --filter "test name" test/

Or run all tests in a specific file:

  deno test --allow-env --allow-ffi --allow-read --allow-write test/specific.test.ts
`);
  Deno.exit(2);
}

Deno.exit(0);
