import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

/**
 * A verb's declared result rides a second type parameter on `Stream`
 * (verb contract WS-C/C1). Schema generation must keep recognizing the
 * property as a stream when that parameter is present — the marker and the
 * event schema both come off the same type check, so if two type arguments
 * confused it, a returning verb would stop being a verb.
 */
describe("Stream with a declared result", () => {
  async function schemaFor(code: string) {
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );
    return asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );
  }

  it("marks a result-declaring stream exactly like a value-less one", async () => {
    const schema = await schemaFor(`
interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

interface SchemaRoot {
  valueLess: Stream<AddTopic>;
  returning: Stream<AddTopic, TopicRef>;
}
`);

    const properties = asObjectSchema(schema).properties as Record<
      string,
      Record<string, unknown> | undefined
    >;

    // Both are streams. A declared result must not cost a verb its marker.
    expect(properties.valueLess?.asCell).toEqual(["stream"]);
    expect(properties.returning?.asCell).toEqual(["stream"]);
  });

  it("keeps the event as the payload schema, not the result", async () => {
    const schema = await schemaFor(`
interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

interface SchemaRoot {
  returning: Stream<AddTopic, TopicRef>;
}
`);

    const returning = asObjectSchema(
      (asObjectSchema(schema).properties as Record<string, unknown>)
        .returning,
    );

    // The stream's own schema describes what a caller SENDS: a reference to
    // the event type, carrying the marker. `cf piece verbs` publishes exactly
    // this as the input schema and `piece call` validates payloads against it,
    // so a result leaking in here would both misreport the verb and start
    // refusing good payloads.
    expect(returning.$ref).toBe("#/$defs/AddTopic");
    expect(returning.asCell).toEqual(["stream"]);
    expect(JSON.stringify(returning)).not.toContain("fid");
  });

  // C1 puts the result in the TYPE; emitting it into the schema is C3. Until
  // then a returning verb and a value-less one generate byte-identical
  // schemas and the result type never reaches `$defs` at all. Pinned so that
  // C3 has a baseline to move rather than a belief to check, and so the day
  // this stops being true is a failing test rather than a discovery.
  it("does not yet carry the result into the schema — that is C3", async () => {
    const schema = await schemaFor(`
interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

interface SchemaRoot {
  valueLess: Stream<AddTopic>;
  returning: Stream<AddTopic, TopicRef>;
}
`);

    const properties = asObjectSchema(schema).properties as Record<
      string,
      unknown
    >;
    expect(properties.returning).toEqual(properties.valueLess);

    const defs = asObjectSchema(schema).$defs as Record<string, unknown>;
    expect(Object.keys(defs)).toEqual(["AddTopic"]);
    expect(JSON.stringify(schema)).not.toContain("TopicRef");
  });

  it("closes the event schema root — closed-world emission (C5, unblocked by #5302)", async () => {
    const schema = await schemaFor(`
interface SchemaRoot {
  verb: Stream<{ title: string }>;
}
`);

    const verb = asObjectSchema(
      (asObjectSchema(schema).properties as Record<string, unknown>).verb,
    );

    // The verb contract's design rule 1: EVENT schemas are closed-world —
    // an undeclared field is a typed rejection at dispatch, never silently
    // stripped. Emission was blocked until the update gate grew the
    // verb-event-role rule (#5302): a boolean additionalProperties
    // transition below a stream marker is free in both directions, so the
    // open→closed migration no longer trips the argument-role refusal.
    // The stamp is position-scoped (a $ref root gains the keyword beside
    // the reference; shared defs stay open at data-position use sites) and
    // guarded — author index signatures, unions, and never-derived shapes
    // are untouched (see closeVerbEventRoot).
    expect(verb.additionalProperties).toBe(false);
    expect(verb.type).toBe("object");
  });

  it("stamps the closure beside a $ref event, leaving the shared def open", async () => {
    const schema = await schemaFor(`
interface AddTopic {
  title: string;
}

interface SchemaRoot {
  verb: Stream<AddTopic>;
  // The same type in a DATA position must stay open there.
  draft: AddTopic;
}
`);
    const root = asObjectSchema(schema);
    const properties = root.properties as Record<string, unknown>;
    const verb = asObjectSchema(properties.verb);
    expect(verb.$ref).toBe("#/$defs/AddTopic");
    expect(verb.additionalProperties).toBe(false);
    // Position-scoped: the def itself and the data-position reference are
    // untouched.
    const defs = root.$defs as Record<string, unknown>;
    expect(Object.hasOwn(asObjectSchema(defs.AddTopic), "additionalProperties"))
      .toBe(false);
    expect(
      Object.hasOwn(asObjectSchema(properties.draft), "additionalProperties"),
    )
      .toBe(false);
  });

  it("leaves an index-signature event open — the author's organic opt-out", async () => {
    const schema = await schemaFor(`
interface SchemaRoot {
  verb: Stream<{ title: string; [key: string]: unknown }>;
}
`);
    const verb = asObjectSchema(
      (asObjectSchema(schema).properties as Record<string, unknown>).verb,
    );
    expect(verb.additionalProperties).not.toBe(false);
  });
});
