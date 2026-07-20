import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createDataCellURI, getJSONFromDataURI } from "../src/data-uri.ts";
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
  });

  describe("getJSONFromDataURI", () => {
    // Both `data:` URI payload readers (this one and attestation `load()`)
    // reject an empty payload uniformly; see `decodeDataURIPayloadText()`.
    it("rejects an empty payload", () => {
      expect(() => getJSONFromDataURI("data:application/json,")).toThrow();
    });
  });
});
