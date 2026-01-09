import { isFunction, isInstance } from "@commontools/utils/types";

/**
 * Converts a value to a storable (JSON-encodable) form. If the value is already
 * JSON-encodable (primitives, plain objects, arrays), it is returned as-is. If
 * the value is a function or instance (non-plain object), this attempts to
 * convert it via `toJSON()`. Throws if the value is a function or instance
 * without a `toJSON()` method, or if `toJSON()` itself returns a function or
 * instance.
 *
 * @param value - The value to convert.
 * @returns The storable value (original or converted).
 * @throws Error if the value is a function/instance that can't be converted.
 */
export function toStorableValue(value: unknown): unknown {
  const valueIsFunction = isFunction(value);
  const valueIsInstance = isInstance(value);

  if (!valueIsFunction && !valueIsInstance) {
    return value;
  }

  const typeName = valueIsFunction ? "function" : "instance";
  const valueObj = value as object; // Safe: guarded by isFunction || isInstance

  if (!("toJSON" in valueObj && typeof valueObj.toJSON === "function")) {
    throw new Error(
      `Cannot store ${typeName} per se (needs to have a \`toJSON()\` method)`,
    );
  }

  const converted = valueObj.toJSON();

  if (isFunction(converted) || isInstance(converted)) {
    throw new Error(
      `\`toJSON()\` on ${typeName} returned something other than a \`JSONValue\``,
    );
  }

  return converted;
}
