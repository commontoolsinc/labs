# JSON Encoding for Fabric Values

This document specifies the JSON-compatible wire format used to represent
fabric values, including the tagged-object convention, escaping mechanisms,
serialization context responsibilities, and the reservation rules for
`/`-prefixed keys.

## Status

Draft formal spec — extracted from Section 5 of `1-fabric-values.md`.

---

## 1. Overview

This section specifies the JSON-compatible wire format for special types. While
the system will maintain a JSON encoding indefinitely (for debugging and
interoperability), other wire and storage formats (e.g., CBOR) may represent
types more directly without layering on JSON.

## 2. Key Convention: `/<Type>@<Version>`

All special types in JSON use a single convention: single-key objects where the
key follows the pattern `/<Type>@<Version>`.

- `/` — sigil prefix (nodding to IPLD heritage)
- `<Type>` — `UpperCamelCase` type name
- `@<Version>` — version number (natural number, starting at 1)

This convention does **not** prohibit storing plain objects that happen to have
`/`-prefixed keys. The escaping mechanism in Section 6 (`/object` and
`/quote`) handles this case: during serialization, plain objects whose shape
would be ambiguous with a tagged type are automatically wrapped so they
round-trip correctly.

## 3. Standard Type Encodings

> **Base64url encoding convention.** All base64-encoded values in the JSON wire
> format use the URL-safe base64url alphabet (`A-Za-z0-9-_`, per RFC 4648
> Section 5). Encoders **must omit** trailing `=` padding characters. Decoders
> **must accept** both padded and unpadded input for compatibility; standard-base64
> characters (`+`, `/`) are still invalid and must be rejected. This convention
> applies to `Bytes@1`, `BigInt@1`, `EpochNsec@1`, and `EpochDays@1` state
> values.

```typescript
// file: packages/data-model/json-type-handlers.ts (illustrative -- tag-to-format map)

/**
 * Standard JSON encodings for all built-in special types.
 *
 * In each case, the tag string (e.g. `"Link@1"`) is passed to the context's
 * internal `wrapTag()` method, which prepends `/` to produce the JSON key
 * (e.g. `"/Link@1"`).
 */

// Cell references (links to other documents)
// Tag: "Link@1"
// { "/Link@1": { id: string, path: string[], space: string } }

// Errors
// Tag: "Error@1"
// { "/Error@1": { type: string, name: string | null, message: string, stack?: string, cause?: ..., ... } }

// Undefined (stateless -- value is null)
// Tag: "Undefined@1"
// { "/Undefined@1": null }

// Array holes (run-length encoded; value is a positive integer; only valid
// inside arrays)
// Tag: "hole"
// { "/hole": <count> }   e.g. { "/hole": 1 }, { "/hole": 5 }

// Stream markers (stateless -- value is null)
// Tag: "Stream@1"
// { "/Stream@1": null }

// Maps (entry pairs preserve insertion order)
// Tag: "Map@1"
// { "/Map@1": [[key, value], ...] }

// Sets (values preserve insertion order)
// Tag: "Set@1"
// { "/Set@1": [value, ...] }

// Binary data (base64url-encoded per the base64url convention above)
// Tag: "Bytes@1"
// { "/Bytes@1": string }

// Epoch nanoseconds (bigint, encoded per BigInt@1 conventions)
// Tag: "EpochNsec@1"
// { "/EpochNsec@1": string }
//
// The state is the base64url encoding of the bigint value's minimal two's
// complement representation in big-endian byte order — the same encoding
// as BigInt@1.

// Epoch days (bigint, encoded per BigInt@1 conventions)
// Tag: "EpochDays@1"
// { "/EpochDays@1": string }
//
// Same encoding convention as EpochNsec@1 (base64url of two's complement
// big-endian bytes).

// BigInts (base64url of two's complement big-endian bytes; see convention above)
// Tag: "BigInt@1"
// { "/BigInt@1": string }
//
// The state is the base64url encoding of the value's minimal two's complement
// representation in big-endian byte order. The minimum byte length is 1 —
// even `0n` produces a single `0x00` byte. Examples:
//   - `0n`  → single byte 0x00 → "AA"
//   - `1n`  → 0x01             → "AQ"
//   - `-1n` → 0xFF             → "_w"
//   - `128n` → 0x00 0x80       → "AIA"  (leading 0x00 needed: 0x80 alone would decode as -128)
//   - `-128n` → 0x80           → "gA"
// This matches the canonical hash byte format (2-canonical-hash-byte-format.md),
// which already uses two's complement big-endian for BigInt payloads.
```

> **Deserialization validation.** Deserialization cannot assume type safety from
> the wire. Each type handler must validate the format of its state before
> processing. For example, a handler whose state is a base64url string (such as
> `BigInt@1`, `EpochNsec@1`, `EpochDays@1`, or `Bytes@1`) must validate that
> its state is a `string` containing valid base64url (padded or unpadded) before decoding. On
> malformed input — wrong type, invalid format, or missing fields — the handler
> should produce a `ProblematicValue` (see `1-fabric-values.md` Section 3.5)
> rather than throwing or silently producing garbage. This principle applies to
> all type handlers. Wire data is untrusted input. See `1-fabric-values.md`
> Section 7.4 for the broader principle that applies to all code consuming
> deserialized values.

> **Sparse array encoding in JSON.** Even when an array contains holes, it is
> serialized as a JSON array. Runs of consecutive holes are represented by
> `hole` entries, each carrying the run length as a positive integer. This
> preserves the array-as-array structure while efficiently encoding sparse
> arrays:
>
> - `[1, , undefined, 3]` serializes as
>   `[1, { "/hole": 1 }, { "/Undefined@1": null }, 3]`.
> - `[1, , , , 5]` serializes as `[1, { "/hole": 3 }, 5]`.
> - A very sparse array like `a = []; a[1000000] = 'x'` serializes as
>   `[{ "/hole": 1000000 }, "x"]`.

## 4. Detection

A value is a special type if:

1. It is a plain object.
2. It has exactly one key.
3. That key starts with `/`.

This rule is quick to check and provides maximum flexibility to evolve the key
format.

## 5. Stateless Types

Types that require no reconstruction state use `null` as the value:

```json
{ "/Stream@1": null }
```

Both `null` and `{}` are acceptable for "no state needed." `null` is the
conventional choice, as it is slightly more idiomatic for signaling absence.
The distinction between "`null` state" and "no state needed" is implied by the
type being represented, not by the wire encoding.

## 6. Escaping

Two escape mechanisms handle cases where user data might be mistaken for
special types.

### `/object` — Single-Layer Escape

Wraps a plain object whose key(s) might look like special types. The values
are still processed normally during deserialization:

```json
{ "/object": { "/myKey": { "/Link@1": { "id": "..." } } } }
```

Deserializes to: `{ "/myKey": <reconstructed Link> }`. The `/object` wrapper
is stripped; inner keys are taken literally; inner values go through normal
deserialization.

**When the serializer emits `/object`:** During serialization, if a plain object
has exactly one string key that starts with `/`, the serializer wraps it in
`/object` to prevent the deserializer from misinterpreting it as a tagged type.
If the object has multiple keys, no wrapping is needed (since tagged types
always have exactly one key).

### `/quote` — Fully Literal

Wraps a value that should be returned exactly as-is, with no deserialization
of any nested special forms:

```json
{ "/quote": { "/Link@1": { "id": "..." } } }
```

Deserializes to: `{ "/Link@1": { "id": "..." } }` — the inner structure is
*not* reconstructed. It remains a plain object.

**Freeze guarantee.** Although `/quote` skips type-tag interpretation, the
result is still deep-frozen (arrays and plain objects within the quoted value
are frozen via `Object.freeze()`). The immutability guarantee (see
`1-fabric-values.md` Section 2.9) is a property of deserialization output, not
of whether reconstruction occurred. A caller receiving a value from the
context's `decode()` can always assume it is immutable, regardless of whether
it came from a `/quote` path, a reconstructed type, or a plain literal.

Use cases:
- Storing schemas or examples that describe special types without instantiating
  them
- Metaprogramming and introspection
- Optimization: skip deserialization when the subtree is known to be plain data
- Round-tripping JSON structures that happen to look like special types

### When to Use Which

- `/object`: You have a plain object with a slash-prefixed key, but values
  should still be interpreted normally.
- `/quote`: You want the entire subtree treated as literal JSON data.

## 7. Serialization Context Responsibilities

The JSON encoding context's internal `wrapTag()` / `unwrapTag()` methods
generate and parse `/<Type>@<Version>` keys. The context is also responsible
for:

- Re-wrapping unknown types using the `typeTag` preserved in
  `UnknownValue` and `ExplicitTagValue`.
- Managing the class registry for deserialization of known `FabricInstance`
  types (e.g., `FabricError`, `FabricMap`, `FabricSet`, `FabricRegExp`).
- Providing a narrow `TypeHandlerCodec` view to type handlers during tree
  walking, exposing only `wrapTag()` and `getTagFor()`.

Note: `/object` escaping (Section 6) is applied directly by the context's
private `serialize()` method in its plain-objects path, since it is structural
escaping rather than type encoding.

## 8. Unknown Type Handling

When a JSON context encounters a `/<Type>@<Version>` key it doesn't recognize,
it wraps the data in `UnknownValue` (see `1-fabric-values.md` Section 3) to
preserve it for round-tripping.

## 9. `/`-Key Reservation Rule

The `/` prefix in key space is wholly owned by the encoding system. Any object
containing **any** key that starts with `/` — regardless of how many other keys
the object has — is a **reserved form**. Plain objects in the data model never
have `/`-prefixed keys; the presence of any such key marks the object as a
tagged or otherwise reserved encoding.

Specifically:

- **Objects with a bare `"/"` key** (i.e., the tag name is empty after
  stripping the leading `/`) are always encoding errors. No valid tag has an
  empty name.
- **Single-key objects** whose sole key starts with `/` are either a tagged
  value of a known type (e.g. `{ "/Error@1": ... }`), a built-in escape
  (`/object`, `/quote`), or an encoding error. Unrecognized tags must be
  treated as `ProblematicValue`.
- **Multi-key objects** containing one or more `/`-prefixed keys are also
  reserved — they are not valid plain objects. Implementations must not treat
  such objects as plain data; they must be flagged as encoding errors or
  treated as `ProblematicValue`.

The `/object` escape (Section 6) ensures that legitimate plain objects with
`/`-prefixed keys are always wrapped before reaching the wire, so a conforming
encoder will never emit a plain-object form that violates this rule. A
conforming decoder that encounters a violation should treat it as an encoding
error.
