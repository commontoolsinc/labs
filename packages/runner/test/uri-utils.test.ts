import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  entityRefFrom,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import { fromURI, getJSONFromDataURI, toURI } from "../src/uri-utils.ts";

const hash = hashOf({ causal: { test: "uri-utils" } });
const tagged = hash.taggedHashString;

describe("toURI", () => {
  afterEach(() => {
    resetModernCellRepConfig();
  });

  // The live id form (an `EntityId`/`createRef` result) is a `FabricHash` in
  // either regime, so it must convert the same way regardless of the flag.
  for (const modernCellRep of [false, true]) {
    it(`converts a FabricHash (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      expect(toURI(hash)).toBe(`of:${tagged}`);
    });

    it(`converts the active-regime serialized ref (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      // `entityRefFrom` yields the regime's serialized form: the `{ "/": … }`
      // object in legacy mode, the `FabricHash` itself in modern mode.
      expect(toURI(entityRefFrom(hash))).toBe(`of:${tagged}`);
    });
  }

  it('converts the legacy `{ "/": … }` object in legacy mode', () => {
    setModernCellRepConfig(false);
    expect(toURI({ "/": tagged })).toBe(`of:${tagged}`);
  });

  // Per the modern-cell-rep invariant, every stored/wire content-id hash is a
  // `FabricHash`, so a bare `{ "/": … }` is never a content-id ref in modern
  // mode — it is not recognized, and so is rejected rather than mishandled.
  it('rejects a `{ "/": … }` object in modern mode', () => {
    setModernCellRepConfig(true);
    expect(() => toURI({ "/": tagged })).toThrow();
  });

  it("passes through an already-prefixed `of:` URI", () => {
    expect(toURI(`of:${tagged}`)).toBe(`of:${tagged}`);
  });

  it("passes through a `data:` URI", () => {
    const uri = "data:application/json,{}";
    expect(toURI(uri)).toBe(uri);
  });

  it("prefixes a bare id string", () => {
    expect(toURI("bare-id")).toBe("of:bare-id");
  });

  it("rejects a non-`of:`/`data:` prefixed string", () => {
    expect(() => toURI("http:example")).toThrow();
  });

  it("rejects a value that is not an id", () => {
    expect(() => toURI({ not: "an id" })).toThrow();
  });
});

describe("toURI with an entity kind (computed: scheme)", () => {
  afterEach(() => {
    resetModernCellRepConfig();
  });

  it("prefixes a FabricHash with computed: for kind 'computed'", () => {
    expect(toURI(hash, "computed")).toBe(`computed:${tagged}`);
  });

  for (const modernCellRep of [false, true]) {
    it(`prefixes the serialized ref (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      expect(toURI(entityRefFrom(hash), "computed")).toBe(
        `computed:${tagged}`,
      );
    });
  }

  it("prefixes a bare id string with computed:", () => {
    expect(toURI("bare-id", "computed")).toBe("computed:bare-id");
  });

  it("passes through an already-prefixed computed: URI (no kind)", () => {
    expect(toURI(`computed:${tagged}`)).toBe(`computed:${tagged}`);
  });

  // `kind` is a minting-time argument; a schemed string is an already-minted
  // identity — never re-scheme it, even when the scheme matches.
  it("throws on kind + already-schemed string", () => {
    expect(() => toURI(`of:${tagged}`, "computed")).toThrow(
      /already-schemed/,
    );
    expect(() => toURI(`computed:${tagged}`, "computed")).toThrow(
      /already-schemed/,
    );
  });
});

describe("fromURI", () => {
  it("round-trips toURI for both entity schemes", () => {
    expect(fromURI(toURI(hash))).toBe(tagged);
    expect(fromURI(toURI(hash, "computed"))).toBe(tagged);
  });

  it("strips of: and computed: prefixes", () => {
    expect(fromURI(`of:${tagged}`)).toBe(tagged);
    expect(fromURI(`computed:${tagged}`)).toBe(tagged);
  });

  it("passes through a colon-free bare id", () => {
    expect(fromURI("bare-id")).toBe("bare-id");
  });

  it("rejects unknown schemes", () => {
    expect(() => fromURI(`future:${tagged}`)).toThrow(/Invalid URI/);
  });

  // The scheme is part of the identity: stripping it loses the kind, so a
  // bare-hash round-trip through toURI renames a computed: id to its of:
  // sibling. Documented one-way — never rebuild a computed URI from its
  // bare hash (the salted preimage keeps the BYTES distinct, but the
  // resulting URI names the wrong-scheme entity).
  it("is one-way for computed: ids (bare hash re-mints as of:)", () => {
    const bare = fromURI(`computed:${tagged}`);
    expect(toURI(FabricHash.fromString(bare))).toBe(`of:${tagged}`);
  });
});

describe("getJSONFromDataURI", () => {
  /** Percent-encoded `data:` URI with the given payload text. */
  const uriOf = (payload: string): string =>
    `data:application/json,${encodeURIComponent(payload)}`;

  /** Base64 `data:` URI with the given payload text. */
  const base64UriOf = (payload: string): string => {
    const bytes = new TextEncoder().encode(payload);
    const binary = String.fromCharCode(...bytes);
    return `data:application/json;base64,${btoa(binary)}`;
  };

  it("rejects a non-`application/json` URI", () => {
    expect(() => getJSONFromDataURI("data:text/plain,hello")).toThrow(
      /Invalid URI/,
    );
  });

  it("rejects a URI with no comma", () => {
    expect(() => getJSONFromDataURI("data:application/json")).toThrow(
      /Invalid data URI format/,
    );
  });

  it("rejects a non-UTF-8 charset", () => {
    expect(() => getJSONFromDataURI("data:application/json;charset=latin1,{}"))
      .toThrow(/Unsupported charset/);
  });

  it("accepts an explicit UTF-8 charset", () => {
    expect(getJSONFromDataURI("data:application/json;charset=utf-8,{}"))
      .toEqual({});
  });

  it("yields `undefined` for an empty payload", () => {
    expect(getJSONFromDataURI("data:application/json,")).toBeUndefined();
  });

  describe("bare-JSON payloads", () => {
    it("decodes a percent-encoded payload", () => {
      const uri = uriOf('{"value":{"b":1,"a":[true,null,"x"]}}');
      expect(getJSONFromDataURI(uri)).toEqual({
        value: { b: 1, a: [true, null, "x"] },
      });
    });

    it("decodes a Base64 payload, including non-ASCII text", () => {
      const uri = base64UriOf('{"value":"città"}');
      expect(getJSONFromDataURI(uri)).toEqual({ value: "città" });
    });

    it("decodes a non-object payload", () => {
      expect(getJSONFromDataURI(uriOf("[1,2,3]"))).toEqual([1, 2, 3]);
      expect(getJSONFromDataURI(uriOf('"plain"'))).toBe("plain");
    });

    it("rejects an invalid JSON payload", () => {
      expect(() => getJSONFromDataURI(uriOf("{nope"))).toThrow();
    });
  });

  describe("encoded-`FabricValue` (`fvj1:`) payloads", () => {
    it("decodes a percent-encoded payload", () => {
      const value = { value: { b: 1, a: [true, null, "x"] } };
      expect(getJSONFromDataURI(uriOf(jsonFromValue(value)))).toEqual(value);
    });

    it("decodes a Base64 payload, including non-ASCII text", () => {
      const value = { value: "città" };
      expect(getJSONFromDataURI(base64UriOf(jsonFromValue(value))))
        .toEqual(value);
    });

    it("preserves non-finite numbers and negative zero", () => {
      const uri = uriOf(jsonFromValue({ value: [NaN, -0, Infinity] }));
      const result = getJSONFromDataURI(uri);
      expect(Object.is(result.value[0], NaN)).toBe(true);
      expect(Object.is(result.value[1], -0)).toBe(true);
      expect(Object.is(result.value[2], Infinity)).toBe(true);
    });

    // Sigil links are plain objects with a `/`-prefixed key, which the codec
    // escapes on encode (spec section 5.6); they must come back as the same
    // plain objects, since link recognition downstream depends on that shape.
    it("round-trips a plain object with a `/`-prefixed key", () => {
      const value = {
        value: { "/": { "link@1": { id: "of:xyz", path: ["a"] } } },
      };
      expect(getJSONFromDataURI(uriOf(jsonFromValue(value)))).toEqual(value);
    });

    it("returns deep-frozen results", () => {
      const uri = uriOf(jsonFromValue({ value: { nested: { deep: [1] } } }));
      const result = getJSONFromDataURI(uri);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.nested.deep)).toBe(true);
    });

    it("rejects a malformed payload past the tag", () => {
      expect(() => getJSONFromDataURI(uriOf("fvj1:{nope"))).toThrow();
    });
  });
});
