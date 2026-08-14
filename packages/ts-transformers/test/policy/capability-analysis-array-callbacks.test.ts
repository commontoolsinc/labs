import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callSchemas, parseModule } from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";

// A builder's input schema is shrunk to the paths the capability analysis
// observes the callback reading, so a property the analysis fails to see is
// not a type-mapping question — it is simply absent from the schema, and the
// runtime delivers `undefined` for it with nothing to say so. These tests pin
// the reads that happen one function deeper than the body: inside the arrow
// passed to `find` / `filter` / `some`.
//
// The whole pipeline is the harness rather than `analyzeFunctionCapabilities`
// alone, because the array-callback descent is keyed off the checker's
// classification of the receiver and the result only becomes observable once
// schema injection has written it into the emitted `lift(...)` call.

/** Every property of `table`'s element schema in `schema`, by name. */
function elementProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown>;
  const table = properties?.table as { items?: Record<string, unknown> };
  return (table?.items?.properties ?? {}) as Record<string, unknown>;
}

/**
 * The input schema emitted for a `lift` reading `{ table, self }`, where
 * `body` is its whole body expression.
 *
 * Both `self` and the element's properties are declared `unknown`, which is
 * the shape that makes the omission silent: `unknown` maps to a schema
 * whatever the analysis concludes, so a dropped property is invisible to the
 * type system and to every other gate the pipeline runs.
 */
async function liftInputSchema(body: string): Promise<Record<string, unknown>> {
  const output = await transformSource(
    `import { equals, lift } from "commonfabric";

const backlinksOf = lift((
  { table, self }: {
    table: { topic: unknown; mentionedBy: unknown }[];
    self: unknown;
  },
): unknown => ${body});

export default { backlinksOf };
`,
    { types: COMMONFABRIC_TYPES },
  );
  const schema = callSchemas(parseModule(output), "lift")[0];
  if (!schema) throw new Error("No emitted `lift(cb, input, result)` schema");
  return schema;
}

describe("capability-analysis-array-callbacks", () => {
  describe("a property read only inside an array-method callback", () => {
    it("reaches the input schema from a `find` callback behind a `??`", async () => {
      const schema = await liftInputSchema(
        `table.find((row) => equals(self, row.topic))?.mentionedBy ?? []`,
      );

      // `mentionedBy` is read by the outer expression and was never at risk;
      // `topic` is read only by the callback, and is the regression.
      expect(elementProperties(schema)).toEqual({
        topic: { type: "unknown" },
        mentionedBy: { type: "unknown" },
      });
    });

    it("reaches the input schema from a `filter` callback behind a `??`", async () => {
      const schema = await liftInputSchema(
        `table.filter((row) => equals(self, row.topic))[0]?.mentionedBy ?? []`,
      );

      expect(elementProperties(schema)).toEqual({
        topic: { type: "unknown" },
        mentionedBy: { type: "unknown" },
      });
    });

    it("reaches the input schema from a `some` callback", async () => {
      const schema = await liftInputSchema(
        `table.some((row) => equals(self, row.topic))`,
      );

      expect(elementProperties(schema)).toEqual({ topic: { type: "unknown" } });
    });
  });

  describe("a captured parameter read only inside an array-method callback", () => {
    it("carries the `comparable` cell annotation `equals` needs", async () => {
      const schema = await liftInputSchema(
        `table.find((row) => equals(self, row.topic))?.mentionedBy ?? []`,
      );

      // Without this the comparison receives a plain value rather than a cell
      // and `equals` compares two `undefined`s, which is the shape the topics
      // board hit: every row reported zero inbound references.
      expect((schema.properties as Record<string, unknown>).self).toEqual({
        type: "unknown",
        asCell: ["comparable"],
      });
      expect([...(schema.required as string[])].sort()).toEqual([
        "self",
        "table",
      ]);
    });
  });
});
