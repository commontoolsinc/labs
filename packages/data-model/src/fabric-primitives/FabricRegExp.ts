import type {
  FabricRegExp as ApiFabricRegExp,
  FabricRegExpConstructor as ApiFabricRegExpConstructor,
} from "@commonfabric/api";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";

import { BaseFabricPrimitive } from "@/fabric-bases/BaseFabricPrimitive.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  JSON_CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
} from "@/codec-interface/interface.ts";
import type { FabricValue } from "@/interface.ts";

/** The only regex flavor currently representable as a native `RegExp`. */
const DEFAULT_FLAVOR = "es2025";

/**
 * The encoded state of a {@link FabricRegExp}. Each field is optional on the
 * wire, an absent one standing for its default, which is what lets a narrower
 * encoder omit it.
 */
type FabricRegExpState = {
  flavor?: string;
  source?: string;
  flags?: string;
};

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

  static #jsonCodec = Object.freeze(
    new (class RegExpCodec extends BaseNonterminalCodec<FabricRegExpState> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.RegExp, FabricRegExp);
      }

      /** @inheritDoc */
      encode(value: FabricRegExp): FabricRegExpState {
        return {
          source: value.#source,
          flags: value.#flags,
          flavor: value.#flavor,
        };
      }

      /**
       * @inheritDoc
       *
       * A field that is *present* and not a string is refused, and that
       * includes one present as `undefined`: nothing here emits such a state,
       * and letting it default would silently answer a question the wire did
       * actually ask -- a `flavor` sent that way would come back `es2025`,
       * naming a dialect the sender did not. An absent field is a different
       * thing, and takes its default in `decode()`, which is what lets a
       * narrower encoder omit one.
       *
       * The check matters more than it looks. The constructor stores a
       * non-`es2025` flavor's `source` and `flags` without touching them, so
       * an unchecked object here reaches the public getters, which are typed
       * `string`, and takes an unfrozen reference into a frozen instance with
       * it.
       */
      canDecode(state: FabricValue): state is FabricRegExpState {
        if (!isPlainObject(state)) {
          return false;
        }

        for (const key of ["flavor", "source", "flags"] as const) {
          if (Object.hasOwn(state, key) && (typeof state[key] !== "string")) {
            return false;
          }
        }

        return true;
      }

      /**
       * @inheritDoc
       *
       * Beyond the three fields being strings, this class does not enforce
       * regex syntax as part of its wire participation: only the `es2025`
       * flavor is validated, eagerly, by the constructor building a native
       * `RegExp`. Another flavor's `source` and `flags` are stored faithfully
       * and may be any strings at all, that dialect being one this runtime
       * cannot check.
       */
      decode(
        typeTag: string,
        state: FabricRegExpState,
        _env: LiveEnvironment,
      ): FabricValue {
        const flavor = state.flavor ?? DEFAULT_FLAVOR;
        const source = state.source ?? "";
        const flags = state.flags ?? "";

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

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): NonterminalCodec {
    return this.#jsonCodec;
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
