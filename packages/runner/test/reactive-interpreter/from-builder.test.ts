/**
 * W2 — builder-born ROG construction (D-V2-SEQ / D-V2-ROG-SIDETABLE).
 *
 * Builds patterns through the REAL builder API and asserts the ROG recorded
 * in the side-table: op kinds, tagged control semantics, native interpolate
 * for `str`, effect boundaries by ref name, live leaf impls, nested pattern
 * child graphs, and the fail-closed `incomplete` marker.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import {
  fetchJson,
  ifElse,
  str,
  unless,
  when,
} from "../../src/builder/built-in.ts";
import type { Frame } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { getBuiltRog } from "../../src/reactive-interpreter/from-builder.ts";
import type { Op, Rog, ValueRef } from "../../src/reactive-interpreter/rog.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

function rogOf(factory: unknown): Rog {
  const built = getBuiltRog(factory);
  assertExists(built, "pattern factory should carry a BuiltRog");
  return built!.rog;
}

function opsOfKind(rog: Rog, kind: Op["kind"]): Op[] {
  return rog.ops.filter((op) => op.kind === kind);
}

function resolveResultConstruct(rog: Rog): Op | undefined {
  if (rog.result.kind !== "opOut") return undefined;
  return rog.ops[rog.result.op];
}

describe("builder-born ROG (W2)", () => {
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

  it("records a complete ROG for a simple lift pattern with live impls", () => {
    const factory = pattern<{ a: number; b: number }>((input) => {
      const sum = lift(({ a, b }: { a: number; b: number }) => a + b)({
        a: input.a,
        b: input.b,
      });
      return { sum };
    });

    const built = getBuiltRog(factory)!;
    assertExists(built);
    const rog = built.rog;
    assertEquals(rog.incomplete, undefined, "should be complete");

    const leaves = opsOfKind(rog, "leaf");
    assertEquals(leaves.length, 1);
    // The live impl is captured — runnable without any SES/implRef round-trip.
    const impl = built.leafImpls.get(leaves[0].id)!;
    assertExists(impl);
    assertEquals(impl({ a: 1, b: 2 }), 3);

    // Leaf input is a construct of {a: argument.a, b: argument.b}.
    assertEquals(leaves[0].inputs.length, 1);
    const leafInput = leaves[0].inputs[0];
    assertEquals(leafInput.kind, "opOut");
    const inputConstruct = rog.ops[(leafInput as { op: number }).op];
    assertEquals(inputConstruct.kind, "construct");
    const template = inputConstruct.detail.kind === "construct"
      ? inputConstruct.detail.template
      : undefined;
    assert(template?.shape === "object");
    assertEquals(template.fields.a, { kind: "argument", path: ["a"] });
    assertEquals(template.fields.b, { kind: "argument", path: ["b"] });

    // Result is a construct with `sum` pointing at the leaf's output.
    const resultConstruct = resolveResultConstruct(rog)!;
    assertEquals(resultConstruct.kind, "construct");
    const resultTemplate = resultConstruct.detail.kind === "construct"
      ? resultConstruct.detail.template
      : undefined;
    assert(resultTemplate?.shape === "object");
    assertEquals(resultTemplate.fields.sum, {
      kind: "opOut",
      op: leaves[0].id,
      path: [],
    });
  });

  it("emits tagged control ops for ifElse/when/unless", () => {
    const factory = pattern<{ flag: boolean; a: string; b: string }>(
      (input) => ({
        picked: ifElse(input.flag, input.a, input.b),
        maybe: when(input.flag, input.a),
        fallback: unless(input.flag, input.b),
      }),
    );

    const rog = rogOf(factory);
    assertEquals(rog.incomplete, undefined);
    const controls = opsOfKind(rog, "control");
    assertEquals(controls.length, 3);

    const byOp = new Map(
      controls.map(
        (op) => [op.detail.kind === "control" ? op.detail.op : "?", op.detail],
      ),
    );

    const ifElseDetail = byOp.get("ifElse");
    assert(ifElseDetail?.kind === "control");
    assertEquals(ifElseDetail.pred, { kind: "argument", path: ["flag"] });
    assertEquals(ifElseDetail.then, { kind: "argument", path: ["a"] });
    assertEquals(ifElseDetail.else, { kind: "argument", path: ["b"] });

    // when(c, v): truthy → v, falsy → the predicate's own value.
    const whenDetail = byOp.get("when");
    assert(whenDetail?.kind === "control");
    assertEquals(whenDetail.then, { kind: "argument", path: ["a"] });
    assertEquals(whenDetail.else, "pred");

    // unless(c, f): truthy → the predicate's own value, falsy → f.
    const unlessDetail = byOp.get("unless");
    assert(unlessDetail?.kind === "control");
    assertEquals(unlessDetail.then, "pred");
    assertEquals(unlessDetail.else, { kind: "argument", path: ["b"] });
  });

  it("lowers str to a native interpolate op (no leaf, no SES)", () => {
    const factory = pattern<{ name: string }>((input) => ({
      greeting: str`Hello, ${input.name}!`,
    }));

    const built = getBuiltRog(factory)!;
    const rog = built.rog;
    assertEquals(rog.incomplete, undefined);

    const interpolates = opsOfKind(rog, "interpolate");
    assertEquals(interpolates.length, 1);
    const detail = interpolates[0].detail;
    assert(detail.kind === "interpolate");
    assertEquals(detail.strings, ["Hello, ", "!"]);
    assertEquals(detail.values, [{ kind: "argument", path: ["name"] }]);
    // Mirrored into op.inputs for the producer-edge view.
    assertEquals(interpolates[0].inputs, detail.values);

    // No opaque leaf for the str body.
    assertEquals(opsOfKind(rog, "leaf").length, 0);
    assertEquals(built.leafImpls.size, 0);
  });

  it("classifies I/O builtins as effect boundaries with their data inputs", () => {
    const factory = pattern<{ url: string }>((input) => ({
      data: fetchJson({ url: input.url }),
    }));

    const rog = rogOf(factory);
    assertEquals(rog.incomplete, undefined);

    const effects = opsOfKind(rog, "effect");
    assertEquals(effects.length, 1);
    const detail = effects[0].detail;
    assert(detail.kind === "effect");
    assertEquals(detail.sink, "io");
    assertEquals(detail.builtin, "fetchJson");
    // The boundary's data input edge exists (F1 by construction).
    assertEquals(effects[0].inputs.length, 1);
  });

  it("inlines a nested pattern's child ROG", () => {
    const inner = pattern<{ x: number }>((input) => ({
      doubled: lift((v: { x: number }) => v.x * 2)({ x: input.x }),
    }));
    const outer = pattern<{ y: number }>((input) => ({
      out: inner({ x: input.y }),
    }));

    const rog = rogOf(outer);
    const patterns = opsOfKind(rog, "pattern");
    assertEquals(patterns.length, 1);
    const detail = patterns[0].detail;
    assert(detail.kind === "pattern");
    assertExists(detail.child, "child ROG should be inlined");
    assertEquals(detail.child!.ops.filter((o) => o.kind === "leaf").length, 1);
    // The bound argument maps the outer argument through.
    const argRef = detail.argument;
    assertEquals(argRef.kind, "opOut"); // construct of {x: argument.y}
  });

  it("const inputs stay inline; static-only trees do not mint construct ops", () => {
    const factory = pattern<{ n: number }>((input) => ({
      out: lift((v: { n: number; cfg: { k: string } }) => `${v.n}${v.cfg.k}`)({
        n: input.n,
        cfg: { k: "static" },
      }),
    }));

    const rog = rogOf(factory);
    assertEquals(rog.incomplete, undefined);
    const leaf = opsOfKind(rog, "leaf")[0];
    const leafInput = leaf.inputs[0];
    assertEquals(leafInput.kind, "opOut");
    const construct = rog.ops[(leafInput as { op: number }).op];
    assert(construct.detail.kind === "construct");
    const t = construct.detail.template;
    assert(t.shape === "object");
    // The static subtree is a const leaf of the template, not its own op.
    assertEquals(t.fields.cfg, {
      kind: "const",
      value: { k: "static" },
    } as ValueRef);
  });
});
