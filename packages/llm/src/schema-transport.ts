// Guards a value against the one lossy step between the runner and an external
// LLM provider: the request is sent as ordinary JSON (`JSON.stringify`), so any
// value it carries that plain JSON cannot represent faithfully reaches the
// provider altered, dropped, or not at all -- or crashes the serialization.
//
// The Common Fabric value model is a superset of JSON, so a generated schema
// (a `generateObject` schema, or a tool's `inputSchema`) may legitimately hold
// values JSON cannot carry. Those are fine internally. Crossing to a provider,
// they are not.
//
// This is a positive whitelist, not a search for known-bad leaves. Only the
// shapes JSON round-trips by identity are accepted -- `null`, booleans,
// strings, finite numbers other than `-0`, dense arrays of accepted values,
// and plain objects whose values are accepted. Everything else is reported:
// `undefined` (dropped from an object, `null` in an array), `NaN` / `±Infinity`
// (become `null`), `-0` (loses its sign), `bigint` / `symbol` / `function`
// (not representable), array holes (`null`), a non-index property on an array
// (dropped), symbol-keyed properties (dropped), a `toJSON` hook (replaces the
// value before JSON sees it), non-plain objects such as a `FabricBytes`
// (flattened -- `JSON.stringify` finds no data in its private fields), and
// cycles (`JSON.stringify` throws).
//
// A blacklist that only hunted bad numbers would pass every one of those: they
// leave no offending numeric leaf, yet JSON still alters them. Whitelisting is
// the only framing that makes an empty result actually mean "JSON transport
// will not change this."
//
// The policy is to refuse, not to quietly narrow: a value that cannot be sent
// unaltered is reported rather than changed. The narrowing to a provider's
// transport belongs to the boundary that crosses it, and the boundary says no.
//
// KNOWN LIMITATIONS. The walk reads enumerable own keys (`Object.keys` /
// `Object.entries`) and an own `toJSON` data property, which certifies the
// ordinary Fabric values a generated schema actually holds. It does NOT fully
// certify adversarially-shaped objects, so for these the empty result is not a
// guarantee (all confirmed to pass here while `JSON.stringify` alters them):
//
//   - A non-enumerable string data property is dropped by JSON but not seen
//     here (the walk is enumerable-only).
//   - An accessor-based `toJSON` (a getter) is missed: the own-descriptor check
//     matches a data property whose value is a function, not an accessor -- and
//     a plain read could fire the getter, which the check avoids on purpose.
//   - An inherited `toJSON` (e.g. on a custom array prototype) is missed: the
//     check looks at own descriptors only.
//   - The array-hole test uses `i in obj`, which consults the prototype, so an
//     inherited numeric property masks a hole; this also does not match JSON's
//     own-vs-inherited element read.
//
// None of these arise from a normally generated schema, which is why they are
// documented rather than handled. A future hardening pass would inspect own
// property descriptors instead of `Object.keys` / `Object.entries`, reject
// accessors and non-enumerable data properties, use `Object.hasOwn` for array
// slots, and reject a nonstandard array prototype or an inherited `toJSON`.
//
// A minor diagnostic point in the same vein: the thrown message renders the
// root pointer as `/`. Under RFC 6901 the root is `""` and `/` names a property
// whose key is the empty string; the message trades that strict accuracy for
// legibility.

import { isPlainObject } from "@commonfabric/utils/types";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

/** A value ordinary JSON serialization would not carry faithfully. */
export interface JsonUnfaithfulValue {
  /** RFC 6901 JSON Pointer to the value; `""` is the whole input. */
  readonly pointer: string;
  /** Why JSON would not carry it, e.g. `NaN (becomes null)`. */
  readonly reason: string;
}

/** Append one token to a JSON Pointer, escaping `~` and `/` per RFC 6901. */
function pointerChild(base: string, token: string | number): string {
  const escaped = String(token).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${base}/${escaped}`;
}

function numberReason(value: number): string | null {
  if (Number.isNaN(value)) return "NaN (becomes null)";
  if (value === Infinity) return "Infinity (becomes null)";
  if (value === -Infinity) return "-Infinity (becomes null)";
  if (Object.is(value, -0)) return "-0 (loses its sign)";
  return null;
}

function walk(
  value: unknown,
  pointer: string,
  ancestors: Set<object>,
  out: JsonUnfaithfulValue[],
): void {
  if (value === null) return;

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number": {
      const reason = numberReason(value);
      if (reason !== null) out.push({ pointer, reason });
      return;
    }
    case "bigint":
      out.push({ pointer, reason: `bigint ${value}n (not representable)` });
      return;
    case "undefined":
      out.push({
        pointer,
        reason: "undefined (dropped from an object, null in an array)",
      });
      return;
    case "symbol":
      out.push({ pointer, reason: "symbol (not representable)" });
      return;
    case "function":
      out.push({ pointer, reason: "function (not representable)" });
      return;
  }

  // A non-null object. Track ancestors (not all visited nodes), so a shared
  // reference at sibling positions -- which `JSON.stringify` duplicates rather
  // than rejects -- is fine; only an actual cycle is reported.
  const obj = value as object;
  if (ancestors.has(obj)) {
    out.push({ pointer, reason: "circular reference (JSON.stringify throws)" });
    return;
  }
  ancestors.add(obj);
  try {
    // A `toJSON` hook (own, even non-enumerable) replaces this value before
    // JSON sees its contents, so what the provider receives is whatever it
    // returns -- not the value walked here. Refuse: this check cannot certify
    // something it does not get to look at.
    const toJson = Object.getOwnPropertyDescriptor(obj, "toJSON");
    if (toJson !== undefined && typeof toJson.value === "function") {
      out.push({
        pointer,
        reason: "toJSON method (JSON.stringify would replace this value)",
      });
      return;
    }

    // Symbol-keyed properties carry data JSON silently drops, on an array or a
    // plain object alike.
    if (Object.getOwnPropertySymbols(obj).length > 0) {
      out.push({ pointer, reason: "symbol-keyed properties (dropped)" });
    }

    if (Array.isArray(obj)) {
      // JSON serializes an array's indices only; any other own property is
      // dropped. `Object.keys` yields the present indices plus those extras.
      for (const key of Object.keys(obj)) {
        if (!isArrayIndexPropertyName(key)) {
          out.push({
            pointer: pointerChild(pointer, key),
            reason: "non-index array property (dropped)",
          });
        }
      }
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) {
          out.push({
            pointer: pointerChild(pointer, i),
            reason: "array hole (becomes null)",
          });
          continue;
        }
        walk(obj[i], pointerChild(pointer, i), ancestors, out);
      }
      return;
    }

    if (!isPlainObject(obj)) {
      const name = obj.constructor?.name ?? "object";
      out.push({
        pointer,
        reason: `non-plain object (${name}; JSON.stringify sees no own data)`,
      });
      return;
    }

    for (const [key, child] of Object.entries(obj)) {
      walk(child, pointerChild(pointer, key), ancestors, out);
    }
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Find every value in `value` that ordinary JSON serialization would not carry
 * faithfully -- see the module comment for the whitelist. Returns them with
 * their JSON Pointers; an empty array means the value round-trips through JSON
 * by identity and is safe to send.
 */
export function findJsonUnfaithfulValues(
  value: unknown,
): JsonUnfaithfulValue[] {
  const out: JsonUnfaithfulValue[] = [];
  walk(value, "", new Set<object>(), out);
  return out;
}

/**
 * Throw if `value` holds anything ordinary JSON serialization would not carry
 * faithfully. `label` names what is being checked (e.g. `The generateObject
 * schema`), and the message lists each offending value by JSON Pointer and
 * reason, so the author can see what to change rather than discovering a
 * mangled value downstream in the provider's behavior.
 */
export function assertJsonTransportSafe(value: unknown, label: string): void {
  const problems = findJsonUnfaithfulValues(value);
  if (problems.length === 0) return;

  const lines = problems.map(({ pointer, reason }) =>
    `  ${pointer || "/"}: ${reason}`
  );
  throw new Error(
    `${label} holds ${problems.length} value(s) that ordinary JSON ` +
      `serialization would not carry faithfully:\n${lines.join("\n")}\n` +
      `These are valid Common Fabric values, but the request reaches the ` +
      `provider as ordinary JSON. Remove or replace the value(s) above.`,
  );
}
