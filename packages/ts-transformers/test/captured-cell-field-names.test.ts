import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("captured cell value fields", () => {
  for (const builder of ["computed", "assert"]) {
    for (const field of ["count", "sum", "min", "max", "map", "get"]) {
      it(`preserves the numeric ${field} field and cell capability in ${builder}`, async () => {
        const output = await transformSource(
          `import { pattern, Writable, ${builder} } from "commonfabric";
          export default pattern(() => {
            const value = Writable.of({ ${field}: 1, unused: "omit" });
            return ${builder}(() => value.get().${field} === 1);
          });`,
          { types: COMMONFABRIC_TYPES, typeCheck: true },
        );
        expect(emittedSchemas(parseModule(output))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                value: expect.objectContaining({
                  asCell: ["readonly"],
                  properties: { [field]: { type: "number" } },
                }),
              }),
            }),
          ]),
        );
      });
    }
  }
  it("retains fields used through a helper alongside a direct member read", async () => {
    const output = await transformSource(
      `import { pattern, computed, Writable } from "commonfabric";
      function readLabel(value: { count: number; label: string }) {
        return value.label.toLowerCase();
      }
      export default pattern(() => {
        const value = Writable.of({ count: 1, label: "Ready" });
        return computed(() => {
          const snapshot = value.get();
          return readLabel(snapshot) + value.get().count;
        });
      });`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    expect(emittedSchemas(parseModule(output))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            value: expect.objectContaining({
              asCell: ["readonly"],
              properties: {
                count: { type: "number" },
                label: { type: "string" },
              },
            }),
          }),
        }),
      ]),
    );
  });

  for (
    const { declaration, read } of [
      { declaration: "value?: Writable<Data>", read: "value!.get().count" },
      { declaration: "value?: Writable<Data>", read: "value?.get().count" },
      {
        declaration: "value: Writable<Data> | null | undefined",
        read: "value?.get().count",
      },
      {
        declaration: "value: Writable<Data | undefined>",
        read: "value.get()?.count",
      },
    ]
  ) {
    it(`narrows count while preserving nullishness in ${declaration} read as ${read}`, async () => {
      const output = await transformSource(
        `import { pattern, computed, Writable } from "commonfabric";
        export default pattern<{ ${
          declaration.replaceAll("Data", "{ count: number; unused: string }")
        } }>(({value}) =>
          computed(() => ${read})
        );`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      expect(emittedSchemas(parseModule(output))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              value: expect.objectContaining({
                asCell: ["readonly"],
                anyOf: expect.arrayContaining([
                  expect.objectContaining({
                    type: "object",
                    properties: { count: { type: "number" } },
                    required: ["count"],
                  }),
                  { type: "undefined" },
                  ...(declaration.includes(" | null")
                    ? [{ type: "null" }]
                    : []),
                ]),
              }),
            }),
          }),
        ]),
      );
    });
  }
});
