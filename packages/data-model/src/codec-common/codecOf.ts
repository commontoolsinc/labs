import type { FabricSpecialObject } from "@/interface.ts";
import {
  CODEC,
  type DecomposingCodec,
  type FabricClassWithCodec,
  type RegistrableCodec,
} from "./interface.ts";

/**
 * Gets the `[CODEC]` for the given value's class, which is a
 * `DecomposingCodec` and so usable whatever the caller's wire format. Throws a
 * "shouldn't happen" error if the value's class has no `[CODEC]`.
 *
 * @param value The value whose class's codec is wanted.
 */
export function codecOf(value: FabricSpecialObject): DecomposingCodec;

/**
 * Gets the `[CODEC]` for the given value's class, falling back to the codec
 * bound to `altCodec` when there is none.
 *
 * A class whose codec terminates binds one per wire format, under that
 * format's own symbol, rather than a single `[CODEC]`. Name that symbol as
 * `altCodec` to reach it; a caller wanting the JSON codec passes
 * `[JSON_CODEC]`, and says so a second time by naming that format's value type
 * as `Encoded`. Absent both symbols, this throws.
 *
 * The alternative arrives as a parameter rather than being known here, which
 * is what keeps this module from naming any wire format.
 *
 * The result is of either kind, since `[CODEC]` still wins when a class
 * happens to bind both, and nothing here distinguishes them. That suits the
 * callers, which want a tag: `tagForValue()` is common to both kinds. A caller
 * that means to encode wants a `MatchedCodec` from a registry instead.
 *
 * @param value The value whose class's codec is wanted.
 * @param altCodec Symbol to try when `[CODEC]` is absent.
 */
export function codecOf<Encoded>(
  value: FabricSpecialObject,
  altCodec: symbol,
): RegistrableCodec<Encoded>;
export function codecOf<Encoded>(
  value: FabricSpecialObject,
  altCodec?: symbol,
): RegistrableCodec<Encoded> {
  const cls = value.constructor as unknown as
    & Partial<FabricClassWithCodec>
    & Partial<Record<symbol, RegistrableCodec<Encoded>>>;
  const codec = cls[CODEC] ??
    ((altCodec === undefined) ? undefined : cls[altCodec]);

  if (codec === undefined) {
    throw new Error(
      `Shouldn't happen: no \`[CODEC]\` for \`${value.constructor.name}\`.`,
    );
  }

  return codec;
}
