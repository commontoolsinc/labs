import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { JSONSchemaObj } from "@commonfabric/api";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { getTypeFromCode } from "./utils.ts";

// `Demand<T>` marks a holder-side demand — the shape a pattern requires of a
// piece it stores, as distinct from state it owns. The generator stamps
// `demand: true` on the marked subtree and otherwise emits the inner type
// unchanged (verb-evolution brief, PR #5682).

async function schemaFor(code: string): Promise<JSONSchemaObj> {
  const { type, checker, typeNode } = await getTypeFromCode(
    code,
    "SchemaRoot",
  );
  return new SchemaGenerator().generateSchema(
    type,
    checker,
    typeNode,
  ) as JSONSchemaObj;
}

function properties(schema: JSONSchemaObj): Record<string, JSONSchemaObj> {
  return (schema.properties ?? {}) as Record<string, JSONSchemaObj>;
}

describe("Demand wrapper", () => {
  it("stamps demand on the referencing node, not the shared def", async () => {
    const schema = await schemaFor(`
interface NotePreview {
  title?: string;
}

interface SchemaRoot {
  note: Demand<NotePreview>;
}
`);
    // The marker rides the USE site (like asCell on a $ref): the same type
    // can be a demand in one property and owned shape in another, so the
    // hoisted def must stay neutral.
    const note = properties(schema).note!;
    expect(note.demand).toBe(true);
    expect(note.$ref).toBe("#/$defs/NotePreview");
    const def = (schema.$defs as Record<string, JSONSchemaObj>).NotePreview!;
    expect(def.demand).toBeUndefined();
    expect((def.properties as Record<string, JSONSchemaObj>).title).toEqual(
      { type: "string" },
    );
  });

  it("stamps demand on array element demands", async () => {
    const schema = await schemaFor(`
interface NotePreview {
  title?: string;
}

interface SchemaRoot {
  notes: Demand<NotePreview>[];
}
`);
    const notes = properties(schema).notes!;
    expect(notes.type).toBe("array");
    expect((notes.items as JSONSchemaObj).demand).toBe(true);
  });

  it("treats nested Demand as one demand", async () => {
    const schema = await schemaFor(`
interface SchemaRoot {
  value: Demand<Demand<string>>;
}
`);
    expect(properties(schema).value).toEqual({
      type: "string",
      demand: true,
    });
  });
});
