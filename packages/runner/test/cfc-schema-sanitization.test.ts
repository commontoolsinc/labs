import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  cfcObjectSchemaIsClosed,
  INJECTION_SAFE_ATOM,
  isPrimitiveJsonValue,
  isPromptInjectionMaterialRiskAtom,
  resolveSchemaForValidation,
  schemaWithInjectionSafeAnnotations,
  validateAgainstSchema,
  validateAndSanitizeSchemaValueWithOpaqueLinks,
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

type AnnotatedIfc = {
  readonly addIntegrity?: readonly unknown[];
  readonly confidentiality?: readonly unknown[];
};

type AnnotatedSchemaNode = {
  readonly ifc?: AnnotatedIfc;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, AnnotatedSchemaNode>>;
  readonly items?: AnnotatedSchemaNode;
  readonly anyOf?: readonly AnnotatedSchemaNode[];
  readonly oneOf?: readonly AnnotatedSchemaNode[];
  readonly allOf?: readonly AnnotatedSchemaNode[];
  readonly not?: AnnotatedSchemaNode;
};

const asAnnotatedNode = (schema: JSONSchema): AnnotatedSchemaNode => {
  expect(typeof schema).toBe("object");
  expect(schema).not.toBeNull();
  if (typeof schema !== "object" || schema === null) {
    throw new Error("expected annotated schema object");
  }
  return schema as AnnotatedSchemaNode;
};

const annotate = (
  schema: JSONSchema,
  observedConfidentiality: readonly unknown[] = [],
): AnnotatedSchemaNode =>
  asAnnotatedNode(
    schemaWithInjectionSafeAnnotations(schema, observedConfidentiality),
  );

const property = (
  schema: AnnotatedSchemaNode,
  name: string,
): AnnotatedSchemaNode => {
  const child = schema.properties?.[name];
  expect(child).toBeDefined();
  if (child === undefined) {
    throw new Error(`expected schema property ${name}`);
  }
  return child;
};

const items = (schema: AnnotatedSchemaNode): AnnotatedSchemaNode => {
  expect(schema.items).toBeDefined();
  if (schema.items === undefined) {
    throw new Error("expected schema items");
  }
  return schema.items;
};

const branch = (
  branches: readonly AnnotatedSchemaNode[] | undefined,
  index: number,
): AnnotatedSchemaNode => {
  const child = branches?.[index];
  expect(child).toBeDefined();
  if (child === undefined) {
    throw new Error(`expected schema branch ${index}`);
  }
  return child;
};

const negatedSchema = (schema: AnnotatedSchemaNode): AnnotatedSchemaNode => {
  expect(schema.not).toBeDefined();
  if (schema.not === undefined) {
    throw new Error("expected not schema");
  }
  return schema.not;
};

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

    const annotated = annotate({
      type: "object",
      properties: {
        approved: { type: "boolean" },
        status: { enum: ["open", "closed"] },
        note: { type: "string" },
      },
      required: ["approved", "status", "note"],
      additionalProperties: false,
    }, [risk, retained]);

    expect(annotated.required).toBeUndefined();
    expect(property(annotated, "approved").ifc?.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(property(annotated, "approved").ifc?.confidentiality).toEqual([
      retained,
    ]);
    expect(property(annotated, "status").ifc?.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(property(annotated, "note").ifc?.confidentiality).toContainEqual(
      risk,
    );
    expect(property(annotated, "note").ifc?.confidentiality).toContainEqual(
      retained,
    );
  });

  it("leaves boolean schemas unchanged while annotating", () => {
    expect(schemaWithInjectionSafeAnnotations(true, ["secret"])).toBe(true);
  });

  it("breaks ref cycles during annotation", () => {
    const annotated = annotate({
      $defs: {
        Node: { $ref: "#/$defs/Node" },
      },
      $ref: "#/$defs/Node",
    }, ["secret"]);

    expect(annotated.ifc?.confidentiality).toEqual(["secret"]);
  });

  it("annotates refs, branches, arrays, and open objects", () => {
    const observed = ["secret"];
    const annotated = annotate({
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
    }, observed);

    const list = property(annotated, "list");

    expect(annotated.ifc?.confidentiality).toEqual(observed);
    expect(property(annotated, "child").ifc?.confidentiality).toEqual(observed);
    expect(list.ifc?.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(items(list).ifc?.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
  });

  it("annotates oneOf, allOf, empty objects, and not schemas", () => {
    const annotated = annotate({
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
    }, ["secret"]);
    const choice = property(annotated, "choice");
    const combined = property(annotated, "combined");

    expect(annotated.required).toBeUndefined();
    expect(branch(choice.oneOf, 0).ifc?.addIntegrity)
      .toContainEqual(INJECTION_SAFE_ATOM);
    expect(branch(combined.allOf, 1).ifc?.addIntegrity)
      .toContainEqual(INJECTION_SAFE_ATOM);
    expect(negatedSchema(annotated).required).toBeUndefined();

    const emptyObject = annotate({
      type: "object",
      additionalProperties: false,
    }, ["secret"]);
    expect(emptyObject.ifc?.addIntegrity).toContainEqual(INJECTION_SAFE_ATOM);
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
    expect(
      validateAgainstSchema(
        { type: "custom" } as unknown as JSONSchema,
        "value",
      ),
    )
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
      type: "array",
      items: { type: "string" },
    }, ["ok", 2])).toBe("1: value does not match type string");
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

    const sanitized = annotate(schema, [
      promptRisk,
      promptInfluence,
    ]);

    expect(sanitized.ifc).toBeUndefined();
    expect(property(sanitized, "action").ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(property(sanitized, "confidence").ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(property(sanitized, "approved").ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    const reason = property(sanitized, "reason");
    expect(reason.ifc).toMatchObject({
      confidentiality: [promptRisk, promptInfluence],
    });
    expect(reason.ifc?.addIntegrity).toBeUndefined();
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

    const sanitized = annotate(
      schema,
      [...flatRisks, ...orRisks],
    );

    const remaining = property(sanitized, "action").ifc?.confidentiality ?? [];
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
    expect(remaining.length).toBe(40);
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

    const sanitized = annotate(schema, [
      promptRisk,
    ]);

    expect(sanitized.ifc).toMatchObject({
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.ifc?.confidentiality ?? []).not.toContain(promptRisk);
  });

  it("keeps open object schemas tainted at the parent", () => {
    const schema = {
      type: "object",
      properties: {
        confidence: { type: "number" },
      },
      additionalProperties: true,
    } as const satisfies JSONSchema;

    const sanitized = annotate(schema, [
      promptRisk,
    ]);

    expect(sanitized.ifc?.confidentiality).toEqual([promptRisk]);
    expect(property(sanitized, "confidence").ifc).toMatchObject({
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
    ]);

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
