import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("aggregate methods", () => {
  for (const inComputed of [false, true]) {
    it(`lowers captured callbacks in ${inComputed ? "computed" : "pattern"} context`, async () => {
      const wrap = (expression: string) =>
        inComputed ? `computed(() => ${expression})` : expression;
      const output = await transformSource(
        `
        import {pattern, computed, Cell} from "commonfabric";
        export default pattern<{items: Cell<{n: number}[]>; threshold: number}>(({items, threshold}) => ({
          count: ${wrap("items.count(item => item.n > threshold)")},
          minimum: ${wrap("items.minBy(item => item.n)")},
          maximum: ${wrap("items.maxBy(item => item.n)")},
        }));
      `,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const module = parseModule(output);
      for (const method of ["count", "minBy", "maxBy"]) {
        expect(callsNamed(module, method)).toHaveLength(0);
        expect(callsNamed(module, `${method}WithPattern`)).toHaveLength(1);
      }
      expect(emittedSchemas(module)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            count: { type: "number" },
            minimum: expect.objectContaining({
              anyOf: expect.arrayContaining([{ type: "undefined" }]),
            }),
            maximum: expect.objectContaining({
              anyOf: expect.arrayContaining([{ type: "undefined" }]),
            }),
          }),
        }),
      ]));
    });
  }

  it("keeps authored WithPattern callbacks with their enclosing captures", async () => {
    for (const method of ["map", "count", "minBy", "maxBy"]) {
      const output = await transformSource(
        `
        import { pattern } from "commonfabric";
        declare const receiver: any;
        export default pattern<{n: number}>(({n}) => ({
          output: receiver.${method}WithPattern(pattern(() => n), {})
        }));
      `,
        { types: COMMONFABRIC_TYPES },
      );
      const calls = callsNamed(parseModule(output), `${method}WithPattern`);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments[0].getText()).toContain("pattern(");
      expect(calls[0].arguments[0].getText()).toContain("n");
    }
  });

  it("retains direct calls for argument-free aggregates", async () => {
    const output = await transformSource(
      `
      import {pattern, Cell} from "commonfabric";
      export default pattern<{numbers: Cell<number[]>}>(({numbers}) => ({
        count: numbers.count(), sum: numbers.sum(), min: numbers.min(), max: numbers.max()
      }));
    `,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const module = parseModule(output);
    for (const method of ["count", "sum", "min", "max"]) {
      const calls = callsNamed(module, method);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toHaveLength(0);
    }
  });
});
