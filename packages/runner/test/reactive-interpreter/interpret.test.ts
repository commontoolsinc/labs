/**
 * W3 (evaluator half) — evaluate builder-born ROGs (W2) with the v2 evalRog
 * and check the values against what the authored computation produces.
 * Covers the v1-ported semantics: leaf run-gate, interpolate/expr coercion
 * (no gate), normalized control (incl. falsy-but-defined operands), per-op
 * error isolation, probe mode, inlined nested patterns.
 */
import { assert, assertEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import { ifElse, str, unless, when } from "../../src/builder/built-in.ts";
import type { Frame } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  type BuiltRog,
  getBuiltRog,
} from "../../src/reactive-interpreter/from-builder.ts";
import { evalRog } from "../../src/reactive-interpreter/interpret.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

function evaluate(factory: unknown, argument: unknown) {
  const built = getBuiltRog(factory) as BuiltRog;
  assert(built, "factory should carry a BuiltRog");
  assertEquals(built.rog.incomplete, undefined, "ROG should be complete");
  return evalRog(built.rog, {
    argument,
    leafImpls: built.leafImpls,
    children: built.children,
  });
}

describe("evalRog over builder-born ROGs (W3)", () => {
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

  it("evaluates a lift chain to the authored values", () => {
    const factory = pattern<{ a: number; b: number }>((input) => {
      const sum = lift(({ a, b }: { a: number; b: number }) => a + b)({
        a: input.a,
        b: input.b,
      });
      const doubled = lift((v: { s: number }) => v.s * 2)({ s: sum });
      return { sum, doubled };
    });

    const { result } = evaluate(factory, { a: 3, b: 4 });
    assertEquals(result, { sum: 7, doubled: 14 });
  });

  it("control semantics match the builtins incl. falsy-but-defined", () => {
    const factory = pattern<{ flag: unknown; a: string; b: string }>(
      (input) => ({
        picked: ifElse(input.flag, input.a, input.b),
        maybe: when(input.flag, input.a),
        fallback: unless(input.flag, input.b),
      }),
    );

    // Truthy: ifElse→a, when→a, unless→condition value.
    assertEquals(evaluate(factory, { flag: true, a: "A", b: "B" }).result, {
      picked: "A",
      maybe: "A",
      fallback: true,
    });
    // Falsy-but-defined (0): when returns the CONDITION VALUE (0), not
    // undefined/false — the v1 E-1 class of divergence this pins.
    assertEquals(evaluate(factory, { flag: 0, a: "A", b: "B" }).result, {
      picked: "B",
      maybe: 0,
      fallback: "B",
    });
    assertEquals(evaluate(factory, { flag: "", a: "A", b: "B" }).result, {
      picked: "B",
      maybe: "",
      fallback: "B",
    });
  });

  it("interpolate coerces undefined like the str body (no run-gate)", () => {
    const factory = pattern<{ name?: string }>((input) => ({
      greeting: str`Hello, ${input.name}!`,
    }));

    assertEquals(evaluate(factory, { name: "Ada" }).result, {
      greeting: "Hello, Ada!",
    });
    // str`${undefined}` → "undefined" (the + coercion), NOT "".
    assertEquals(evaluate(factory, {}).result, {
      greeting: "Hello, undefined!",
    });
  });

  it("isolates a throwing leaf; downstream is run-gated; siblings compute", () => {
    const factory = pattern<{ n: number }>((input) => {
      const poisoned = lift((v: { n: number }) => {
        if (v.n > 0) throw new Error("boom");
        return v.n;
      })({ n: input.n });
      const downstream = lift((v: { p: number }) => `got ${v.p}`)({
        p: poisoned,
      });
      const safe = lift((v: { n: number }) => v.n + 1)({ n: input.n });
      return { downstream, safe };
    });

    const { result, errors } = evaluate(factory, { n: 5 });
    // Downstream reads {p: undefined}... the construct is DEFINED (an object
    // with an undefined field), so the leaf runs — matching legacy, whose
    // node input is the assembled object. The throwing leaf's own value is
    // undefined; the sibling still computes; exactly one error surfaced.
    assertEquals(result, { downstream: "got undefined", safe: 6 });
    assertEquals(errors.length, 1);
  });

  it("probe mode never invokes leaf bodies", () => {
    let invocations = 0;
    const factory = pattern<{ n: number }>((input) => ({
      out: lift((v: { n: number }) => {
        invocations++;
        return v.n;
      })({ n: input.n }),
    }));

    const built = getBuiltRog(factory)!;
    invocations = 0; // pattern construction does not run bodies either
    const { result } = evalRog(built.rog, {
      argument: { n: 1 },
      leafImpls: built.leafImpls,
      children: built.children,
      probe: true,
    });
    assertEquals(invocations, 0);
    assertEquals(result, { out: undefined });
  });

  it("evaluates an inlined nested pattern in the same pass", () => {
    const inner = pattern<{ x: number }>((input) => ({
      doubled: lift((v: { x: number }) => v.x * 2)({ x: input.x }),
    }));
    const outer = pattern<{ y: number }>((input) => ({
      out: inner({ x: input.y }),
    }));

    const { result } = evaluate(outer, { y: 21 });
    assertEquals(result, { out: { doubled: 42 } });
  });
});
