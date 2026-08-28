/**
 * Recognizing the native JS builtins, which is the part of the dispatch that
 * needs no class this system defines.
 *
 * It is separate for the sake of where its callers sit. Recognizing a
 * `FabricBytes` means holding the `FabricBytes` class, and a concrete fabric
 * class reaches the codecs and, through them, the instance bases -- so a module
 * that asks about the fabric classes is layered above them. `type-check.ts` is
 * layered _below_ them, and still has to be able to tell a `Date` from a `Map`
 * from an ordinary class instance; this is what it asks. `native-type-tags.ts`
 * asks this first and then its own.
 *
 * What this file must not import is any module that knows a fabric class, since
 * that is the whole of what its callers cannot reach. `VALUE_TAGS.ts` is below
 * even this one and is fine; anything else deserves a second look.
 */

import { VALUE_TAGS, type ValueTag } from "./VALUE_TAGS.ts";

/**
 * Maps a constructor to its tag, for the native JS builtins alone. Returns
 * `null` for anything else, a fabric class included -- `tagFromNativeClass()`
 * is what knows those.
 *
 * Uses a `switch` on the constructor identity for dispatch (instead of
 * sequential `instanceof` checks). Falls back to `instanceof Error` on the
 * constructor's prototype to catch exotic `Error` subclasses. (Note:
 * `Error.isError()` doesn't work on prototype objects -- it only recognizes
 * actual `Error` instances, not the prototype chain -- so we use `instanceof`.)
 */
export function tagFromNativeBuiltinClass(
  constructorFn: { prototype: unknown },
): ValueTag | null {
  switch (constructorFn) {
    // The two commonest by a distance, and a `switch` on object identity
    // compares in order, so they are asked first.
    case Object:
      return VALUE_TAGS.Object;
    case Array:
      return VALUE_TAGS.Array;

    // `Error` and standard subclasses all map to the `Error` tag.
    case Error:
    case TypeError:
    case RangeError:
    case SyntaxError:
    case ReferenceError:
    case URIError:
    case EvalError:
      return VALUE_TAGS.Error;

    case Map:
      return VALUE_TAGS.Map;
    case Set:
      return VALUE_TAGS.Set;
    case Date:
      return VALUE_TAGS.Date;
    case Uint8Array:
      return VALUE_TAGS.Uint8Array;
    case RegExp:
      return VALUE_TAGS.RegExp;

    default:
      // Catch exotic `Error` subclasses (e.g. custom subclasses with
      // non-standard constructors). Guard against non-function values
      // (e.g. null-prototype objects where `constructor()` is undefined).
      if (
        typeof constructorFn === "function" &&
        constructorFn.prototype instanceof Error
      ) {
        return VALUE_TAGS.Error;
      }
      return null;
  }
}
