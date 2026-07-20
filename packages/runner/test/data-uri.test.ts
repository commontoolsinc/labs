import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import {
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { UnknownValue } from "@commonfabric/data-model/fabric-instances";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  createDataCellURI,
  decodeDataURIPayloadText,
  getJSONFromDataURI,
} from "../src/data-uri.ts";
import { isSigilLink, type NormalizedLink } from "../src/link-utils.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createCell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("data-uri", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("createDataCellURI", () => {
    it("should throw on circular data", () => {
      const circular: any = { name: "test" };
      circular.self = circular;

      expect(() => createDataCellURI(circular)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on nested circular data", () => {
      const obj1: any = { name: "obj1" };
      const obj2: any = { name: "obj2", ref: obj1 };
      obj1.ref = obj2;

      expect(() => createDataCellURI(obj1)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on circular data in arrays", () => {
      const circular: any = { items: [] };
      circular.items.push(circular);

      expect(() => createDataCellURI(circular)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should rewrite relative links with base id", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const baseId = baseCell.getAsNormalizedFullLink().id;

      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
          },
        },
      };

      const dataURI = createDataCellURI(
        { link: relativeLink },
        baseCell,
      );

      // Decode the data URI using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.link["/"][LINK_V1_TAG].path).toEqual([
        "nested",
        "value",
      ]);
      expect(parsed.link["/"][LINK_V1_TAG].id).toBe(baseId);
    });

    it("should rewrite relative links with base scope", () => {
      const baseCell = runtime.getCell(space, "scoped base", undefined, tx);
      const scopedBaseCell = createCell(runtime, {
        ...baseCell.getAsNormalizedFullLink(),
        scope: "session",
      }, tx);
      const baseId = scopedBaseCell.getAsNormalizedFullLink().id;

      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
          },
        },
      };

      const dataURI = createDataCellURI(
        { link: relativeLink },
        scopedBaseCell,
      );
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.link["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.link["/"][LINK_V1_TAG].scope).toBe("session");
    });

    it("should rewrite nested relative links with base id", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const baseId = baseCell.getAsNormalizedFullLink().id;

      const data = {
        items: [
          {
            "/": {
              [LINK_V1_TAG]: {
                path: ["item", "0"],
              },
            },
          },
          {
            nested: {
              link: {
                "/": {
                  [LINK_V1_TAG]: {
                    path: ["item", "1"],
                  },
                },
              },
            },
          },
        ],
      };

      const dataURI = createDataCellURI(data, baseCell);

      // Decode the data URI using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.items[0]["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.items[1].nested.link["/"][LINK_V1_TAG].id).toBe(
        baseId,
      );
    });

    it("should not modify absolute links", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const otherCell = runtime.getCell(space, "other", undefined, tx);
      const otherId = otherCell.getAsNormalizedFullLink().id;

      const absoluteLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: otherId,
            path: ["some", "path"],
          },
        },
      };

      const dataURI = createDataCellURI({ link: absoluteLink }, baseCell);

      // Decode the data URI using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      // Should remain unchanged
      expect(parsed.link["/"][LINK_V1_TAG].id).toBe(otherId);
      expect(parsed.link["/"][LINK_V1_TAG].path).toEqual([
        "some",
        "path",
      ]);
    });

    it("should handle reused acyclic objects without throwing", () => {
      const sharedObject = { value: 42 };
      const data = {
        first: sharedObject,
        second: sharedObject,
        nested: {
          third: sharedObject,
        },
      };

      // Should not throw even though sharedObject is referenced multiple times
      const dataURI = createDataCellURI(data);

      // Decode and verify using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.first.value).toBe(42);
      expect(parsed.second.value).toBe(42);
      expect(parsed.nested.third.value).toBe(42);
    });

    it("should handle UTF-8 characters (emojis, special characters)", () => {
      const data = {
        emoji: "🚀 Hello World! 🌍",
        chinese: "你好世界",
        arabic: "مرحبا بالعالم",
        special: "Ñoño™©®",
        mixed: "Test 🎉 with ñ and 中文",
      };

      // Should not throw with UTF-8 characters
      const dataURI = createDataCellURI(data);

      // Decode and verify using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.emoji).toBe("🚀 Hello World! 🌍");
      expect(parsed.chinese).toBe("你好世界");
      expect(parsed.arabic).toBe("مرحبا بالعالم");
      expect(parsed.special).toBe("Ñoño™©®");
      expect(parsed.mixed).toBe("Test 🎉 with ñ and 中文");
    });

    it("mints the data-cell media type and the standard encoding", () => {
      const dataURI = createDataCellURI({ x: 1 });
      expect(dataURI.startsWith("data:application/vnd.common-fabric.data,"))
        .toBe(true);
      const payload = new TextDecoder().decode(
        decodeBase64Url(dataURI.slice(dataURI.indexOf(",") + 1)),
      );
      expect(payload.startsWith("fvj1:")).toBe(true);
    });

    // The standard encoding canonicalizes key order, so the minted id is a
    // function of content alone. This is the property whose absence #4360
    // worked around in `schema-hash.ts`.
    it("mints the same URI regardless of key insertion order", () => {
      const inOrder = { alpha: 1, beta: [2, 3], gamma: { delta: 4 } };
      const scrambled = { gamma: { delta: 4 }, beta: [2, 3], alpha: 1 };
      expect(createDataCellURI(scrambled)).toBe(createDataCellURI(inOrder));
    });

    it("preserves non-finite numbers and negative zero", () => {
      const dataURI = createDataCellURI({ n: NaN, z: -0, i: -Infinity });
      const parsed = getJSONFromDataURI(dataURI);
      expect(Object.is(parsed.n, NaN)).toBe(true);
      expect(Object.is(parsed.z, -0)).toBe(true);
      expect(Object.is(parsed.i, -Infinity)).toBe(true);
    });

    // `undefined` is a `FabricValue` and round-trips as itself; the
    // present-`undefined` document property is the reader's synthesis
    // (see attestation `load()`), not part of the payload.
    it("round-trips an `undefined` value", () => {
      expect(getJSONFromDataURI(createDataCellURI(undefined)))
        .toBeUndefined();
    });

    it("represents a `FabricPrimitive` leaf correctly", () => {
      const h = hashOf({ some: "value" });
      const parsed = getJSONFromDataURI(createDataCellURI({ h }));
      expect(parsed.h).toBeInstanceOf(FabricHash);
      expect(parsed.h.toString()).toBe(h.toString());
    });

    // Link-free content on purpose: for an instance whose state carries no
    // links, today's pass-through and the eventual traverse-into-state
    // behavior (see the `TODO` in the walk) coincide, so this pins only the
    // codec round-trip, not the pass-through itself.
    it("represents a link-free `FabricInstance` via its codec", () => {
      const inst = new UnknownValue("zzz@1", { a: 1 });
      const parsed = getJSONFromDataURI(createDataCellURI({ inst }));
      expect(parsed.inst).toBeInstanceOf(UnknownValue);
      expect(parsed.inst.wireTypeTag).toBe("zzz@1");
      expect(parsed.inst.state).toEqual({ a: 1 });
    });

    it("rewrites relative links in the modern regime (`FabricLink`)", () => {
      setModernCellRepConfig(true);
      try {
        const baseId = `of:${hashOf({ base: "modern" }).taggedHashString}`;
        const base: NormalizedLink = {
          id: baseId as any,
          space,
          scope: "space",
          path: [],
        };
        const relativeLink = linkRefFrom({ path: ["nested", "value"] });

        const dataURI = createDataCellURI({ link: relativeLink }, base);
        const parsed = getJSONFromDataURI(dataURI);

        expect(isSigilLink(parsed.link)).toBe(true);
        const payload = linkRefPayload(parsed.link) as any;
        expect(payload.id).toBe(baseId);
        expect(payload.path).toEqual(["nested", "value"]);
      } finally {
        resetModernCellRepConfig();
      }
    });
  });

  describe("decodeDataURIPayloadText", () => {
    it("decodes encoded payload text of every top-level shape", () => {
      expect(decodeDataURIPayloadText(jsonFromValue({ b: 1, a: [true] })))
        .toEqual({ b: 1, a: [true] });
      expect(decodeDataURIPayloadText(jsonFromValue([1, 2, 3])))
        .toEqual([1, 2, 3]);
      expect(decodeDataURIPayloadText(jsonFromValue("plain"))).toBe("plain");
      expect(decodeDataURIPayloadText(jsonFromValue(null))).toBe(null);
    });

    it("rejects historical bare-JSON payload text", () => {
      expect(() => decodeDataURIPayloadText('{"value":{"x":1}}')).toThrow();
      expect(() => decodeDataURIPayloadText("[1,2,3]")).toThrow();
    });

    it("rejects invalid payload text", () => {
      expect(() => decodeDataURIPayloadText("{nope")).toThrow();
    });

    it("rejects empty payload text", () => {
      expect(() => decodeDataURIPayloadText("")).toThrow();
    });

    it("decodes encoded-`FabricValue` (`fvj1:`) payload text", () => {
      const value = { value: { b: 1, a: [true, null, "x"] } };
      expect(decodeDataURIPayloadText(jsonFromValue(value))).toEqual(value);
    });

    it("rejects invalid payload text past the `fvj1:` tag", () => {
      expect(() => decodeDataURIPayloadText("fvj1:{nope")).toThrow();
    });
  });

  describe("getJSONFromDataURI", () => {
    /** `data:` cell URI (base64url payload) with the given payload text. */
    const uriOf = (payload: string): string =>
      `data:application/vnd.common-fabric.data,${
        encodeBase64Url(new TextEncoder().encode(payload))
      }`;

    it("rejects a URI whose media type is not the data-cell type", () => {
      expect(() => getJSONFromDataURI("data:text/plain,aGVsbG8")).toThrow(
        /Invalid URI/,
      );
    });

    // Exactly one media type is accepted; the historical `application/json`
    // form is not.
    it("rejects the `application/json` media type", () => {
      const payload = encodeBase64Url(
        new TextEncoder().encode(jsonFromValue({ a: 1 })),
      );
      expect(() => getJSONFromDataURI(`data:application/json,${payload}`))
        .toThrow(/Invalid URI/);
    });

    // There are no header parameters in this format; a header carrying any
    // fails the media-type check.
    it("rejects header parameters (charset, base64)", () => {
      const payload = encodeBase64Url(
        new TextEncoder().encode(jsonFromValue({})),
      );
      expect(() =>
        getJSONFromDataURI(
          `data:application/vnd.common-fabric.data;charset=utf-8,${payload}`,
        )
      ).toThrow(/Invalid URI/);
      expect(() =>
        getJSONFromDataURI(
          `data:application/vnd.common-fabric.data;base64,${payload}`,
        )
      ).toThrow(/Invalid URI/);
    });

    it("rejects a URI with no comma", () => {
      expect(() =>
        getJSONFromDataURI("data:application/vnd.common-fabric.data")
      ).toThrow(
        /Invalid data URI format/,
      );
    });

    it("rejects a percent-encoded payload", () => {
      const payload = encodeURIComponent(jsonFromValue({ a: 1 }));
      expect(() =>
        getJSONFromDataURI(
          `data:application/vnd.common-fabric.data,${payload}`,
        )
      ).toThrow(/not base64url/);
    });

    // Both `data:` URI payload readers (this one and attestation `load()`)
    // reject an empty payload uniformly; see `decodeDataURIPayloadText()`.
    it("rejects an empty payload", () => {
      expect(() =>
        getJSONFromDataURI("data:application/vnd.common-fabric.data,")
      ).toThrow();
    });

    describe("historical bare-JSON payloads", () => {
      it("rejects one", () => {
        expect(() => getJSONFromDataURI(uriOf('{"value":{"b":1}}')))
          .toThrow();
      });
    });

    describe("encoded-`FabricValue` (`fvj1:`) payloads", () => {
      it("decodes a payload", () => {
        const value = { value: { b: 1, a: [true, null, "x"] } };
        expect(getJSONFromDataURI(uriOf(jsonFromValue(value)))).toEqual(value);
      });

      it("decodes non-ASCII text", () => {
        const value = { value: "città" };
        expect(getJSONFromDataURI(uriOf(jsonFromValue(value))))
          .toEqual(value);
      });

      it("decodes a non-object payload", () => {
        expect(getJSONFromDataURI(uriOf(jsonFromValue([1, 2, 3]))))
          .toEqual([1, 2, 3]);
        expect(getJSONFromDataURI(uriOf(jsonFromValue("plain"))))
          .toBe("plain");
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

      it("stops the payload at a raw query or fragment delimiter", () => {
        // base64url never contains `?` or `#`; raw ones delimit a
        // query/fragment per the URL grammar.
        const uri = uriOf(jsonFromValue({ a: 1 }));
        expect(getJSONFromDataURI(`${uri}#frag`)).toEqual({ a: 1 });
        expect(getJSONFromDataURI(`${uri}?q=1`)).toEqual({ a: 1 });
      });

      it("rejects a malformed payload past the tag", () => {
        expect(() => getJSONFromDataURI(uriOf("fvj1:{nope"))).toThrow();
      });
    });
  });
});
