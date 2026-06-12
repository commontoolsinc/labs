import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

// The DEFAULT_MARKER brand payload carries V (the default VALUE's type) — see
// Default<> in packages/api/index.ts. These tests generate schemas from bare
// checker TYPES (no typeNode), the situation every capture/projection/
// instantiation path puts the generator in: the authored `Default<…>` alias
// node is gone, and the payload is the only surviving source of the value.
// A local replica of the alias is declared in each snippet — brand detection
// is name-based (`__@DEFAULT_MARKER…` escaped names), matching the formatters.
const DEFAULT_PRELUDE = `
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
  type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
`;

describe("brand-payload default recovery (expanded Default<T, V>)", () => {
  const transformer = createSchemaTransformerV2();

  it("recovers string literal defaults from the payload", async () => {
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        note: Default<string, "n/a">;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect(schema.properties?.note).toEqual({
      type: "string",
      default: "n/a",
    });
  });

  it("recovers number and boolean literal defaults", async () => {
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        count: Default<number, 3>;
        flag: Default<boolean, true>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect(schema.properties?.count).toEqual({ type: "number", default: 3 });
    expect(schema.properties?.flag).toEqual({
      type: "boolean",
      default: true,
    });
  });

  it("recovers defaults through generic instantiation", async () => {
    // The case no authored-AST recovery can serve: V is substituted through
    // a type parameter, so no declaration anywhere spells the literal next
    // to this property.
    const code = `${DEFAULT_PRELUDE}
      interface Tagged<V extends string> {
        note: Default<string, V>;
      }
      interface Holder {
        tagged: Tagged<"from-generic">;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Holder");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    const tagged = asObjectSchema(
      (schema.properties?.tagged ?? {}) as Record<string, unknown>,
    );
    expect(tagged.properties?.note).toEqual({
      type: "string",
      default: "from-generic",
    });
  });

  it("recovers tuple and object literal payloads", async () => {
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        tags: Default<string[], ["a", "b"]>;
        config: Default<{ retries: number }, { retries: 2 }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect((schema.properties?.tags as Record<string, unknown>).default)
      .toEqual(["a", "b"]);
    expect((schema.properties?.config as Record<string, unknown>).default)
      .toEqual({ retries: 2 });
  });

  it("bails to plain formatting for non-literal payloads", async () => {
    // One-arg form: V = T = string, which is not a literal — no default can
    // or should be emitted.
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        note: Default<string>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect(schema.properties?.note).toEqual({ type: "string" });
  });
});
