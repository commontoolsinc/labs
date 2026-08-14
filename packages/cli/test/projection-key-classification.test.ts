import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { ANNOTATION_KEYS } from "@commonfabric/piece/schema-compatibility";
import {
  deriveSelectedValue,
  parseSelectionProjection,
  PROJECTION_ANNOTATION_EXCEPTIONS,
  projectionKeyTier,
} from "../lib/cell-selection.ts";

const signer = await Identity.fromPassphrase(
  "cf-projection-key-classification",
);
const space = signer.did();

/** The keywords the reader drives the projection from. */
const HONORED = [
  "type",
  "properties",
  "items",
  "additionalProperties",
  "$link",
];

/**
 * The keywords the reader consults for container inference and then consumes.
 * Every one of them changes which container an untyped position describes.
 */
const CONSULTED = [
  "required",
  "minProperties",
  "maxProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
];

/** A tolerated keyword, beside a value of the right JSON type for it. */
const TOLERATED_VALUES: ReadonlyArray<[string, unknown]> = [
  // `$comment` carries the value the runner reserves as a control marker,
  // which is the only value of it that could disturb a read.
  ["$comment", "emptyProperties"],
  ["$id", "https://example.com/caller.json"],
  ["$schema", "https://json-schema.org/draft/2020-12/schema"],
  ["deprecated", true],
  ["description", "what the caller thinks this is"],
  ["examples", ["an example"]],
  ["tags", ["a tag"]],
  ["tier", "wrapper"],
  ["title", "A title"],
];

/** Every key in keyword position anywhere in `schema`. */
function keywordsIn(schema: unknown, into = new Set<string>()): Set<string> {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return into;
  }
  for (
    const [key, child] of Object.entries(schema as Record<string, unknown>)
  ) {
    into.add(key);
    if (key === "properties") {
      if (child !== null && typeof child === "object") {
        for (const value of Object.values(child as Record<string, unknown>)) {
          keywordsIn(value, into);
        }
      }
    } else if (key === "items" || key === "additionalProperties") {
      keywordsIn(child, into);
    }
  }
  return into;
}

describe("projection-key-classification", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
      errorHandlers: [() => {}],
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A cell holding `value` under `schema`, committed and read back fresh. */
  async function seed(
    cause: string,
    schema: JSONSchema,
    value: unknown,
  ): Promise<Cell<unknown>> {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, schema, tx);
    cell.set(value as never);
    expect((await tx.commit()).ok).toBeDefined();
    return runtime.getCell(space, cause, schema);
  }

  /** `source` read through the JSON `--schema` spelled by `projection`. */
  async function read(
    source: Cell<unknown>,
    projection: unknown,
  ): Promise<unknown> {
    return await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(JSON.stringify(projection)),
    });
  }

  /** The schema `deriveSelectedValue` re-asserts on its output cell. */
  async function outputSchemaOf(
    source: Cell<unknown>,
    projection: unknown,
  ): Promise<JSONSchema | undefined> {
    let outputCell: Cell<unknown> | undefined;
    await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(JSON.stringify(projection)),
    }, { onOutputCell: (cell) => outputCell = cell });
    return outputCell?.schema;
  }

  describe("a key in no tier", () => {
    it("refuses the projection, naming the key and the position it sat at", async () => {
      await expect(
        parseSelectionProjection(
          '{"type":"object","propertes":{"title":true}}',
        ),
      ).rejects.toThrow(
        'Invalid --schema at <root>: "propertes" is not a projection schema keyword',
      );
    });

    it("names the nested position a refused key sat at", async () => {
      await expect(parseSelectionProjection(JSON.stringify({
        properties: { notes: { minLenght: 3 } },
      }))).rejects.toThrow('Invalid --schema at <root>.notes: "minLenght"');
    });

    it("names the honored vocabulary a caller can write instead", async () => {
      await expect(parseSelectionProjection('{"pattern":"^a"}')).rejects
        .toThrow(
          'Projection reads "type", "properties", "items", ' +
            '"additionalProperties", "$link"',
        );
    });

    it("suggests the honored keyword a misspelling is one edit from", async () => {
      await expect(parseSelectionProjection('{"propertes":{"a":true}}')).rejects
        .toThrow('Did you mean "properties"?');
      await expect(parseSelectionProjection('{"type":"array","itmes":true}'))
        .rejects.toThrow('Did you mean "items"?');
    });

    it("refuses a misspelled `properties` beside a stated `type` rather than returning the whole object", async () => {
      const source = await seed("classification-widening-source", {
        type: "object",
        properties: {
          title: { type: "string" },
          secret: { type: "string" },
        },
      }, { title: "Visible", secret: "not asked for" });

      await expect(
        read(source, { type: "object", propertes: { title: true } }),
      ).rejects.toThrow('"propertes" is not a projection schema keyword');
    });

    it("refuses a misspelled `properties` with no stated `type` rather than reading nothing", async () => {
      const source = await seed("classification-narrowing-source", {
        type: "object",
        properties: { title: { type: "string" } },
      }, { title: "Visible" });

      await expect(read(source, { propertes: { title: true } })).rejects
        .toThrow('"propertes" is not a projection schema keyword');
    });

    it("returns a tier for every keyword the reader accepts", () => {
      for (const key of HONORED) {
        expect(projectionKeyTier(key)).toBe("honored");
      }
      for (const key of CONSULTED) {
        expect(projectionKeyTier(key)).toBe("consulted");
      }
      for (const [key] of TOLERATED_VALUES) {
        expect(projectionKeyTier(key)).toBe("tolerated");
      }
      for (const key of ["propertes", "pattern", "minLength", "format"]) {
        expect(projectionKeyTier(key)).toBe("refused");
      }
    });
  });

  describe("a tier C key the caller wrote", () => {
    it("names the array container an untyped position describes", async () => {
      expect((await parseSelectionProjection('{"minItems":1}')).schema).toEqual(
        {
          type: "array",
        },
      );
      expect((await parseSelectionProjection('{"uniqueItems":true}')).schema)
        .toEqual({ type: "array" });
    });

    it("names the object container an untyped position describes", async () => {
      expect((await parseSelectionProjection('{"required":["id"]}')).schema)
        .toEqual({ type: "object", additionalProperties: true });
      expect((await parseSelectionProjection('{"minProperties":1}')).schema)
        .toEqual({ type: "object", additionalProperties: true });
    });

    it("leaves no caller-written tier C constraint in the output schema", async () => {
      const source = await seed("classification-tier-c-source", {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          notes: { type: "array", items: { type: "string" } },
        },
      }, { id: 1, title: "Visible", notes: ["one"] });

      const schema = await outputSchemaOf(source, {
        type: "object",
        minProperties: 1,
        maxProperties: 9,
        required: ["id"],
        properties: {
          title: true,
          notes: {
            type: "array",
            minItems: 1,
            maxItems: 9,
            uniqueItems: true,
            items: true,
          },
        },
      });

      const carried = keywordsIn(schema);
      for (const key of CONSULTED) {
        // `required` may appear from the reader's own derivation; here the
        // source requires nothing, so no origin can put one there.
        expect([...carried]).not.toContain(key);
      }
    });

    it("returns the projected fields for a projection naming a `required` field it does not project", async () => {
      const source = await seed("classification-5734-source", {
        type: "object",
        properties: {
          title: { type: "string" },
          secret: { type: "string" },
        },
      }, { title: "Visible", secret: "not asked for" });

      expect(
        await read(source, {
          type: "object",
          required: ["secret"],
          properties: { title: true },
        }),
      ).toEqual({ title: "Visible" });
    });
  });

  describe("a tier T key the caller wrote", () => {
    it("returns what the same projection returns without it", async () => {
      const source = await seed("classification-tier-t-source", {
        type: "object",
        properties: { title: { type: "string" } },
      }, { title: "Visible" });

      const baseline = await read(source, {
        type: "object",
        properties: { title: {} },
      });
      expect(baseline).toEqual({ title: "Visible" });

      for (const [key, value] of TOLERATED_VALUES) {
        expect(
          await read(source, {
            type: "object",
            properties: { title: { [key]: value } },
          }),
        ).toEqual(baseline);
      }
    });

    it("is `ANNOTATION_KEYS` less projection's stated exceptions, in both directions", () => {
      for (const key of ANNOTATION_KEYS) {
        expect(
          projectionKeyTier(key) === "tolerated" ||
            PROJECTION_ANNOTATION_EXCEPTIONS.has(key),
        ).toBe(true);
      }
      for (const key of PROJECTION_ANNOTATION_EXCEPTIONS) {
        expect(ANNOTATION_KEYS.has(key)).toBe(true);
      }
    });
  });

  describe("the `required` the reader derives from the source", () => {
    const requiredSourceSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        title: { type: "string" },
      },
      required: ["id", "title"],
    } as const satisfies JSONSchema;

    it("carries a source-required projected property into the output schema", async () => {
      const source = await seed(
        "classification-derived-required-source",
        requiredSourceSchema,
        { id: 1, title: "Visible" },
      );

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: { title: true },
      });

      expect((schema as Record<string, unknown>).required).toEqual(["title"]);
    });

    it("leaves the caller's own `required` out of the schema it carries a derived one into", async () => {
      const source = await seed(
        "classification-two-origins-source",
        requiredSourceSchema,
        { id: 1, title: "Visible" },
      );

      const schema = await outputSchemaOf(source, {
        type: "object",
        required: ["id"],
        properties: { title: true },
      });

      // The caller named `id`; the source requires `title` as well. Only the
      // reader's own derivation reaches the boundary, so `id` — which the
      // projection does not name at all — is not there.
      expect((schema as Record<string, unknown>).required).toEqual(["title"]);
    });

    it("returns the object without a source-required property the caller narrowed to a mismatched scalar", async () => {
      const source = await seed("classification-scalar-mismatch-source", {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
        required: ["id"],
      }, { id: 1, title: "Visible" });

      expect(
        await read(source, {
          type: "object",
          properties: { id: { type: "string" }, title: true },
        }),
      ).toEqual({ title: "Visible" });
    });

    it("returns the object without a source-required array whose items the caller narrowed to a mismatched scalar", async () => {
      const source = await seed("classification-item-mismatch-source", {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          title: { type: "string" },
        },
        required: ["values"],
      }, { values: [1], title: "Visible" });

      expect(
        await read(source, {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "string" } },
            title: true,
          },
        }),
      ).toEqual({ title: "Visible" });
    });

    it("returns a source-required array of objects whose leaf the caller narrowed to a mismatched scalar", async () => {
      const source = await seed("classification-item-object-source", {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
              required: ["id"],
            },
          },
          title: { type: "string" },
        },
        required: ["rows"],
      }, { rows: [{ id: 1, name: "a" }], title: "Visible" });

      expect(
        await read(source, {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, name: true },
              },
            },
            title: true,
          },
        }),
      ).toEqual({ rows: [{ name: "a" }], title: "Visible" });
    });
  });

  describe("the output schema the reader constructs", () => {
    it("omits a nested scalar leaf whose declared type does not match the stored value", async () => {
      const source = await seed("classification-nested-scalar-source", {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: {
              id: { type: "number" },
              title: { type: "string" },
            },
          },
        },
      }, { topic: { id: 1, title: "Visible" } });

      expect(
        await read(source, {
          type: "object",
          properties: {
            topic: {
              type: "object",
              properties: { id: { type: "string" }, title: true },
            },
          },
        }),
      ).toEqual({ topic: { title: "Visible" } });
    });

    it("returns none of an object source's fields for a scalar projection over it", async () => {
      const source = await seed("classification-scalar-over-object-source", {
        type: "object",
        properties: {
          title: { type: "string" },
          secret: { type: "string" },
        },
      }, { title: "Visible", secret: "not asked for" });

      expect(await read(source, { type: "string" })).toBeUndefined();
    });
  });
});
