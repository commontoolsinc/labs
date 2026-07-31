import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type JSONSchema, type Pattern } from "@commonfabric/runner";
import { assertPatternSchemasBackwardCompatible } from "../src/schema-compatibility.ts";

function pattern(
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): Pattern {
  return {
    argumentSchema,
    resultSchema,
    derivedInternalCells: [],
    result: {},
    nodes: [],
  };
}

const openArgument: JSONSchema = { type: "object", properties: {} };

/** A pattern result schema carrying one verb, optionally with a declared result. */
const withVerb = (result?: JSONSchema): JSONSchema => ({
  type: "object",
  properties: {
    addTopic: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      asCell: ["stream"],
      ...(result !== undefined && { result }),
    },
  },
  required: ["addTopic"],
});

const emptyReceipt: JSONSchema = { type: "object", properties: {} };

/**
 * A verb's declared result (`result`, the dialect keyword the schema
 * generator emits beside `asCell: ["stream"]` — C3) is part of the piece's
 * public contract: every published name is permanent, at every depth, exactly
 * as for every other result name (verb contract WS-C). The checker recurses
 * into the keyword rather than demanding byte-equality, so compatible
 * evolution (adding optional fields) stays possible while removals are
 * refused.
 */
describe("verb declared-result compatibility", () => {
  it("rejects removing a named field from a verb's declared result", () => {
    const previous = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string" } },
        required: ["fid"],
      }),
    );
    const candidate = pattern(openArgument, withVerb(emptyReceipt));
    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/result/);
  });

  it("rejects the removal at depth, not only at the result's top level", () => {
    const nested = (fields: Record<string, JSONSchema>): JSONSchema =>
      withVerb({
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: fields,
            required: Object.keys(fields),
          },
        },
        required: ["topic"],
      });
    const previous = pattern(
      openArgument,
      nested({ fid: { type: "string" }, rev: { type: "number" } }),
    );
    const candidate = pattern(
      openArgument,
      nested({ fid: { type: "string" } }),
    );
    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/rev/);
  });

  it("accepts ADDING the result keyword where the previous schema had none", () => {
    // Every existing deployment's durable schema predates C3 and carries no
    // result keyword. The first update compiled after C3 adds it to every
    // verb, so this direction is the entire fleet's upgrade path.
    const previous = pattern(openArgument, withVerb(undefined));
    const candidate = pattern(openArgument, withVerb(emptyReceipt));
    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();

    const declaring = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string" } },
        required: ["fid"],
      }),
    );
    expect(() => assertPatternSchemasBackwardCompatible(previous, declaring))
      .not.toThrow();
  });

  it("rejects DROPPING the result keyword once it was published", () => {
    // The keyword absent means unconstrained; a candidate without it no
    // longer promises the names the previous schema published.
    const previous = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string" } },
        required: ["fid"],
      }),
    );
    const candidate = pattern(openArgument, withVerb(undefined));
    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/result/);
  });

  it("accepts adding an OPTIONAL field to a declared result", () => {
    // The authoring rule the permanence table implies: publish as few names
    // as the verb can live with, make every later addition optional. The
    // checker must therefore recurse into the keyword — byte-equality would
    // refuse this legal evolution.
    const previous = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string" } },
        required: ["fid"],
      }),
    );
    const candidate = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string" }, note: { type: "string" } },
        required: ["fid"],
      }),
    );
    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();
  });

  it("keeps the value-less receipt open to later declare a result", () => {
    // The value-less receipt `{ type: "object", properties: {} }` leaves
    // additionalProperties undefined (?? true) precisely so a verb is never
    // frozen as value-less forever. The permanence table still governs HOW it
    // grows: new names must be optional or defaulted — a bare required field
    // would invalidate every `{}` receipt already written.
    const previous = pattern(openArgument, withVerb(emptyReceipt));

    const optionalField = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string" } },
      }),
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, optionalField)
    ).not.toThrow();

    const defaultedField = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string", default: "" } },
        required: ["fid"],
      }),
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, defaultedField)
    ).not.toThrow();

    const bareRequiredField = pattern(
      openArgument,
      withVerb({
        type: "object",
        properties: { fid: { type: "string" } },
        required: ["fid"],
      }),
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, bareRequiredField)
    ).toThrow(/fid/);
  });

  it("resolves $refs inside a declared result against each side's own $defs", () => {
    const refVerb = (fid: JSONSchema): JSONSchema => ({
      type: "object",
      properties: {
        addTopic: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          asCell: ["stream"],
          result: { $ref: "#/$defs/TopicRef" },
        },
      },
      required: ["addTopic"],
      $defs: {
        TopicRef: {
          type: "object",
          properties: { fid },
          required: ["fid"],
        },
      },
    });
    const previous = pattern(openArgument, refVerb({ type: "string" }));
    const same = pattern(openArgument, refVerb({ type: "string" }));
    expect(() => assertPatternSchemasBackwardCompatible(previous, same))
      .not.toThrow();

    // Same spelling, different definition content: the ref target changed
    // incompatibly (string -> number), which only a checker that resolves
    // refs INSIDE the keyword can see.
    const retyped = pattern(openArgument, refVerb({ type: "number" }));
    expect(() => assertPatternSchemasBackwardCompatible(previous, retyped))
      .toThrow(/fid|TopicRef|result/);
  });

  it("applies the same permanence to a verb carried in the argument schema", () => {
    // A pattern can take a stream as INPUT. The declared result is still
    // produced by the verb and read by callers, so its variance does not
    // flip with the property's role: candidate result stays within previous,
    // and adding the keyword remains compatible (the upgrade path).
    const argWithVerb = (result?: JSONSchema): JSONSchema => ({
      type: "object",
      properties: {
        onSubmit: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          asCell: ["stream"],
          ...(result !== undefined && { result }),
        },
      },
      required: ["onSubmit"],
    });
    const openResult: JSONSchema = { type: "object", properties: {} };

    const previousBare = pattern(argWithVerb(undefined), openResult);
    const candidateAdding = pattern(argWithVerb(emptyReceipt), openResult);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousBare, candidateAdding)
    ).not.toThrow();

    const previousNamed = pattern(
      argWithVerb({
        type: "object",
        properties: { fid: { type: "string" } },
        required: ["fid"],
      }),
      openResult,
    );
    const candidateRemoving = pattern(argWithVerb(emptyReceipt), openResult);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousNamed, candidateRemoving)
    ).toThrow(/fid/);
  });
});
