import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { DATA_CELL_MEDIA_TYPE } from "../src/data-uri.ts";
import { load } from "../src/storage/transaction/attestation.ts";
import type { URI } from "../src/sigil-types.ts";

/** `data:` cell URI (base64url payload) with the given payload text. */
const uriOf = (payload: string): URI =>
  `data:${DATA_CELL_MEDIA_TYPE},${
    toUnpaddedBase64url(new TextEncoder().encode(payload))
  }` as URI;

// `load()` is the storage-transaction-side reader of `data:` URI documents,
// separate from `data-uri.ts`'s `getJSONFromDataURI()`. Both route payload
// text through `decodeDataURIPayloadText()`, so the two readers cannot
// silently diverge on what a payload means.
describe("attestation `load()` of `data:` URIs", () => {
  it("errors on a historical bare-JSON payload", () => {
    const { ok, error } = load({ id: uriOf('{"value":{"x":1}}') });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("synthesizes the document around the decoded value", () => {
    const { ok, error } = load({ id: uriOf(jsonFromValue({ x: 1 })) });
    expect(error).toBeUndefined();
    expect(ok!.value).toEqual({ value: { x: 1 } });
    expect(ok!.address.path).toEqual([]);
    expect(Object.isFrozen(ok!.value)).toBe(true);
  });

  it("loads an encoded-`FabricValue` (`fvj1:`) payload", () => {
    const value = { b: 1, a: [true, null, "x"] };
    const { ok, error } = load({ id: uriOf(jsonFromValue(value)) });
    expect(error).toBeUndefined();
    expect(ok!.value).toEqual({ value });
  });

  it("preserves non-finite numbers in an `fvj1:` payload", () => {
    const { ok, error } = load({
      id: uriOf(jsonFromValue([NaN, -0, Infinity])),
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

  it("rejects the `application/json` media type", () => {
    const { ok, error } = load({
      id: `data:application/json,${
        toUnpaddedBase64url(new TextEncoder().encode(jsonFromValue({ a: 1 })))
      }` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });

  it("errors on an empty payload", () => {
    const { ok, error } = load({
      id: `data:${DATA_CELL_MEDIA_TYPE},` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("errors on an unsupported media type", () => {
    const { error } = load({ id: "data:text/plain,hello" as URI });
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });

  // A parameterized header passes the prefix pre-gate but is not the exact
  // media type (this format has no parameters).
  it("errors on a parameterized header", () => {
    const payload = toUnpaddedBase64url(
      new TextEncoder().encode(jsonFromValue({ a: 1 })),
    );
    const { ok, error } = load({
      id: `data:${DATA_CELL_MEDIA_TYPE};base64,${payload}` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });

  // Extraction-level failure (as opposed to payload-decode failure): a
  // percent-encoded payload is not base64url.
  it("errors on a percent-encoded payload", () => {
    const { ok, error } = load({
      id: `data:${DATA_CELL_MEDIA_TYPE},${
        encodeURIComponent(jsonFromValue({ a: 1 }))
      }` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });
});
