import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { FrozenSet } from "./frozen-builtins.ts";

/**
 * Returns `true` if the value is a native JS object type that the fabric
 * system knows how to wrap. These are the "wild-west" instances that get
 * converted into `FabricNativeWrapper` subclasses, `FabricPrimitive` types,
 * or `FabricInstance` types by the conversion layer.
 *
 * Arrays, plain objects, objects with `toJSON()`, and system-defined special
 * primitives are recognized by `tagFromNativeValue()` but are NOT convertible
 * native instances -- they have their own handling paths in the conversion
 * layer.
 */
export function isConvertibleNativeInstance(value: object): boolean {
  switch (tagFromNativeValue(value)) {
    case NATIVE_TAGS.Error:
    case NATIVE_TAGS.Map:
    case NATIVE_TAGS.Set:
    case NATIVE_TAGS.Date:
    case NATIVE_TAGS.Uint8Array:
    case NATIVE_TAGS.RegExp:
      return true;
    default:
      return false;
  }
}

/** Keys that must never be copied to prevent prototype pollution. */
export const UNSAFE_KEYS: FrozenSet<string> = new FrozenSet([
  "__proto__",
  "constructor",
]);

/** Map from Error subclass name to its constructor. */
const ERROR_CLASS_BY_TYPE: ReadonlyMap<string, ErrorConstructor> = new Map([
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["SyntaxError", SyntaxError],
  ["ReferenceError", ReferenceError],
  ["URIError", URIError],
  ["EvalError", EvalError],
]);

/**
 * Helper for `FabricError.[RECONSTRUCT]()`, which returns the `Error`
 * constructor for the given type string (e.g. `"TypeError"`). Falls back
 * to the base `Error` constructor for unknown types.
 */
export function errorClassFromType(type: string): ErrorConstructor {
  return ERROR_CLASS_BY_TYPE.get(type) ?? Error;
}
