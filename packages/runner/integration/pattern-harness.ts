import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";
import { fromFileUrl } from "@std/path";
import { FileSystemProgramResolver } from "@commontools/js-runtime";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";

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

function getValueByPath(data: unknown, segments: (string | number)[]): unknown {
  let current: any = data;
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;
    current = current[segment as keyof typeof current];
  }
  return current;
}

function getCellByPath(
  result: Cell<any>,
  segments: (string | number)[],
): Cell<any> {
  let current = result;
  for (const segment of segments) {
    current = current.key(segment as PropertyKey);
  }
  return current;
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
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });

  const modulePath = resolveModulePath(scenario.module);
  const programResolver = new FileSystemProgramResolver(modulePath);
  const program = await runtime.harness.resolve(programResolver);
  if (scenario.exportName) {
    program.mainExport = scenario.exportName;
  }
  const patternFactory = await runtime.recipeManager.compileRecipe(program);

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
      const actual = targetCell.get();
      expect(actual, `${name}:${stepIndex}:${assertion.path}`)
        .toEqualIgnoringSymbols(assertion.value);
    }
  }

  await runtime.dispose();
  await storageManager.close();
}
