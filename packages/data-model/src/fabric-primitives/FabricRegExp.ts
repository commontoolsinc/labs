import { FabricPrimitive } from "../interface.ts";
import { TAGS } from "../fabric-type-tags.ts";

/**
 * Immutable regular-expression value in the fabric type system. Extends
 * `FabricPrimitive` -- treated like a primitive (always frozen, passes through
 * conversion unchanged). Direct member of `FabricValue` via the
 * `FabricPrimitive` arm.
 *
 * The essential state is `{ source, flags, flavor }` -- the values needed to
 * (re)construct an equivalent `RegExp`. A `FabricRegExp` is a leaf type with
 * respect to references (it holds no nested `FabricValue`s) and is reasonably
 * conceived of as stateless: although a JS `RegExp` carries mutable internal
 * state (notably `lastIndex`), the stored `RegExp` is **never handed out
 * un-cloned**, so no mutable `RegExp` state is exposed. The `value` getter
 * returns a fresh clone on each call (mirroring `FabricBytes`, which copies on
 * `slice()` rather than handing back its private `#bytes`).
 *
 * Internally the constructor builds and retains a `RegExp` in a hard-private
 * field: this validates the pattern syntax eagerly (a bad `source`/`flags`
 * combination throws at construction) and makes cloning cheap (`new
 * RegExp(this.#value)` copies the compiled pattern and resets `lastIndex`
 * without re-parsing).
 * See Section 1.4.1 of the formal spec.
 */
export class FabricRegExp extends FabricPrimitive {
  /**
   * The wrapped pattern, retained for eager syntax validation and cheap
   * cloning. Never handed out directly -- `value` returns a fresh clone.
   */
  readonly #value: RegExp;

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  readonly #flavor: string;

  /**
   * Constructs a `FabricRegExp` from a native `RegExp`. The `source` and
   * `flags` are retained via a fresh internal `RegExp` (which also validates
   * the pattern eagerly); the input `RegExp` object itself is not aliased. A
   * `RegExp` with extra enumerable own properties is rejected (the built-in
   * `.lastIndex` is non-enumerable, so `Object.keys()` only sees user-added
   * properties).
   *
   * @param regex - The native `RegExp` to wrap (only its `source`/`flags` are
   *   retained, via a fresh internal `RegExp`).
   * @param flavor - Regex flavor/dialect identifier (default `"es2025"`).
   */
  constructor(regex: RegExp, flavor: string = "es2025") {
    super();
    rejectExtraRegExpProperties(regex);
    this.#value = new RegExp(regex.source, regex.flags);
    this.#flavor = flavor;
    Object.freeze(this);
  }

  /** The wire-format type tag (`RegExp@1`). */
  get typeTag(): string {
    return TAGS.RegExp;
  }

  /** The pattern source text. */
  get source(): string {
    return this.#value.source;
  }

  /** The flags string (e.g. `"gi"`). */
  get flags(): string {
    return this.#value.flags;
  }

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  get flavor(): string {
    return this.#flavor;
  }

  /**
   * A fresh native `RegExp` equivalent to this value. A new instance is
   * returned on every call -- the stored `RegExp` is never aliased out
   * (mirroring why `FabricBytes` returns a copy from `slice()` rather than its
   * private bytes), so the caller cannot reach this instance's internal state
   * (`lastIndex` etc.). The returned `RegExp` is mutable; mutating it has no
   * effect on this `FabricRegExp`.
   */
  get value(): RegExp {
    return new RegExp(this.#value);
  }

  /**
   * Reconstructs a `FabricRegExp` from its essential state
   * (`{ source, flags, flavor }`). Reconstruction goes through the constructor,
   * so the eager syntax-validation path covers decoding too.
   *
   * @param state - The essential state, with optional `source`, `flags`, and
   *   `flavor` string fields.
   */
  static fromState(state: Record<string, unknown>): FabricRegExp {
    const source = (state.source as string) ?? "";
    const flags = (state.flags as string) ?? "";
    const flavor = (state.flavor as string) ?? "es2025";
    return new FabricRegExp(new RegExp(source, flags), flavor);
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
