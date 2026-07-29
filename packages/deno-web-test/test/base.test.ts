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
  const beforeInvalidByte = encoder.encode(
    "Task test deno run cli.ts *.test.ts\n" +
      "Download https://registry.npmjs.org/esbuild\n" +
      "Download http://registry.npmjs.org/typescript\n" +
      "Warning with non-UTF-8 byte: ",
  );
  const afterInvalidByte = encoder.encode(
    "\nDownload https://example.test/from-application\n",
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

  const expectedTask = encoder.encode(
    "Task test deno run cli.ts *.test.ts\nWarning with non-UTF-8 byte: ",
  );
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
  );
});
