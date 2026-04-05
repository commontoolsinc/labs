import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { JsScript } from "@commonfabric/js-compiler";
import type { Pattern } from "../../src/builder/types.ts";
import { getRuntimeModuleExports } from "../../src/sandbox/mod.ts";
import { LegacyEvalRuntime } from "./legacy-eval-runtime.ts";
import { normalizeMappedStack } from "./stack-filter.ts";

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
    assertEquals(
      normalizeValue(ses.exportMap),
      normalizeValue(legacy.exportMap),
    );
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

    const sesError = captureError(() =>
      runtime.harness.invoke(() => invokeExport(ses.main!))
    );
    const legacyError = captureError(() =>
      legacy.runtime.invoke(() => invokeExport(legacy.main))
    );

    assertEquals(
      normalizeMappedStack(runtime.harness.parseStack(sesError.stack ?? "")),
      normalizeMappedStack(legacy.runtime.parseStack(legacyError.stack ?? "")),
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

export async function comparePatternResult<TArgument>(
  program: RuntimeProgram,
  argument: TArgument,
): Promise<void> {
  const sesSigner = await Identity.fromPassphrase(
    "runtime-compare ses pattern",
  );
  const sesStorageManager = StorageManager.emulate({ as: sesSigner });
  const sesRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sesStorageManager,
  });

  const legacySigner = await Identity.fromPassphrase(
    "runtime-compare legacy pattern",
  );
  const legacyStorageManager = StorageManager.emulate({ as: legacySigner });
  const legacyRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: legacyStorageManager,
  });

  try {
    const { id, jsScript } = await sesRuntime.harness.compile(program);
    const ses = await sesRuntime.harness.evaluate(id, jsScript, program.files);
    const legacy = await executeLegacy(jsScript);
    const exportName = program.mainExport ?? "default";
    const sesPattern = ses.main?.[exportName] as Pattern;
    const legacyPattern = legacyRuntime.unsafeTrustPattern(
      legacy.main[exportName] as Pattern,
      { reason: "legacy differential runtime comparison" },
    );

    const sesResultCell = sesRuntime.getCell(
      sesSigner.did(),
      { compare: "ses-pattern-result" },
      sesPattern.resultSchema,
    );
    const legacyResultCell = legacyRuntime.getCell(
      legacySigner.did(),
      { compare: "legacy-pattern-result" },
      legacyPattern.resultSchema,
    );

    const sesResult = await sesRuntime.runSynced(
      sesResultCell,
      sesPattern,
      argument,
    );
    const legacyResult = await legacyRuntime.runSynced(
      legacyResultCell,
      legacyPattern,
      argument,
    );

    assertEquals(
      normalizeValue(await sesResult.pull()),
      normalizeValue(await legacyResult.pull()),
    );
  } finally {
    await sesRuntime.dispose();
    await legacyRuntime.dispose();
    await sesStorageManager.close();
    await legacyStorageManager.close();
  }
}

export interface RuntimeCompareEvent {
  stream: string;
  payload: unknown;
}

export interface RuntimeCompareStep {
  events?: RuntimeCompareEvent[];
  observe: string[];
}

export async function comparePatternScenario<TArgument>(
  program: RuntimeProgram,
  argument: TArgument,
  steps: RuntimeCompareStep[],
): Promise<void> {
  const sesSigner = await Identity.fromPassphrase(
    "runtime-compare ses scenario",
  );
  const sesStorageManager = StorageManager.emulate({ as: sesSigner });
  const sesRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sesStorageManager,
  });

  const legacySigner = await Identity.fromPassphrase(
    "runtime-compare legacy scenario",
  );
  const legacyStorageManager = StorageManager.emulate({ as: legacySigner });
  const legacyRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: legacyStorageManager,
  });

  try {
    const { id, jsScript } = await sesRuntime.harness.compile(program);
    const ses = await sesRuntime.harness.evaluate(id, jsScript, program.files);
    const legacy = await executeLegacy(jsScript);
    const exportName = program.mainExport ?? "default";
    const sesPattern = ses.main?.[exportName] as Pattern;
    const legacyPattern = legacyRuntime.unsafeTrustPattern(
      legacy.main[exportName] as Pattern,
      { reason: "legacy differential runtime comparison" },
    );

    const sesResultCell = sesRuntime.getCell(
      sesSigner.did(),
      { compare: "ses-pattern-scenario" },
      sesPattern.resultSchema,
    );
    const legacyResultCell = legacyRuntime.getCell(
      legacySigner.did(),
      { compare: "legacy-pattern-scenario" },
      legacyPattern.resultSchema,
    );

    const sesResult = await sesRuntime.runSynced(
      sesResultCell,
      sesPattern,
      argument,
    );
    const legacyResult = await legacyRuntime.runSynced(
      legacyResultCell,
      legacyPattern,
      argument,
    );

    for (const step of steps) {
      if (step.events) {
        for (const event of step.events) {
          await sendRuntimeEvent(sesRuntime, sesResult, event);
          await sendRuntimeEvent(legacyRuntime, legacyResult, event);
        }
        await sesRuntime.idle();
        await legacyRuntime.idle();
      }

      for (const path of step.observe) {
        const sesValue = await readResultPath(sesResult, path);
        const legacyValue = await readResultPath(legacyResult, path);
        assertEquals(normalizeValue(sesValue), normalizeValue(legacyValue));
      }
    }
  } finally {
    await sesRuntime.dispose();
    await legacyRuntime.dispose();
    await sesStorageManager.close();
    await legacyStorageManager.close();
  }
}

export async function comparePatternMappedError<TArgument>(
  program: RuntimeProgram,
  argument: TArgument,
  event: RuntimeCompareEvent,
): Promise<void> {
  const sesErrors: Error[] = [];
  const legacyErrors: Error[] = [];
  const sesSigner = await Identity.fromPassphrase("runtime-compare ses error");
  const sesStorageManager = StorageManager.emulate({ as: sesSigner });
  const sesRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sesStorageManager,
    errorHandlers: [(error) => sesErrors.push(error)],
  });

  const legacySigner = await Identity.fromPassphrase(
    "runtime-compare legacy error",
  );
  const legacyStorageManager = StorageManager.emulate({ as: legacySigner });
  const legacyRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: legacyStorageManager,
    errorHandlers: [(error) => legacyErrors.push(error)],
  });

  try {
    const { id, jsScript } = await sesRuntime.harness.compile(program);
    const ses = await sesRuntime.harness.evaluate(id, jsScript, program.files);
    const legacy = await executeLegacy(jsScript);
    const exportName = program.mainExport ?? "default";
    const sesPattern = ses.main?.[exportName] as Pattern;
    const legacyPattern = legacyRuntime.unsafeTrustPattern(
      legacy.main[exportName] as Pattern,
      { reason: "legacy differential runtime comparison" },
    );

    const sesResultCell = sesRuntime.getCell(
      sesSigner.did(),
      { compare: "ses-pattern-error" },
      sesPattern.resultSchema,
    );
    const legacyResultCell = legacyRuntime.getCell(
      legacySigner.did(),
      { compare: "legacy-pattern-error" },
      legacyPattern.resultSchema,
    );

    const sesResult = await sesRuntime.runSynced(
      sesResultCell,
      sesPattern,
      argument,
    );
    const legacyResult = await legacyRuntime.runSynced(
      legacyResultCell,
      legacyPattern,
      argument,
    );

    await sendRuntimeEvent(sesRuntime, sesResult, event);
    await sendRuntimeEvent(legacyRuntime, legacyResult, event);
    await sesRuntime.idle();
    await legacyRuntime.idle();

    const sesError = sesErrors[0];
    const legacyError = legacyErrors[0];
    if (!sesError || !legacyError) {
      throw new Error("Expected both runtimes to surface a handler error");
    }

    assertEquals(
      normalizeMappedStack(sesRuntime.harness.parseStack(sesError.stack ?? "")),
      normalizeMappedStack(legacy.runtime.parseStack(legacyError.stack ?? "")),
    );
  } finally {
    await sesRuntime.dispose();
    await legacyRuntime.dispose();
    await sesStorageManager.close();
    await legacyStorageManager.close();
  }
}

async function executeLegacy(jsScript: JsScript): Promise<{
  main: Record<string, unknown>;
  exportMap: Record<string, Record<string, unknown>>;
  runtime: LegacyEvalRuntime;
}> {
  const runtime = new LegacyEvalRuntime();
  const isolate = runtime.getIsolate("");
  const { runtimeExports } = await getRuntimeModuleExports();
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
  if (value instanceof Map) {
    return {
      __kind: "Map",
      entries: Array.from(value.entries(), ([key, entry]) => [
        normalizeValue(key),
        normalizeValue(entry),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      __kind: "Set",
      values: Array.from(value.values(), normalizeValue),
    };
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

async function sendRuntimeEvent(
  runtime: Runtime,
  result: any,
  event: RuntimeCompareEvent,
): Promise<void> {
  const targetCell = getResultPath(result, event.stream);
  await runtime.editWithRetry((tx) =>
    targetCell.withTx(tx).send(event.payload)
  );
}

async function readResultPath(result: any, path: string): Promise<unknown> {
  return await getResultPath(result, path).pull();
}

function getResultPath(result: any, path: string): any {
  return splitPath(path).reduce((cell, segment) => cell.key(segment), result);
}

function splitPath(path: string): Array<string | number> {
  return path.split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const index = Number(segment);
      return Number.isInteger(index) && index.toString() === segment
        ? index
        : segment;
    });
}

function captureError(callback: () => unknown): Error {
  try {
    callback();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected callback to throw");
}
