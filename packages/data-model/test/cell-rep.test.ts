import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import {
  type EntityRef,
  entityRefFrom,
  entityRefFromString,
  entityRefToString,
  isEntityRef,
  isLinkRef,
  LINK_V1_TAG,
  linkPayloadAtProbe,
  linkProbeSubPath,
  linkRefFrom,
  linkRefPayload,
  linkRefPayloadFromString,
  linkRefPayloadToString,
  resetModernCellRepConfig,
  setModernCellRepConfig,
  type WireLinkRefPayload,
} from "@/cell-rep.ts";

/** A fixed 32-byte hash for deterministic tests. */
const SAMPLE_HASH = new Uint8Array(32);
for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = i;

const HASH = new FabricHash(SAMPLE_HASH, "fid1");
const TAGGED = HASH.taggedHashString; // "fid1:…"

describe("cell-rep entity-id reference", () => {
  afterEach(() => {
    resetModernCellRepConfig();
  });

  describe("with the flag OFF (legacy plain-object form)", () => {
    it('produces a `{ "/": string }` object from a string', () => {
      const ref = entityRefFromString(TAGGED);
      expect(ref).toEqual({ "/": TAGGED });
      expect(ref).not.toBeInstanceOf(FabricHash);
    });

    it('produces a `{ "/": string }` object from a FabricHash', () => {
      expect(entityRefFrom(HASH)).toEqual({ "/": TAGGED });
    });

    it("recognizes the plain-object form, not a FabricHash", () => {
      expect(isEntityRef({ "/": TAGGED })).toBe(true);
      expect(isEntityRef(HASH)).toBe(false);
      expect(isEntityRef(undefined)).toBe(false);
      expect(isEntityRef("plain string")).toBe(false);
    });

    it("extracts the tagged hash string from the plain-object form", () => {
      expect(entityRefToString({ "/": TAGGED })).toBe(TAGGED);
    });

    it("throws extracting from a FabricHash (wrong regime)", () => {
      expect(() => entityRefToString(HASH as EntityRef)).toThrow();
    });
  });

  describe("with the flag ON (modern FabricHash form)", () => {
    it("produces a FabricHash from a string", () => {
      setModernCellRepConfig(true);
      const ref = entityRefFromString(TAGGED);
      expect(ref).toBeInstanceOf(FabricHash);
      expect((ref as FabricHash).taggedHashString).toBe(TAGGED);
    });

    it("returns the FabricHash unchanged from a FabricHash", () => {
      setModernCellRepConfig(true);
      expect(entityRefFrom(HASH)).toBe(HASH);
    });

    it("recognizes a FabricHash, not the plain-object form", () => {
      setModernCellRepConfig(true);
      expect(isEntityRef(HASH)).toBe(true);
      expect(isEntityRef({ "/": TAGGED })).toBe(false);
    });

    it("extracts the tagged hash string from a FabricHash", () => {
      setModernCellRepConfig(true);
      expect(entityRefToString(HASH)).toBe(TAGGED);
    });

    it("throws extracting from the plain-object form (wrong regime)", () => {
      setModernCellRepConfig(true);
      expect(() => entityRefToString({ "/": TAGGED } as EntityRef)).toThrow();
    });
  });

  it("round-trips a string through both forms in each regime", () => {
    for (const enabled of [false, true]) {
      setModernCellRepConfig(enabled);
      expect(entityRefToString(entityRefFromString(TAGGED))).toBe(TAGGED);
      expect(entityRefToString(entityRefFrom(HASH))).toBe(TAGGED);
      resetModernCellRepConfig();
    }
  });
});

describe("cell-rep link-ref envelope", () => {
  const PAYLOAD = { id: "of:abc", path: ["x", "y"] };

  it('wraps a payload in the `{ "/": { "link@1": … } }` envelope', () => {
    expect(linkRefFrom(PAYLOAD)).toEqual({ "/": { [LINK_V1_TAG]: PAYLOAD } });
  });

  it("recognizes the link-ref envelope", () => {
    expect(isLinkRef(linkRefFrom(PAYLOAD))).toBe(true);
  });

  it("rejects everything that is not a link-ref envelope", () => {
    // The `{ "/": string }` entity-ref form is deliberately NOT a link ref.
    expect(isLinkRef({ "/": "fid1:abc" })).toBe(false);
    // Envelope with extra keys, or missing the tag, or wrong shape.
    expect(isLinkRef({ "/": { [LINK_V1_TAG]: PAYLOAD }, extra: 1 })).toBe(
      false,
    );
    expect(isLinkRef({ "/": {} })).toBe(false);
    expect(isLinkRef({ other: { [LINK_V1_TAG]: PAYLOAD } })).toBe(false);
    expect(isLinkRef(undefined)).toBe(false);
    expect(isLinkRef("link")).toBe(false);
    expect(isLinkRef([])).toBe(false);
  });

  it("extracts the payload from an envelope", () => {
    expect(linkRefPayload(linkRefFrom(PAYLOAD))).toEqual(PAYLOAD);
  });

  it("throws extracting a payload from a non-envelope", () => {
    expect(() => linkRefPayload({ "/": "fid1:abc" } as never)).toThrow(
      "Not a link reference",
    );
    expect(() => linkRefPayload({} as never)).toThrow("Not a link reference");
  });
});

describe("cell-rep link storage-tree probe", () => {
  const PAYLOAD = { id: "of:abc", path: ["x", "y"] };

  it('probes two segments down at ["/", "link@1"]', () => {
    expect(linkProbeSubPath()).toEqual(["/", LINK_V1_TAG]);
  });

  it("reads the payload back from the value at the probe sub-path", () => {
    // The envelope is decomposed in the tree, so walking the probe sub-path
    // lands directly on the payload record.
    const envelope = linkRefFrom(PAYLOAD);
    const atProbe = linkProbeSubPath().reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      envelope,
    );
    expect(linkPayloadAtProbe(atProbe)).toEqual(PAYLOAD);
  });

  it("treats any record at the probe as the payload", () => {
    expect(linkPayloadAtProbe(PAYLOAD)).toBe(PAYLOAD);
    expect(linkPayloadAtProbe({})).toEqual({});
  });

  it("returns undefined when the probed value is not a record", () => {
    expect(linkPayloadAtProbe(undefined)).toBeUndefined();
    expect(linkPayloadAtProbe(null)).toBeUndefined();
    expect(linkPayloadAtProbe("redirect")).toBeUndefined();
    expect(linkPayloadAtProbe(42)).toBeUndefined();
  });
});

describe("cell-rep link-ref payload wire serialization", () => {
  it("round-trips a payload of strings and string arrays", () => {
    const payload = { id: "of:abc", space: "did:key:z6Mk", path: ["a", "b"] };
    const wire = linkRefPayloadToString(payload);
    expect(wire.startsWith("fcl1:")).toBe(true);
    expect(linkRefPayloadFromString(wire)).toEqual(payload);
  });

  it("tags the output with the fcl1: prefix followed by the JSON", () => {
    expect(linkRefPayloadToString({ id: "of:abc" })).toBe(
      'fcl1:{"id":"of:abc"}',
    );
  });

  describe("linkRefPayloadToString validation", () => {
    const bad = (p: unknown) =>
      expect(() => linkRefPayloadToString(p as WireLinkRefPayload)).toThrow();

    it("throws on a non-plain-object payload", () => {
      bad([]);
      bad("of:abc");
      bad(null);
    });

    it("throws on a value that is neither string nor array-of-strings", () => {
      bad({ n: 1 }); // number
      bad({ o: { k: "v" } }); // nested object (e.g. a `schema`)
      bad({ a: ["ok", 2] }); // array with a non-string element
    });
  });

  describe("linkRefPayloadFromString validation", () => {
    it("throws without the fcl1: prefix", () => {
      expect(() => linkRefPayloadFromString('{"id":"of:abc"}')).toThrow();
      expect(() => linkRefPayloadFromString("of:abc")).toThrow();
    });

    it("throws on invalid JSON after the prefix", () => {
      expect(() => linkRefPayloadFromString("fcl1:not json")).toThrow();
    });

    it("throws when the decoded value is not a plain object", () => {
      expect(() => linkRefPayloadFromString('fcl1:"x"')).toThrow();
      expect(() => linkRefPayloadFromString("fcl1:[]")).toThrow();
      expect(() => linkRefPayloadFromString("fcl1:null")).toThrow();
    });

    it("throws when a decoded value is not a string or array-of-strings", () => {
      expect(() => linkRefPayloadFromString('fcl1:{"n":1}')).toThrow();
      expect(() => linkRefPayloadFromString('fcl1:{"o":{"k":"v"}}')).toThrow();
      expect(() => linkRefPayloadFromString('fcl1:{"a":["ok",2]}')).toThrow();
    });

    it("rejects prototype-pollution keys carried on the wire", () => {
      expect(() => linkRefPayloadFromString('fcl1:{"__proto__":"x"}'))
        .toThrow();
      expect(() => linkRefPayloadFromString('fcl1:{"constructor":"x"}'))
        .toThrow();
    });
  });
});
