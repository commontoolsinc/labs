/**
 * W3 measurement — the doc#/node#/wall instrumentation, OFF vs ON, on a
 * computation-heavy pure pattern. The single-segment increment's claim:
 * scheduler NODES drop (one interpreter action replaces N javascript
 * actions); DOCS stay flat (same writes through the same aliases); outputs
 * byte-equal. Numbers are printed for PROGRESS.md tracking.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import { ifElse, str } from "../../src/builder/built-in.ts";
import type { Pattern } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
} from "../../src/reactive-interpreter/dispatch.ts";
import {
  attachDocRecorder,
  nodeStats,
  type NodeStats,
} from "../support/interpreter-measure.ts";
import { trustExecutable } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

interface Measurement {
  value: unknown;
  docsCreated: number;
  nodes: NodeStats;
  wallMs: number;
}

const num = lift((v: { x: number; y: number }) => v.x + v.y);

function buildComputeHeavyPattern(): Pattern {
  return pattern<{ a: number; b: number; flag: boolean }>((input) => {
    const s1 = num({ x: input.a, y: input.b });
    const s2 = num({ x: s1, y: input.a });
    const s3 = num({ x: s2, y: input.b });
    const s4 = num({ x: s3, y: s1 });
    const s5 = num({ x: s4, y: s2 });
    const s6 = num({ x: s5, y: s3 });
    const label1 = str`s4=${s4}`;
    const label2 = str`s6=${s6} (${label1})`;
    const picked = ifElse(input.flag, s5, s6);
    return { s6, label2, picked };
  }) as unknown as Pattern;
}

async function measureOnce(interpreter: boolean): Promise<Measurement> {
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
    const factory = buildComputeHeavyPattern();
    const resultCell = runtime.getCell(space, `ri2-measure-${interpreter}`);
    const mark = docs.mark();
    const t0 = performance.now();
    const result = runtime.run(
      undefined,
      trustExecutable(runtime, factory) as never,
      { a: 2, b: 3, flag: false } as never,
      resultCell as never,
    );
    const value = JSON.parse(JSON.stringify(await result.pull()));
    await runtime.idle();
    const wallMs = performance.now() - t0;
    return {
      value,
      docsCreated: mark.createdSince().length,
      nodes: nodeStats(runtime),
      wallMs,
    };
  } finally {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("interpreter footprint measurement (W3)", () => {
  it("nodes drop, docs stay flat, outputs byte-equal (OFF vs ON)", async () => {
    const off = await measureOnce(false);
    resetDispatchCensus();
    const on = await measureOnce(true);
    const census = getDispatchCensus();

    console.log(
      `[ri2-measure] OFF: nodes=${off.nodes.total} ` +
        `byType=${JSON.stringify(off.nodes.byType)} docs=${off.docsCreated} ` +
        `wall=${off.wallMs.toFixed(1)}ms`,
    );
    console.log(
      `[ri2-measure] ON:  nodes=${on.nodes.total} ` +
        `byType=${JSON.stringify(on.nodes.byType)} docs=${on.docsCreated} ` +
        `wall=${on.wallMs.toFixed(1)}ms census=${JSON.stringify(census)}`,
    );

    assertEquals(on.value, off.value, "outputs must be byte-equal");
    assert(census.interpreted >= 1, "flag-on run must interpret");
    assert(
      on.nodes.total < off.nodes.total,
      `node win expected: ON ${on.nodes.total} < OFF ${off.nodes.total}`,
    );
    // Same writes through the same aliases ⇒ no doc regression.
    assert(
      on.docsCreated <= off.docsCreated,
      `docs must not regress: ON ${on.docsCreated} vs OFF ${off.docsCreated}`,
    );
  });
});
