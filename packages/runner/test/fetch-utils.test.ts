import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";
import {
  computeInputHashFromValue,
  legacyFetchResultMarker,
  selectUnavailableFetchInput,
} from "../src/builtins/fetch-utils.ts";

describe("computeInputHashFromValue", () => {
  it("drops the top-level `result` type-hint field", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({
      url: "x",
      mode: "json",
      result: "ignored type hint",
    });
    expect(a).toBe(b);
  });

  it("treats omitted vs `undefined` top-level properties identically", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({
      url: "x",
      mode: "json",
      options: undefined,
    });
    expect(a).toBe(b);
  });

  it("treats omitted vs `undefined` nested properties identically", () => {
    const a = computeInputHashFromValue({
      url: "x",
      options: { method: "GET" },
    });
    const b = computeInputHashFromValue({
      url: "x",
      options: { method: "GET", body: undefined },
    });
    expect(a).toBe(b);
  });

  it("distinguishes inputs that differ in non-`undefined` content", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({ url: "y", mode: "json" });
    expect(a).not.toBe(b);
  });

  it("treats `undefined` inputs as the empty object", () => {
    const a = computeInputHashFromValue(undefined);
    const b = computeInputHashFromValue({});
    expect(a).toBe(b);
  });
});

describe("selectUnavailableFetchInput", () => {
  it("uses reason precedence then serialized argument order", () => {
    const firstError = DataUnavailable.error(new Error("first"));
    const secondError = DataUnavailable.error(new Error("second"));
    const pending = DataUnavailable.pending();
    const syncing = DataUnavailable.syncing();
    const schemaMismatch = DataUnavailable.schemaMismatch();

    expect(selectUnavailableFetchInput({
      pending,
      secondError,
      firstError,
      syncing,
      schemaMismatch,
    })).toBe(secondError);
    expect(selectUnavailableFetchInput({
      schemaMismatch,
      syncing,
      pending,
    })).toBe(pending);
    expect(selectUnavailableFetchInput({
      schemaMismatch,
      syncing,
    })).toBe(syncing);
    expect(selectUnavailableFetchInput({ schemaMismatch })).toBe(
      schemaMismatch,
    );
  });

  it("ignores structural lookalikes", () => {
    expect(selectUnavailableFetchInput({
      url: { reason: "pending", pending: true },
    })).toBeUndefined();
  });

  it("ignores only the top-level result type hint", () => {
    const marker = DataUnavailable.pending();
    expect(selectUnavailableFetchInput({
      url: "/data",
      result: marker,
    })).toBeUndefined();
    expect(selectUnavailableFetchInput({
      url: "/data",
      options: { result: marker },
    })).toBe(marker);
  });
});

describe("legacyFetchResultMarker", () => {
  it("repairs persisted pre-cutover terminal and pending states", () => {
    const error = legacyFetchResultMarker(
      undefined,
      true,
      { message: "legacy failure" },
    );
    expect(error?.reason).toBe("error");
    expect(error?.error?.message).toBe("legacy failure");

    expect(legacyFetchResultMarker(undefined, true, undefined)).toBe(
      DataUnavailable.pending(),
    );
    expect(legacyFetchResultMarker(undefined, false, undefined))
      .toBeUndefined();
  });

  it("preserves native errors when repairing persisted terminal state", () => {
    const native = new TypeError("legacy native failure");
    const repaired = legacyFetchResultMarker(undefined, false, native);

    expect(repaired?.reason).toBe("error");
    expect(repaired?.error?.type).toBe("TypeError");
    expect(repaired?.error?.message).toBe("legacy native failure");
  });

  it("never replaces a current usable value or marker", () => {
    expect(legacyFetchResultMarker("usable", true, new Error("old")))
      .toBeUndefined();
    expect(
      legacyFetchResultMarker(
        DataUnavailable.schemaMismatch(),
        true,
        new Error("old"),
      ),
    ).toBeUndefined();
  });
});
