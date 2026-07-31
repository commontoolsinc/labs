/**
 * Pure utility functions for checking the property-key shape of plain objects.
 */

/**
 * Indicates whether the given value is a plain object -- prototype
 * `Object.prototype` or `null` -- every one of whose own properties has an
 * enumerable string key. Symbol keys and non-enumerable string keys both cause
 * rejection, whether or not they carry data, because neither has any
 * representation as a property *name*: neither survives serialization, nor a
 * name-driven copy such as `Object.entries()` round-tripping.
 *
 * Anything that isn't a plain object is rejected, class instances and arrays
 * included, which also makes this function total: it answers rather than
 * throwing no matter what it is handed. A `Proxy` is the one exception, and
 * unavoidably so, since it can throw from its own traps.
 *
 * @param value The value to check.
 * @returns `true` if the value is a plain object all of whose own keys are
 *   enumerable strings, `false` otherwise.
 */
export function isPlainObjectWithOnlyEnumerableStringKeys(
  value: unknown,
): boolean {
  if ((value === null) || (typeof value !== "object")) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  if (!((proto === Object.prototype) || (proto === null))) {
    return false;
  }

  // `Reflect.ownKeys()` yields every own string and symbol key regardless of
  // enumerability, while `Object.keys()` yields exactly the enumerable string
  // ones, so the former is always a superset of the latter. Equal counts across
  // a superset relation therefore means the two agree key for key -- no symbol
  // key and no non-enumerable string key anywhere.
  return Reflect.ownKeys(value).length === Object.keys(value).length;
}

/**
 * Indicates whether every own property of the given object is a *data*
 * property -- as opposed to an accessor (getter and/or setter). An accessor
 * is live code rather than inert data: a read executes it and can answer
 * differently every time, and freezing the object does not change that.
 *
 * This is purely a descriptor-shape check; it says nothing about the keys'
 * visibility or type. Pair it with
 * `isPlainObjectWithOnlyEnumerableStringKeys()` when both dimensions matter.
 *
 * @param value The object to check.
 * @returns `true` if every own property is a data property, `false`
 *   otherwise.
 */
export function hasOnlyOwnDataProperties(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {
      return false;
    }
  }
  return true;
}
