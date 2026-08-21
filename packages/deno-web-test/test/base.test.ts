import { assertEquals } from "@std/assert";
import { runDenoWebTest, sanitizeDenoWebTestOutput } from "./utils.ts";

Deno.test("smoke test", async function () {
  const run = await runDenoWebTest("success-project");

  run.assert(run.success, "test successful");
  run.assert(/add-sync ... ok/.test(run.stdoutText), "test output ok");
  run.assert(/add-async ... ok/.test(run.stdoutText), "test output ok");
  run.assert(/ok | 2 passed | 0 failed/.test(run.stdoutText), "test output ok");
  run.assert(/deno run/.test(run.stderrText), "stderr has deno task run");
  run.assert(
    !/experimentalDecorators/.test(run.stderrText),
    "stderr has no compiler options warning",
  );
  run.assert(
    run.stderrText.split("\n").length === 2,
    "stderr has no other messages",
  );
  run.assert(
    run.stderrText.split("\n")[1] === "",
    "stderr has no other messages",
  );
});

Deno.test("dependency downloads before the harness boundary are removed", function () {
  const encoder = new TextEncoder();
  const boundary = "deno-web-test:test-boundary";
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
      `\n${boundary}\n` +
        downloadLine("https://example.test/from-application"),
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
    const expectedBeforeInvalidByte = encoder.encode(taskLine + warning);
    const expectedAfterInvalidByte = encoder.encode(
      "\n" + downloadLine("https://example.test/from-application"),
    );
    const expectedStderr = new Uint8Array(
      expectedBeforeInvalidByte.length + 1 + expectedAfterInvalidByte.length,
    );
    expectedStderr.set(expectedBeforeInvalidByte);
    expectedStderr[expectedBeforeInvalidByte.length] = 0xff;
    expectedStderr.set(
      expectedAfterInvalidByte,
      expectedBeforeInvalidByte.length + 1,
    );

    assertEquals(
      sanitizeDenoWebTestOutput(output, boundary),
      {
        ...output,
        stderr: expectedStderr,
      },
      colorized ? "colorized diagnostics" : "plain diagnostics",
    );
  }
});

Deno.test("non-SGR control sequences remain before the boundary", function () {
  const encoder = new TextEncoder();
  const boundary = "deno-web-test:test-boundary";
  for (const sequence of ["\x1b[>4;2m", "\x1b[ 31m"]) {
    const taskLine = "Task test deno run cli.ts *.test.ts\n";
    const applicationLine =
      `${sequence}Download https://example.test/from-application\n`;
    const output: Deno.CommandOutput = {
      code: 0,
      success: true,
      signal: null,
      stdout: encoder.encode("test output"),
      stderr: encoder.encode(
        `${taskLine}${applicationLine}${boundary}\n`,
      ),
    };

    assertEquals(
      sanitizeDenoWebTestOutput(output, boundary),
      {
        ...output,
        stderr: encoder.encode(taskLine + applicationLine),
      },
      `preserves ${JSON.stringify(sequence)}`,
    );
  }
});

Deno.test("application download lines remain in harness stderr", function () {
  const encoder = new TextEncoder();
  const boundary = "deno-web-test:test-boundary";
  for (const colorized of [false, true]) {
    const taskLine = colorized
      ? "\x1b[0m\x1b[32mTask\x1b[0m \x1b[0m\x1b[36mtest\x1b[0m deno run cli.ts *.test.ts\n"
      : "Task test deno run cli.ts *.test.ts\n";
    const applicationLine = colorized
      ? "\x1b[0m\x1b[32mDownload\x1b[0m https://example.test/from-application\n"
      : "Download https://example.test/from-application\n";
    const output: Deno.CommandOutput = {
      code: 0,
      success: true,
      signal: null,
      stdout: encoder.encode("test output"),
      stderr: encoder.encode(
        taskLine +
          applicationLine.replace("example.test", "registry.npmjs.org") +
          `${boundary}\n` +
          applicationLine,
      ),
    };

    assertEquals(
      sanitizeDenoWebTestOutput(output, boundary),
      {
        ...output,
        stderr: encoder.encode(taskLine + applicationLine),
      },
      colorized ? "colorized application output" : "plain application output",
    );
  }
});
