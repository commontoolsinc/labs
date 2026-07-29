import { assert, assertEquals } from "@std/assert";
import { decode } from "@commonfabric/utils/encoding";
import { runDenoWebTest, sanitizeDenoWebTestOutput } from "./utils.ts";

Deno.test("smoke test", async function () {
  const { success, stdout, stderr } = await runDenoWebTest("success-project");
  const stdoutText = decode(stdout);
  const stderrText = decode(stderr);

  // While the test package is pulled out of the workspace
  // during testing, ensure we use the same version in `success-project`
  // as the outer workspace so that we don't get terminal spam
  // from downloading new versions, breaking stdout/stderr
  // parsers in the tests

  assert(success, "test successful");
  assert(/add-sync ... ok/.test(stdoutText), "test output ok");
  assert(/add-async ... ok/.test(stdoutText), "test output ok");
  assert(/ok | 2 passed | 0 failed/.test(stdoutText), "test output ok");
  assert(/deno run/.test(stderrText), "stderr has deno task run");
  assert(
    !/experimentalDecorators/.test(stderrText),
    "stderr has no compiler options warning",
  );
  assert(stderrText.split("\n").length === 2, "stderr has no other messages");
  assert(stderrText.split("\n")[1] === "", "stderr has no other messages");
});

Deno.test("dependency downloads do not enter harness stderr", function () {
  const encoder = new TextEncoder();
  for (const colorized of [false, true]) {
    const taskLine = colorized
      ? "\x1b[0m\x1b[32mTask\x1b[0m \x1b[0m\x1b[36mtest\x1b[0m deno run cli.ts *.test.ts\n"
      : "Task test deno run cli.ts *.test.ts\n";
    const downloadLine = (url: string) =>
      colorized
        ? `\x1b[0m\x1b[32mDownload\x1b[0m ${url}\n`
        : `Download ${url}\n`;
    const warning = "Warning with non-UTF-8 byte: ";
    const beforeInvalidByte = encoder.encode(
      taskLine +
        downloadLine("https://registry.npmjs.org/esbuild") +
        downloadLine("http://registry.npmjs.org/typescript") +
        warning,
    );
    const afterInvalidByte = encoder.encode(
      "\n" + downloadLine("https://example.test/from-application"),
    );
    const stderr = new Uint8Array(
      beforeInvalidByte.length + 1 + afterInvalidByte.length,
    );
    stderr.set(beforeInvalidByte);
    stderr[beforeInvalidByte.length] = 0xff;
    stderr.set(afterInvalidByte, beforeInvalidByte.length + 1);

    const output: Deno.CommandOutput = {
      code: 0,
      success: true,
      signal: null,
      stdout: encoder.encode("test output"),
      stderr,
    };

    const expectedTask = encoder.encode(taskLine + warning);
    const expectedStderr = new Uint8Array(
      expectedTask.length + 1 + afterInvalidByte.length,
    );
    expectedStderr.set(expectedTask);
    expectedStderr[expectedTask.length] = 0xff;
    expectedStderr.set(afterInvalidByte, expectedTask.length + 1);

    assertEquals(
      sanitizeDenoWebTestOutput(output),
      {
        ...output,
        stderr: expectedStderr,
      },
      colorized ? "colorized diagnostics" : "plain diagnostics",
    );
  }
});
