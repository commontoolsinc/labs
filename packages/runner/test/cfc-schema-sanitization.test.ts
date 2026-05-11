import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  INJECTION_SAFE_ATOM,
  isPromptInjectionMaterialRiskAtom,
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

describe("schema-based prompt injection sanitization", () => {
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

  it("terminates on self-referential $ref schemas", () => {
    // Cyclic schema: a tree node whose `children` is an array of the same
    // node. The sanitizer must not infinite-loop walking the cycle.
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

    // Should resolve, terminate, and produce a sanitized schema; the inner
    // `label` field is a free string so it carries the prompt-influence
    // confidentiality but no InjectionSafe integrity.
    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptInfluence,
    ]) as any;

    expect(sanitized).toBeDefined();
    // The cycle in `children` must not have produced an exception or a
    // structurally infinite tree. We don't assert deep shape here — only
    // that termination + sanitization happened.
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

  it("validates nested $refs by preserving root $defs across recursion", () => {
    // Top-level $ref → $defs/Outer → contains property whose type is
    // $defs/Inner. If validateAgainstSchema dropped root $defs when
    // recursing through the top-level $ref, the nested $ref to Inner
    // would resolve to false and the validation would reject valid
    // values. This guards against that regression.
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
