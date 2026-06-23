/**
 * W0.4 — Pattern → ROG extraction coverage.
 *
 * Builds representative patterns via the real builder, extracts each into the
 * ROG vocabulary, and reports honest coverage: every node should classify into
 * a known OpKind, the recognized `$alias` shapes should resolve to ValueRefs,
 * and the collection element graph should be recursed. Unrecognized shapes are
 * surfaced (the boundary W1 must close), not hidden.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { createMeasureEnv } from "../support/interpreter-measure.ts";
import { extractRog } from "../../src/reactive-interpreter/extract.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-extract");
const num = { type: "number" } as const satisfies JSONSchema;

describe("W0.4 extraction coverage", () => {
  it("classifies map / control / leaf patterns and recurses element graphs", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;

      // (a) map over a list — collection + nested element pattern.
      const dbl = cf.lift((x: number) => x * 2, num, num);
      const elem = cf.pattern(
        ({ element }: { element: number }) => dbl(element),
        { type: "object", properties: { element: num }, required: ["element"] },
        num,
      );
      const mapP = cf.pattern(
        // deno-lint-ignore no-explicit-any
        ({ values }: { values: any }) => ({
          mapped: values.mapWithPattern(elem, {}),
        }),
        {
          type: "object",
          properties: { values: { type: "array", items: num } },
          required: ["values"],
        },
        {
          type: "object",
          properties: { mapped: { type: "array", items: num } },
        },
      );

      // (b) control — ifElse over a boolean argument.
      const ctrlP = cf.pattern(
        ({ show, a, b }: { show: boolean; a: number; b: number }) => ({
          out: cf.ifElse(show, a, b),
        }),
        {
          type: "object",
          properties: { show: { type: "boolean" }, a: num, b: num },
          required: ["show", "a", "b"],
        },
        { type: "object", properties: { out: num } },
      );

      // (c) plain leaf — a single lift over the argument.
      const leafP = cf.pattern(
        ({ x }: { x: number }) => ({ y: dbl(x) }),
        { type: "object", properties: { x: num }, required: ["x"] },
        { type: "object", properties: { y: num } },
      );

      const mapR = extractRog(mapP);
      const ctrlR = extractRog(ctrlP);
      const leafR = extractRog(leafP);

      for (
        const [name, r] of [["map", mapR], ["ctrl", ctrlR], [
          "leaf",
          leafR,
        ]] as const
      ) {
        console.log(
          `[extract ${name}] nodes=${r.coverage.nodes} classified=${r.coverage.classified}` +
            ` byKind=${
              JSON.stringify(r.coverage.byKind)
            } nested=${r.coverage.nested}` +
            ` unrecognized=${JSON.stringify(r.coverage.unrecognizedAliases)}` +
            ` result=${JSON.stringify(r.rog.result)}`,
        );
      }

      // Every node classifies (leaf is the sound default; nothing falls to
      // "unknown").
      for (const r of [mapR, ctrlR, leafR]) {
        expect(r.coverage.classified).toBe(r.coverage.nodes);
        expect(r.coverage.byKind.unknown ?? 0).toBe(0);
      }

      // map classified a collection op and recursed its element graph.
      expect(mapR.coverage.byKind.collection ?? 0).toBeGreaterThanOrEqual(1);
      expect(mapR.coverage.nested).toBeGreaterThanOrEqual(1);
      // its result is a synthesized object construct whose `mapped` field
      // resolves to the internal "mapped" cell (not silently dropped to const).
      expect(mapR.rog.result.kind).toBe("opOut");
      const ctor = mapR.rog.ops.find((op) => op.detail.kind === "construct");
      expect(ctor).toBeDefined();
      const tmpl = ctor!.detail.kind === "construct"
        ? ctor!.detail.template
        : undefined;
      const mappedField = tmpl?.shape === "object"
        ? tmpl.fields["mapped"]
        : undefined;
      expect(mappedField?.kind).toBe("internal");

      // control classified a control op.
      expect(ctrlR.coverage.byKind.control ?? 0).toBeGreaterThanOrEqual(1);

      // leaf pattern produced at least one leaf op reading the argument.
      expect(leafR.coverage.byKind.leaf ?? 0).toBeGreaterThanOrEqual(1);
      const leafReadsArg = leafR.rog.ops.some((op) =>
        op.inputs.some((i) => i.kind === "argument")
      );
      expect(leafReadsArg).toBe(true);
    } finally {
      env.dispose();
    }
  });
});
