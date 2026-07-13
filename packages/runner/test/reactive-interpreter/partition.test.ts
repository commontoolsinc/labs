/**
 * W3 (partition half) — partition builder-born ROGs into segments +
 * boundaries. Structural properties: fully-pure pattern = one segment / no
 * boundaries; I/O builtins cut layers (upstream segment feeds the boundary,
 * downstream consumer lands in a later segment); pure nested patterns are
 * NOT boundaries; incomplete ROGs fail closed.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import { fetchJson, str } from "../../src/builder/built-in.ts";
import type { Frame } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  type BuiltRog,
  getBuiltRog,
} from "../../src/reactive-interpreter/from-builder.ts";
import { partition } from "../../src/reactive-interpreter/partition.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

function builtOf(factory: unknown): BuiltRog {
  const built = getBuiltRog(factory);
  assertExists(built);
  return built!;
}

describe("partition over builder-born ROGs (W3)", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("a fully pure pattern is one segment with no boundaries", () => {
    const factory = pattern<{ a: number; b: number }>((input) => {
      const sum = lift(({ a, b }: { a: number; b: number }) => a + b)({
        a: input.a,
        b: input.b,
      });
      const label = str`sum=${sum}`;
      return { sum, label };
    });

    const result = partition({ built: builtOf(factory) });
    assert(result.partitionable, `should partition: ${JSON.stringify(result)}`);
    assertEquals(result.boundaries.length, 0);
    assertEquals(result.segments.length, 1);
    assertEquals(result.segments[0].layer, 0);
    // The result-producing op is materialized.
    assert(result.segments[0].outputs.length >= 1);
  });

  it("an I/O builtin cuts: upstream seg → boundary → downstream seg", () => {
    const factory = pattern<{ q: string }>((input) => {
      const url = str`https://api.example.com/${input.q}`;
      const fetched = fetchJson<{ value: number }>({ url });
      const rendered = lift((v: { r: unknown }) =>
        `got ${JSON.stringify(v.r)}`
      )(
        { r: fetched },
      );
      return { rendered };
    });

    const result = partition({ built: builtOf(factory) });
    assert(result.partitionable, `should partition: ${JSON.stringify(result)}`);
    assertEquals(result.boundaries.length, 1);
    assertEquals(result.boundaries[0].kind, "effect");
    // Two pure regions: url-production (layer 0) and consumption (layer 1).
    assertEquals(result.segments.length, 2);
    assertEquals(result.segments[0].layer, 0);
    assertEquals(result.segments[1].layer, 1);

    const kinds = new Set(result.edges.map((e) => e.kind));
    assert(kinds.has("seg->bnd"), "upstream segment feeds the boundary");
    assert(kinds.has("bnd->seg"), "downstream segment reads the boundary");

    // The upstream segment materializes the boundary's input (its output set
    // is non-empty); the downstream segment reads the boundary output.
    const seg0 = result.segments[0];
    assert(seg0.outputs.length >= 1, "seg0 must materialize boundary input");
  });

  it("a pure nested pattern is a boundary by default; inlinable on opt-in", () => {
    const inner = pattern<{ x: number }>((input) => ({
      doubled: lift((v: { x: number }) => v.x * 2)({ x: input.x }),
    }));
    const outer = pattern<{ y: number }>((input) => ({
      out: inner({ x: input.y }),
    }));

    // Default: a child pattern's result cell can itself be the observable
    // (the launched-child / piece-identity contract), so it stays a boundary.
    const defaultResult = partition({ built: builtOf(outer) });
    assert(defaultResult.partitionable);
    assertEquals(defaultResult.boundaries.length, 1);
    assertEquals(defaultResult.boundaries[0].kind, "pattern");

    // Opt-in (future consumed-as-value analysis): inlined into the segment.
    const inlined = partition({
      built: builtOf(outer),
      inlinePurePatterns: true,
    });
    assert(inlined.partitionable);
    assertEquals(inlined.boundaries.length, 0);
    assertEquals(inlined.segments.length, 1);
  });

  it("an incomplete ROG fails closed", () => {
    const someCell = { deeply: { odd: () => 1 } };
    const factory = pattern<{ a: number }>((input) => ({
      out: lift((v: unknown) => v)({ a: input.a, weird: someCell }),
    }));

    const built = builtOf(factory);
    assert((built.rog.incomplete?.length ?? 0) > 0, "should be incomplete");
    const result = partition({ built });
    assert(!result.partitionable);
    assert(result.reason.includes("incomplete"));
  });
});
