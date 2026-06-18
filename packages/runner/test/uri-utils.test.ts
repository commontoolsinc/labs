import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  entityRefFrom,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { toURI } from "../src/uri-utils.ts";

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
