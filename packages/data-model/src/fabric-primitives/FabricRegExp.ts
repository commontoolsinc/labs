import type {
  FabricRegExp as ApiFabricRegExp,
  FabricRegExpConstructor as ApiFabricRegExpConstructor,
} from "@commonfabric/api";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";

import { BaseFabricPrimitive } from "@/codec-common/BaseFabricPrimitive.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  JSON_CODEC,
  type NonterminalCodec,
  REALM_CODEC,
  type DecodeContext,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";
import type { FabricValue } from "@/interface.ts";

/** The only regex flavor currently representable as a native `RegExp`. */
const DEFAULT_FLAVOR = "es2025";

/**
 * Immutable regular-expression value in the fabric type system.
 *
 * The essential state is `{ source, flags, flavor }` -- the values needed to
 * (re)construct an equivalent regex. A `FabricRegExp` is a leaf type with
 * respect to references (it holds no nested `FabricValue`s) and is reasonably
 * conceived of as stateless: although a JS `RegExp` carries mutable internal
 * state (notably `lastIndex`), the stored `RegExp` is never handed out
 * un-cloned, so no mutable state is exposed -- `value` returns a fresh clone on
 * each call.
 *
 * `flavor` identifies the regex dialect. Only `"es2025"` (the default) is
 * currently representable as a native JS `RegExp`; for that flavor the
 * constructor proactively builds and retains a private `RegExp`, which both
 * validates the pattern syntax eagerly and makes `value` cheap. Other flavors
 * are stored faithfully (`source` / `flags` / `flavor`) but cannot yet produce
 * a native `RegExp`, so `value` throws for them -- leaving room to represent
 * other regex syntaxes in the future.
 * See Section 1.4.1 of the formal spec.
 */
export class FabricRegExp extends BaseFabricPrimitive
  implements ApiFabricRegExp {
  /** The pattern source text. */
  readonly #source: string;

  /** The flags string (e.g. `"gi"`). */
  readonly #flags: string;

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  readonly #flavor: string;

  /**
   * The native `RegExp`, built eagerly for the `"es2025"` flavor (and only
   * that flavor). `undefined` for other flavors, which cannot yet produce a
   * native `RegExp`. Never handed out directly -- `value` returns a fresh
   * clone.
   */
  readonly #value: RegExp | undefined;

  /**
   * Constructs an instance, either from a native `RegExp` (implying the
   * `"es2025"` flavor) or from explicit `flavor` / `source` / `flags`.
   *
   * When the resulting flavor is `"es2025"`, the `source` and `flags` are
   * validated eagerly by building the retained native `RegExp`. A native
   * `RegExp` argument with extra enumerable own properties is rejected (the
   * built-in `.lastIndex` is non-enumerable, so `Object.keys()` only sees
   * user-added properties).
   */
  constructor(regex: RegExp);
  constructor(flavor: string, source: string, flags: string);
  constructor(
    regexOrFlavor: RegExp | string,
    source?: string,
    flags?: string,
  ) {
    super();

    if (regexOrFlavor instanceof RegExp) {
      rejectExtraRegExpProperties(regexOrFlavor);
      this.#source = regexOrFlavor.source;
      this.#flags = regexOrFlavor.flags;
      this.#flavor = DEFAULT_FLAVOR;
    } else {
      this.#flavor = regexOrFlavor;
      this.#source = source ?? "";
      this.#flags = flags ?? "";
    }

    // Only `"es2025"` is representable as a native `RegExp`; build it eagerly
    // (which also validates the pattern). Other flavors store their strings but
    // have no native form yet.
    this.#value = (this.#flavor === DEFAULT_FLAVOR)
      ? new RegExp(this.#source, this.#flags)
      : undefined;

    Object.freeze(this);
  }

  /** The pattern source text. */
  get source(): string {
    return this.#source;
  }

  /** The flags string (e.g. `"gi"`). */
  get flags(): string {
    return this.#flags;
  }

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  get flavor(): string {
    return this.#flavor;
  }

  /**
   * A fresh native `RegExp` equivalent to this value, returned anew on each
   * call so the internal instance is never aliased out (the caller cannot
   * reach its `lastIndex` etc.). Throws when the flavor is not `"es2025"`,
   * which has no native `RegExp` representation.
   */
  get value(): RegExp {
    if (this.#value === undefined) {
      throw new Error(
        `Cannot represent flavor ${
          backtickQuote(this.#flavor)
        } as a native \`RegExp\`.`,
      );
    }
    return new RegExp(this.#value);
  }

  //
  // Static members
  //

  /**
   * Reads the three fields a wire state carries, or `null` if any of them is
   * present with a type it cannot have.
   *
   * An absent field takes its default, which is what lets a narrower encoder
   * omit one. A field that is *present* and not a string is a different thing
   * entirely, and that includes one present as `undefined`: nothing here emits
   * such a state, and defaulting it would silently answer a question the wire
   * did actually ask -- a `flavor` sent that way would come back `es2025`,
   * naming a dialect the sender did not.
   *
   * The rest matters more than it looks. The constructor stores a non-`es2025`
   * flavor's `source` and `flags` without touching them, so an unchecked
   * object here reaches the public getters, which are typed `string`, and
   * takes an unfrozen reference into a frozen instance with it.
   */
  static #stateFields(
    state: Record<string, unknown>,
  ): { flavor: string; source: string; flags: string } | null {
    for (const key of ["flavor", "source", "flags"] as const) {
      if (Object.hasOwn(state, key) && (typeof state[key] !== "string")) {
        return null;
      }
    }

    const { flavor, source, flags } = state;

    return {
      flavor: (flavor as string | undefined) ?? DEFAULT_FLAVOR,
      source: (source as string | undefined) ?? "",
      flags: (flags as string | undefined) ?? "",
    };
  }

  static #jsonCodec = Object.freeze(
    new (class RegExpCodec extends BaseNonterminalCodec {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.RegExp, FabricRegExp);
      }

      /** @inheritDoc */
      encode(value: FabricRegExp): FabricValue {
        return {
          source: value.#source,
          flags: value.#flags,
          flavor: value.#flavor,
        };
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        _context: DecodeContext,
      ): FabricValue {
        if (!isPlainObject(state)) {
          return new ProblematicValue(
            typeTag,
            state,
            `RegExp: expected object state, got ${typeof state}`,
          );
        }
        // Beyond the three fields being strings, this class does not enforce
        // regex syntax as part of its wire participation: only the `es2025`
        // flavor is validated, eagerly, by the constructor building a native
        // `RegExp`. Another flavor's `source` and `flags` are stored
        // faithfully and may be any strings at all, that dialect being one
        // this runtime cannot check.
        const fields = FabricRegExp.#stateFields(state);
        if (fields === null) {
          return new ProblematicValue(
            typeTag,
            state,
            "RegExp: expected string `flavor`, `source` and `flags`",
          );
        }

        const { flavor, source, flags } = fields;
        try {
          return new FabricRegExp(flavor, source, flags);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `RegExp: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class RegExpCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.RegExp, FabricRegExp);
      }

      /** @inheritDoc */
      encode(value: FabricRegExp): RealmCodecValue {
        return {
          source: value.#source,
          flags: value.#flags,
          flavor: value.#flavor,
        };
      }

      /**
       * @inheritDoc
       *
       * Reports a bad state by returning a `ProblematicValue`, as this
       * class's JSON codec does. The two ways a codec can reject -- this and
       * throwing -- are equivalent to a caller, the engine settling them
       * against `lenient`, so what decides between them is consistency across
       * the codecs a reader meets together.
       *
       * As on the JSON side, regex syntax is not enforced as part of wire
       * participation beyond what the constructor validates eagerly for the
       * `es2025` flavor.
       */
      decode(
        typeTag: string,
        state: RealmCodecValue,
        _context: DecodeContext,
      ): FabricValue {
        if (!isPlainObject(state)) {
          return new ProblematicValue(
            typeTag,
            state,
            `expected object state, got ${typeof state}`,
          );
        }

        const fields = FabricRegExp.#stateFields(state);
        if (fields === null) {
          return new ProblematicValue(
            typeTag,
            state,
            "expected string `flavor`, `source` and `flags`",
          );
        }

        const { flavor, source, flags } = fields;
        try {
          return new FabricRegExp(flavor, source, flags);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            (e instanceof Error) ? e.message : String(e),
          );
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): NonterminalCodec {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format.
   *
   * Terminal, where JSON's is nonterminal, and the essential state is the same
   * `{ source, flags, flavor }` either way. A record of strings sits in both
   * domains at once -- it is a `FabricValue`, and it is also a value this
   * format carries as it stands -- so the shape of the state does not decide
   * the kind, and each format says which it means. Terminal is what this one
   * has to gain by: the walk hands the record to the transport rather than
   * descending into three strings whose shape it already knows.
   *
   * Structured cloning carrying a native `RegExp` is not the reason, and would
   * not have been a good one. `flavor` has no native carrier, and a flavor
   * other than `es2025` has no native `RegExp` at all, so a state of that
   * shape would drop the first and be unreachable for the second.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }
}

/**
 * Rejects `RegExp` instances with extra enumerable properties. The built-in
 * `.lastIndex` property is not enumerable, so `Object.keys()` won't see it. Any
 * enumerable own property is therefore user-added and causes rejection.
 */
function rejectExtraRegExpProperties(regex: RegExp): void {
  if (Object.keys(regex).length > 0) {
    throw new Error(
      "Not representable as a `FabricValue`: `RegExp` with extra enumerable " +
        "properties",
    );
  }
}

// Compile-time check that the exported `FabricRegExp` constructor matches the
// `FabricRegExpConstructor` declared in `@commonfabric/api`. This catches a
// declared member that is missing here or has the wrong type. It does NOT
// catch the other direction: `satisfies` is an assignability check, so a
// public member on this class that the declaration omits passes silently.
// Members added here need adding there by hand.
FabricRegExp satisfies ApiFabricRegExpConstructor;
