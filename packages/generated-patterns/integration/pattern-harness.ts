import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";
import { waitFor } from "@commontools/integration";
import { fromFileUrl } from "@std/path";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../../runner/src/storage/cache.deno.ts";
import { Runtime } from "@commontools/runner";
import { sleep } from "@commontools/utils/sleep";

export interface EventSpec {
  stream: string;
  payload: unknown;
}

export interface AssertionSpec {
  path: string;
  value: unknown;
}

export interface TestStep {
  events?: EventSpec[];
  expect: AssertionSpec[];
}

export interface PatternIntegrationScenario<TArgument = any> {
  name: string;
  module: string | URL;
  exportName?: string;
  argument?: TArgument;
  steps: TestStep[];
}

const signer = await Identity.fromPassphrase("pattern integration harness");
const space = signer.did();

function splitPath(path: string): (string | number)[] {
  return path.split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const index = Number(segment);
      return Number.isInteger(index) && index.toString() === segment
        ? index
        : segment;
    });
}

function resolveModulePath(moduleRef: string | URL): string {
  if (moduleRef instanceof URL) {
    if (moduleRef.protocol === "file:") {
      return fromFileUrl(moduleRef);
    }
    throw new Error(`Unsupported module URL protocol: ${moduleRef.protocol}`);
  }

  if (moduleRef.startsWith("file:")) {
    return fromFileUrl(new URL(moduleRef));
  }

  return moduleRef;
}

export async function runPatternScenario(scenario: PatternIntegrationScenario) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtimeErrors: Error[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    errorHandlers: [(error) => {
      runtimeErrors.push(error);
    }],
  });

  const modulePath = resolveModulePath(scenario.module);
  const programResolver = new FileSystemProgramResolver(modulePath);
  const program = await runtime.harness.resolve(programResolver);
  if (scenario.exportName) {
    program.mainExport = scenario.exportName;
  }
  const patternFactory = await runtime.patternManager.compilePattern(program);

  const tx = runtime.edit();
  const resultCell = runtime.getCell<any>(
    space,
    { scenario: scenario.name },
    patternFactory.resultSchema,
    tx,
  );
  const argument = scenario.argument ?? {};
  const result = runtime.run(tx, patternFactory, argument, resultCell);
  tx.commit();

  // Sink to keep the result reactive, track cancel function for cleanup
  const cancelSink = result.sink(() => {});
  await runtime.idle();

  let stepIndex = 0;
  const name = scenario.exportName ?? scenario.name;

  for (const step of scenario.steps) {
    stepIndex++;
    if (step.events) {
      for (const event of step.events) {
        const pathSegments = splitPath(event.stream);
        const targetCell = pathSegments.reduce(
          (cell, segment) => cell.key(segment),
          result,
        );
        await runtime.editWithRetry((tx) =>
          targetCell.withTx(tx).send(event.payload)
        );
      }
      await runtime.idle();
    }

    for (const assertion of step.expect) {
      const pathSegments = splitPath(assertion.path);
      const targetCell = pathSegments.reduce(
        (cell, segment) => cell.key(segment),
        result,
      );

      // Use waitFor to poll until assertion passes or timeout
      let actual: unknown;
      try {
        await waitFor(async () => {
          actual = await targetCell.pull();
          try {
            expect(actual).toEqualIgnoringSymbols(assertion.value);
            return true;
          } catch {
            return false;
          }
        }, { timeout: 5000, delay: 50 });
      } catch {
        // Pull final value for detailed assertion error on timeout
        actual = await targetCell.pull();
      }

      // Final assertion with expect() to get proper error messages on failure
      expect(actual, `${name}:${stepIndex}:${assertion.path}`)
        .toEqualIgnoringSymbols(assertion.value);
    }
  }

  // Cancel the sink to stop reactive updates
  cancelSink();

  // Wait for any pending work to complete before cleanup
  await runtime.idle();

  // Small delay to allow any pending debounce timers to either fire or be cancelled
  await sleep(100);

  await runtime.dispose();
  await storageManager.close();

  if (runtimeErrors.length > 0) {
    const errorMessages = runtimeErrors.map((e) => e.message).join("\n");
    throw new Error(
      `Test passed but runtime errors occurred:\n${errorMessages}`,
    );
  }
}
