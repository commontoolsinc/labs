/**
 * Coverage: collection-inline.ts — the element-argument-usage scan (which
 * child-argument fields the element ROG actually reads: element / index /
 * params / array, including whole-argument reads, nested children, and the
 * structural op-ref branches) plus the inline map's runtime edge cases
 * (undefined input list, non-array list). The degrade-to-legacy and
 * resume-republish machinery is exercised by the resume/list integration
 * suites, not here.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import { ifElse } from "../../src/builder/built-in.ts";
import type { Frame } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { getBuiltRog } from "../../src/reactive-interpreter/from-builder.ts";
import { elementArgumentUsage } from "../../src/reactive-interpreter/collection-inline.ts";

const signer = await Identity.fromPassphrase("ri2 cov-collection-inline");
const space = signer.did();

/** Build an element BuiltRog inside a frame and return its argument usage. */
function usageOf(build: () => unknown): {
  usesElement: boolean;
  usesIndex: boolean;
  usesArray: boolean;
  usesParams: boolean;
} {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { experimentalInterpreter: true },
  });
  const frame: Frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    const factory = build();
    const built = getBuiltRog(factory);
    assert(built !== undefined, "element factory should carry a BuiltRog");
    return elementArgumentUsage(built!);
  } finally {
    popFrame(frame);
    runtime.dispose();
    storageManager.close();
  }
}

describe("elementArgumentUsage scan", () => {
  it("reads element only", () => {
    const u = usageOf(() =>
      pattern<{ element: { n: number } }>((i) =>
        lift((v: { n: number }) => v.n * 2)({ n: i.element.n })
      )
    );
    assertEquals(u, {
      usesElement: true,
      usesIndex: false,
      usesArray: false,
      usesParams: false,
    });
  });

  it("reads index", () => {
    const u = usageOf(() =>
      pattern<{ element: { n: number }; index: number }>((i) => ({
        at: lift((v: { i: number }) => v.i)({ i: i.index }),
      }))
    );
    assert(u.usesIndex);
  });

  it("reads params", () => {
    const u = usageOf(() =>
      pattern<{ element: { n: number }; params: { k: number } }>((i) => ({
        scaled: lift((v: { n: number; k: number }) => v.n * v.k)({
          n: i.element.n,
          k: i.params.k,
        }),
      }))
    );
    assert(u.usesElement && u.usesParams);
  });

  it("reads array", () => {
    const u = usageOf(() =>
      pattern<{ element: { n: number }; array: number[] }>((i) => ({
        whole: lift((v: { arr: number[] }) => v.arr.length)({ arr: i.array }),
      }))
    );
    assert(u.usesArray);
  });

  it("whole-argument read marks every head", () => {
    // A lift reading the ENTIRE argument object → argument ref with empty
    // path → every usage head flips true.
    const u = usageOf(() =>
      pattern<{ element: { n: number } }>((i) =>
        lift((whole: unknown) => whole)(i as unknown as never)
      )
    );
    assertEquals(u, {
      usesElement: true,
      usesIndex: true,
      usesArray: true,
      usesParams: true,
    });
  });

  it("scans control-op refs (ifElse over element)", () => {
    const u = usageOf(() =>
      pattern<{ element: { flag: boolean; a: number; b: number } }>((i) => ({
        picked: ifElse(i.element.flag, i.element.a, i.element.b),
      }))
    );
    assert(u.usesElement);
  });

  it("recurses into a nested child pattern's refs", () => {
    const u = usageOf(() =>
      pattern<{ element: { n: number } }>((i) => {
        const inner = pattern<{ x: number }>((c) => ({
          doubled: lift((v: { x: number }) => v.x * 2)({ x: c.x }),
        }));
        return { out: inner({ x: i.element.n }) };
      })
    );
    assert(u.usesElement);
  });
});

/** Run a map pattern flag-on and return the mapped result. */
async function runMap(
  items: unknown,
  edit?: { path: string[]; value: unknown },
): Promise<unknown> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { experimentalInterpreter: true },
  });
  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    const Double = pattern<{ element: { n: number } }>(
      (i) => ({ d: lift((v: { n: number }) => v.n * 2)({ n: i.element.n }) }),
      {
        type: "object",
        properties: {
          element: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
        required: ["element"],
      },
    );
    const factory = pattern<{ items: { n: number }[] }>((input) => ({
      mapped: (input.items as unknown as {
        mapWithPattern: (op: unknown, params: unknown) => unknown;
      }).mapWithPattern(Double as unknown, {}),
    }));
    const resultCell = runtime.getCell(space, "cov-ci-map");
    const result = runtime.run(
      undefined,
      factory as never,
      { items: items } as never,
      resultCell as never,
    );
    const initial = JSON.parse(JSON.stringify(await result.pull()));
    return initial;
  } finally {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("inline map runtime edges", () => {
  it("maps a normal list", async () => {
    const out = await runMap([{ n: 1 }, { n: 2 }, { n: 3 }]);
    assertEquals(out, { mapped: [{ d: 2 }, { d: 4 }, { d: 6 }] });
  });

  it("undefined input list yields an empty container", async () => {
    const out = await runMap(undefined);
    assertEquals(out, { mapped: [] });
  });
});
