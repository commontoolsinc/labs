import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { SESRuntime } from "../src/sandbox/mod.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("SESRuntime", () => {
  it("creates distinct isolates per key and resets them on clear", () => {
    const runtime = new SESRuntime({ lockdown: true });

    const alpha = runtime.getIsolate("alpha");
    const beta = runtime.getIsolate("beta");

    expect(alpha).not.toBe(beta);

    runtime.clear();

    const alphaAfterClear = runtime.getIsolate("alpha");
    expect(alphaAfterClear).not.toBe(alpha);
  });

  it("clears cached callback creators on runtime.clear", () => {
    const runtime = new SESRuntime({ lockdown: true });

    const next = runtime.evaluateCallback(
      "function next(x) { return x + 1; }",
    ) as (x: number) => number;

    expect(next(1)).toBe(2);
    expect(
      (runtime as unknown as {
        callbackEvaluator: { callbackCreatorCache: Map<string, () => unknown> };
      }).callbackEvaluator.callbackCreatorCache.size,
    ).toBe(1);

    runtime.clear();

    expect(
      (runtime as unknown as {
        callbackEvaluator: { callbackCreatorCache: Map<string, () => unknown> };
      }).callbackEvaluator.callbackCreatorCache.size,
    ).toBe(0);
  });
});

describe("Engine module evaluation", () => {
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

  // NOTE: arbitrary top-level call results (`export default add(10, 2)`) are
  // rejected by the SES module-scope policy under the ESM record loader, so
  // these execute imported functions via exported functions instead.
  it("Compiles and executes a set of typescript files", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { add } from './utils.ts';",
            "export default function compute(): number { return add(10, 2); }",
          ].join("\n"),
        },
        {
          name: "/utils.ts",
          contents: "export const add=(x:number,y:number):number =>x+y;",
        },
      ],
    };
    const { main } = await runtime.harness.compileAndEvaluateModules(program);
    expect((main!.default as () => number)()).toBe(12);
  });

  it("Exports all file exports", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { add } from './utils/foo.ts';",
            "export function compute(): number { return add(10, 2); }",
            "export const foo = 'bar';",
          ].join("\n"),
        },
        {
          name: "/utils/foo.ts",
          contents:
            "export const add = (x: number, y: number): number => x + y; export const sub = (x: number, y: number): number => x - y;",
        },
      ],
    };
    const { exportMap } = await runtime.harness.compileAndEvaluateModules(
      program,
    );
    expect(exportMap).toBeDefined();
    // The export map is keyed by normalized authored paths and includes every
    // authored module's full export namespace.
    expect((exportMap!["/main.tsx"]["compute"] as () => number)()).toBe(12);
    expect(exportMap!["/main.tsx"]["foo"]).toBe("bar");
    expect(exportMap!["/utils/foo.ts"]["add"]).toBeInstanceOf(Function);
    expect(exportMap!["/utils/foo.ts"]["sub"]).toBeInstanceOf(Function);
  });

  it("compiles and executes the public CFC authoring runtime module", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { CFC_ATOM_TYPE, CFC_CONCEPT_KIND, cfcAtom } from 'commonfabric/cfc';",
            "export function buildCfcEvidence() {",
            "  return {",
            "    concept: CFC_CONCEPT_KIND.PromptInfluence,",
            "    safeType: cfcAtom.injectionSafe().type,",
            "    certifiedType: CFC_ATOM_TYPE.PolicyCertified,",
            "  };",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { main } = await runtime.harness.compileAndEvaluateModules(program);

    expect((main!.buildCfcEvidence as () => unknown)()).toEqual({
      concept: "https://commonfabric.org/cfc/concepts/prompt-influence",
      safeType: "https://commonfabric.org/cfc/atom/InjectionSafe",
      certifiedType: "https://commonfabric.org/cfc/atom/PolicyCertified",
    });
  });
});
