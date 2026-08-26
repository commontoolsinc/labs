// An opaque cell (`asCell: ["opaque"]`) is a reference, not a readable view:
// reads that would materialize the value behind it throw, while identity
// operations and the reference-only `getRaw()` default stay available.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("opaque cell read refusal test");
const space = signer.did();

const SCHEMA = {
  type: "object",
  properties: {
    opaque: { type: "number", asCell: ["opaque"] },
    plain: { type: "number" },
  },
  additionalProperties: false,
} as const satisfies JSONSchema;

describe("opaque cell read refusal", () => {
  const mintRoot = (rt: Runtime, t: IExtendedStorageTransaction) =>
    rt.getCell(space, "opaque-cell-read-refusal", SCHEMA, t);
  const mintOpaque = (r: ReturnType<typeof mintRoot>) => r.key("opaque");

  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let root: ReturnType<typeof mintRoot>;
  let opaque: ReturnType<typeof mintOpaque>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    runtime.getCell(space, "opaque-cell-read-refusal", undefined, tx)
      .setRawUntyped({ opaque: 5, plain: 7 });
    root = mintRoot(runtime, tx);
    opaque = mintOpaque(root);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("get()", () => {
    it("throws on an opaque cell", () => {
      expect(() => opaque.get()).toThrow(
        "Cannot read through an opaque cell",
      );
    });

    it("returns the value for a sibling the schema does not mark opaque", () => {
      expect(root.key("plain").get()).toBe(7);
    });
  });

  describe("getRaw()", () => {
    it('returns the stored value under the default `lastNode: "top"`', () => {
      expect(opaque.getRaw()).toBe(5);
    });

    it('throws under `lastNode: "value"`', () => {
      expect(() => opaque.getRaw({ lastNode: "value" })).toThrow(
        "Cannot read through an opaque cell",
      );
    });

    it('throws under `lastNode: "writeRedirect"`', () => {
      expect(() => opaque.getRaw({ lastNode: "writeRedirect" })).toThrow(
        "Cannot read through an opaque cell",
      );
    });
  });

  describe("getAsQueryResult()", () => {
    it("throws on an opaque cell", () => {
      expect(() => opaque.getAsQueryResult()).toThrow(
        "Cannot read through an opaque cell",
      );
    });
  });

  describe("identity operations", () => {
    it("equals() compares two handles to the same location as equal", () => {
      expect(opaque.equals(root.key("opaque"))).toBe(true);
    });

    it("getAsNormalizedFullLink() returns the reference", () => {
      const link = opaque.getAsNormalizedFullLink();
      expect(link.id).toBe(root.getAsNormalizedFullLink().id);
      expect(link.path).toEqual(["opaque"]);
    });
  });
});
