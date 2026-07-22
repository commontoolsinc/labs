import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  DATA_URI_MEDIA_TYPE,
  valueFromDataUri,
} from "@commonfabric/data-model/data-uri-codec";

import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("factory data URI writer");
const destinationSpace = signer.did();
const otherSpace = (await Identity.fromPassphrase(
  "factory data URI writer other space",
)).did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => ({ value }));",
    ].join("\n"),
  }],
};

const OTHER_PROGRAM: RuntimeProgram = {
  main: "/other.tsx",
  files: [{
    name: "/other.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => ({ doubled: value * 2 }));",
    ].join("\n"),
  }],
};

describe("canonical factory data URI writer", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("writes Factory@1 only when its closure is available in the exact containing space", async () => {
    const factory = await runtime.patternManager.compilePattern(PROGRAM, {
      space: destinationSpace,
    });
    const cell = runtime.getImmutableCell(destinationSpace, {
      direct: factory,
      nested: [factory],
    });
    const id = cell.getAsNormalizedFullLink().id;

    expect(id.startsWith(`data:${DATA_URI_MEDIA_TYPE},`)).toBe(true);
    const value = valueFromDataUri(id) as {
      direct: unknown;
      nested: unknown[];
    };
    expect(isAdmittedFabricFactory(value.direct)).toBe(true);
    expect(isAdmittedFabricFactory(value.nested[0])).toBe(true);
    expect(factoryStateOf(value.direct)).toEqual(
      factoryStateOf(factory),
    );
    expect(() => (value.direct as () => unknown)()).toThrow(
      "factory requires runner materialization",
    );

    expect(() => runtime.getImmutableCell(otherSpace, factory)).toThrow(
      `is not available in space ${otherSpace}`,
    );

    const onlyInOtherSpace = await runtime.patternManager.compilePattern(
      OTHER_PROGRAM,
      { space: otherSpace },
    );
    expect(() =>
      runtime.getImmutableCell(destinationSpace, {
        available: factory,
        unavailable: onlyInOtherSpace,
      })
    ).toThrow(`is not available in space ${destinationSpace}`);
  });

  it("rejects session-only factories and arbitrary JavaScript functions", async () => {
    const sessionOnly = await runtime.patternManager.compilePattern(PROGRAM);
    expect(() => runtime.getImmutableCell(destinationSpace, sessionOnly))
      .toThrow("artifact ref is not available");
    expect(() => runtime.getImmutableCell(destinationSpace, () => undefined))
      .toThrow("Cannot store function");
  });

  it("preserves undefined fields and sparse arrays in canonical inline documents", () => {
    const sparse = new Array<string | undefined>(2);
    sparse[1] = "present";
    const cell = runtime.getImmutableCell(destinationSpace, {
      explicit: undefined,
      sparse,
    });
    const value = cell.getRaw() as {
      explicit?: unknown;
      sparse: Array<string | undefined>;
    };

    expect(Object.hasOwn(value, "explicit")).toBe(true);
    expect(0 in value.sparse).toBe(false);
    expect(value.sparse[1]).toBe("present");
  });
});
