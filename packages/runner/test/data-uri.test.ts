import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/utils/base64url";
import {
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { UnknownValue } from "@commonfabric/data-model/fabric-instances";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { dataUriFromValueWithResolvedLinks } from "../src/data-uri.ts";
import { valueFromDataUri } from "@commonfabric/data-model/data-uri-codec";
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

  describe("dataUriFromValueWithResolvedLinks", () => {
    it("should throw on circular data", () => {
      const circular: any = { name: "test" };
      circular.self = circular;

      expect(() => dataUriFromValueWithResolvedLinks(circular)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on nested circular data", () => {
      const obj1: any = { name: "obj1" };
      const obj2: any = { name: "obj2", ref: obj1 };
      obj1.ref = obj2;

      expect(() => dataUriFromValueWithResolvedLinks(obj1)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on circular data in arrays", () => {
      const circular: any = { items: [] };
      circular.items.push(circular);

      expect(() => dataUriFromValueWithResolvedLinks(circular)).toThrow(
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

      const dataURI = dataUriFromValueWithResolvedLinks(
        { link: relativeLink },
        baseCell,
      );

      // Decode the data URI using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

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

      const dataURI = dataUriFromValueWithResolvedLinks(
        { link: relativeLink },
        scopedBaseCell,
      );
      const parsed = valueFromDataUri(dataURI);

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

      const dataURI = dataUriFromValueWithResolvedLinks(data, baseCell);

      // Decode the data URI using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

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

      const dataURI = dataUriFromValueWithResolvedLinks(
        { link: absoluteLink },
        baseCell,
      );

      // Decode the data URI using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

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
      const dataURI = dataUriFromValueWithResolvedLinks(data);

      // Decode and verify using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

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
      const dataURI = dataUriFromValueWithResolvedLinks(data);

      // Decode and verify using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

      expect(parsed.emoji).toBe("🚀 Hello World! 🌍");
      expect(parsed.chinese).toBe("你好世界");
      expect(parsed.arabic).toBe("مرحبا بالعالم");
      expect(parsed.special).toBe("Ñoño™©®");
      expect(parsed.mixed).toBe("Test 🎉 with ñ and 中文");
    });

    it("mints the data-cell media type and the standard encoding", () => {
      const dataURI = dataUriFromValueWithResolvedLinks({ x: 1 });
      // Deliberately a literal (not the imported constant): changing the
      // minted media type must be a conscious test change.
      expect(dataURI.startsWith("data:application/vnd.common-fabric.data,"))
        .toBe(true);
      const payload = new TextDecoder().decode(
        fromBase64url(dataURI.slice(dataURI.indexOf(",") + 1)),
      );
      expect(payload.startsWith("fvj1:")).toBe(true);
    });

    // The standard encoding canonicalizes key order, so the minted id is a
    // function of content alone. This is the property whose absence #4360
    // worked around in `schema-hash.ts`.
    it("mints the same URI regardless of key insertion order", () => {
      const inOrder = { alpha: 1, beta: [2, 3], gamma: { delta: 4 } };
      const scrambled = { gamma: { delta: 4 }, beta: [2, 3], alpha: 1 };
      expect(dataUriFromValueWithResolvedLinks(scrambled)).toBe(
        dataUriFromValueWithResolvedLinks(inOrder),
      );
    });

    it("preserves non-finite numbers and negative zero", () => {
      const dataURI = dataUriFromValueWithResolvedLinks({
        n: NaN,
        z: -0,
        i: -Infinity,
      });
      const parsed = valueFromDataUri(dataURI);
      expect(Object.is(parsed.n, NaN)).toBe(true);
      expect(Object.is(parsed.z, -0)).toBe(true);
      expect(Object.is(parsed.i, -Infinity)).toBe(true);
    });

    // `undefined` is a `FabricValue` and round-trips as itself; the
    // present-`undefined` document property is the reader's synthesis
    // (see attestation `load()`), not part of the payload.
    it("round-trips an `undefined` value", () => {
      expect(valueFromDataUri(dataUriFromValueWithResolvedLinks(undefined)))
        .toBeUndefined();
    });

    it("represents a `FabricPrimitive` leaf correctly", () => {
      const h = hashOf({ some: "value" });
      const parsed = valueFromDataUri(dataUriFromValueWithResolvedLinks({ h }));
      expect(parsed.h).toBeInstanceOf(FabricHash);
      expect(parsed.h.toString()).toBe(h.toString());
    });

    // Link-free content on purpose: for an instance whose state carries no
    // links, today's pass-through and the eventual traverse-into-state
    // behavior (see the `TODO` in the walk) coincide, so this pins only the
    // codec round-trip, not the pass-through itself.
    it("represents a link-free `FabricInstance` via its codec", () => {
      const inst = new UnknownValue("zzz@1", { a: 1 });
      const parsed = valueFromDataUri(
        dataUriFromValueWithResolvedLinks({ inst }),
      );
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

        const dataURI = dataUriFromValueWithResolvedLinks(
          { link: relativeLink },
          base,
        );
        const parsed = valueFromDataUri(dataURI);

        expect(isSigilLink(parsed.link)).toBe(true);
        const payload = linkRefPayload(parsed.link) as any;
        expect(payload.id).toBe(baseId);
        expect(payload.path).toEqual(["nested", "value"]);
      } finally {
        resetModernCellRepConfig();
      }
    });
  });
});
