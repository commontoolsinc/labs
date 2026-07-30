# JSON Encoding for Fabric Values

This document specifies the JSON-compatible wire format used to represent
fabric values, including the `fvj1:` encoding prefix, the tagged-object
convention, escaping mechanisms, serialization context responsibilities, and
the reservation rules for `/`-prefixed keys.

## Status

Draft formal spec — extracted from Section 5 of `1-fabric-values.md`.

---

## 1. Overview

This section specifies the JSON-compatible wire format for special types. While
the system will maintain a JSON encoding indefinitely (for debugging and
interoperability), other wire and storage formats (e.g., CBOR) may represent
types more directly without layering on JSON.

### 1.1 Encoding Prefix

Every encoded fabric value carries an unambiguous textual prefix, before the
JSON itself:

```
fvj1:<json>
```

The literal string `fvj1:` stands for "Fabric Value JSON, version 1". Its
purpose is to make the encoded form distinguishable, on inspection, from
arbitrary JSON produced by some other source — a brief peek at the start of
a string is sufficient to tell whether it carries a fabric-value payload.

- A conforming **encoder** emits the prefix exactly once, immediately before
  the JSON body, on every encoded value (including encoded primitives — e.g.,
  the number `42` encodes as the seven-character string `fvj1:42`).
- A conforming **decoder** verifies the prefix is present before parsing the
  remainder as JSON, and strips the prefix before processing.
- A short detection helper (`seemsLikeJsonEncodedFabricValue`) tests for the
  prefix without parsing — useful for routing arbitrary input through the
  right decode path.

**Forward compatibility.** The trailing `1` is a version digit, reserving the
prefix space for future incompatible revisions of the wire format. Should the
encoding ever evolve in a way older decoders cannot interpret, a new prefix
(`fvj2:`, etc.) signals the change; older decoders can reject the input
cleanly rather than parsing it incorrectly. The current spec defines only
`fvj1:`.

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
> values, and to the `hash` field of `Hash@1` state.

```typescript
// Illustrative tag-to-format map. The canonical tag-string constants live
// in `packages/data-model/codec-common/codec-type-tags.ts`
// (`CODEC_TYPE_TAGS`) and `codec-meta-tags.ts` (`CODEC_META_TAGS`).

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

// Content hashes (see `1-fabric-values.md` Section 1.4.9)
// Tag: "Hash@1"
// { "/Hash@1": { tag: string, hash: string } }
//
// `tag` is the algorithm tag (e.g. "fid1"); `hash` is the hash bytes as an
// unpadded base64url string (per the convention above). On
// deserialization, a non-object state or non-string fields produce a
// `ProblematicValue` (see `1-fabric-values.md` Section 3.5) per the
// general codec-validation rule below.

// Regular expressions (see `1-fabric-values.md` Section 1.4.5)
// Tag: "RegExp@1"
// { "/RegExp@1": { source: string, flags: string, flavor: string } }
//
// `source` is the pattern string; `flags` is the flag string (e.g. "gi");
// `flavor` identifies the regex dialect (e.g. "es2025", the default). On
// deserialization, a non-object state produces a `ProblematicValue`, as
// does an `es2025` pattern that fails native `RegExp` construction;
// non-`es2025` flavors are stored faithfully without syntax validation
// (their dialects cannot be validated here).

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
// This matches the hash byte format (2-hash-byte-format.md), which already
// uses two's complement big-endian for BigInt payloads.

// Special numeric values that JSON cannot represent natively.
// Tag: "SpecialNumber@1"
// { "/SpecialNumber@1": string }
//
// The state is one of exactly four literal strings:
//   - "-0"          → the negative-zero value
//   - "NaN"         → Number.NaN (any input NaN bit pattern serializes as
//                     this single literal and round-trips back to NaN)
//   - "+Infinity"   → positive infinity
//   - "-Infinity"   → negative infinity
//
// String state (rather than a JSON number) is used because JSON.stringify
// emits `null` for NaN/±Infinity and drops the sign on -0; a numeric-state
// form would be lossy through the JSON layer. On deserialization, any state
// other than these four literals — including a non-string state — produces
// a `ProblematicValue` (see `1-fabric-values.md` Section 3.5) per the
// general codec-validation rule below.
//
// Whether such values reach this encoder depends on the fabric-value
// conversion gate; see `1-fabric-values.md` Section 4.9. The wire format
// above is the encoder's contract regardless of how the values arrived.

// Registry-interned symbols (`Symbol.for(key)`).
// Tag: "Symbol@1"
// { "/Symbol@1": string }
//
// The state is the registry key — the JavaScript string returned by
// `Symbol.keyFor(s)`. On deserialization, `Symbol.for(state)` retrieves
// (or creates) the registry symbol with the matching key, so the result
// is `===` to any other `Symbol.for(state)` in the same realm.
//
// Unique symbols (`Symbol(desc)`, where `Symbol.keyFor(s)` returns
// `undefined`) have no portable representation. The codec's
// `canEncode()` returns `false` for them, which routes them to the
// registry's "unhandled value" path rather than coercing them silently
// to a registry key. On deserialization, any state other than a string
// yields a `ProblematicValue` (see `1-fabric-values.md` Section 3.5)
// per the general codec-validation rule below.
//
// Whether a symbol value reaches this encoder depends on the fabric-value
// conversion gate; see `1-fabric-values.md` Section 4.9. The wire format
// above is the encoder's contract regardless of how the value arrived.

// Admitted callable pattern, module/lift, and handler factories.
// Tag: "Factory@1"
// { "/Factory@1": FactoryStateV1 }
```

### 3.1 `Factory@1`

`Factory@1` is the one callable Fabric-value encoding. The callable itself is
the value; the wire format does not introduce a wrapper object or a separate
factory-class tag. Its state is exactly one of these discriminated forms:

```typescript
import type {
  FabricPlainObject,
  FabricValue,
  JSONSchema,
} from "@commonfabric/api";

type FactoryArtifactRef = {
  identity: string; // canonical unpadded base64url of exactly 32 bytes
  symbol: string; // non-empty module export or __cfReg name
};

type FactoryStateV1 =
  | {
    kind: "pattern";
    ref: FactoryArtifactRef;
    argumentSchema: JSONSchema;
    resultSchema: JSONSchema;
    paramsSchema?: JSONSchema;
    params?: FabricPlainObject;
    defaultScope?: "space" | "user" | "session";
    spaceSelector?: FabricValue;
  }
  | {
    kind: "module";
    ref: FactoryArtifactRef;
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    defaultScope?: "space" | "user" | "session";
  }
  | {
    kind: "handler";
    ref: FactoryArtifactRef;
    contextSchema?: JSONSchema;
    eventSchema?: JSONSchema;
  };
```

Validation is exact and fail-closed:

- `identity` is the complete content-addressed builder artifact identity. It is
  never `$implRef`, a host/session pseudo-ref, or an implementation-function
  identity.
- Every object admits only the fields shown for its discriminant. Required
  fields must be present; optional fields with an `undefined` value are invalid
  and must instead be omitted.
- Schemas are canonical JSON values. `defaultScope` is one of the three literal
  values shown. `params` must be a plain Fabric-value object and requires
  `paramsSchema`.
- Nested `params` and `spaceSelector` values are recursively encoded, so a
  nested admitted factory receives another `/Factory@1` tag. Arbitrary
  JavaScript functions remain invalid at every depth.
- The wire state never carries an artifact source space, execution authority,
  or trusted `FrameworkProvided` paths. Those are runner/compiler provenance.

Context-free decode validates and freezes the complete state, then returns an
inert branded callable shell. Calling that shell throws. Deserialization alone
does not execute code or establish execution trust; only the runner-owned
materialization boundary may resolve `ref` against a trusted artifact source
space and produce an executable factory. Re-encoding an inert shell yields the
same canonical state.

> **Deserialization validation.** Deserialization cannot assume type safety from
> the wire. Each codec must validate the format of its state in `decode()`
> before processing. For example, a codec whose state is a base64url string
> (such as
> `BigInt@1`, `EpochNsec@1`, `EpochDays@1`, or `Bytes@1`) must validate that
> its state is a `string` containing valid base64url (padded or unpadded) before decoding. On
> malformed input — wrong type, invalid format, or missing fields — the codec
> should produce a `ProblematicValue` (see `1-fabric-values.md` Section 3.5)
> rather than silently producing garbage; a codec may either construct the
> `ProblematicValue` directly or throw and rely on a lenient encoding
> context to do the wrapping (see `1-fabric-values.md` Section 4.5). This
> principle applies to
> all codecs. Wire data is untrusted input. See `1-fabric-values.md`
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

In the JSON wire format, any plain object containing at least one key that
starts with `/` is a **reserved form** — it is either a tagged value, a
built-in escape, or an encoding error.

> **Data level vs. wire level.** User-data plain objects may carry any keys,
> including `/`-prefixed ones. The `/object` and `/quote` escapes (Section 6)
> exist precisely to represent such objects in encoded form without ambiguity.
> A conforming encoder always wraps user-data objects that contain `/`-prefixed
> keys via one of these escapes before they reach the wire, so bare
> `/`-prefixed keys in the wire format are always encoding signals, never
> literal user-data keys.

The common case — a **tagged value** — is a single-key object whose sole key
starts with `/`:

1. It is a plain object.
2. It has exactly one key.
3. That key starts with `/`.

Multi-key objects that contain one or more `/`-prefixed keys among their keys
are also reserved (see Section 9). They are not treated as plain objects.

This reservation provides maximum flexibility to evolve the encoding without
ambiguity about what is an encoding signal and what is user data.

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
has any string key that starts with `/` — regardless of how many other keys the
object has — the serializer wraps it in one of these escapes (either `/object`
or `/quote`; see "Encoder dispatch" below). This prevents the deserializer from
treating the object as a reserved form. `/object` is always a valid choice; the
distinction between `/object` and `/quote` is a recommendation about which form
makes the wire output most readable, not a correctness requirement.

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

### Encoder Dispatch (Recommended Best Practice)

When the encoder encounters a plain object that needs an escape (i.e., any plain
object containing one or more `/`-prefixed keys), both `/object` and `/quote`
are valid choices. The recommended best practice is:

- If the entire subtree to be wrapped is fully literal — i.e., it contains no
  values that would themselves need encoding as special types — emit `/quote`.
- Otherwise (some descendant value still needs to be processed as a special
  type during deserialization), emit `/object`.

The motivation for the recommendation is wire-format readability and round-trip
fidelity: a `/quote`-wrapped literal subtree appears in the wire format as
itself, with no per-key escaping or restructuring, which is easier for humans to
read and easier for tools to compare. Conversely, `/object` is required (not
just preferred) whenever any descendant value still needs encoding, because
`/quote` would suppress that encoding entirely.

This is a **recommendation, not a requirement**. A conforming encoder may emit
`/object` in either case; the wire format is unambiguous either way. **A
conforming decoder must accept both forms.** See `1-fabric-values.md` Section
2.9 (immutability) and the freeze guarantee under `/quote` above for the
properties a decoder preserves regardless of which form it sees.

## 7. Serialization Context Responsibilities

The JSON encoding context's internal `wrapTag()` / `unwrapTag()` methods
generate and parse `/<Type>@<Version>` keys. The context is also responsible
for:

- Owning recursion and tag-wrapping around the shallow per-type codecs
  (see `1-fabric-values.md` Sections 2.4 and 4.5): tags come from
  `codec.tagForValue(value)` on encode, and decode routes each tag to its
  registered codec via the `CodecRegistry`.
- Re-wrapping unknown types using the per-instance `wireTypeTag` preserved
  in `UnknownValue` / `ProblematicValue` (read back through their codecs'
  `tagForValue()`), and constructing `UnknownValue` for tags with no
  registered codec.
- In lenient mode, converting codec `decode()` throws into
  `ProblematicValue`.

Note: `/object` escaping (Section 6) is applied directly by the context's
private encode walker in its plain-objects path, since it is structural
escaping rather than type encoding.

## 8. Unknown Type Handling

When a JSON context encounters a `/<Type>@<Version>` key it doesn't recognize,
it wraps the data in `UnknownValue` (see `1-fabric-values.md` Section 3) to
preserve it for round-tripping.

## 9. `/`-Key Reservation Rule

The `/` prefix is wholly owned by the encoding system in the wire format. Any
object containing **any** key that starts with `/` — regardless of how many
other keys the object has — is a **reserved form** in the encoded
representation. User-data plain objects may contain `/`-prefixed keys at the
data level, but a conforming encoder always wraps them via `/object` or `/quote`
(Section 6) before they reach the wire. The presence of a bare `/`-prefixed key
in a wire-format object therefore always signals a tagged value, built-in
escape, or encoding error — never a literal user-data key.

Specifically:

- **Objects with a bare `"/"` key** (i.e., the tag name is empty after
  stripping the leading `/`) are always encoding errors — produce
  `ProblematicValue`. No valid tag has an empty name.
- **Single-key objects** whose sole key starts with `/` are either a tagged
  value of a known type (e.g. `{ "/Error@1": ... }`), a built-in escape
  (`/object`, `/quote`), or an unrecognized tag. A syntactically well-formed
  but unrecognized tag (e.g. `{ "/Future@2": ... }`) must be treated as
  `UnknownValue` (see Section 8) to preserve it for round-tripping. Structural
  violations — e.g. a tag name that cannot be a valid type identifier — should
  produce `ProblematicValue`.
- **Multi-key objects** containing one or more `/`-prefixed keys are structural
  encoding errors — produce `ProblematicValue`. They are not valid plain
  objects.

The `/object` escape (Section 6) ensures that legitimate plain objects with
`/`-prefixed keys are always wrapped before reaching the wire, so a conforming
encoder will never emit a plain-object form that violates this rule. A
conforming decoder that encounters a violation should treat it as an encoding
error.

## 10. Plain Object Key Ordering

A conforming encoder **must** emit the keys of every plain object in **UTF-8
byte order**, using the same comparison defined for hashing in
`2-hash-byte-format.md` Section 5:

1. Compare byte-by-byte, treating each byte as an unsigned integer (0--255).
2. At each position, the byte with the smaller unsigned value comes first.
3. If one key is a prefix of another, the shorter key comes first.

This requirement applies to every plain object that reaches the wire,
including:

- Bare plain objects (no `/`-prefixed keys).
- Plain objects wrapped in `/object` (Section 6) — the keys of the wrapped
  inner object must be sorted.
- Plain objects wrapped in `/quote` (Section 6) — the keys of the quoted
  literal must be sorted.

> **Why sort.** Sorting makes the JSON wire form **canonical**: two plain
> objects with the same keys and values produce the same JSON bytes regardless
> of the order in which their keys were inserted. This in turn lets two
> independently-built encoders agree on a single byte-for-byte encoding for the
> same logical value, which simplifies content addressing, deduplication, and
> diffing. The sort key is the same UTF-8 byte order used by hashing, so the
> two systems share one specification of "canonical key order."
>
> The keys of a single-key tagged object (`/<Type>@<Version>`, `/object`,
> `/quote`, `/hole`, etc.) are trivially "sorted" — there is only one key.
> The requirement is meaningful only for plain objects with two or more keys,
> and for the inner contents of `/object` and `/quote` wrappers.

> **JS implementation note.** JavaScript's native string comparison (`<`, `>`,
> `Array.prototype.sort` with no comparator) sorts by UTF-16 code units, which
> differs from UTF-8 byte order when supplementary characters (U+10000 and
> above) are present. An implementation must use a UTF-8-aware comparator
> (or equivalently, sort by Unicode code point) when supplementary characters
> may appear in keys. See `2-hash-byte-format.md` Section 5 for the detailed
> rationale and example.

> **Decoder behavior.** A decoder is **not** required to validate that incoming
> keys are sorted. The host language's own object representation may impose its
> own iteration order on the decoded value (for example, in JavaScript,
> integer-index-like keys iterate in numeric order ahead of other string keys,
> regardless of the order in which they appeared on the wire). A conforming
> encoder re-establishes UTF-8 canonical key order on output regardless of the
> order in which keys were received or the host language's iteration rules.
