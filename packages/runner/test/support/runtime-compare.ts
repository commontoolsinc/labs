import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { UnsafeEvalRuntime } from "../../src/harness/eval-runtime.ts";
import * as RuntimeModules from "../../src/harness/runtime-modules.ts";
import type { JsScript } from "@commontools/js-compiler";

export async function compareExports(program: RuntimeProgram): Promise<void> {
  const signer = await Identity.fromPassphrase("runtime-compare exports");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const { id, jsScript } = await runtime.harness.compile(program);
    const ses = await runtime.harness.evaluate(id, jsScript, program.files);
    const legacy = await executeLegacy(jsScript);

    assertEquals(normalizeValue(ses.main), normalizeValue(legacy.main));
    assertEquals(normalizeValue(ses.exportMap), normalizeValue(legacy.exportMap));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

export async function compareMappedError(
  program: RuntimeProgram,
  invokeExport: (main: Record<string, unknown>) => unknown,
): Promise<void> {
  const signer = await Identity.fromPassphrase("runtime-compare errors");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const { id, jsScript } = await runtime.harness.compile(program);
    const ses = await runtime.harness.evaluate(id, jsScript, program.files);
    const legacy = await executeLegacy(jsScript);

    const sesError = captureError(() => runtime.harness.invoke(() => invokeExport(ses.main!)));
    const legacyError = captureError(() => invokeExport(legacy.main));

    assertEquals(
      normalizeStack(runtime.harness.parseStack(sesError.stack ?? "")),
      normalizeStack(legacy.runtime.parseStack(legacyError.stack ?? "")),
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

async function executeLegacy(jsScript: JsScript): Promise<{
  main: Record<string, unknown>;
  exportMap: Record<string, Record<string, unknown>>;
  runtime: UnsafeEvalRuntime;
}> {
  const runtime = new UnsafeEvalRuntime();
  const isolate = runtime.getIsolate("");
  const { runtimeExports } = await RuntimeModules.getExports();
  const result = isolate.execute(jsScript).invoke(runtimeExports).inner();
  if (
    result && typeof result === "object" && "main" in result &&
    "exportMap" in result
  ) {
    return {
      main: result.main as Record<string, unknown>,
      exportMap: result.exportMap as Record<string, Record<string, unknown>>,
      runtime,
    };
  }
  throw new Error("Unexpected legacy evaluation result");
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "function") {
    return "[Function]";
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeValue(entry),
      ]),
    );
  }
  return value;
}

function captureError(callback: () => unknown): Error {
  try {
    callback();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected callback to throw");
}

function normalizeStack(stack: string): string[] {
  return stack.split("\n").slice(0, 3);
}
