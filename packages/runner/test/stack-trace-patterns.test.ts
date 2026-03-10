// Tests that errors thrown from pattern lift() and handler() callbacks
// produce stack traces with correct ORIGINAL source locations when
// compiled through the full CTS transformer pipeline.
//
// These tests exercise the production compilation path:
// source string → transformCtDirective → TypeScript + CTS transformers
// → source maps → eval → error → parseStack → original line numbers.

import { assertEquals, assertMatch } from "@std/assert";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

function makeProgram(source: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: source }],
  };
}

Deno.test("lift error through CTS pipeline has correct source line", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost"),
    storageManager,
  });

  // Pattern source: throw is on line 5.
  // Source maps correctly point to the original throw location.
  const THROW_LINE = 5;
  const source = [
    "/// <cts-enable />", //                                  line 1
    'import { lift, pattern } from "commontools";', //        line 2
    "const double = lift((val: number) => {", //              line 3
    "  if (val > 10) {", //                                   line 4
    "    throw new Error('lift value too large');", //         line 5
    "  }", //                                                 line 6
    "  return val * 2;", //                                   line 7
    "});", //                                                 line 8
    "export default pattern<{ input: number }>(({ input }) => {", // line 9
    "  const result = double(input);", //                     line 10
    "  return { result };", //                                line 11
    "});", //                                                 line 12
  ].join("\n");

  const patternFn = await runtime.harness.run(makeProgram(source));

  let capturedError: Error | null = null;
  const errorHandlers = (runtime.scheduler as any).errorHandlers;
  errorHandlers.add((err: Error) => {
    capturedError = err;
  });

  const resultCell = runtime.getCell(space, "lift-stack-trace-cts");

  await runtime.setup(undefined, patternFn, { input: 5 }, resultCell);
  runtime.start(resultCell);

  const initial = (await resultCell.pull()) as any;
  assertEquals(initial.result, 10);

  // Trigger the error by setting input > 10
  const argumentCell = resultCell.getArgumentCell<{ input: number }>()!;
  const tx = runtime.edit();
  argumentCell.withTx(tx).set({ input: 20 });
  await tx.commit();
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true, "error should have been caught");
  assertEquals(capturedError!.message, "lift value too large");

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: lift value too large");

  // First frame must point to the throw location in main.tsx
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`main\\.tsx:${THROW_LINE}:\\d+`),
    `first frame should reference main.tsx:${THROW_LINE}, got:\n${frames[0]}`,
  );

  await runtime.dispose();
  await storageManager.close();
});

Deno.test("handler error through CTS pipeline has correct source line", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost"),
    storageManager,
  });

  // Pattern source: throw is on line 6.
  // Source maps correctly point to the original throw location.
  const THROW_LINE = 6;
  const source = [
    "/// <cts-enable />", //                                          line 1
    'import { type Cell, handler, pattern } from "commontools";', //  line 2
    "const clickHandler = handler(", //                               line 3
    "  (event: { action: string }, state: { status: Cell<string> }) => {", // line 4
    '    if (event.action === "crash") {', //                         line 5
    "      throw new Error('handler crash on purpose');", //          line 6
    "    }", //                                                       line 7
    "    state.status.set(`did: ${event.action}`);", //               line 8
    "  },", //                                                        line 9
    ");", //                                                          line 10
    "export default pattern<{ status: string }>(({ status }) => {", // line 11
    "  return { status, stream: clickHandler({ status }) };", //      line 12
    "});", //                                                         line 13
  ].join("\n");

  const patternFn = await runtime.harness.run(makeProgram(source));

  let capturedError: Error | null = null;
  const errorHandlers = (runtime.scheduler as any).errorHandlers;
  errorHandlers.add((err: Error) => {
    capturedError = err;
  });

  const resultCell = runtime.getCell(space, "handler-stack-trace-cts");

  await runtime.setup(
    undefined,
    patternFn,
    { status: "idle" },
    resultCell,
  );
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

  // First frame must point to the throw location in main.tsx
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`main\\.tsx:${THROW_LINE}:\\d+`),
    `first frame should reference main.tsx:${THROW_LINE}, got:\n${frames[0]}`,
  );

  await runtime.dispose();
  await storageManager.close();
});

Deno.test("lift error stack has multiple frames with correct source line", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost"),
    storageManager,
  });

  // Pattern source: throw is on line 4.
  // Source maps correctly point to the original throw location.
  const THROW_LINE = 4;
  const source = [
    "/// <cts-enable />", //                                  line 1
    'import { lift, pattern } from "commontools";', //        line 2
    "const double = lift((x: number) => {", //                line 3
    "  if (x < 0) throw new Error('negative not supported');", // line 4
    "  return x * 2;", //                                     line 5
    "});", //                                                  line 6
    "export default pattern<{ n: number }>(({ n }) => {", //   line 7
    "  const doubled = double(n);", //                         line 8
    "  return { doubled };", //                                line 9
    "});", //                                                  line 10
  ].join("\n");

  const patternFn = await runtime.harness.run(makeProgram(source));

  let capturedError: Error | null = null;
  const errorHandlers = (runtime.scheduler as any).errorHandlers;
  errorHandlers.add((err: Error) => {
    capturedError = err;
  });

  const resultCell = runtime.getCell(space, "multi-frame-cts");

  await runtime.setup(undefined, patternFn, { n: 1 }, resultCell);
  runtime.start(resultCell);
  await resultCell.pull();

  // Trigger error by setting n < 0
  const argumentCell = resultCell.getArgumentCell<{ n: number }>()!;
  const tx = runtime.edit();
  argumentCell.withTx(tx).set({ n: -5 });
  await tx.commit();
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true, "error should have been caught");

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: negative not supported");

  // First frame points to the throw location
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`main\\.tsx:${THROW_LINE}:\\d+`),
    `first frame should reference main.tsx:${THROW_LINE}, got:\n${frames[0]}`,
  );

  // Should have multiple frames
  assertEquals(
    frames.length > 1,
    true,
    `should have multiple frames, got ${frames.length}:\n${stack}`,
  );

  await runtime.dispose();
  await storageManager.close();
});
