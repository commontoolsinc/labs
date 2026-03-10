/// <cts-enable />
// Tests that errors thrown from pattern lift() and handler() callbacks
// produce stack traces with correct source locations pointing back to
// the original test file with exact line numbers.
//
// NOTE: The CTS transformer rewrites the source, shifting line numbers.
// The asserted line numbers below are the *transformed* positions.
// The goal is to eventually get the original pre-transformation line numbers
// (e.g. the lift throw is on source line 44, but CTS transforms it to line 39).

import { assertEquals, assertMatch } from "@std/assert";
import { Runtime } from "../src/runtime.ts";
import { handler, lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const THIS_FILE = "stack-trace-patterns.test.ts";

// CTS-transformed line numbers for each throw site.
// TODO: These should match the original source lines once source maps
// are wired through the CTS transformer pipeline.
const LIFT_THROW_LINE = 51; // source line 54
const HANDLER_THROW_LINE = 114; // source line 120
const NEGATIVE_THROW_LINE = 189; // source line 189

Deno.test("lift error stack trace has exact line number", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    opaqueRefs: new Set(),
    runtime,
  });

  let capturedError: Error | null = null;
  const errorHandlers = (runtime.scheduler as any).errorHandlers;
  errorHandlers.add((err: Error) => {
    capturedError = err;
  });

  const testPattern = pattern<{ input: number }>(({ input }) => {
    const result = lift((val: number) => {
      if (val > 10) {
        throw new Error("lift value too large"); // source line 54, CTS line 39
      }
      return val * 2;
    })(input).for("result");
    return { result };
  });

  const resultCell = runtime.getCell(space, "lift-stack-trace-test");

  runtime.setup(undefined, testPattern, { input: 5 }, resultCell);
  runtime.start(resultCell);

  const initial = (await resultCell.pull()) as any;
  assertEquals(initial.result, 10);

  // Trigger the error
  const argumentCell = resultCell.getArgumentCell<{ input: number }>()!;
  const tx = runtime.edit();
  argumentCell.withTx(tx).set({ input: 20 });
  await tx.commit();
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true, "error should have been caught");
  assertEquals(capturedError!.message, "lift value too large");

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: lift value too large");

  // First frame must point to this file at the exact throw line
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`${THIS_FILE}:${LIFT_THROW_LINE}:\\d+`),
    `first frame should be ${THIS_FILE}:${LIFT_THROW_LINE}, got:\n${frames[0]}`,
  );

  popFrame(frame);
  await runtime.dispose();
  await storageManager.close();
});

Deno.test("handler error stack trace has exact line number", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    opaqueRefs: new Set(),
    runtime,
  });

  let capturedError: Error | null = null;
  const errorHandlers = (runtime.scheduler as any).errorHandlers;
  errorHandlers.add((err: Error) => {
    capturedError = err;
  });

  const clickHandler = handler<
    { action: string },
    { status: string }
  >(
    ({ action }, state) => {
      if (action === "crash") {
        throw new Error("handler crash on purpose"); // source line 120, CTS line 104
      }
      state.status = `did: ${action}`;
    },
    { proxy: true },
  );

  const testPattern = pattern<{ status: string }>(({ status }) => {
    return { status, stream: clickHandler({ status }) };
  });

  const resultCell = runtime.getCell(space, "handler-stack-trace-test");

  runtime.setup(undefined, testPattern, { status: "idle" }, resultCell);
  runtime.start(resultCell);

  await resultCell.pull();

  // First event succeeds
  resultCell.key("stream").send({ action: "ok" });
  await runtime.scheduler.idle();
  assertEquals(capturedError, null, "no error on valid action");

  // Second event triggers the error
  resultCell.key("stream").send({ action: "crash" });
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true, "error should have been caught");
  assertEquals(capturedError!.message, "handler crash on purpose");

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: handler crash on purpose");

  // First frame must point to this file at the exact throw line
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`${THIS_FILE}:${HANDLER_THROW_LINE}:\\d+`),
    `first frame should be ${THIS_FILE}:${HANDLER_THROW_LINE}, got:\n${
      frames[0]
    }`,
  );

  popFrame(frame);
  await runtime.dispose();
  await storageManager.close();
});

Deno.test("error stack has multiple frames including this file", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    opaqueRefs: new Set(),
    runtime,
  });

  let capturedError: Error | null = null;
  const errorHandlers = (runtime.scheduler as any).errorHandlers;
  errorHandlers.add((err: Error) => {
    capturedError = err;
  });

  const testPattern = pattern<{ n: number }>(({ n }) => {
    const doubled = lift((x: number) => {
      if (x < 0) throw new Error("negative not supported"); // source line 189, CTS line 179
      return x * 2;
    })(n).for("doubled");
    return { doubled };
  });

  const resultCell = runtime.getCell(space, "error-message-test");

  runtime.setup(undefined, testPattern, { n: 1 }, resultCell);
  runtime.start(resultCell);
  await resultCell.pull();

  const argumentCell = resultCell.getArgumentCell<{ n: number }>()!;
  const tx = runtime.edit();
  argumentCell.withTx(tx).set({ n: -5 });
  await tx.commit();
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true);

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: negative not supported");

  // First frame points to exact line
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`${THIS_FILE}:${NEGATIVE_THROW_LINE}:\\d+`),
    `first frame should be ${THIS_FILE}:${NEGATIVE_THROW_LINE}, got:\n${
      frames[0]
    }`,
  );

  // Should have multiple frames (not just one)
  assertEquals(
    frames.length > 1,
    true,
    `should have multiple frames, got ${frames.length}:\n${stack}`,
  );

  popFrame(frame);
  await runtime.dispose();
  await storageManager.close();
});
