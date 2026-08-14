/**
 * The `data:` URI form of a value: minting one, and reading one back.
 *
 * A minted URI stands in for the value, which pulls two demands against each
 * other. It has to be canonical -- key insertion order cannot show through,
 * and neither can a sort order that differs between UTF-16 and code points --
 * while still telling apart values that ordinary equality would merge. That is
 * where the numeric cases earn their place: `-0` and `+0` mint different URIs,
 * the two infinities differ, and every `NaN` mints the same one whatever
 * payload bits it happened to carry.
 *
 * Reading one back is deliberately strict. The media type must be this
 * codec's, header parameters are refused, a percent-encoded payload is
 * refused, and the payload stops at a raw query or fragment delimiter rather
 * than swallowing it. What comes back is deep-frozen.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import {
  JsonCodecEngine,
  seemsLikeJsonEncodedFabricValue,
} from "@/codec-json/index.ts";
import { jsonFromFabricValue } from "@/codecs.ts";
import {
  DATA_URI_MEDIA_TYPE,
  dataUriFromValue,
  hasDataUriScheme,
  isDataUriMediaType,
  isFabricDataUri,
  valueFromDataUri,
  valueFromDataUriPayloadText,
} from "@/data-uri-codec.ts";

describe("data-uri-codec", () => {
  describe("media-type predicates", () => {
    it("returns `true` only for the data-cell media type", () => {
      expect(isDataUriMediaType(DATA_URI_MEDIA_TYPE)).toBe(true);
      expect(isDataUriMediaType("application/json")).toBe(false);
      expect(isDataUriMediaType(`${DATA_URI_MEDIA_TYPE};charset=utf-8`))
        .toBe(false);
    });

    it("recognizes only this codec's `data:` URIs", () => {
      expect(isFabricDataUri(dataUriFromValue({ a: 1 }))).toBe(true);
      expect(isFabricDataUri("data:image/png;base64,aGVsbG8")).toBe(false);
      expect(isFabricDataUri("of:xyz")).toBe(false);
    });

    it("recognizes a `data:` URI of any media type", () => {
      expect(hasDataUriScheme(dataUriFromValue({ a: 1 }))).toBe(true);
      expect(hasDataUriScheme("data:image/png;base64,aGVsbG8")).toBe(true);
      expect(hasDataUriScheme("data:,")).toBe(true);
      expect(hasDataUriScheme("of:xyz")).toBe(false);
      expect(hasDataUriScheme("computed:fid1:xyz")).toBe(false);
      expect(hasDataUriScheme("")).toBe(false);
      // The scheme has to be at the start and has to end at the colon.
      expect(hasDataUriScheme("user:data:123")).toBe(false);
      expect(hasDataUriScheme("data-user:1")).toBe(false);
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
      expect(seemsLikeJsonEncodedFabricValue(payload)).toBe(true);
    });

    // The payload is base64url of the UTF-8 form of the encoded text. The id
    // is that payload, so however the bytes are arrived at, the answer has to
    // be the one this spells out. The cases cover text that is entirely
    // ASCII, text that is not, and text too long to take any short cut.
    it("mints a payload that is base64url of the encoded text", () => {
      const textEncoder = new TextEncoder();
      const values = [
        { x: 1 },
        { text: "Ñoño 🚀 你好" },
        { long: "y".repeat(8000) },
      ];

      for (const value of values) {
        const uri = dataUriFromValue(value);
        expect(uri.slice(uri.indexOf(",") + 1)).toBe(
          toUnpaddedBase64url(textEncoder.encode(jsonFromFabricValue(value))),
        );
      }
    });

    // The standard encoding canonicalizes key order, so the minted id is a
    // function of content alone.
    it("mints the same URI regardless of key insertion order", () => {
      const inOrder = { alpha: 1, beta: [2, 3], gamma: { delta: 4 } };
      const scrambled = { gamma: { delta: 4 }, beta: [2, 3], alpha: 1 };
      expect(dataUriFromValue(scrambled)).toBe(dataUriFromValue(inOrder));
    });

    // Canonical order is UTF-8 byte order, which differs from the order a
    // plain JavaScript string comparison gives whenever a key carries a
    // surrogate pair.
    it("mints the same URI for keys that a UTF-16 sort would order differently", () => {
      const oneWay = { "￿": 1, "\u{10000}": 2 };
      const other = { "\u{10000}": 2, "￿": 1 };
      expect(dataUriFromValue(other)).toBe(dataUriFromValue(oneWay));
      expect(Object.keys(valueFromDataUri(dataUriFromValue(other)))).toEqual([
        "￿",
        "\u{10000}",
      ]);
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
      expect(
        valueFromDataUriPayloadText(jsonFromFabricValue({ b: 1, a: [true] })),
      )
        .toEqual({ b: 1, a: [true] });
      expect(valueFromDataUriPayloadText(jsonFromFabricValue([1, 2, 3])))
        .toEqual([1, 2, 3]);
      expect(valueFromDataUriPayloadText(jsonFromFabricValue("plain"))).toBe(
        "plain",
      );
      expect(valueFromDataUriPayloadText(jsonFromFabricValue(null))).toBe(null);
    });

    it("throws given historical bare-JSON payload text", () => {
      expect(() => valueFromDataUriPayloadText('{"value":{"x":1}}')).toThrow();
      expect(() => valueFromDataUriPayloadText("[1,2,3]")).toThrow();
    });

    it("throws given invalid payload text", () => {
      expect(() => valueFromDataUriPayloadText("{nope")).toThrow();
    });

    it("throws given empty payload text", () => {
      expect(() => valueFromDataUriPayloadText("")).toThrow();
    });

    it("decodes encoded-`FabricValue` payload text", () => {
      const value = { value: { b: 1, a: [true, null, "x"] } };
      expect(valueFromDataUriPayloadText(jsonFromFabricValue(value))).toEqual(
        value,
      );
    });

    it("throws given invalid payload text past the codec tag", () => {
      expect(() =>
        valueFromDataUriPayloadText(
          JsonCodecEngine.wrapEncodedValueForTesting("{nope", true),
        )
      ).toThrow();
    });
  });

  describe("valueFromDataUri", () => {
    /** `data:` cell URI (base64url payload) with the given payload text. */
    const uriOf = (payload: string): string =>
      `data:${DATA_URI_MEDIA_TYPE},${
        toUnpaddedBase64url(new TextEncoder().encode(payload))
      }`;

    it("throws given a URI whose media type is not the data-cell type", () => {
      expect(() => valueFromDataUri("data:text/plain,aGVsbG8")).toThrow(
        /Invalid URI/,
      );
    });

    // Exactly one media type is accepted; the historical `application/json`
    // form is not.
    it("throws given the `application/json` media type", () => {
      const payload = toUnpaddedBase64url(
        new TextEncoder().encode(jsonFromFabricValue({ a: 1 })),
      );
      expect(() => valueFromDataUri(`data:application/json,${payload}`))
        .toThrow(/Invalid URI/);
    });

    // There are no header parameters in this format; a header carrying any
    // fails the media-type check.
    it("throws given header parameters (charset, base64)", () => {
      const payload = toUnpaddedBase64url(
        new TextEncoder().encode(jsonFromFabricValue({})),
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

    it("throws given a URI with no comma", () => {
      expect(() => valueFromDataUri(`data:${DATA_URI_MEDIA_TYPE}`))
        .toThrow(
          /Invalid data URI format/,
        );
    });

    it("throws given a percent-encoded payload", () => {
      const payload = encodeURIComponent(jsonFromFabricValue({ a: 1 }));
      expect(() =>
        valueFromDataUri(
          `data:${DATA_URI_MEDIA_TYPE},${payload}`,
        )
      ).toThrow(/not base64url/);
    });

    // Both `data:` URI payload readers (this one and attestation `load()`)
    // reject an empty payload uniformly; see `valueFromDataUriPayloadText()`.
    it("throws given an empty payload", () => {
      expect(() => valueFromDataUri(`data:${DATA_URI_MEDIA_TYPE},`))
        .toThrow();
    });

    describe("historical bare-JSON payloads", () => {
      it("throws given one", () => {
        expect(() => valueFromDataUri(uriOf('{"value":{"b":1}}')))
          .toThrow();
      });
    });

    describe("encoded-`FabricValue` payloads", () => {
      it("decodes a payload", () => {
        const value = { value: { b: 1, a: [true, null, "x"] } };
        expect(valueFromDataUri(uriOf(jsonFromFabricValue(value)))).toEqual(
          value,
        );
      });

      it("decodes non-ASCII text", () => {
        const value = { value: "città" };
        expect(valueFromDataUri(uriOf(jsonFromFabricValue(value))))
          .toEqual(value);
      });

      it("decodes a non-object payload", () => {
        expect(valueFromDataUri(uriOf(jsonFromFabricValue([1, 2, 3]))))
          .toEqual([1, 2, 3]);
        expect(valueFromDataUri(uriOf(jsonFromFabricValue("plain"))))
          .toBe("plain");
      });

      it("preserves non-finite numbers and negative zero", () => {
        const uri = uriOf(jsonFromFabricValue({ value: [NaN, -0, Infinity] }));
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
        expect(valueFromDataUri(uriOf(jsonFromFabricValue(value)))).toEqual(
          value,
        );
      });

      it("returns deep-frozen results", () => {
        const uri = uriOf(
          jsonFromFabricValue({ value: { nested: { deep: [1] } } }),
        );
        const result = valueFromDataUri(uri);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.value)).toBe(true);
        expect(Object.isFrozen(result.value.nested.deep)).toBe(true);
      });

      it("stops the payload at a raw query or fragment delimiter", () => {
        // base64url never contains `?` or `#`; raw ones delimit a
        // query/fragment per the URL grammar.
        const uri = uriOf(jsonFromFabricValue({ a: 1 }));
        expect(valueFromDataUri(`${uri}#frag`)).toEqual({ a: 1 });
        expect(valueFromDataUri(`${uri}?q=1`)).toEqual({ a: 1 });
      });

      it("throws given a malformed payload past the tag", () => {
        expect(() =>
          valueFromDataUri(
            uriOf(
              JsonCodecEngine.wrapEncodedValueForTesting("{nope", true),
            ),
          )
        ).toThrow();
      });
    });
  });
});
