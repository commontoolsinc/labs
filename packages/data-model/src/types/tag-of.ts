/**
 * The dispatches that return a tag from the vocabulary in `tags.ts`, one
 * per kind of value a caller can be holding.
 *
 * Which classes a given dispatch recognizes varies with where it is layered:
 * recognizing a `FabricBytes` means holding the `FabricBytes` class, which not
 * every caller can. The vocabulary does not vary, so it is one constant there
 * rather than one inside each of them.
 */

import { constructorOfPrototype } from "@commonfabric/utils/objects";
import { isPlainObject, typeOfIncludingNull } from "@commonfabric/utils/types";

import {
  BaseFabricPrimitive,
  VALUE_TAG,
} from "@/fabric-bases/BaseFabricPrimitive.ts";
import {
  FabricInstance,
  FabricPrimitive,
  type FabricValueLayer,
  type FabricValuePlusLayer,
} from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";

import { type PlusTypePredicate } from "./interface.ts";
import {
  type ConvertibleJsValueTag,
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
  type FabricValuePlusTag,
  type FabricValueTag,
  VALUE_TAGS,
} from "./tags.ts";

/**
 * Maps a `FabricPrimitive` to its tag. This `throw`s if it determines that the
 * given value is not valid: a type lie, an instance of no primitive class, or
 * one reporting a tag that is not a primitive tag.
 */
export function tagOfFabricPrimitive(
  value: FabricPrimitive,
): FabricPrimitiveValueTag {
  const result = tagOfFabricPrimitiveElseNull(value);

  if (result !== null) {
    return result;
  }

  const desc = toCompactDebugString(value, { backtickQuote: true });
  throw new Error(`Not a valid \`FabricPrimitive\`: ${desc}`);
}

/**
 * Maps a `FabricPrimitive` to its tag. This returns `null` if the given value
 * turns out not to be valid: a type lie, an instance of no primitive class, or
 * one reporting a tag that is not a primitive tag.
 */
export function tagOfFabricPrimitiveElseNull(
  value: FabricPrimitive,
): FabricPrimitiveValueTag | null {
  if (!(value instanceof BaseFabricPrimitive)) {
    return null;
  }

  const tag = value[VALUE_TAG];

  return ((typeof tag === "string") &&
      Object.hasOwn(FABRIC_PRIMITIVE_VALUE_TAGS, tag))
    ? tag
    : null;
}

/**
 * Maps an arbitrary value to a `FabricValueTag`, based on a shallow evaluation
 * of its type as a possibly-valid `FabricValue`, `FabricValueLayer`, or `*Plus`
 * version of same. This returns `null` if it determines that the given value
 * cannot possibly be valid. To get a `PlusType` return value, a corresponding
 * type predicate must be passed as the second argument, and that function is
 * used to make a determination if the value would otherwise be considered
 * invalid.
 *
 * This function is _usually_ not the one that is most appropriate to use from
 * this module. Most of the time there should be a properly-typed
 * `FabricValue`-ish value that can be passed to `tagOfFabricValue()` or
 * similar, or in the case of wrangling "wild west" values, there is
 * `tagOfConvertibleJsValueElseNull()`.
 */
export function tagOfUnknownElseNull(
  value: unknown,
): FabricValueTag | null;
export function tagOfUnknownElseNull<PlusType = never>(
  value: unknown,
  isPlusType: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null;
export function tagOfUnknownElseNull<PlusType = never>(
  value: unknown,
  isPlusType?: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null {
  const jsType = typeOfIncludingNull(value);

  if (jsType === VALUE_TAGS.function) {
    return isPlusType?.(value) ? VALUE_TAGS.PlusType : null;
  } else if (jsType !== "object") {
    return jsType;
  } else if (Array.isArray(value)) {
    return VALUE_TAGS.Array;
  } else if (isPlainObject(value)) {
    return VALUE_TAGS.Object;
  } else if (value instanceof FabricPrimitive) {
    // Note: If `value` turns out to be an invalid `FabricPrimitive`, this will
    // return `null` instead of falling through to an `isPlusType()` check. The
    // reasoning here is that the full class hierarchy under `FabricPrimitive`
    // is meant to be controlled by the `data-model`, and so any invalid
    // `FabricPrimitive` is de facto a bug in the `data-model`, and that makes
    // it _more correct_ to return `null` here compared to blithely calling
    // through to an `isPlusType()` predicate which should never have been
    // called with such a value.
    return tagOfFabricPrimitiveElseNull(value);
  } else if (value instanceof FabricInstance) {
    return VALUE_TAGS.FabricInstance;
  } else if (isPlusType?.(value)) {
    return VALUE_TAGS.PlusType;
  } else {
    return null;
  }
}

/**
 * Maps a presumed valid `FabricValue`, `FabricValueLayer`, or corresponding
 * `*Plus` value to its tag, based on a shallow evaluation of its type. This
 * `throw`s if it determines that the given value cannot possibly be valid. For
 * `*Plus` values, a corresponding type predicate must be passed as the second
 * argument, and that function is used to make a determination if the value
 * would otherwise be considered invalid.
 */
export function tagOfFabricValue(value: FabricValueLayer): FabricValueTag;
export function tagOfFabricValue<PlusType = never>(
  value: NoInfer<FabricValuePlusLayer<PlusType>>,
  isPlusType: PlusTypePredicate<PlusType>,
): FabricValuePlusTag;
export function tagOfFabricValue<PlusType = never>(
  value: FabricValuePlusLayer<PlusType>,
  isPlusType?: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag {
  // For rationale, see comment on the similar call in
  // `tagOfFabricValueElseNull()`, below.
  const result = tagOfUnknownElseNull(value, isPlusType);

  if (result !== null) {
    return result;
  }

  const desc = toCompactDebugString(value, { backtickQuote: true });
  throw new Error(`Not possibly a valid \`FabricValue\`: ${desc}`);
}

/**
 * Maps a presumed valid `FabricValue`, `FabricValueLayer`, or corresponding
 * `*Plus` value to its tag, based on a shallow evaluation of its type. This
 * returns `null` if it determines that the given value cannot possibly be
 * valid. For `*Plus` values, a corresponding type predicate must be passed as
 * the second argument, and that function is used to make a determination if the
 * value would otherwise be considered invalid.
 */
export function tagOfFabricValueElseNull(
  value: FabricValueLayer,
): FabricValueTag | null;
export function tagOfFabricValueElseNull<PlusType = never>(
  value: NoInfer<FabricValuePlusLayer<PlusType>>,
  isPlusType?: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null;
export function tagOfFabricValueElseNull<PlusType = never>(
  value: FabricValuePlusLayer<PlusType>,
  isPlusType?: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null {
  // The point of this arrangement -- instead of having an `unknown` overload on
  // this function -- is so that the `unknown` argument doesn't get
  // inadvertently bound when code is trying to have proper type hygiene.
  return tagOfUnknownElseNull(value, isPlusType);
}

/**
 * Maps a possible `FabricConvertibleJsValue` to its tag, based on a shallow
 * evaluation of its type. This returns `null` if it determines that the given
 * value isn't possibly either a valid `FabricValue` or an instance of one of
 * the members of `FabricConvertibleJsObject`.
 *
 * Note: Instances of `Error` are _only_ detected in this function using
 * `Error.isError()` and _not_ by looking at the prototype chain.
 */
export function tagOfConvertibleJsValueElseNull(
  value: unknown,
): ConvertibleJsValueTag | null {
  // Note: This function is written to prioritize DRYness over avoiding
  // redundant work, especially in that (a) the redundancy is minimal generally
  // speaking, and (b) in the context of doing value conversion, the redundancy
  // rounds to basically nothing. The one thing worth mentioning is that in the
  // code here _might_ get the prototype of a given value twice, and in the case
  // of a buggy `Proxy`, that answer might not be the same both times. We accept
  // that possibility here, for the usual reason in this codebase: The code's
  // job is to produce correct results in the face of non-buggy input and not to
  // detect all possible bugs.

  if (Error.isError(value)) {
    return VALUE_TAGS.JsError;
  }

  const result = tagOfUnknownElseNull(value);

  if (result !== null) {
    return result;
  }

  // The constructor (a/k/a class object) is read from the _prototype_, not from
  // the value (which might turn out to have a misleading `constructor`
  // property).
  const proto = Object.getPrototypeOf(value);
  const constructor = constructorOfPrototype(proto);

  switch (constructor) {
    case Map: {
      return VALUE_TAGS.JsMap;
    }

    case Set: {
      return VALUE_TAGS.JsSet;
    }

    case Date: {
      return VALUE_TAGS.JsDate;
    }

    case Uint8Array: {
      return VALUE_TAGS.JsUint8Array;
    }

    case RegExp: {
      return VALUE_TAGS.JsRegExp;
    }

    default: {
      return null;
    }
  }
}
