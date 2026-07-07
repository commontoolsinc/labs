/**
 * V8 line-coverage tests for leaf-caps.ts — the capture-time LEAF CAPABILITY
 * analysis. All three targets are EXPORTED pure functions, so these are direct
 * unit tests with no Runtime harness. Each uncovered branch is driven by an
 * input that makes it run AND the observable result is asserted.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  computeLeafCaps,
  resultSchemaDeclaresValueType,
  schemaNeedsCellContext,
} from "../../src/reactive-interpreter/leaf-caps.ts";

describe("resultSchemaDeclaresValueType (leaf-caps.ts 65-97)", () => {
  it("is FALSE for `true` (any), {}, null, [], and array-typed schema", () => {
    // schema === true (line 66)
    assertEquals(resultSchemaDeclaresValueType(true), false);
    // null / non-object (line 67-69)
    assertEquals(resultSchemaDeclaresValueType(null), false);
    assertEquals(resultSchemaDeclaresValueType(undefined), false);
    // Array.isArray(schema) short-circuits (line 67)
    assertEquals(resultSchemaDeclaresValueType([]), false);
    assertEquals(resultSchemaDeclaresValueType([{ type: "string" }]), false);
    // empty object — no pinning key (falls through to line 96)
    assertEquals(resultSchemaDeclaresValueType({}), false);
  });

  it("is TRUE for a plain typed schema {type:'string'}", () => {
    // typeof s.type === "string" (line 82)
    assertEquals(resultSchemaDeclaresValueType({ type: "string" }), true);
  });

  it("is TRUE for a union type array {type:['string','number']}", () => {
    // Array.isArray(s.type) && length>0 (line 83)
    assertEquals(
      resultSchemaDeclaresValueType({ type: ["string", "number"] }),
      true,
    );
    // empty type array must NOT pin
    assertEquals(resultSchemaDeclaresValueType({ type: [] }), false);
  });

  it("is TRUE for {enum:[...]} and FALSE for empty enum", () => {
    // Array.isArray(s.enum) && length>0 (line 84)
    assertEquals(resultSchemaDeclaresValueType({ enum: [1, 2] }), true);
    assertEquals(resultSchemaDeclaresValueType({ enum: [] }), false);
  });

  it("is TRUE for {const:5} — even a falsy const value", () => {
    // hasOwnProperty(s, "const") (line 85)
    assertEquals(resultSchemaDeclaresValueType({ const: 5 }), true);
    assertEquals(resultSchemaDeclaresValueType({ const: 0 }), true);
  });

  it("is TRUE for {$ref:'#/x'} and FALSE for non-string $ref", () => {
    // typeof s.$ref === "string" (line 86)
    assertEquals(resultSchemaDeclaresValueType({ $ref: "#/x" }), true);
    assertEquals(resultSchemaDeclaresValueType({ $ref: 5 }), false);
  });

  it("recurses into array items (line 71-72)", () => {
    // {type:"array"} with typed items -> TRUE via recursion
    assertEquals(
      resultSchemaDeclaresValueType({
        type: "array",
        items: { type: "number" },
      }),
      true,
    );
  });

  it("is FALSE for a bare {type:'array'} with no items/prefixItems", () => {
    // array branch: items absent, prefix absent -> return false (line 80)
    assertEquals(resultSchemaDeclaresValueType({ type: "array" }), false);
    // array with EMPTY-object items (items does not pin) -> false
    assertEquals(
      resultSchemaDeclaresValueType({ type: "array", items: {} }),
      false,
    );
  });

  it("is TRUE for array prefixItems all typed (line 74-79)", () => {
    assertEquals(
      resultSchemaDeclaresValueType({
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
      }),
      true,
    );
    // empty prefixItems does NOT pin
    assertEquals(
      resultSchemaDeclaresValueType({ type: "array", prefixItems: [] }),
      false,
    );
    // a prefix element that does not pin -> false (every() fails)
    assertEquals(
      resultSchemaDeclaresValueType({
        type: "array",
        prefixItems: [{ type: "number" }, {}],
      }),
      false,
    );
  });

  it("is TRUE for anyOf all-typed and FALSE for anyOf with an empty branch (line 87-95)", () => {
    assertEquals(
      resultSchemaDeclaresValueType({ anyOf: [{ type: "string" }] }),
      true,
    );
    // allOf / oneOf keys exercised too
    assertEquals(
      resultSchemaDeclaresValueType({ allOf: [{ type: "number" }] }),
      true,
    );
    assertEquals(
      resultSchemaDeclaresValueType({ oneOf: [{ const: 1 }] }),
      true,
    );
    // anyOf with an empty (non-pinning) branch -> false
    assertEquals(resultSchemaDeclaresValueType({ anyOf: [{}] }), false);
    // empty anyOf array -> false
    assertEquals(resultSchemaDeclaresValueType({ anyOf: [] }), false);
  });
});

describe("schemaNeedsCellContext (leaf-caps.ts 99-114)", () => {
  it("is FALSE for a plain typed schema and non-objects", () => {
    assertEquals(schemaNeedsCellContext({ type: "number" }), false);
    assertEquals(schemaNeedsCellContext(null), false);
    assertEquals(schemaNeedsCellContext(undefined), false);
    assertEquals(schemaNeedsCellContext(42), false);
  });

  it("is TRUE when the schema declares asCell", () => {
    assertEquals(schemaNeedsCellContext({ asCell: [] }), true);
  });

  it("is TRUE when the schema declares asStream", () => {
    assertEquals(schemaNeedsCellContext({ asStream: [] }), true);
  });

  it("recurses into nested properties (line 109-112)", () => {
    assertEquals(
      schemaNeedsCellContext({
        type: "object",
        properties: { x: { asCell: [] }, y: { type: "string" } },
      }),
      true,
    );
  });

  it("recurses through arrays (line 104-106)", () => {
    assertEquals(
      schemaNeedsCellContext([{ type: "string" }, { asStream: [] }]),
      true,
    );
    assertEquals(schemaNeedsCellContext([{ type: "string" }]), false);
  });

  it("SKIPS the `default` key — an asCell-looking default value is NOT a sub-schema (line 110)", () => {
    // The default holds an authored VALUE; even though it structurally looks
    // like an asCell schema it must be ignored, so the result is FALSE.
    assertEquals(
      schemaNeedsCellContext({
        type: "object",
        default: { asCell: [{ type: "string" }] },
      }),
      false,
    );
    // Control: the SAME shape under `properties` DOES trip it.
    assertEquals(
      schemaNeedsCellContext({
        type: "object",
        properties: { asCell: [{ type: "string" }] },
      }),
      true,
    );
  });
});

describe("computeLeafCaps (leaf-caps.ts 119-121,139,158,182-184)", () => {
  it("returns undefined for a plain pure value-producer leaf", () => {
    // A body with no hazards, plain schema: no caps set -> undefined (line 194).
    const caps = computeLeafCaps(
      (x: number) => x + 1,
      { type: "number" },
      { type: "number" },
    );
    assertEquals(caps, undefined);
  });

  it("flags instantiatesPattern for a bare call to a non-pure callee (line 179-181)", () => {
    // A bare `helper(x)` call — `helper` is not in PURE_GLOBAL_CALLEES and is
    // not preceded by `.`, so callRe matches it and the gate flips.
    const helper = (n: number) => n * 2;
    const caps = computeLeafCaps(
      (x: number) => helper(x),
      { type: "number" },
      { type: "number" },
    );
    assert(caps);
    assertEquals(caps.instantiatesPattern, true);
  });

  it("does NOT flag instantiatesPattern for calls to pure global callees only", () => {
    // Only Array/Number/etc callees -> PURE_GLOBAL_CALLEES, no flag.
    const caps = computeLeafCaps(
      (x: string) => Number(x) + Array.from(x).length,
      { type: "number" },
      { type: "number" },
    );
    assertEquals(caps, undefined);
  });

  it("flags instantiatesPattern for .inSpace / .asScope factory routing (line 138)", () => {
    const inSpace = computeLeafCaps(
      (h: { inSpace: (s: string) => unknown }) => h.inSpace("did:x"),
      true,
      true,
    );
    assert(inSpace);
    assertEquals(inSpace.instantiatesPattern, true);
  });

  it("flags BOTH instantiatesPattern and async for an async body (line 139, 182-184)", () => {
    const caps = computeLeafCaps(
      async (x: number) => x + 1,
      { type: "number" },
      { type: "number" },
    );
    assert(caps);
    // async body matches /^async[\s(]/ in scanInstantiatesPattern (139)
    assertEquals(caps.instantiatesPattern, true);
    // and again in computeLeafCaps for the async cap (182-184)
    assertEquals(caps.async, true);
  });

  it("flags needsCellContext from an asCell argument schema (line 185-189)", () => {
    const caps = computeLeafCaps(
      (h: unknown) => h,
      { asCell: [{ type: "number" }] },
      { type: "number" },
    );
    assert(caps);
    assertEquals(caps.needsCellContext, true);
  });

  it("flags needsCellContext from a .get(/.sample( handle read", () => {
    const caps = computeLeafCaps(
      (h: { get: () => unknown }) => h.get(),
      true,
      { type: "number" },
    );
    assert(caps);
    assertEquals(caps.needsCellContext, true);
  });

  it("flags needsCellContext from a .for( named-cell mint", () => {
    const caps = computeLeafCaps(
      (h: { for: (k: string) => unknown }) => h.for("k"),
      true,
      true,
    );
    assert(caps);
    assertEquals(caps.needsCellContext, true);
  });

  it("flags writesInput only together with needsCellContext (line 191-193)", () => {
    // asCell schema gives needsCellContext, .set( gives writesInput.
    const caps = computeLeafCaps(
      (h: { set: (v: number) => void }) => h.set(1),
      { asCell: [{ type: "number" }] },
      true,
    );
    assert(caps);
    assertEquals(caps.needsCellContext, true);
    assertEquals(caps.writesInput, true);
  });

  it("does NOT flag writesInput when there is no cell context even if .set( appears", () => {
    // A .set( call on a plain-typed schema without any handle-read/asCell:
    // needsCellContext is false, so the writesInput guard (191) is skipped.
    // But .set( is a bare-ish member call... it must not itself set writesInput
    // without needsCellContext. `x.set(` here: no asCell schema, no .get/.for,
    // so needsCellContext stays false and writesInput stays unset.
    const caps = computeLeafCaps(
      (x: { set: (v: number) => void }) => {
        x.set(1);
        return 0;
      },
      { type: "number" },
      { type: "number" },
    );
    // The bare call `x.set(` — `.set` is a member call, callRe uses a negative
    // lookbehind for `.`, so `set(` after a dot is NOT matched as a bare call.
    // needsCellContext false -> writesInput never set.
    assert(caps === undefined || caps.writesInput === undefined);
  });

  it("handles a non-function impl: sourceOf returns undefined (line 119-121, 158)", () => {
    // Function.prototype.toString.call on a non-function THROWS -> catch ->
    // undefined. scanWritesCellInput(undefined) === true, but needsCellContext
    // is false (schema plain, no src to read) so writesInput stays unset.
    const caps = computeLeafCaps(
      { not: "a function" } as unknown,
      { type: "number" },
      { type: "number" },
    );
    // src undefined: scanInstantiatesPattern(undefined)=false,
    // async check src!==undefined fails, schemaNeedsCellContext(plain)=false,
    // scanReadsCellHandle(undefined)=false, scanNeedsBuilderContext(undefined)=
    // false -> needsCellContext false -> writesInput not reached -> undefined.
    assertEquals(caps, undefined);
  });

  it("non-function impl WITH an asCell schema flags needsCellContext AND writesInput (line 158 conservative-true)", () => {
    // Here needsCellContext is true (asCell schema). With src undefined,
    // scanWritesCellInput returns the CONSERVATIVE true (line 158), so
    // writesInput is set.
    const caps = computeLeafCaps(
      { not: "a function" } as unknown,
      { asCell: [{ type: "number" }] },
      true,
    );
    assert(caps);
    assertEquals(caps.needsCellContext, true);
    assertEquals(caps.writesInput, true);
  });
});
