import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { createDefaultRegistry } from "@/codec-json/createDefaultRegistry.ts";
import { jsonFromValue, valueFromJson } from "@/codec-json/index.ts";
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";
import {
  DataUnavailable,
  hasError,
  hasSchemaMismatch,
  isDataUnavailable,
  isPending,
  isSyncing,
} from "@/fabric-instances/DataUnavailable.ts";
import {
  DataUnavailable as ForeignDataUnavailable,
} from "@/fabric-instances/DataUnavailable.ts?foreign-copy";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { FabricInstance } from "@/interface.ts";
import { shallowFabricFromNativeValue } from "@/native-conversion.ts";
import { cloneIfNecessary } from "@/value-clone.ts";
import { valueEqual } from "@/valueEqual.ts";
import { hashStringOf } from "@/value-hash.ts";

describe("DataUnavailable", () => {
  it("is one concrete FabricInstance with four discriminated reasons", () => {
    const values = [
      DataUnavailable.pending(),
      DataUnavailable.error(new Error("boom")),
      DataUnavailable.syncing(),
      DataUnavailable.schemaMismatch(),
    ];

    expect(values.map((value) => value.reason)).toEqual([
      "pending",
      "error",
      "syncing",
      "schema-mismatch",
    ]);
    for (const value of values) {
      expect(value).toBeInstanceOf(DataUnavailable);
      expect(value instanceof FabricInstance).toBe(true);
      expect(Object.isFrozen(value)).toBe(true);
      expect(isDeepFrozen(value)).toBe(true);
    }
  });

  it("interns the three non-error variants", () => {
    expect(DataUnavailable.pending()).toBe(DataUnavailable.pending());
    expect(DataUnavailable.syncing()).toBe(DataUnavailable.syncing());
    expect(DataUnavailable.schemaMismatch()).toBe(
      DataUnavailable.schemaMismatch(),
    );
  });

  it("creates distinct error variants with a deeply frozen FabricError", () => {
    const native = new TypeError("bad input", {
      cause: { field: "title" },
    });
    Object.assign(native, { status: 422 });

    const first = DataUnavailable.error(native);
    const second = DataUnavailable.error(native);

    expect(first).not.toBe(second);
    expect(first.error).toBeInstanceOf(FabricError);
    expect(first.error?.type).toBe("TypeError");
    expect(first.error?.message).toBe("bad input");
    expect(first.error?.cause).toEqual({ field: "title" });
    expect(first.error?.getExtra("status")).toBe(422);
    expect(isDeepFrozen(first.error)).toBe(true);
  });

  it("preserves the identity of an existing valid FabricError", () => {
    const error = new FabricError({
      type: "Error",
      message: "already fabric",
      stack: undefined,
      cause: { detail: "kept" },
    });

    const unavailable = DataUnavailable.error(error);

    expect(unavailable.error).toBe(error);
    expect(isDeepFrozen(error)).toBe(true);
  });

  it("normalizes error objects minted by a tamed SES realm", () => {
    class Error4 {
      readonly name = "Error";
      readonly message = "sandbox failed";
      readonly stack = "Error: sandbox failed\n    at sandbox.ts:1:1";
      readonly cause = { operation: "wish" };
    }

    const unavailable = DataUnavailable.error(new Error4() as Error);

    expect(unavailable.error).toBeInstanceOf(FabricError);
    expect(unavailable.error?.type).toBe("Error4");
    expect(unavailable.error?.name).toBe("Error");
    expect(unavailable.error?.message).toBe("sandbox failed");
    expect(unavailable.error?.cause).toEqual({ operation: "wish" });
    expect(isDeepFrozen(unavailable.error)).toBe(true);
  });

  it("rejects values which are not native or Fabric errors", () => {
    expect(() => DataUnavailable.error("not an error" as never)).toThrow(
      "DataUnavailable.error() requires an Error",
    );
  });

  it("fails closed if native error conversion violates its contract", () => {
    const originalFromNativeError = FabricError.fromNativeError;
    let conversionAttempted = false;
    FabricError.fromNativeError = () => {
      conversionAttempted = true;
      return "not a FabricError" as unknown as FabricError;
    };

    try {
      expect(() => DataUnavailable.error(new Error("bad conversion"))).toThrow(
        "DataUnavailable.error() requires an Error",
      );
      expect(conversionAttempted).toBe(true);
    } finally {
      FabricError.fromNativeError = originalFromNativeError;
    }
  });

  it("projects ergonomic boolean fields from reason", () => {
    expect(DataUnavailable.pending()).toMatchObject({
      reason: "pending",
      pending: true,
    });
    expect(DataUnavailable.syncing()).toMatchObject({
      reason: "syncing",
      syncing: true,
    });
    expect(DataUnavailable.schemaMismatch()).toMatchObject({
      reason: "schema-mismatch",
      schemaMismatch: true,
    });
    expect(DataUnavailable.pending().syncing).toBeUndefined();
    expect(DataUnavailable.pending().error).toBeUndefined();
  });

  it("guards require the concrete brand and the matching reason", () => {
    const pending = DataUnavailable.pending();
    const error = DataUnavailable.error(new Error("nope"));
    const syncing = DataUnavailable.syncing();
    const mismatch = DataUnavailable.schemaMismatch();

    expect(isDataUnavailable(pending)).toBe(true);
    expect(isPending(pending)).toBe(true);
    expect(hasError(error)).toBe(true);
    expect(isSyncing(syncing)).toBe(true);
    expect(hasSchemaMismatch(mismatch)).toBe(true);

    expect(hasError(pending)).toBe(false);
    expect(isPending(error)).toBe(false);
    expect(isDataUnavailable({ reason: "pending", pending: true })).toBe(false);
    expect(isPending({ reason: "pending", pending: true })).toBe(false);
    expect(hasError({ reason: "error", error: new Error("forged") })).toBe(
      false,
    );
  });

  it("recognizes a concrete marker from a duplicate module instance", () => {
    const foreignPending = ForeignDataUnavailable.pending();

    expect(foreignPending).toBeInstanceOf(DataUnavailable);
    expect(foreignPending).toBeInstanceOf(ForeignDataUnavailable);
    expect(ForeignDataUnavailable[CODEC]).toBe(DataUnavailable[CODEC]);
    expect(isDataUnavailable(foreignPending)).toBe(true);
    expect(isPending(foreignPending)).toBe(true);
    expect(hasError(foreignPending)).toBe(false);
  });

  it("recognizes a marker whose FabricInstance base came from another bundle", () => {
    const foreignPending = new DataUnavailable({ reason: "pending" });
    class ForeignDataUnavailable {}
    Object.setPrototypeOf(
      foreignPending,
      ForeignDataUnavailable.prototype,
    );
    Object.freeze(foreignPending);

    expect(foreignPending instanceof FabricInstance).toBe(false);
    expect(isDataUnavailable(foreignPending)).toBe(true);
    expect(shallowFabricFromNativeValue(foreignPending)).toBe(foreignPending);
  });

  it("does not expose mutable same-realm brand registration", () => {
    const forged = { reason: "pending", pending: true };
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    const exposedRegistry = host[
      Symbol.for("common.fabric.DataUnavailable.instances")
    ] as WeakSet<object> | undefined;

    exposedRegistry?.add(forged);
    Object.setPrototypeOf(forged, DataUnavailable.prototype);

    expect(isDataUnavailable(forged)).toBe(false);
  });

  describe("clone and value protocols", () => {
    it("returns an already-frozen marker for a frozen clone", () => {
      const pending = DataUnavailable.pending();
      expect(pending.deepClone(true)).toBe(pending);
      expect(pending.shallowClone(true)).toBe(pending);
    });

    it("can make an unfrozen protocol clone without changing the singleton", () => {
      const pending = DataUnavailable.pending();
      const clone = pending.deepClone(false);

      expect(clone).not.toBe(pending);
      expect(clone.reason).toBe("pending");
      expect(Object.isFrozen(clone)).toBe(false);
      expect(Object.isFrozen(pending)).toBe(true);
      expect(clone.deepClone(true)).toBe(pending);
    });

    it("uses the instance protocols for fresh unavailable values", () => {
      const pending = new DataUnavailable({ reason: "pending" });
      const shallow = pending.shallowClone(false) as DataUnavailable;

      expect(shallow).not.toBe(pending);
      expect(shallow.reason).toBe("pending");
      expect(Object.isFrozen(shallow)).toBe(false);

      const frozenWithMutableState = Object.freeze(pending);
      expect(isDeepFrozen(frozenWithMutableState)).toBe(false);

      const deeplyFrozen = Object.freeze(
        new DataUnavailable(Object.freeze({ reason: "pending" })),
      );
      expect(isDeepFrozen(deeplyFrozen)).toBe(true);
    });

    it("canonicalizes fresh non-error variants when cloning frozen", () => {
      expect(
        new DataUnavailable({ reason: "syncing" }).deepClone(true),
      ).toBe(DataUnavailable.syncing());
      expect(
        new DataUnavailable({ reason: "schema-mismatch" }).deepClone(true),
      ).toBe(DataUnavailable.schemaMismatch());
    });

    it("deep-clones the nested FabricError", () => {
      const original = DataUnavailable.error(new Error("clone me"));
      const clone = original.deepClone(false);

      expect(clone).not.toBe(original);
      expect(clone.error).not.toBe(original.error);
      expect(clone.error?.message).toBe("clone me");
      expect(Object.isFrozen(clone)).toBe(false);
      expect(Object.isFrozen(clone.error)).toBe(false);
    });

    it("uses generic clone, equality, and hash dispatch", () => {
      const original = DataUnavailable.error(new Error("stable"));
      const clone = cloneIfNecessary(original, {
        frozen: false,
      });

      expect(clone).toBeInstanceOf(DataUnavailable);
      expect(valueEqual(original, deepFreeze(clone))).toBe(true);
      expect(hashStringOf(original)).toBe(hashStringOf(clone));
      expect(hashStringOf(DataUnavailable.pending())).not.toBe(
        hashStringOf(DataUnavailable.syncing()),
      );
    });
  });

  describe("codec", () => {
    const codec = DataUnavailable[CODEC];

    it("uses DataUnavailable@1 and is in the default registry", () => {
      expect(codec.recognizedTypeTag).toBe(CODEC_TYPE_TAGS.DataUnavailable);
      expect(
        createDefaultRegistry().codecFromTag(
          CODEC_TYPE_TAGS.DataUnavailable,
        ),
      ).toBe(codec);
    });

    it("encodes the exact reason-discriminated state", () => {
      expect(codec.encode(DataUnavailable.pending())).toEqual({
        reason: "pending",
      });
      const error = DataUnavailable.error(new Error("encoded"));
      expect(codec.encode(error)).toEqual({
        reason: "error",
        error: error.error,
      });
      expect(codec.encode(DataUnavailable.syncing())).toEqual({
        reason: "syncing",
      });
      expect(codec.encode(DataUnavailable.schemaMismatch())).toEqual({
        reason: "schema-mismatch",
      });
    });

    it("round-trips all four reasons through the default JSON codec", () => {
      const inputs = [
        DataUnavailable.pending(),
        DataUnavailable.error(new Error("round trip")),
        DataUnavailable.syncing(),
        DataUnavailable.schemaMismatch(),
      ];

      for (const input of inputs) {
        const output = valueFromJson(jsonFromValue(input));
        expect(output).toBeInstanceOf(DataUnavailable);
        expect((output as DataUnavailable).reason).toBe(input.reason);
        expect(valueEqual(output, input)).toBe(true);
      }
    });

    it("preserves FabricError state through JSON", () => {
      const native = new RangeError("out of range", {
        cause: { minimum: 1 },
      });
      Object.assign(native, { code: "E_RANGE" });
      const output = valueFromJson(
        jsonFromValue(DataUnavailable.error(native)),
      ) as DataUnavailable;

      expect(output.error).toBeInstanceOf(FabricError);
      expect(output.error?.type).toBe("RangeError");
      expect(output.error?.name).toBe("RangeError");
      expect(output.error?.message).toBe("out of range");
      expect(output.error?.stack).toContain("RangeError: out of range");
      expect(output.error?.cause).toEqual({ minimum: 1 });
      expect(output.error?.getExtra("code")).toBe("E_RANGE");
    });

    it("returns ProblematicValue for malformed or inexact state", () => {
      const invalidStates = [
        null,
        {},
        { reason: "unknown" },
        { reason: "error" },
        { reason: "error", error: "not an error" },
        {
          reason: "pending",
          error: new FabricError({
            type: "Error",
            message: "extra",
            stack: undefined,
            cause: undefined,
          }),
        },
        { reason: "syncing", extra: true },
      ];

      for (const state of invalidStates) {
        const decoded = codec.decode(
          CODEC_TYPE_TAGS.DataUnavailable,
          state as never,
          EMPTY_RECONSTRUCTION_CONTEXT,
        );
        expect(decoded).toBeInstanceOf(ProblematicValue);
      }
    });

    it("uses the normal unknown-value path for a future wire version", () => {
      const decoded = valueFromJson(
        'fvj1:{"/DataUnavailable@2":{"reason":"pending"}}',
      );

      expect(decoded).toBeInstanceOf(UnknownValue);
      expect((decoded as UnknownValue).wireTypeTag).toBe(
        "DataUnavailable@2",
      );
      expect((decoded as UnknownValue).state).toEqual({ reason: "pending" });
    });
  });
});
