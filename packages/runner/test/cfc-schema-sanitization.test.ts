import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  cfcObjectSchemaIsClosed,
  INJECTION_SAFE_ATOM,
  isPrimitiveJsonValue,
  isPromptInjectionMaterialRiskAtom,
  resolveCfcSchemaRefRoot,
  resolveSchemaForValidation,
  schemaWithInjectionSafeAnnotations,
  validateAgainstSchema,
  validateAndSanitizeSchemaValueWithOpaqueLinks,
  validateSchemaValue,
} from "../src/cfc/mod.ts";

const promptRisk = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
  source: "of:hostile",
} as const;

const promptInfluence = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

describe("cfc schema sanitization", () => {
  it("classifies primitive values and prompt-injection risk atoms", () => {
    expect(isPrimitiveJsonValue(null)).toBe(true);
    expect(isPrimitiveJsonValue("text")).toBe(true);
    expect(isPrimitiveJsonValue(1)).toBe(true);
    expect(isPrimitiveJsonValue(false)).toBe(true);
    expect(isPrimitiveJsonValue({})).toBe(false);

    expect(isPromptInjectionMaterialRiskAtom("prompt-injection-risk"))
      .toBe(true);
    expect(isPromptInjectionMaterialRiskAtom({
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-injection-risk-value-screened",
    })).toBe(true);
    expect(isPromptInjectionMaterialRiskAtom({
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-influence",
    })).toBe(false);
  });

  it("detects closed object schemas", () => {
    expect(cfcObjectSchemaIsClosed({ type: "object" })).toBe(true);
    expect(cfcObjectSchemaIsClosed({ properties: {} })).toBe(true);
    expect(cfcObjectSchemaIsClosed({ required: ["title"] })).toBe(true);
    expect(cfcObjectSchemaIsClosed({ additionalProperties: false })).toBe(
      true,
    );
    expect(cfcObjectSchemaIsClosed({ additionalProperties: true })).toBe(
      false,
    );
    expect(cfcObjectSchemaIsClosed({
      additionalProperties: { type: "string" },
    })).toBe(false);
  });

  it("resolves refs for validation and falls back on unresolved refs", () => {
    const fullSchema = {
      $defs: {
        Count: { type: "integer" },
      },
    } as const;

    expect(resolveSchemaForValidation({ $ref: "#/$defs/Count" }, fullSchema))
      .toEqual({ type: "integer" });
    expect(resolveSchemaForValidation({ $ref: "#/$defs/Missing" }, fullSchema))
      .toBe(false);
    expect(resolveCfcSchemaRefRoot({ $ref: "#/$defs/Missing" }, fullSchema))
      .toBe(fullSchema);
    expect(resolveSchemaForValidation({ type: "string" }, fullSchema))
      .toEqual({ type: "string" });
  });

  it("annotates injection-safe primitive schema shapes", () => {
    const risk = {
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-injection-risk-unscreened",
    } as const;
    const retained = {
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-influence",
    } as const;

    const annotated = schemaWithInjectionSafeAnnotations({
      type: "object",
      properties: {
        approved: { type: "boolean" },
        status: { enum: ["open", "closed"] },
        note: { type: "string" },
      },
      required: ["approved", "status", "note"],
      additionalProperties: false,
    }, [risk, retained]) as any;

    expect(annotated.required).toBeUndefined();
    expect(annotated.properties.approved.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(annotated.properties.approved.ifc.confidentiality).toEqual([
      retained,
    ]);
    expect(annotated.properties.status.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(annotated.properties.note.ifc.confidentiality).toContainEqual(risk);
    expect(annotated.properties.note.ifc.confidentiality).toContainEqual(
      retained,
    );
  });

  it("leaves boolean schemas unchanged while annotating", () => {
    expect(schemaWithInjectionSafeAnnotations(true, ["secret"])).toBe(true);
  });

  it("breaks ref cycles during annotation", () => {
    const annotated = schemaWithInjectionSafeAnnotations({
      $defs: {
        Node: { $ref: "#/$defs/Node" },
      },
      $ref: "#/$defs/Node",
    }, ["secret"]) as any;

    expect(annotated.ifc.confidentiality).toEqual(["secret"]);
  });

  it("annotates refs, branches, arrays, and open objects", () => {
    const observed = ["secret"];
    const annotated = schemaWithInjectionSafeAnnotations({
      $defs: {
        Choice: {
          anyOf: [
            { type: "boolean" },
            { type: "string" },
          ],
        },
      },
      type: "object",
      properties: {
        child: { $ref: "#/$defs/Choice" },
        list: {
          type: "array",
          items: { type: "integer" },
        },
      },
      additionalProperties: true,
    }, observed) as any;

    expect(annotated.ifc.confidentiality).toEqual(observed);
    expect(annotated.properties.child.ifc.confidentiality).toEqual(observed);
    expect(annotated.properties.list.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(annotated.properties.list.items.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
  });

  it("annotates oneOf, allOf, empty objects, and not schemas", () => {
    const annotated = schemaWithInjectionSafeAnnotations({
      type: "object",
      properties: {
        choice: {
          oneOf: [
            { type: "boolean" },
            { type: "null" },
          ],
        },
        combined: {
          allOf: [
            { type: "integer" },
            { const: 1 },
          ],
        },
      },
      required: ["choice", "combined"],
      additionalProperties: false,
      not: {
        required: ["blocked"],
      },
    }, ["secret"]) as any;

    expect(annotated.required).toBeUndefined();
    expect(annotated.properties.choice.oneOf[0].ifc.addIntegrity)
      .toContainEqual(INJECTION_SAFE_ATOM);
    expect(annotated.properties.combined.allOf[1].ifc.addIntegrity)
      .toContainEqual(INJECTION_SAFE_ATOM);
    expect(annotated.not.required).toBeUndefined();

    const emptyObject = schemaWithInjectionSafeAnnotations({
      type: "object",
      additionalProperties: false,
    }, ["secret"]) as any;
    expect(emptyObject.ifc.addIntegrity).toContainEqual(INJECTION_SAFE_ATOM);
  });

  it("validates values against schema features", () => {
    expect(validateAgainstSchema(true, "anything")).toBeUndefined();
    expect(validateAgainstSchema(false, "anything")).toBe(
      "schema rejects all values",
    );
    expect(validateAgainstSchema({
      $defs: { Count: { type: "integer" } },
      $ref: "#/$defs/Count",
    }, 2)).toBeUndefined();
    expect(validateAgainstSchema({
      allOf: [
        { type: "object" },
        { required: ["name"] },
      ],
    }, {})).toBe("missing required property name");
    expect(validateAgainstSchema({
      allOf: [{ type: "number" }, { minimum: 0 }],
    }, 1)).toBeUndefined();
    expect(validateAgainstSchema({
      anyOf: [{ type: "string" }, { type: "number" }],
    }, false)).toBe("value does not match anyOf");
    expect(validateAgainstSchema({
      oneOf: [{ type: "number" }, { type: "integer" }],
    }, 1)).toBe("value does not match exactly one oneOf branch");
    expect(validateAgainstSchema({ enum: ["a", "b"] }, "c")).toBe(
      "value is not in enum",
    );
    expect(validateAgainstSchema({ const: "ready" }, "waiting")).toBe(
      "value does not match const",
    );
    expect(validateAgainstSchema({ type: ["string", "number"] }, false)).toBe(
      "value does not match type string|number",
    );
    expect(validateAgainstSchema({ type: "unknown" }, Symbol("value")))
      .toBeUndefined();
    expect(validateAgainstSchema({ type: "null" }, null)).toBeUndefined();
    expect(validateAgainstSchema({ type: "custom" } as any, "value"))
      .toBeUndefined();
    expect(validateAgainstSchema({
      type: "object",
      properties: { count: { type: "number" } },
      additionalProperties: false,
    }, { count: 1, extra: true })).toBe("additional property extra");
    expect(validateAgainstSchema({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: { type: "number" },
    }, { title: "ok", extra: "bad" })).toBe(
      "extra: value does not match type number",
    );
    expect(validateAgainstSchema({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: { type: "number" },
    }, { title: "ok", extra: 1 })).toBeUndefined();
    expect(validateAgainstSchema({
      type: "array",
      items: { type: "string" },
    }, ["ok", 2])).toBe("1: value does not match type string");
    expect(validateAgainstSchema({
      type: "array",
      items: { type: "string" },
    }, ["ok"])).toBeUndefined();
  });

  it("strictly validates Common Fabric values for schema migrations", () => {
    expect(validateSchemaValue({ type: "undefined" }, undefined))
      .toBeUndefined();
    expect(validateSchemaValue({ type: "undefined" }, "not undefined"))
      .toContain("type undefined");
    expect(validateSchemaValue({
      type: "object",
      properties: { known: { type: "number" } },
    }, { known: 1, extra: true })).toBeUndefined();
    expect(validateSchemaValue({
      type: "object",
      properties: { known: { type: "number" } },
      additionalProperties: false,
    }, { known: 1, extra: true })).toContain("additional property extra");
    expect(validateSchemaValue({ type: "custom" } as any, "value"))
      .toContain("unsupported schema type custom");

    const sparse = [1, , 3];
    expect(validateSchemaValue({
      type: "array",
      items: { type: "number" },
    }, sparse)).toBeUndefined();
    expect(validateSchemaValue({
      type: "array",
      items: { type: "number" },
    }, [1, undefined, 3])).toContain("1:");

    expect(validateSchemaValue({ type: "array", uniqueItems: true }, [
      new FabricBytes(new Uint8Array([1])),
      new FabricBytes(new Uint8Array([2])),
    ])).toBeUndefined();
    expect(validateSchemaValue({ type: "array", uniqueItems: true }, [
      new FabricBytes(new Uint8Array([1])),
      new FabricBytes(new Uint8Array([1])),
    ])).toContain("not unique");

    const validSchema: JSONSchema = {
      type: "object",
      minProperties: 3,
      maxProperties: 3,
      required: ["count", "label", "items"],
      properties: {
        count: {
          type: "number",
          minimum: 10,
          exclusiveMinimum: 9,
          maximum: 20,
          exclusiveMaximum: 21,
          multipleOf: 2,
        },
        label: {
          type: "string",
          minLength: 3,
          maxLength: 20,
          pattern: "^[a-z@.]+$",
          format: "email",
        },
        items: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          uniqueItems: true,
          prefixItems: [{ type: "string" }],
          items: { type: "number" },
          contains: { type: "number", minimum: 10 },
          minContains: 1,
          maxContains: 2,
        },
      },
      dependentRequired: { count: ["label"] },
      dependentSchemas: { count: { required: ["items"] } },
      propertyNames: { pattern: "^[a-z]+$" },
      patternProperties: { "^lab": { type: "string" } },
    };
    expect(validateSchemaValue(validSchema, {
      count: 12,
      label: "a@b.co",
      items: ["first", 12],
    })).toBeUndefined();
  });

  it("reports every strict migration constraint it cannot satisfy", () => {
    const invalid: [JSONSchema, unknown, string][] = [
      [{ not: { type: "number" } }, 1, "not schema"],
      [{ if: { type: "number" }, then: { minimum: 2 } }, 1, "minimum"],
      [{ if: { type: "number" }, else: { minLength: 2 } }, "x", "minLength"],
      [{ minimum: 2 }, 1, "minimum"],
      [{ exclusiveMinimum: 1 }, 1, "exclusiveMinimum"],
      [{ maximum: 1 }, 2, "maximum"],
      [{ exclusiveMaximum: 2 }, 2, "exclusiveMaximum"],
      [{ multipleOf: 2 }, 3, "multiple"],
      [{ multipleOf: 0 }, 0, "multiple"],
      [{ minLength: 2 }, "x", "minLength"],
      [{ maxLength: 1 }, "xy", "maxLength"],
      [{ pattern: "[" }, "x", "invalid pattern"],
      [{ pattern: "^x$" }, "y", "pattern"],
      [{ format: "email" }, "invalid", "format email"],
      [{ minItems: 2 }, [1], "minItems"],
      [{ maxItems: 1 }, [1, 2], "maxItems"],
      [{ uniqueItems: true }, [1, 1], "not unique"],
      [{ prefixItems: [{ type: "string" }] }, [1], "0:"],
      [{ items: { type: "number" } }, ["x"], "0:"],
      [{ contains: { type: "number" } }, ["x"], "fewer than 1"],
      [
        {
          contains: { type: "number" },
          maxContains: 1,
        },
        [1, 2],
        "more than 1",
      ],
      [{ minProperties: 2 }, { one: 1 }, "minProperties"],
      [{ maxProperties: 1 }, { one: 1, two: 2 }, "maxProperties"],
      [
        {
          dependentRequired: { one: ["two"] },
        },
        { one: 1 },
        "dependent property two",
      ],
      [
        {
          dependentSchemas: { one: { required: ["two"] } },
        },
        { one: 1 },
        "missing required property two",
      ],
      [{ propertyNames: { pattern: "^[a-z]+$" } }, { "BAD!": 1 }, "BAD!"],
      [
        { patternProperties: { "[": { type: "number" } } },
        { x: 1 },
        "invalid property pattern",
      ],
      [{ patternProperties: { "^x": { type: "number" } } }, { x: "bad" }, "x:"],
      [{ contentEncoding: "base64" }, "encoded", "not supported"],
      [{ contentMediaType: "application/json" }, "encoded", "not supported"],
      [{ contentSchema: { type: "object" } }, "encoded", "not supported"],
    ];
    for (const [schema, value, message] of invalid) {
      expect(validateSchemaValue(schema, value)).toContain(message);
    }
    expect(validateSchemaValue({
      prefixItems: [{ type: "string" }, { type: "number" }],
    }, ["only-present-item"])).toBeUndefined();
  });

  it("fails closed on recursive schema validation", () => {
    const recursive: JSONSchema = {
      allOf: [{ $ref: "#/$defs/Loop" }],
      $defs: {
        Loop: { allOf: [{ $ref: "#/$defs/Loop" }] },
      },
    };

    expect(() => validateSchemaValue(recursive, "value")).not.toThrow();
    expect(validateSchemaValue(recursive, "value")).toContain(
      "recursive schema",
    );

    const productive: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/Node" },
          },
          required: ["value"],
        },
      },
    };
    expect(validateSchemaValue(productive, {
      value: 1,
      next: { value: 2 },
    })).toBeUndefined();
  });

  it("validates the schema formats generated by Common Fabric", () => {
    const valid: [string, string][] = [
      ["email", "a@b.co"],
      ["uri", "https://example.com/path"],
      ["date", "2026-07-14"],
      ["date-time", "2026-07-14T12:34:56Z"],
    ];
    for (const [format, value] of valid) {
      expect(validateSchemaValue({ type: "string", format }, value))
        .toBeUndefined();
    }
    for (
      const [format, value] of [
        ["email", ".a@example.com"],
        ["email", "a..b@example.com"],
        ["email", "a@example..com"],
        ["uri", "not a uri"],
        ["date", "not a date"],
        ["date", "2026-02-30"],
        ["date-time", "not a timestamp"],
        ["date-time", "2026-02-30T12:00:00Z"],
        ["date-time", "2026-01-01T24:00:00Z"],
        ["custom", "value"],
      ]
    ) {
      expect(validateSchemaValue({ type: "string", format }, value))
        .toContain(`format ${format}`);
    }
  });
});

describe("schema-based prompt injection sanitization compatibility", () => {
  it("adds InjectionSafe to closed enum, number, and boolean fields but not free strings", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        confidence: { type: "number" },
        approved: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["action", "confidence", "approved", "reason"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptRisk,
      promptInfluence,
    ]) as any;

    expect(sanitized.ifc).toBeUndefined();
    expect(sanitized.properties.action.ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.properties.confidence.ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.properties.approved.ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.properties.reason.ifc).toMatchObject({
      confidentiality: [promptRisk, promptInfluence],
    });
    expect(sanitized.properties.reason.ifc.addIntegrity).toBeUndefined();
  });

  it("discharges ALL material-risk caveats on a large label (fuel scales past the default 64)", () => {
    // A path carrying more than DEFAULT_EXCHANGE_FUEL (64) material-risk
    // ALTERNATIVES must still be fully discharged on an instruction-inert
    // field — the old strip removed all of them, and the fuel budget must
    // scale (over the summed clause-alternative count, not the clause count)
    // so the rule path matches that (cubic P2 on #4567). With a fixed 64-fuel
    // budget this retains the tail. Mixes flat caveats AND OR-clauses whose
    // material-risk alternative must be dropped from within the clause — the
    // alternative-count path the fuel budget sums over.
    const risk = (i: number) => ({
      type: CFC_ATOM_TYPE.Caveat,
      kind: "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
      source: `of:hostile-${i}`,
    });
    const keep = (i: number) => ({
      type: CFC_ATOM_TYPE.User,
      subject: `did:key:reader-${i}`,
    });
    const flatRisks = Array.from({ length: 50 }, (_, i) => risk(i));
    // 40 OR-clauses (80 alternatives), each a risk beside a retained atom.
    const orRisks = Array.from(
      { length: 40 },
      (_, i) => ({ anyOf: [risk(1000 + i), keep(i)] }),
    );
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
      },
      required: ["action"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(
      schema,
      [
        ...flatRisks,
        ...orRisks,
        "prompt-injection-risk",
        { anyOf: ["prompt-injection-risk", keep(100)] },
      ],
    ) as any;

    const remaining: unknown[] = sanitized.properties.action.ifc
      .confidentiality ?? [];
    // No material-risk alternative survives anywhere — not as a bare clause,
    // not nested inside a surviving OR-clause.
    const hasMaterialRiskAnywhere = remaining.some((clause) =>
      isPromptInjectionMaterialRiskAtom(clause) ||
      (typeof clause === "object" && clause !== null &&
        Array.isArray((clause as { anyOf?: unknown }).anyOf) &&
        (clause as { anyOf: unknown[] }).anyOf.some(
          isPromptInjectionMaterialRiskAtom,
        ))
    );
    expect(hasMaterialRiskAnywhere).toBe(false);
    // The retained (non-risk) alternatives survive.
    expect(remaining.length).toBe(41);
  });

  it("marks a whole closed object when every readable child is instruction-inert", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        confidence: { type: "integer" },
      },
      required: ["action", "confidence"],
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptRisk,
    ]) as any;

    expect(sanitized.ifc).toMatchObject({
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.ifc.confidentiality ?? []).not.toContain(promptRisk);
  });

  it("keeps open object schemas tainted at the parent", () => {
    const schema = {
      type: "object",
      properties: {
        confidence: { type: "number" },
      },
      additionalProperties: true,
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptRisk,
    ]) as any;

    expect(sanitized.ifc.confidentiality).toEqual([promptRisk]);
    expect(sanitized.properties.confidence.ifc).toMatchObject({
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
  });

  it("validates closed structured values before sanitization", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
      },
      required: ["action"],
    } as const satisfies JSONSchema;

    expect(validateAgainstSchema(schema, { action: "approve" }))
      .toBeUndefined();
    expect(validateAgainstSchema(schema, { action: "maybe" })).toContain(
      "enum",
    );
    expect(validateAgainstSchema(schema, {
      action: "approve",
      body: "extra",
    })).toContain("additional property body");
  });

  it("leaves empty schemas permissive while closing object-shaped schemas", () => {
    expect(validateAgainstSchema({}, { body: "extra" })).toBeUndefined();
    expect(validateAgainstSchema(true, { body: "extra" })).toBeUndefined();
    expect(validateAgainstSchema({
      properties: { approved: { type: "boolean" } },
    }, { approved: true, body: "extra" })).toContain(
      "additional property body",
    );
  });

  it("recognizes material-risk caveats without treating prompt influence as clearable", () => {
    expect(isPromptInjectionMaterialRiskAtom(promptRisk)).toBe(true);
    expect(isPromptInjectionMaterialRiskAtom(promptInfluence)).toBe(false);
  });

  it("terminates on self-referential ref schemas", () => {
    const schema = {
      $defs: {
        Node: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/$defs/Node" },
            },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/Node",
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptInfluence,
    ]) as any;

    expect(sanitized).toBeDefined();
    expect(typeof sanitized).toBe("object");
  });

  it("does not mutate the input schema", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        reason: { type: "string" },
      },
      required: ["action", "reason"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const before = JSON.stringify(schema);

    schemaWithInjectionSafeAnnotations(schema, [promptRisk, promptInfluence]);

    expect(JSON.stringify(schema)).toBe(before);
  });

  it("validates nested refs by preserving root defs across recursion", () => {
    const schema = {
      $defs: {
        Outer: {
          type: "object",
          properties: {
            label: { type: "string" },
            payload: { $ref: "#/$defs/Inner" },
          },
          required: ["label", "payload"],
          additionalProperties: false,
        },
        Inner: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/Outer",
    } as const satisfies JSONSchema;

    expect(
      validateAgainstSchema(schema, {
        label: "ok",
        payload: { value: 42 },
      }),
    ).toBeUndefined();

    expect(
      validateAgainstSchema(schema, {
        label: "ok",
        payload: { value: "not a number" },
      }),
    ).toBeDefined();
  });

  it("sanitizes free strings to opaque links while preserving schema-inert values", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        confidence: { type: "number" },
        evidence: { type: "string" },
      },
      required: ["action", "confidence", "evidence"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: {
        action: "approve",
        confidence: 0.9,
        evidence: "untrusted page text",
      },
      opaqueHandleId: "child-run-1",
    });

    expect(sanitized).toEqual({
      value: {
        action: "approve",
        confidence: 0.9,
        evidence: { "@link": "opaque:child-run-1#/evidence" },
      },
      linkedStringCount: 1,
    });
  });

  it("preserves caller-provided opaque links when the matching schema branch allows them", () => {
    const opaqueLinkSchema = {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const schema = {
      type: "object",
      properties: {
        evidence: {
          anyOf: [
            opaqueLinkSchema,
            { type: "string" },
          ],
        },
      },
      required: ["evidence"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: {
        evidence: { "@link": "opaque:child-run-1#/raw" },
      },
      opaqueHandleId: "child-run-1",
    });

    expect(sanitized).toEqual({
      value: {
        evidence: { "@link": "opaque:child-run-1#/raw" },
      },
      linkedStringCount: 0,
    });
  });
});
