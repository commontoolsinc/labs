import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { isPlainObject } from "@commonfabric/utils/types";

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
export class FabricRegExp extends BaseFabricPrimitive {
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
   * Constructs a `FabricRegExp`, either from a native `RegExp` (implying the
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
        `Cannot represent flavor \`${this.#flavor}\` as a native \`RegExp\`.`,
      );
    }
    return new RegExp(this.#value);
  }

  //
  // Static members
  //

  static #codec = Object.freeze(
    new (class RegExpCodec extends BaseFabricCodec {
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
        _context: ReconstructionContext,
      ): FabricValue {
        if (!isPlainObject(state)) {
          return new ProblematicValue(
            typeTag,
            state,
            `RegExp: expected object state, got ${typeof state}`,
          );
        }
        // Beyond requiring an object, this class does not enforce regex
        // syntax as part of its wire participation: only the `es2025` flavor
        // is validated (eagerly, by the constructor building a native
        // `RegExp`); other flavors are stored faithfully and may carry
        // arbitrary `source`/`flags`. So a malformed non-`es2025` wire object
        // is accepted as-is rather than becoming a `ProblematicValue`.
        const s = state as Record<string, unknown>;
        const flavor = (s.flavor as string) ?? DEFAULT_FLAVOR;
        const source = (s.source as string) ?? "";
        const flags = (s.flags as string) ?? "";
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
  static get [CODEC](): FabricCodec {
    return this.#codec;
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
      "Cannot store RegExp with extra enumerable properties",
    );
  }
}
