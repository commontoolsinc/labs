/**
 * Pure utility functions for checking the property-key shape of plain objects.
 */

/**
 * Indicates whether the given value is an *inert* plain object -- a direct
 * instance of `Object`, every own property an enumerable
 * string-keyed *data* property -- which is what "plain object" means in this
 * system. Symbol keys and non-enumerable string keys cause rejection,
 * whether or not they carry data, because neither has any representation as
 * a property *name*: neither survives serialization, nor a name-driven copy
 * such as `Object.entries()` round-tripping. An accessor-backed (getter
 * and/or setter) property also causes rejection, even when its key is an
 * enumerable string, because it makes the object non-inert: an accessor is
 * live code, a read of which executes it and can answer differently every
 * time -- and freezing the object does not change that.
 *
 * "Direct instance" means the prototype is `Object.prototype` exactly, so a
 * null-prototype object is rejected along with every class instance. A
 * prototype is not part of what an object says as data: it has no
 * representation in any encoding, so a record that crosses a storage boundary
 * comes back `Object.prototype`-rooted whatever it went in as. Accepting a
 * null-prototype object would therefore mean carrying a distinction that
 * exists only in memory and stops existing at the first boundary. A caller
 * holding one and meaning to shed it can say so with
 * `shallowCleanPlainObject()`, which rebuilds the record `Object`-rooted.
 *
 * Anything that isn't a plain object is rejected, class instances and arrays
 * included, which also makes this function total: it answers rather than
 * throwing no matter what it is handed. A `Proxy` is the one exception, and
 * unavoidably so, since it can throw from its own traps.
 *
 * @param value The value to check.
 * @returns `true` if the value is a plain object all of whose own properties
 *   are enumerable string-keyed data properties, `false` otherwise.
 */
export function isInertPlainObject(
  value: unknown,
): boolean {
  if ((value === null) || (typeof value !== "object")) {
    return false;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }

  // A single pass over the own keys checks all three requirements: each key
  // must be a string (`Reflect.ownKeys()` yields symbol keys too, which a
  // count-based comparison would need a second key walk to exclude), and its
  // descriptor must be enumerable and carry `value` (an accessor answers
  // `get` / `set` instead).
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      return false;
    }
  }

  return true;
}
