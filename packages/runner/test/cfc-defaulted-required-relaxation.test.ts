import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  localRefTarget,
  relaxDefaultedRequired,
  validateSchemaValue,
} from "../src/cfc/schema-sanitization.ts";

/** The composition the CLI's pre-dispatch verb gate applies to a present
 * payload (`verbInputSchemaError`, `packages/cli/lib/callable.ts`), and the
 * one C5's server-side closed-world enforcement shares: validate against the
 * schema with defaulted properties relaxed out of `required`. These tests
 * moved here with the helpers (verb contract D6) because they pin the
 * relaxation semantics, not the CLI's refusal behavior. */
const relaxedValidationError = (
  input: unknown,
  schema: JSONSchema,
): string | undefined =>
  validateSchemaValue(relaxDefaultedRequired(schema, schema, new Map()), input);

describe("relaxDefaultedRequired", () => {
  // The runtime injects a property's default when a present payload omits it,
  // so requiring it here would refuse a call the verb would have accepted.
  it("treats a defaulted property as satisfied when omitted", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { type: "string", default: "fast" } },
      required: ["mode"],
    })).toBeUndefined();
  });

  it("treats a defaulted property as satisfied when nested", () => {
    expect(relaxedValidationError({ opts: {} }, {
      type: "object",
      properties: {
        opts: {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
          required: ["mode"],
        },
      },
      required: ["opts"],
    })).toBeUndefined();
  });

  it("treats a defaulted property as satisfied behind a $ref", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Mode" } },
      required: ["mode"],
      $defs: { Mode: { type: "string", default: "fast" } },
    })).toBeUndefined();
  });

  it("follows a $ref chain to find the default", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Mode" } },
      required: ["mode"],
      $defs: {
        Mode: { $ref: "#/$defs/RealMode" },
        RealMode: { type: "string", default: "fast" },
      },
    })).toBeUndefined();
  });

  it("relaxes a defaulted property inside array items", () => {
    expect(relaxedValidationError([{}], {
      type: "array",
      items: {
        type: "object",
        properties: { mode: { type: "string", default: "fast" } },
        required: ["mode"],
      },
    })).toBeUndefined();
  });

  it("relaxes a defaulted property inside a combinator branch", () => {
    expect(relaxedValidationError({}, {
      anyOf: [
        {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
          required: ["mode"],
        },
      ],
    } as JSONSchema)).toBeUndefined();
  });

  // A reference that names nothing local cannot be followed to a default.
  // Relaxation leaves it exactly as written rather than guessing.
  it("leaves a non-local $ref untouched", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "https://example.com/Mode" } },
    } as JSONSchema)).toMatch(/cannot resolve schema reference/);
  });

  // Hoisting emits `$defs`; a `definitions` ref is one the runtime cannot
  // resolve either. Relaxing on a default behind one would admit a payload the
  // verb then receives as an absent event, spending the invocation id.
  it("does not relax on a default behind a #/definitions ref", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/definitions/Mode" } },
      required: ["mode"],
      definitions: { Mode: { type: "string", default: "fast" } },
    } as unknown as JSONSchema)).toMatch(/mode/);
  });

  it("leaves a $ref naming a missing definition untouched", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Absent" } },
      $defs: { Present: { type: "string" } },
    } as JSONSchema)).toMatch(/cannot resolve schema reference/);
  });

  it("ignores a malformed $defs pool instead of indexing it", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Mode" } },
      $defs: null,
    } as unknown as JSONSchema)).toMatch(/cannot resolve schema reference/);
  });

  it("handles a $ref whose target is a boolean schema", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Anything" } },
      $defs: { Anything: true },
    } as JSONSchema)).toBeUndefined();
  });

  it("passes a boolean property schema through unchanged", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: true },
    } as JSONSchema)).toBeUndefined();
  });

  // A ref cycle names no schema to check against. Relaxation walks it without
  // looping and hands it on unchanged; the validator is what reports it.
  it("terminates on a $ref cycle instead of looping", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/A" } },
      $defs: {
        A: { $ref: "#/$defs/B" },
        B: { $ref: "#/$defs/A" },
      },
    })).toMatch(/cannot resolve schema reference/);
  });

  it("still rejects a non-defaulted sibling of a defaulted property", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: {
        mode: { type: "string", default: "fast" },
        target: { type: "string" },
      },
      required: ["mode", "target"],
    })).toMatch(/target/);
  });

  it("terminates on a self-referential schema", () => {
    const cyclic: Record<string, unknown> = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    (cyclic.properties as Record<string, unknown>).child = cyclic;
    expect(relaxedValidationError({ name: "a" }, cyclic as JSONSchema))
      .toBeUndefined();
  });
});

describe("localRefTarget", () => {
  it("resolves a top-level local $ref to the schema it names", () => {
    const target = { type: "object", properties: {} } as const;
    expect(localRefTarget(
      { $ref: "#/$defs/Event" } as JSONSchema,
      { $ref: "#/$defs/Event", $defs: { Event: target } } as JSONSchema,
    )).toEqual(target);
  });

  it("returns the last reachable schema when a ref cannot be resolved", () => {
    const unresolvable = { $ref: "#/$defs/Absent" } as JSONSchema;
    expect(localRefTarget(
      unresolvable,
      { $defs: { Present: { type: "string" } } } as JSONSchema,
    )).toBe(unresolvable);
  });
});
