import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";

import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { patternTool } from "../src/builder/built-in.ts";
import { pattern } from "../src/builder/pattern.ts";
import {
  decodeDataURIValue,
  FABRIC_VALUE_DATA_URI_PREFIX,
} from "../src/uri-utils.ts";
import { isPatternRefSentinel } from "../src/builtins/op-pattern-ref.ts";

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

    expect(id.startsWith(FABRIC_VALUE_DATA_URI_PREFIX)).toBe(true);
    const document = decodeDataURIValue(id) as {
      value: { direct: unknown; nested: unknown[] };
    };
    expect(isAdmittedFabricFactory(document.value.direct)).toBe(true);
    expect(isAdmittedFabricFactory(document.value.nested[0])).toBe(true);
    expect(factoryStateOf(document.value.direct)).toEqual(
      factoryStateOf(factory),
    );
    expect(() => (document.value.direct as () => unknown)()).toThrow(
      "factory requires runner materialization",
    );
    expect(isPatternRefSentinel(document.value.direct)).toBe(false);

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
      .toThrow("no durable artifact ref");
    expect(() => runtime.getImmutableCell(destinationSpace, () => undefined))
      .toThrow("no applicable codec");
  });

  it("keeps keyless patternTool values on the explicit legacy graph boundary", () => {
    const keyless = pattern(
      ({ value }: { value: number }) => ({ value }),
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    );

    const tool = patternTool(keyless);
    expect(typeof tool.pattern).toBe("object");
    expect((tool.pattern as unknown as { nodes?: readonly unknown[] }).nodes)
      .toBeDefined();

    const stored = runtime.getImmutableCell(destinationSpace, { tool })
      .getRaw() as {
        tool: {
          pattern: {
            nodes?: readonly unknown[];
            result?: { value?: { $alias?: unknown } };
          };
        };
      };
    expect(typeof stored.tool.pattern).toBe("object");
    expect(stored.tool.pattern.nodes).toBeDefined();
    expect(stored.tool.pattern.result?.value?.$alias).toBeDefined();

    // Only the deprecated patternTool writer gets the explicit graph fallback.
    // An ordinary keyless Factory@1 value still cannot cross a durable
    // boundary because no cold-loadable artifact closure exists for it.
    expect(() =>
      runtime.getImmutableCell(destinationSpace, { direct: keyless })
    ).toThrow("no durable artifact ref");
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
