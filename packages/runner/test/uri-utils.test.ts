import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  createFactoryShell,
  factoryStateOf,
  type FactoryStateV1,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import {
  entityRefFrom,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  decodeDataURIValue,
  encodeFabricValueDataURI,
  FABRIC_VALUE_DATA_URI_MEDIA_TYPE,
  FABRIC_VALUE_DATA_URI_PREFIX,
  fromURI,
  getJSONFromDataURI,
  toURI,
} from "../src/uri-utils.ts";

const hash = hashOf({ causal: { test: "uri-utils" } });
const tagged = hash.taggedHashString;

const FACTORY_REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;

function base64Utf8(value: string): string {
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(value)),
  );
}

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
    const uri = "data:application/vnd.common-fabric.data,e30";
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

describe("Fabric value data URIs", () => {
  it("keeps legacy JSON slash envelopes literal and never sniffs Fabric encoding", () => {
    const literal = { "/": { "link@1": { id: "of:literal" } } };
    const legacy = `data:application/json,${
      encodeURIComponent(JSON.stringify(literal))
    }`;
    expect(decodeDataURIValue(legacy)).toEqual(literal);

    const fabricLooking = `data:application/json,${
      encodeURIComponent('"fvj1:{\\"/Undefined@1\\":null}"')
    }`;
    expect(decodeDataURIValue(fabricLooking)).toBe(
      'fvj1:{"/Undefined@1":null}',
    );
  });

  it("round-trips all three factory kinds as inert context-free shells", () => {
    const states: FactoryStateV1[] = [
      {
        kind: "pattern",
        ref: { ...FACTORY_REF, symbol: "pattern" },
        argumentSchema: { type: "object" },
        resultSchema: true,
      },
      {
        kind: "module",
        ref: { ...FACTORY_REF, symbol: "module" },
        argumentSchema: false,
        resultSchema: { type: "string" },
      },
      {
        kind: "handler",
        ref: { ...FACTORY_REF, symbol: "handler" },
        contextSchema: { type: "object" },
        eventSchema: { type: "number" },
      },
    ];

    for (const state of states) {
      const uri = encodeFabricValueDataURI(createFactoryShell(state));
      expect(uri.startsWith(FABRIC_VALUE_DATA_URI_PREFIX)).toBe(true);
      const decoded = decodeDataURIValue(uri);
      expect(isAdmittedFabricFactory(decoded)).toBe(true);
      expect(factoryStateOf(decoded)).toEqual(state);
      expect(isDeepFrozen(decoded)).toBe(true);
      expect(() => (decoded as () => unknown)()).toThrow(
        "factory requires runner materialization",
      );
      expect(encodeFabricValueDataURI(decoded)).toBe(uri);
    }
  });

  it("dispatches only the exact media type and requires a versioned Fabric payload", () => {
    expect(FABRIC_VALUE_DATA_URI_MEDIA_TYPE).toBe(
      "application/vnd.commonfabric.fabric-value",
    );
    expect(() => decodeDataURIValue("data:application/jsonx,%7B%7D")).toThrow(
      "Unsupported data URI media type",
    );
    expect(() =>
      decodeDataURIValue(
        "data:application/vnd.commonfabric.fabric-value,%7B%7D",
      )
    ).toThrow();
    expect(() =>
      decodeDataURIValue(
        "data:application/vnd.commonfabric.fabric-value,fvj1%3A",
      )
    ).toThrow();
  });

  it("decodes percent and base64 UTF-8 payloads identically", () => {
    const value = { message: "Grüße 🌊" };
    const fabric = jsonFromValue(value);
    const percent = `data:${FABRIC_VALUE_DATA_URI_MEDIA_TYPE};charset=utf-8,${
      encodeURIComponent(fabric)
    }`;
    const base64 =
      `data:${FABRIC_VALUE_DATA_URI_MEDIA_TYPE};charset=utf8;base64,${
        base64Utf8(fabric)
      }`;

    expect(decodeDataURIValue(percent)).toEqual(value);
    expect(decodeDataURIValue(base64)).toEqual(value);
    expect(getJSONFromDataURI(percent)).toEqual(value);
  });
});
