import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { jsonFromValue } from "@/codec-json/index.ts";
import {
  DATA_URI_MEDIA_TYPE,
  dataUriFromValue,
  isDataUri,
  isDataUriMediaType,
  valueFromDataUri,
  valueFromDataUriPayloadText,
} from "@/data-uri-codec.ts";

describe("data-uri-codec", () => {
  describe("media-type predicates", () => {
    it("accepts exactly the data-cell media type", () => {
      expect(isDataUriMediaType(DATA_URI_MEDIA_TYPE)).toBe(true);
      expect(isDataUriMediaType("application/json")).toBe(false);
      expect(isDataUriMediaType(`${DATA_URI_MEDIA_TYPE};charset=utf-8`))
        .toBe(false);
    });

    it("recognizes only this codec's `data:` URIs", () => {
      expect(isDataUri(dataUriFromValue({ a: 1 }))).toBe(true);
      expect(isDataUri("data:image/png;base64,aGVsbG8")).toBe(false);
      expect(isDataUri("of:xyz")).toBe(false);
    });
  });

  describe("dataUriFromValue", () => {
    it("mints the data-cell media type and the standard encoding", () => {
      const uri = dataUriFromValue({ x: 1 });
      // Deliberately a literal (not the imported constant): changing the
      // minted media type must be a conscious test change.
      expect(uri.startsWith("data:application/vnd.common-fabric.data,"))
        .toBe(true);
      const payload = new TextDecoder().decode(
        fromBase64url(uri.slice(uri.indexOf(",") + 1)),
      );
      expect(payload.startsWith("fvj1:")).toBe(true);
    });

    // The standard encoding canonicalizes key order, so the minted id is a
    // function of content alone.
    it("mints the same URI regardless of key insertion order", () => {
      const inOrder = { alpha: 1, beta: [2, 3], gamma: { delta: 4 } };
      const scrambled = { gamma: { delta: 4 }, beta: [2, 3], alpha: 1 };
      expect(dataUriFromValue(scrambled)).toBe(dataUriFromValue(inOrder));
    });

    it("round-trips an `undefined` value", () => {
      expect(valueFromDataUri(dataUriFromValue(undefined))).toBeUndefined();
    });

    it("round-trips non-finite numbers and negative zero", () => {
      const parsed = valueFromDataUri(
        dataUriFromValue({ n: NaN, z: -0, i: -Infinity }),
      );
      expect(Object.is(parsed.n, NaN)).toBe(true);
      expect(Object.is(parsed.z, -0)).toBe(true);
      expect(Object.is(parsed.i, -Infinity)).toBe(true);
    });

    // Distinctness is a separate property from round-tripping, and the more
    // important one here: these URIs are content addresses, so two values that
    // are not equal must not mint the same identifier. A codec could round-trip
    // every value faithfully and still collide.
    it("mints distinct URIs for `-0` and `+0`", () => {
      expect(dataUriFromValue(-0)).not.toBe(dataUriFromValue(0));
      expect(dataUriFromValue({ z: -0 })).not.toBe(dataUriFromValue({ z: 0 }));
    });

    it("mints distinct URIs for the two infinities", () => {
      expect(dataUriFromValue(Infinity)).not.toBe(
        dataUriFromValue(-Infinity),
      );
    });

    it("mints distinct URIs for `NaN` and other non-finites", () => {
      expect(dataUriFromValue(NaN)).not.toBe(dataUriFromValue(Infinity));
      expect(dataUriFromValue(NaN)).not.toBe(dataUriFromValue(-Infinity));
    });

    // Arithmetic only ever yields one `NaN` bit pattern, so `NaN` and `0 / 0`
    // are the same value and comparing them proves only determinism. A
    // distinct payload has to be built through a typed-array view, which is
    // also how one reaches a caller in practice.
    it("mints one URI for every `NaN`, whatever its payload", () => {
      const buffer = new ArrayBuffer(8);
      const bytes = new Uint8Array(buffer);
      const doubles = new Float64Array(buffer);
      bytes.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x7f]);
      const payloadNan = doubles[0];

      // Guard the premise: if this ever stops holding, the case below is
      // vacuous and should fail loudly rather than pass for free.
      doubles[0] = 0 / 0;
      expect(Number.isNaN(payloadNan)).toBe(true);
      expect(bytes[0]).not.toBe(0x01);

      expect(dataUriFromValue(payloadNan)).toBe(dataUriFromValue(0 / 0));
      expect(dataUriFromValue({ n: payloadNan })).toBe(
        dataUriFromValue({ n: NaN }),
      );
    });

    it("mints the same URI for repeated `-0`", () => {
      expect(dataUriFromValue(-0)).toBe(dataUriFromValue(-0));
    });
  });

  describe("valueFromDataUriPayloadText", () => {
    it("decodes encoded payload text of every top-level shape", () => {
      expect(valueFromDataUriPayloadText(jsonFromValue({ b: 1, a: [true] })))
        .toEqual({ b: 1, a: [true] });
      expect(valueFromDataUriPayloadText(jsonFromValue([1, 2, 3])))
        .toEqual([1, 2, 3]);
      expect(valueFromDataUriPayloadText(jsonFromValue("plain"))).toBe(
        "plain",
      );
      expect(valueFromDataUriPayloadText(jsonFromValue(null))).toBe(null);
    });

    it("rejects historical bare-JSON payload text", () => {
      expect(() => valueFromDataUriPayloadText('{"value":{"x":1}}')).toThrow();
      expect(() => valueFromDataUriPayloadText("[1,2,3]")).toThrow();
    });

    it("rejects invalid payload text", () => {
      expect(() => valueFromDataUriPayloadText("{nope")).toThrow();
    });

    it("rejects empty payload text", () => {
      expect(() => valueFromDataUriPayloadText("")).toThrow();
    });

    it("decodes encoded-`FabricValue` (`fvj1:`) payload text", () => {
      const value = { value: { b: 1, a: [true, null, "x"] } };
      expect(valueFromDataUriPayloadText(jsonFromValue(value))).toEqual(value);
    });

    it("rejects invalid payload text past the `fvj1:` tag", () => {
      expect(() => valueFromDataUriPayloadText("fvj1:{nope")).toThrow();
    });
  });

  describe("valueFromDataUri", () => {
    /** `data:` cell URI (base64url payload) with the given payload text. */
    const uriOf = (payload: string): string =>
      `data:${DATA_URI_MEDIA_TYPE},${
        toUnpaddedBase64url(new TextEncoder().encode(payload))
      }`;

    it("rejects a URI whose media type is not the data-cell type", () => {
      expect(() => valueFromDataUri("data:text/plain,aGVsbG8")).toThrow(
        /Invalid URI/,
      );
    });

    // Exactly one media type is accepted; the historical `application/json`
    // form is not.
    it("rejects the `application/json` media type", () => {
      const payload = toUnpaddedBase64url(
        new TextEncoder().encode(jsonFromValue({ a: 1 })),
      );
      expect(() => valueFromDataUri(`data:application/json,${payload}`))
        .toThrow(/Invalid URI/);
    });

    // There are no header parameters in this format; a header carrying any
    // fails the media-type check.
    it("rejects header parameters (charset, base64)", () => {
      const payload = toUnpaddedBase64url(
        new TextEncoder().encode(jsonFromValue({})),
      );
      expect(() =>
        valueFromDataUri(
          `data:${DATA_URI_MEDIA_TYPE};charset=utf-8,${payload}`,
        )
      ).toThrow(/Invalid URI/);
      expect(() =>
        valueFromDataUri(
          `data:${DATA_URI_MEDIA_TYPE};base64,${payload}`,
        )
      ).toThrow(/Invalid URI/);
    });

    it("rejects a URI with no comma", () => {
      expect(() => valueFromDataUri(`data:${DATA_URI_MEDIA_TYPE}`))
        .toThrow(
          /Invalid data URI format/,
        );
    });

    it("rejects a percent-encoded payload", () => {
      const payload = encodeURIComponent(jsonFromValue({ a: 1 }));
      expect(() =>
        valueFromDataUri(
          `data:${DATA_URI_MEDIA_TYPE},${payload}`,
        )
      ).toThrow(/not base64url/);
    });

    // Both `data:` URI payload readers (this one and attestation `load()`)
    // reject an empty payload uniformly; see `valueFromDataUriPayloadText()`.
    it("rejects an empty payload", () => {
      expect(() => valueFromDataUri(`data:${DATA_URI_MEDIA_TYPE},`))
        .toThrow();
    });

    describe("historical bare-JSON payloads", () => {
      it("rejects one", () => {
        expect(() => valueFromDataUri(uriOf('{"value":{"b":1}}')))
          .toThrow();
      });
    });

    describe("encoded-`FabricValue` (`fvj1:`) payloads", () => {
      it("decodes a payload", () => {
        const value = { value: { b: 1, a: [true, null, "x"] } };
        expect(valueFromDataUri(uriOf(jsonFromValue(value)))).toEqual(
          value,
        );
      });

      it("decodes non-ASCII text", () => {
        const value = { value: "città" };
        expect(valueFromDataUri(uriOf(jsonFromValue(value))))
          .toEqual(value);
      });

      it("decodes a non-object payload", () => {
        expect(valueFromDataUri(uriOf(jsonFromValue([1, 2, 3]))))
          .toEqual([1, 2, 3]);
        expect(valueFromDataUri(uriOf(jsonFromValue("plain"))))
          .toBe("plain");
      });

      it("preserves non-finite numbers and negative zero", () => {
        const uri = uriOf(jsonFromValue({ value: [NaN, -0, Infinity] }));
        const result = valueFromDataUri(uri);
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
        expect(valueFromDataUri(uriOf(jsonFromValue(value)))).toEqual(
          value,
        );
      });

      it("returns deep-frozen results", () => {
        const uri = uriOf(jsonFromValue({ value: { nested: { deep: [1] } } }));
        const result = valueFromDataUri(uri);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.value)).toBe(true);
        expect(Object.isFrozen(result.value.nested.deep)).toBe(true);
      });

      it("stops the payload at a raw query or fragment delimiter", () => {
        // base64url never contains `?` or `#`; raw ones delimit a
        // query/fragment per the URL grammar.
        const uri = uriOf(jsonFromValue({ a: 1 }));
        expect(valueFromDataUri(`${uri}#frag`)).toEqual({ a: 1 });
        expect(valueFromDataUri(`${uri}?q=1`)).toEqual({ a: 1 });
      });

      it("rejects a malformed payload past the tag", () => {
        expect(() => valueFromDataUri(uriOf("fvj1:{nope"))).toThrow();
      });
    });
  });
});
