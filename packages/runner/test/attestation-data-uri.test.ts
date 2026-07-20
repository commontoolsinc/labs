import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import { load } from "../src/storage/transaction/attestation.ts";
import type { URI } from "../src/sigil-types.ts";

/** Percent-encoded `data:` URI with the given payload text. */
const uriOf = (payload: string): URI =>
  `data:application/json,${encodeURIComponent(payload)}` as URI;

// `load()` is the storage-transaction-side reader of `data:` URI documents,
// separate from `uri-utils.ts`'s `getJSONFromDataURI()`. Both route payload
// text through `decodeDataURIPayloadText()`, so the two readers cannot
// silently diverge on what a payload means — both accept the standard
// `fvj1:`-tagged `FabricValue` encoding alongside bare JSON.
describe("attestation `load()` of `data:` URIs", () => {
  it("loads a bare-JSON payload", () => {
    const { ok, error } = load({ id: uriOf('{"value":{"x":1}}') });
    expect(error).toBeUndefined();
    expect(ok!.value).toEqual({ value: { x: 1 } });
    expect(ok!.address.path).toEqual([]);
  });

  it("loads an encoded-`FabricValue` (`fvj1:`) payload", () => {
    const value = { value: { b: 1, a: [true, null, "x"] } };
    const { ok, error } = load({ id: uriOf(jsonFromValue(value)) });
    expect(error).toBeUndefined();
    expect(ok!.value).toEqual(value);
  });

  it("preserves non-finite numbers in an `fvj1:` payload", () => {
    const { ok, error } = load({
      id: uriOf(jsonFromValue({ value: [NaN, -0, Infinity] })),
    });
    expect(error).toBeUndefined();
    const items = (ok!.value as { value: number[] }).value;
    expect(Object.is(items[0], NaN)).toBe(true);
    expect(Object.is(items[1], -0)).toBe(true);
    expect(Object.is(items[2], Infinity)).toBe(true);
  });

  it("errors on an undecodable payload", () => {
    const { ok, error } = load({ id: uriOf("{nope") });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("errors on an undecodable payload past the `fvj1:` tag", () => {
    const { ok, error } = load({ id: uriOf("fvj1:{nope") });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("errors on an unsupported media type", () => {
    const { error } = load({ id: "data:text/plain,hello" as URI });
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });
});
