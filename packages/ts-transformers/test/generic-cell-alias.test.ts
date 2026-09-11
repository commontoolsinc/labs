import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const types = {
  ...COMMONFABRIC_TYPES,
  "commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"] + `
    export interface PairHandle<T> extends BrandedCell<T, "readonly"> {
      lookup(key: unknown): Reactive<number>;
    }
    export type KeyedHandle<K, V> = PairHandle<{ key: K; value: V }>;
  `,
};

describe("generic cell aliases", () => {
  it("preserves alias arguments and Cell payloads in input and capture schemas", async () => {
    const output = await transformSource(
      `import { pattern, type KeyedHandle, type Cell } from "commonfabric";
      export default pattern<{
        index: KeyedHandle<Cell<{ id: string }>, { name: string }>;
        key: Cell<{ id: string }>;
      }>(({ index, key }) => index.lookup(key));`,
      { types, typeCheck: true },
    );
    const indexSchemas = emittedSchemas(parseModule(output)).flatMap(
      (schema) => {
        const properties = schema.properties;
        return properties !== null && typeof properties === "object" &&
            "index" in properties
          ? [properties.index]
          : [];
      },
    );
    expect(indexSchemas).toHaveLength(2);
    for (const schema of indexSchemas) {
      expect(schema).toEqual(expect.objectContaining({
        asCell: ["readonly"],
        properties: {
          key: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            asCell: ["cell"],
          },
          value: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      }));
    }
    expect(output).toContain("KeyedHandle<__cfHelpers.Cell<");
    expect(output).not.toContain("KeyedHandle<__cfHelpers.PairHandle<");
  });
  it("preserves a direct generic Cell alias when narrowing a captured read", async () => {
    const output = await transformSource(
      `import { pattern, computed, type Cell } from "commonfabric";
      type Pair<K, V> = Cell<{ key: K; value: V }>;
      export default pattern<{ pair: Pair<string, { name: string }> }>(
        ({ pair }) => computed(() => pair.get()),
      );`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const pairSchemas = emittedSchemas(parseModule(output)).flatMap(
      (schema) => {
        const properties = schema.properties;
        return properties !== null && typeof properties === "object" &&
            "pair" in properties
          ? [properties.pair]
          : [];
      },
    );
    expect(pairSchemas).toHaveLength(2);
    for (const schema of pairSchemas) {
      expect(schema).toEqual(expect.objectContaining({
        properties: {
          key: { type: "string" },
          value: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      }));
    }
  });
});
