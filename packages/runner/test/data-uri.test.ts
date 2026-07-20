import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
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

      expect(parsed.value.link["/"][LINK_V1_TAG].path).toEqual([
        "nested",
        "value",
      ]);
      expect(parsed.value.link["/"][LINK_V1_TAG].id).toBe(baseId);
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

      expect(parsed.value.link["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.value.link["/"][LINK_V1_TAG].scope).toBe("session");
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

      expect(parsed.value.items[0]["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.value.items[1].nested.link["/"][LINK_V1_TAG].id).toBe(
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
      expect(parsed.value.link["/"][LINK_V1_TAG].id).toBe(otherId);
      expect(parsed.value.link["/"][LINK_V1_TAG].path).toEqual([
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

      expect(parsed.value.first.value).toBe(42);
      expect(parsed.value.second.value).toBe(42);
      expect(parsed.value.nested.third.value).toBe(42);
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

      expect(parsed.value.emoji).toBe("🚀 Hello World! 🌍");
      expect(parsed.value.chinese).toBe("你好世界");
      expect(parsed.value.arabic).toBe("مرحبا بالعالم");
      expect(parsed.value.special).toBe("Ñoño™©®");
      expect(parsed.value.mixed).toBe("Test 🎉 with ñ and 中文");
    });

    it("mints a payload in the standard encoding (`fvj1:` tag)", () => {
      const dataURI = createDataCellURI({ x: 1 });
      const payload = decodeURIComponent(
        dataURI.slice(dataURI.indexOf(",") + 1),
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
      expect(Object.is(parsed.value.n, NaN)).toBe(true);
      expect(Object.is(parsed.value.z, -0)).toBe(true);
      expect(Object.is(parsed.value.i, -Infinity)).toBe(true);
    });

    it("encodes an `undefined` value as an empty document", () => {
      const parsed = getJSONFromDataURI(createDataCellURI(undefined));
      expect(parsed).toEqual({});
      expect("value" in parsed).toBe(false);
    });

    it("represents a `FabricPrimitive` leaf correctly", () => {
      const h = hashOf({ some: "value" });
      const parsed = getJSONFromDataURI(createDataCellURI({ h }));
      expect(parsed.value.h).toBeInstanceOf(FabricHash);
      expect(parsed.value.h.toString()).toBe(h.toString());
    });

    // Link-free content on purpose: for an instance whose state carries no
    // links, today's pass-through and the eventual traverse-into-state
    // behavior (see the `TODO` in the walk) coincide, so this pins only the
    // codec round-trip, not the pass-through itself.
    it("represents a link-free `FabricInstance` via its codec", () => {
      const inst = new UnknownValue("zzz@1", { a: 1 });
      const parsed = getJSONFromDataURI(createDataCellURI({ inst }));
      expect(parsed.value.inst).toBeInstanceOf(UnknownValue);
      expect(parsed.value.inst.wireTypeTag).toBe("zzz@1");
      expect(parsed.value.inst.state).toEqual({ a: 1 });
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

        expect(isSigilLink(parsed.value.link)).toBe(true);
        const payload = linkRefPayload(parsed.value.link) as any;
        expect(payload.id).toBe(baseId);
        expect(payload.path).toEqual(["nested", "value"]);
      } finally {
        resetModernCellRepConfig();
      }
    });
  });

  describe("decodeDataURIPayloadText", () => {
    it("decodes JSON payload text", () => {
      expect(decodeDataURIPayloadText('{"value":{"b":1,"a":[true,null]}}'))
        .toEqual({ value: { b: 1, a: [true, null] } });
      expect(decodeDataURIPayloadText("[1,2,3]")).toEqual([1, 2, 3]);
      expect(decodeDataURIPayloadText('"plain"')).toBe("plain");
      expect(decodeDataURIPayloadText("null")).toBe(null);
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
      expect(() =>
        getJSONFromDataURI("data:application/json;charset=latin1,{}")
      ).toThrow(/Unsupported charset/);
    });

    it("accepts an explicit UTF-8 charset", () => {
      expect(getJSONFromDataURI("data:application/json;charset=utf-8,{}"))
        .toEqual({});
    });

    // Both `data:` URI payload readers (this one and attestation `load()`)
    // reject an empty payload uniformly; see `decodeDataURIPayloadText()`.
    it("rejects an empty payload", () => {
      expect(() => getJSONFromDataURI("data:application/json,")).toThrow();
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
});
