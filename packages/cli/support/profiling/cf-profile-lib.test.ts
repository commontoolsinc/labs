import { assertEquals, assertThrows } from "@std/assert";
import {
  findInspectorWebSocketUrl,
  inspectWaitFlag,
  parseProfileArgs,
  waitForCliStatusOrStopOnCaptureFailure,
} from "./cf-profile-lib.ts";

const successStatus: Deno.CommandStatus = {
  success: true,
  code: 0,
  signal: null,
};
const failureStatus: Deno.CommandStatus = {
  success: false,
  code: 1,
  signal: null,
};

Deno.test("inspectWaitFlag pauses the profiled process until capture attaches", () => {
  assertEquals(
    inspectWaitFlag("127.0.0.1", 9333),
    "--inspect-wait=127.0.0.1:9333",
  );
});

Deno.test("findInspectorWebSocketUrl reads the inspector URL from stderr text", () => {
  assertEquals(
    findInspectorWebSocketUrl(
      "Debugger listening on ws://127.0.0.1:9333/abc\n",
    ),
    "ws://127.0.0.1:9333/abc",
  );
  assertEquals(findInspectorWebSocketUrl("no inspector yet"), undefined);
});

Deno.test("parseProfileArgs rejects target URL patterns", () => {
  assertThrows(
    () => parseProfileArgs(["--profile-target-url-pattern=mod.ts"]),
    Error,
    "cf-profile uses the inspector URL emitted by its child process",
  );
});

Deno.test("parseProfileArgs rejects timeout-based options", () => {
  for (const arg of [
    "--profile-timeout-ms=5000",
    "--profile-connect-timeout-ms=2500",
  ]) {
    assertThrows(
      () => parseProfileArgs([arg]),
      Error,
      "cf-profile does not support timeout-based options",
    );
  }
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure stops the CLI after capture failure", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();
  const cliStopState = { sent: false };
  const signals: Deno.Signal[] = [];

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve(failureStatus),
    cliStopState,
    {
      kill: (signal) => {
        signals.push(signal);
        cliStatus.resolve({
          success: false,
          code: 143,
          signal,
        });
      },
    },
  );

  assertEquals(await result, {
    success: false,
    code: 143,
    signal: "SIGTERM",
  });
  assertEquals(cliStopState.sent, true);
  assertEquals(signals, ["SIGTERM"]);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure leaves the CLI running after capture success", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();
  const cliStopState = { sent: false };
  const signals: Deno.Signal[] = [];

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve(successStatus),
    cliStopState,
    {
      kill: (signal) => {
        signals.push(signal);
      },
    },
  );

  await Promise.resolve();
  cliStatus.resolve(successStatus);

  assertEquals(await result, successStatus);
  assertEquals(cliStopState.sent, false);
  assertEquals(signals, []);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure returns when the CLI exits first", async () => {
  const cliStopState = { sent: false };
  const signals: Deno.Signal[] = [];

  const result = await waitForCliStatusOrStopOnCaptureFailure(
    Promise.resolve(successStatus),
    new Promise(() => {}),
    cliStopState,
    {
      kill: (signal) => {
        signals.push(signal);
      },
    },
  );

  assertEquals(result, successStatus);
  assertEquals(cliStopState.sent, false);
  assertEquals(signals, []);
});
