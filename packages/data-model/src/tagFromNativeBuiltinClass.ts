import { VALUE_TAGS, type ValueTag } from "./VALUE_TAGS.ts";

/**
 * Maps a constructor to its tag, for the native JS builtins alone. Returns
 * `null` for anything else, a fabric class included.
 *
 * Answering this needs no class this system defines, which is what lets code
 * layered below the fabric classes ask it at all: recognizing a `FabricBytes`
 * would mean holding that class, and a concrete fabric class reaches the
 * codecs and, through them, the instance bases. Nothing here may import a
 * module that knows a fabric class, for that reason.
 */
export function tagFromNativeBuiltinClass(
  constructorFn: { prototype: unknown },
): ValueTag | null {
  // A `switch` on constructor identity, rather than sequential `instanceof`
  // checks.
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
      // non-standard constructors). `Error.isError()` is no use here: it
      // recognizes actual `Error` instances, not a prototype chain, and what
      // is in hand is a constructor. Guard against non-function values too
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
