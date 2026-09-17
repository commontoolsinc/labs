/**
 * The unavailable-data marker as a `FabricPrimitive`: a reason, a message
 * that belongs with exactly one of the reasons, and one prefab instance for
 * each of the other three.
 *
 * The pairing of message and reason is what most of this checks, on the
 * constructor and on each codec's decoding: a state carrying a message the
 * reason does not take, or lacking the one it requires, is a state this class
 * never writes, and is reported as a `ProblematicValue` rather than built.
 * The prefabs are checked by identity where a decode is meant to yield one,
 * and by content where equality is the question.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { UnavailableReason } from "@/api.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";
import { JSON_CODEC, REALM_CODEC } from "@/codec-interface/interface.ts";
import { valueEqual } from "@/comparison";
import {
  FabricUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_REASONS,
  UNAVAILABLE_SCHEMA_MISMATCH,
  UNAVAILABLE_SYNCING,
} from "@/fabric-primitives/FabricUnavailable.ts";
import { shallowFabricFromConvertibleJsValue } from "@/index.ts";
import { FabricInstance, FabricPrimitive } from "@/interface.ts";

/**
 * One instance per reason, each built afresh, keyed by reason. The
 * `satisfies` closes the set: a reason added to the type without a row here
 * stops this file compiling.
 */
function instancesByReason(): Record<UnavailableReason, FabricUnavailable> {
  return {
    pending: new FabricUnavailable("pending"),
    syncing: new FabricUnavailable("syncing"),
    schemaMismatch: new FabricUnavailable("schemaMismatch"),
    error: new FabricUnavailable("error", "boom"),
  } satisfies Record<UnavailableReason, FabricUnavailable>;
}

/** The prefab for each reason that has one. */
const PREFABS = {
  pending: UNAVAILABLE_PENDING,
  syncing: UNAVAILABLE_SYNCING,
  schemaMismatch: UNAVAILABLE_SCHEMA_MISMATCH,
} satisfies Partial<Record<UnavailableReason, FabricUnavailable>>;

describe("FabricUnavailable", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).

  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricUnavailable("pending") instanceof FabricPrimitive)
      .toBe(true);
  });

  it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
    expect(new FabricUnavailable("pending") instanceof FabricInstance)
      .toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricUnavailable("syncing"))).toBe(true);
    });

    it("defaults `errorMessage` to `null`", () => {
      expect(new FabricUnavailable("pending").errorMessage).toBe(null);
    });

    it("accepts an explicit `null` message for a reason other than `error`", () => {
      expect(new FabricUnavailable("syncing", null).errorMessage).toBe(null);
    });

    it("throws given a reason outside the set", () => {
      expect(() =>
        new FabricUnavailable("gone" as unknown as UnavailableReason)
      ).toThrow(/Not an `UnavailableReason`: `gone`/);
    });

    it("throws given a reason that is not a string", () => {
      expect(() => new FabricUnavailable(1 as unknown as UnavailableReason))
        .toThrow(/Not an `UnavailableReason`/);
    });

    it("throws given a non-string reason that coerces to a valid one", () => {
      // An array or an object with a `toString()` reads as a key when looked
      // up in the table, so the table lookup alone would admit it.
      expect(() =>
        new FabricUnavailable(["pending"] as unknown as UnavailableReason)
      ).toThrow(/Not an `UnavailableReason`: `pending`/);
    });

    it("throws given reason `error` and no message", () => {
      expect(() => new FabricUnavailable("error"))
        .toThrow(/requires an `errorMessage`/);
      expect(() => new FabricUnavailable("error", null))
        .toThrow(/requires an `errorMessage`/);
    });

    it("throws given a message with a reason other than `error`", () => {
      for (const reason of ["pending", "syncing", "schemaMismatch"] as const) {
        expect(() => new FabricUnavailable(reason, "boom"))
          .toThrow(/does not take an `errorMessage`/);
      }
    });
  });

  describe("instance members", () => {
    describe(".reason", () => {
      it("is the reason given at construction", () => {
        for (const [reason, instance] of Object.entries(instancesByReason())) {
          expect(instance.reason).toBe(reason);
        }
      });
    });

    describe(".errorMessage", () => {
      it("is the message given with reason `error`", () => {
        expect(new FabricUnavailable("error", "boom").errorMessage)
          .toBe("boom");
      });

      it("is `null` for every other reason", () => {
        const { error: _, ...rest } = instancesByReason();
        for (const instance of Object.values(rest)) {
          expect(instance.errorMessage).toBe(null);
        }
      });
    });

    describe("the four predicates", () => {
      // Each predicate is checked against every reason rather than only the
      // one it names, so a predicate that returned `true` too widely is seen.

      const predicates = {
        pending: (u: FabricUnavailable) => u.isPending(),
        syncing: (u: FabricUnavailable) => u.isSyncing(),
        schemaMismatch: (u: FabricUnavailable) => u.isSchemaMismatch(),
        error: (u: FabricUnavailable) => u.isError(),
      } satisfies Record<UnavailableReason, (u: FabricUnavailable) => boolean>;

      for (const [name, predicate] of Object.entries(predicates)) {
        it(
          `\`is${name[0]!.toUpperCase()}${
            name.slice(1)
          }()\` returns \`true\` for reason \`${name}\` and \`false\` for every other`,
          () => {
            for (
              const [reason, instance] of Object.entries(instancesByReason())
            ) {
              expect([reason, predicate(instance)]).toEqual([
                reason,
                reason === name,
              ]);
            }
          },
        );
      }
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricUnavailable[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Unavailable;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Unavailable` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricUnavailable`, rejecting other values", () => {
          expect(codec.canEncode(UNAVAILABLE_PENDING)).toBe(true);
          expect(codec.canEncode({ reason: "pending" })).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes a message-less reason to a record holding the reason alone", () => {
          expect(codec.encode(UNAVAILABLE_SYNCING, env))
            .toStrictEqual({ reason: "syncing" });
        });

        it("encodes reason `error` with its message", () => {
          expect(codec.encode(new FabricUnavailable("error", "boom"), env))
            .toStrictEqual({ reason: "error", errorMessage: "boom" });
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record holding a known reason", () => {
          expect(codec.canDecode({ reason: "pending" })).toBe(true);
          expect(codec.canDecode({ reason: "error", errorMessage: "x" }))
            .toBe(true);
        });

        it("returns `false` for state that is not a plain object", () => {
          expect(codec.canDecode("pending")).toBe(false);
          expect(codec.canDecode(["pending"])).toBe(false);
          expect(codec.canDecode(null)).toBe(false);
        });

        it("returns `false` for a reason outside the set", () => {
          expect(codec.canDecode({ reason: "gone" })).toBe(false);
          expect(codec.canDecode({ reason: "constructor" })).toBe(false);
          expect(codec.canDecode({})).toBe(false);
        });

        it("returns `false` for a reason that is inherited rather than own", () => {
          // Read as an own property, so a `reason` reachable only through the
          // prototype chain does not stand in for one.
          const polluted = Object.prototype as { reason?: unknown };
          polluted.reason = "pending";
          try {
            expect(codec.canDecode({})).toBe(false);
          } finally {
            delete polluted.reason;
          }
        });

        it("returns `false` for a message that is present and not a string", () => {
          expect(codec.canDecode({ reason: "error", errorMessage: 1 }))
            .toBe(false);
          expect(codec.canDecode({ reason: "error", errorMessage: undefined }))
            .toBe(false);
          expect(codec.canDecode({ reason: "pending", errorMessage: null }))
            .toBe(false);
        });
      });

      describe("decode()", () => {
        for (const [reason, prefab] of Object.entries(PREFABS)) {
          it(`decodes reason \`${reason}\` to its prefab instance`, () => {
            expect(codec.decode(expectedTag, { reason }, env)).toBe(prefab);
          });
        }

        it("decodes reason `error` to a fresh instance carrying the message", () => {
          const decoded = codec.decode(
            expectedTag,
            { reason: "error", errorMessage: "boom" },
            env,
          ) as unknown as FabricUnavailable;

          expect(decoded).toBeInstanceOf(FabricUnavailable);
          expect(decoded.reason).toBe("error");
          expect(decoded.errorMessage).toBe("boom");
        });

        it("decodes reason `error` without a message to a `ProblematicValue`", () => {
          expect(codec.decode(expectedTag, { reason: "error" }, env))
            .toBeInstanceOf(ProblematicValue);
        });

        it("decodes a message with a reason that does not take one to a `ProblematicValue`", () => {
          expect(
            codec.decode(
              expectedTag,
              { reason: "pending", errorMessage: "boom" },
              env,
            ),
          ).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips each reason", () => {
          for (const original of Object.values(instancesByReason())) {
            const decoded = codec.decode(
              expectedTag,
              codec.encode(original, env),
              env,
            ) as unknown as FabricUnavailable;

            expect(decoded).toBeInstanceOf(FabricUnavailable);
            expect(decoded.reason).toBe(original.reason);
            expect(decoded.errorMessage).toBe(original.errorMessage);
          }
        });
      });
    });

    describe("[REALM_CODEC]", () => {
      const codec = FabricUnavailable[REALM_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Unavailable;
      const env = NULL_LIVE_ENVIRONMENT;

      it("is terminal", () => {
        expect(codec instanceof BaseTerminalCodec).toBe(true);
      });

      describe("recognizedTypeTag", () => {
        it("is the `Unavailable` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("encode()", () => {
        it("encodes to the same record the JSON codec emits", () => {
          for (const original of Object.values(instancesByReason())) {
            expect(codec.encode(original, env))
              .toStrictEqual(
                FabricUnavailable[JSON_CODEC].encode(original, env),
              );
          }
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record holding a known reason", () => {
          expect(codec.canDecode({ reason: "schemaMismatch" })).toBe(true);
        });

        it("returns `false` for a message that is present holding `undefined`", () => {
          // This format carries `undefined` faithfully, so a peer can send
          // one on purpose, and it is a malformation rather than an absence.
          expect(codec.canDecode({ reason: "error", errorMessage: undefined }))
            .toBe(false);
        });

        it("returns `false` for state that is not a plain object", () => {
          expect(codec.canDecode("pending")).toBe(false);
          expect(codec.canDecode(undefined)).toBe(false);
        });
      });

      describe("decode()", () => {
        for (const [reason, prefab] of Object.entries(PREFABS)) {
          it(`decodes reason \`${reason}\` to its prefab instance`, () => {
            expect(codec.decode(expectedTag, { reason }, env)).toBe(prefab);
          });
        }

        it("decodes reason `error` to a fresh instance carrying the message", () => {
          const decoded = codec.decode(
            expectedTag,
            { reason: "error", errorMessage: "boom" },
            env,
          ) as unknown as FabricUnavailable;

          expect(decoded).toBeInstanceOf(FabricUnavailable);
          expect(decoded.errorMessage).toBe("boom");
        });

        it("decodes a message with a reason that does not take one to a `ProblematicValue`", () => {
          expect(
            codec.decode(
              expectedTag,
              { reason: "syncing", errorMessage: "boom" },
              env,
            ),
          ).toBeInstanceOf(ProblematicValue);
        });
      });
    });
  });

  describe("the prefab instances", () => {
    // Exercised as module-level exports rather than as members of the class,
    // so they live directly under the class `describe()`.

    for (const [reason, prefab] of Object.entries(PREFABS)) {
      it(`\`${reason}\` has that reason and no message`, () => {
        expect(prefab.reason).toBe(reason);
        expect(prefab.errorMessage).toBe(null);
      });

      it(`\`${reason}\` is equal by content to a fresh instance with that reason`, () => {
        expect(
          valueEqual(
            prefab,
            new FabricUnavailable(reason as UnavailableReason),
          ),
        ).toBe(true);
      });
    }

    it("are three distinct instances", () => {
      expect(new Set(Object.values(PREFABS)).size).toBe(3);
    });
  });

  describe("UNAVAILABLE_REASONS", () => {
    it("keys each reason by itself", () => {
      for (const [key, value] of Object.entries(UNAVAILABLE_REASONS)) {
        expect(value).toBe(key);
      }
    });

    it("is frozen", () => {
      expect(Object.isFrozen(UNAVAILABLE_REASONS)).toBe(true);
    });
  });

  describe("`shallowFabricFromConvertibleJsValue()` integration", () => {
    // Exercises the free `shallowFabricFromConvertibleJsValue()` rather than a
    // member of the class, so it lives directly under the class `describe()`.

    it("passes through unchanged even with `freeze=false`", () => {
      const unavailable = new FabricUnavailable("error", "boom");
      expect(shallowFabricFromConvertibleJsValue(unavailable, false))
        .toBe(unavailable);
    });
  });
});
