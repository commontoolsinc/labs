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
});
