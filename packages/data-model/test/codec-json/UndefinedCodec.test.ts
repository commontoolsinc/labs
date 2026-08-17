/**
 * `undefined` on a wire whose nearest neighbor is `null`, and the care that
 * distinction takes.
 *
 * The encoded state is itself `null`, so the codec's whole job is keeping the
 * two apart: it claims `undefined` and refuses `null`, and on the way back a
 * state that is not `null` is treated as a malformed encoding rather than as
 * something to salvage.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { UndefinedCodec } from "@/codec-json/UndefinedCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";

describe("UndefinedCodec", () => {
  const codec = new UndefinedCodec();
  const expectedTag = CODEC_TYPE_TAGS.Undefined;
  const env = NULL_LIVE_ENVIRONMENT;

  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("is the `Undefined` wire type tag", () => {
        expect(codec.recognizedTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("claims `undefined`, rejects `null` (and other values)", () => {
        // `undefined` encodes to the `Undefined@1` tag with `null` state,
        // whereas `null` is a JSON-native value that is not codec-handled.
        expect(codec.canEncode(undefined)).toBe(true);
        expect(codec.canEncode(null)).toBe(false);
        expect(codec.canEncode(0)).toBe(false);
      });
    });

    describe("encode()", () => {
      it("encodes `undefined` to `null` state", () => {
        expect(codec.encode(undefined)).toBe(null);
      });
    });

    describe("decode()", () => {
      it("decodes `null` state back to `undefined`", () => {
        const decoded = codec.decode(expectedTag, null, env);
        expect(decoded).toBe(undefined);
      });

      it("throws when decoding non-`null` state", () => {
        expect(() => codec.decode(expectedTag, 42, env)).toThrow(
          "expected `null` state",
        );
      });
    });

    describe("round trip encode-decode", () => {
      it("round-trips `undefined` via encode -> decode", () => {
        const decoded = codec.decode(
          expectedTag,
          codec.encode(undefined),
          env,
        );
        expect(decoded).toBe(undefined);
      });
    });
  });
});
