import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";

import {
  dataUnavailableFromTransformFailure,
  preferDataUnavailable,
  selectDataUnavailable,
} from "../src/data-unavailability.ts";

describe("data-unavailability selection helpers", () => {
  it("ignores available candidates and preserves the current marker", () => {
    const current = DataUnavailable.pending();

    expect(preferDataUnavailable(undefined, "available")).toBeUndefined();
    expect(preferDataUnavailable(current, { pending: true })).toBe(current);
  });

  it("converts link traversal failures into concrete control values", () => {
    const syncing = dataUnavailableFromTransformFailure({
      unavailableReason: "syncing",
    });
    expect(syncing?.reason).toBe("syncing");

    const original = new Error("replica failed");
    const failed = dataUnavailableFromTransformFailure({
      unavailableReason: "error",
      unavailableError: original,
    });
    expect(failed?.reason).toBe("error");
    expect(failed?.error?.message).toBe("replica failed");

    const failedWithoutCause = dataUnavailableFromTransformFailure({
      unavailableReason: "error",
    });
    expect(failedWithoutCause?.reason).toBe("error");
    expect(failedWithoutCause?.error?.message).toBe(
      "Linked document synchronization failed",
    );

    expect(dataUnavailableFromTransformFailure({})).toBeUndefined();
  });

  it("walks materialized containers without mistaking lookalikes for markers", () => {
    const firstError = DataUnavailable.error(new Error("first"));
    const laterError = DataUnavailable.error(new Error("later"));
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray, DataUnavailable.syncing());
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    cyclicObject.value = DataUnavailable.pending();

    const selected = selectDataUnavailable({
      lookalike: { reason: "error", error: new Error("ordinary data") },
      cyclicArray,
      cyclicObject,
      firstError,
      laterError,
    });

    expect(selected).toBe(firstError);
    expect(selectDataUnavailable(new Date())).toBeUndefined();
    expect(selectDataUnavailable("available")).toBeUndefined();
  });
});
