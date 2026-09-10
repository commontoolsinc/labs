/**
 * The walk itself is `replaceArtifacts()`, covered in `encodable-form.test.ts`.
 * What this module adds is the HOOK: the walk bound to `noteDerivedCopy`, so
 * every copy it makes says where it came from. That is not visible in the
 * replaced value at all -- trust and the content-addressed entry ref live in
 * identity-keyed side tables -- so it is what these cases look at.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { registerFabricFactory } from "@commonfabric/data-model/fabric-factory";

import { flattenBuilderArtifacts } from "../src/storage-preflight.ts";
import {
  brandTrustedBuilderArtifact,
  isTrustedBuilderArtifact,
  resolveOriginal,
} from "../src/builder/pattern-metadata.ts";

/** Builds an artifact of the shape `builder/module.ts` produces. */
function artifact(serialized: unknown): Record<string, unknown> {
  return {
    type: "javascript",
    implementation: () => "not representable",
    toEncodableForm: () => serialized,
  };
}

describe("flattenBuilderArtifacts()", () => {
  it("runs the walk", () => {
    const value = { tools: { send: { handler: artifact({ ok: true }) } } };
    expect(flattenBuilderArtifacts(value))
      .toEqual({ tools: { send: { handler: { ok: true } } } });
  });

  it("flattens a keyless PatternFactory through its embedded graph", () => {
    const factory = Object.assign(() => {}, {
      toEncodableForm: () => ({
        argumentSchema: true,
        resultSchema: true,
        result: { value: 1 },
        nodes: [],
      }),
    });
    registerFabricFactory(factory, "pattern", {
      kind: "pattern",
      rootToken: {},
      argumentSchema: true,
      resultSchema: true,
    });

    const result = flattenBuilderArtifacts({ factory }) as {
      factory: unknown;
    };

    expect(typeof result.factory).toBe("object");
    expect(result.factory).toMatchObject({
      argumentSchema: true,
      resultSchema: true,
      result: { value: 1 },
      nodes: [],
    });
  });

  it("leaves a bound keyless PatternFactory for Factory@1 validation", () => {
    const factory = Object.assign(() => {}, {
      toEncodableForm: () => ({
        argumentSchema: true,
        resultSchema: true,
        result: { value: 1 },
        nodes: [],
      }),
    });
    registerFabricFactory(factory, "pattern", {
      kind: "pattern",
      rootToken: {},
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: {
        type: "object",
        properties: { offset: { type: "number" } },
        required: ["offset"],
        additionalProperties: false,
      },
      params: { offset: 1 },
    });

    const result = flattenBuilderArtifacts({ factory }) as {
      factory: unknown;
    };

    expect(result.factory).toBe(factory);
  });

  it("records where each copy came from", () => {
    const original = artifact({ ok: true });
    const result = flattenBuilderArtifacts({ held: original }) as {
      held: unknown;
    };
    expect(resolveOriginal(result.held)).toBe(original);
  });

  it("records the container it rebuilt, not only the artifact", () => {
    const value = { held: artifact({ ok: true }) };
    const result = flattenBuilderArtifacts(value);
    expect(result).not.toBe(value);
    expect(resolveOriginal(result)).toBe(value);
  });

  it("carries trust across the copy", () => {
    // Trust is why the derivation is recorded eagerly: a serialized copy of a
    // trusted artifact has to stay trusted, and nothing about the copy's own
    // bytes could establish that -- the brand lives in a runner-private
    // WeakSet keyed on identity, which a copy does not share.
    const original = brandTrustedBuilderArtifact({
      held: artifact({ ok: true }),
    });
    expect(isTrustedBuilderArtifact(original)).toBe(true);

    const result = flattenBuilderArtifacts(original);
    expect(result).not.toBe(original);
    expect(isTrustedBuilderArtifact(result)).toBe(true);
  });

  it("leaves a value it did not copy out of the side table", () => {
    // Nothing was replaced, so the value is returned by identity and is its
    // own original -- not a derivation of anything.
    const value = { a: 1, b: { c: [1, 2, 3] } };
    expect(flattenBuilderArtifacts(value)).toBe(value);
    expect(resolveOriginal(value)).toBe(value);
  });
});
