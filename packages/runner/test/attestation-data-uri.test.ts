import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { load } from "../src/storage/transaction/attestation.ts";
import type { URI } from "../src/sigil-types.ts";

/** Percent-encoded `data:` URI with the given payload text. */
const uriOf = (payload: string): URI =>
  `data:application/json,${encodeURIComponent(payload)}` as URI;

// `load()` is the storage-transaction-side reader of `data:` URI documents,
// separate from `uri-utils.ts`'s `getJSONFromDataURI()`. Both route payload
// text through `decodeDataURIPayloadText()`, so the two readers cannot
// silently diverge on what a payload means.
describe("attestation `load()` of `data:` URIs", () => {
  it("loads a bare-JSON payload", () => {
    const { ok, error } = load({ id: uriOf('{"value":{"x":1}}') });
    expect(error).toBeUndefined();
    expect(ok!.value).toEqual({ value: { x: 1 } });
    expect(ok!.address.path).toEqual([]);
  });

  it("errors on an undecodable payload", () => {
    const { ok, error } = load({ id: uriOf("{nope") });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("errors on an unsupported media type", () => {
    const { error } = load({ id: "data:text/plain,hello" as URI });
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });
});
