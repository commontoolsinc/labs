/**
 * The doc-explosion law shape (v1 05-baselines: docs ≈ 5 + 3N,
 * nodes ≈ 8 + 4N for a map over N elements), measured OFF vs ON through the
 * real runtime. Pins the CURRENT slopes so the collection-inline work (W5)
 * has a baseline, and asserts output equality. The per-element child
 * patterns instantiate through `instantiatePattern`, so flag-ON they
 * RE-DISPATCH through the interpreter — the census tells us whether that
 * engagement already happens before per-element inlining lands.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import { str } from "../../src/builder/built-in.ts";
import type { Pattern } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
} from "../../src/reactive-interpreter/dispatch.ts";
import {
  attachDocRecorder,
  type NodeStats,
  nodeStats,
} from "../support/interpreter-measure.ts";
import { trustExecutable } from "../support/trusted-builder.ts";
import { pullSnapshot } from "../support/pull-snapshot.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

interface Measurement {
  value: unknown;
  docsCreated: number;
  nodes: NodeStats;
  wallMs: number;
  census: ReturnType<typeof getDispatchCensus>;
}

function buildMapPattern(): Pattern {
  // The list-op child contract: the element pattern's argument is
  // `{element, index?, array?, params?}` (inferListOpArgumentUsage).
  const Row = pattern<{ element: { n: number } }>(
    (input) => {
      const doubled = lift((v: { n: number }) => v.n * 2)({
        n: input.element.n,
      });
      const label = str`n=${input.element.n} doubled=${doubled}`;
      return { doubled, label };
    },
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
  return pattern<{ items: { n: number }[] }>((input) => {
    const rows = (input.items as unknown as {
      mapWithPattern: (op: unknown, params: unknown) => unknown;
    }).mapWithPattern(Row as unknown, {}) as never;
    return { rows };
  }) as unknown as Pattern;
}

async function measureOnce(
  interpreter: boolean,
  n: number,
): Promise<Measurement> {
  const storageManager = StorageManager.emulate({ as: signer });
  const docs = attachDocRecorder(storageManager);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { experimentalInterpreter: interpreter },
  });
  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    resetDispatchCensus();
    const factory = buildMapPattern();
    const items = Array.from({ length: n }, (_, i) => ({ n: i + 1 }));
    const resultCell = runtime.getCell(
      space,
      `ri2-measure-map-${interpreter}-${n}`,
    );
    const mark = docs.mark();
    const t0 = performance.now();
    const result = runtime.run(
      undefined,
      trustExecutable(runtime, factory) as never,
      { items } as never,
      resultCell as never,
    );
    const value = await pullSnapshot(result);
    await runtime.idle();
    const wallMs = performance.now() - t0;
    return {
      value,
      docsCreated: mark.createdSince().length,
      nodes: nodeStats(runtime),
      wallMs,
      census: JSON.parse(JSON.stringify(getDispatchCensus())),
    };
  } finally {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("map footprint (doc-explosion law) OFF vs ON", () => {
  it("N=10: outputs equal; slopes printed for PROGRESS", async () => {
    const n = 10;
    const off = await measureOnce(false, n);
    const on = await measureOnce(true, n);

    for (const [tag, m] of [["OFF", off], ["ON ", on]] as const) {
      console.log(
        `[ri2-map] ${tag} N=${n}: nodes=${m.nodes.total} ` +
          `byType=${JSON.stringify(m.nodes.byType)} docs=${m.docsCreated} ` +
          `wall=${m.wallMs.toFixed(1)}ms census=${JSON.stringify(m.census)}`,
      );
    }

    assertEquals(on.value, off.value, "outputs must be byte-equal");
    // The inline coordinator must engage on this eligible pure-element map
    // and break the doc-explosion law (legacy ~3 docs + ~4 nodes/element →
    // ~1 doc + 1 effect/element).
    assert(
      (on.census.boundariesByKind["collection-inlined"] ?? 0) >= 1,
      `expected inline engagement, census=${JSON.stringify(on.census)}`,
    );
    assert(
      on.docsCreated < off.docsCreated,
      `doc win expected: ON ${on.docsCreated} < OFF ${off.docsCreated}`,
    );
    assert(
      on.nodes.total < off.nodes.total,
      `node win expected: ON ${on.nodes.total} < OFF ${off.nodes.total}`,
    );
  });
});
