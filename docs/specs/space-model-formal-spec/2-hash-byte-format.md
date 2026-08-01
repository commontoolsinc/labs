# Hash Byte Format

This document specifies the precise byte-level format for hashing of
`FabricValue`s. It is the implementation-ready companion to Section 6.4 of the
formal spec (`1-fabric-values.md`), which defines the algorithm at the
pseudocode level. The tag byte assignments used here are defined in formal spec
Section 6.3.

An implementer can work from this document alone to produce a byte-for-byte
compatible hasher. All encodings are deterministic; two conforming
implementations must produce identical byte streams (and therefore identical
hashes) for any given `FabricValue`.

## Status

Draft byte-level spec — extracted from the formal spec Section 6.3 and the
implementation plan Phase 6.1.

---

## 1. Digest Algorithm

The hash function is **SHA-256** (FIPS 180-4). All byte sequences described in
this document are fed to a SHA-256 context in the order specified.

The digest output is **32 raw bytes** (256 bits). The `hashOf()` function wraps
the raw bytes into a `FabricHash` instance (Section 1.4.9 of the formal spec)
with algorithm tag `fid1`. Callers who need a string representation call
`toString()` on the result, which produces `fid1:<base64urlhash>` (unpadded
base64url, RFC 4648 Section 5). `hashStringOf()` returns the base64url hash
directly as a plain string, avoiding `FabricHash` allocation when only the
string form is needed.

> **Future addition.** BLAKE2b is listed as a recommended second algorithm in
> the formal spec. When added, it will use the same byte-level input format
> defined here; only the digest function changes.

---

## 2. Type Tag Bytes

Every value fed to the hasher begins with a single-byte type tag. The tag
prevents cross-type collisions (e.g., the number `0` and the boolean `false`
produce different hashes even though both could be represented as a zero byte).

The authoritative tag assignments are in formal spec Section 6.3. Tags are
organized into four categories by high nibble: **meta** (`0x0N`) for structural
markers like `TAG_END` and `TAG_HOLE`, **compound** (`0x1N`) for containers
whose children are tagged values, **primitive** (`0x2N`) for leaf value
types, and **optimized** (`0xFN`) for hash-level encodings of primitive values
that substitute a digest for the raw payload (see Section 4.4 for the long-string
optimization). All unassigned values are reserved for future use.

---

## 3. Encoding Conventions

- **Unsigned LEB128** — variable-length encoding for non-negative integers. Each
  byte uses 7 data bits (bits 0--6) and 1 continuation bit (bit 7). If the
  continuation bit is `1`, another byte follows; if `0`, the encoding is
  complete. Bytes are emitted in little-endian order (least significant group
  first). Used for byte-length prefixes on raw payloads (strings, bigints, byte
  arrays) and hole run counts.

  Examples: `0` encodes as `0x00` (1 byte); `5` as `0x05` (1 byte); `127` as
  `0x7F` (1 byte); `128` as `0x80 0x01` (2 bytes); `300` as `0xAC 0x02`
  (2 bytes).

- **`TAG_END` sentinel** — compound types (arrays and objects) use `TAG_END`
  (`0x00`) to mark the end of their element or key-value sequence, instead of
  encoding a count prefix. This is unambiguous because `TAG_END` is not a valid
  value type tag — it cannot appear as the start of a child element.

---

## 4. Encoding Per Type

For each type, the subsections below specify the exact byte sequence fed to the
SHA-256 context. "Feed" means the bytes are appended to the running hash state
in order; the overall hash is finalized only after the entire value tree has been
traversed.

### 4.1 `null`

```
Bytes: TAG_NULL
       0x20
```

Total: 1 byte. No payload.

### 4.2 `boolean`

```
Bytes: TAG_BOOLEAN  PAYLOAD
       0x22         0x01   (true)
       0x22         0x00   (false)
```

Total: 2 bytes.

### 4.3 `number`

```
Bytes: TAG_NUMBER  IEEE_754_FLOAT64_BE
       0x23        <8 bytes>
```

Total: 9 bytes.

The payload is the IEEE 754 binary64 representation of the number, in
big-endian byte order. All JavaScript numbers are accepted, including the
four special values that JSON cannot represent natively (`-0`, `NaN`,
`+Infinity`, `-Infinity`).

**Encoding rules:**

- **Negative zero (`-0`)** is encoded with its natural sign bit. The 8-byte
  payload for `-0` is `80 00 00 00 00 00 00 00`, distinct from the payload
  for `+0` (`00 00 00 00 00 00 00 00`). The two values therefore produce
  different hashes.

- **`+Infinity`** is encoded as `7F F0 00 00 00 00 00 00`.

- **`-Infinity`** is encoded as `FF F0 00 00 00 00 00 00`.

- **`NaN`** is canonicalized to a single representation: the **quiet NaN**
  payload `7F F8 00 00 00 00 00 00`. Any input NaN bit pattern (signaling,
  quiet, with arbitrary payload bits) hashes via this canonical 8-byte
  sequence. This ensures all NaN values produce identical hashes, matching
  fabric value-equality, under which all `NaN`s are equal (`Object.is(NaN,
  NaN)` is `true`; see `1-fabric-values.md` Section 6.7). Note this is
  distinct from the `===` operator, under which a `NaN` compares unequal even
  to itself.

> **Conversion-gate cross-reference.** Whether `-0`, `NaN`, or `±Infinity`
> reach this layer depends on the fabric-value conversion gate; see
> `1-fabric-values.md` Section 4.9. The byte-level encoding above is the
> hasher's contract regardless of how the values arrived.

### 4.4 `string`

Strings use one of two encodings based on their UTF-8 byte length. The
threshold is **64 bytes** (inclusive): strings whose UTF-8 encoding is 64 bytes
or fewer use the **direct** form, and strings whose UTF-8 encoding exceeds 64
bytes use the **hashed** form. The threshold compares against the UTF-8 byte
length, not the JavaScript `string.length` (UTF-16 code units).

**Direct form** (UTF-8 length ≤ 64 bytes):

```
Bytes: TAG_STRING  LENGTH_LEB128  UTF8_BYTES
       0x24        <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the byte length of the UTF-8
encoding.

- **Length**: The number of bytes in the UTF-8 encoding of the string, encoded
  as unsigned LEB128.
- **Payload**: The string encoded as UTF-8 bytes. Characters in the Basic
  Multilingual Plane (U+0000--U+FFFF) use 1--3 bytes; supplementary characters
  (U+10000 and above) use 4 bytes.

Empty string (`""`) is encoded as `0x24 0x00` — the tag plus a zero-length
prefix and no payload bytes.

**Hashed form** (UTF-8 length > 64 bytes):

```
Bytes: TAG_STRING_HASH  SHA256_OF_UTF8
       0xF0             <32 bytes>
```

Total: 33 bytes, regardless of the string's length.

- **Payload**: The raw 32-byte SHA-256 digest (per Section 1, FIPS 180-4) of
  the string's UTF-8 byte sequence. The digest bytes are emitted in their
  natural order as produced by SHA-256 (bytes 0 through 31 of the digest). No
  transformation, truncation, or re-encoding is applied. No length prefix is
  emitted in this form — the digest is always exactly 32 bytes.

This is a Merkle-style optimization: the hasher substitutes a SHA-256 of the
UTF-8 bytes for the raw payload when the raw payload would be long. It shortens
the byte stream fed to the outer hasher and enables a string-representation
cache keyed by the JavaScript string. Because the two encodings use different
type tags (`0x24` vs. `0xF0`), they are unambiguous and cannot collide.

**The two forms produce different hashes for the same string.** The
64-byte threshold is part of the format, and conforming implementations
must use the threshold when deciding which form to emit.

The hashed form applies everywhere this spec encodes a string via the
`TAG_STRING` layout: standalone strings (this section), `symbol` keys
(Section 4.6), object keys (Section 4.13), `FabricInstance` type tags
(Section 4.14), `FabricHash` algorithm tags (Section 4.11), and
`FabricRegExp` source/flags/flavor strings (Section 4.16).

### 4.5 `bigint`

```
Bytes: TAG_BIGINT  LENGTH_LEB128  TWO_COMP_BYTES
       0x26        <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the minimal encoding length.

- **Length**: The number of bytes in the two's-complement representation,
  encoded as unsigned LEB128.
- **Payload**: The value encoded as a signed two's-complement integer in
  big-endian byte order, using the **minimal** number of bytes. Minimal means:
  - The value `0n` is encoded as a single byte `0x00` (length = 1).
  - Positive values use the fewest bytes such that the high bit of the first
    byte is `0` (to distinguish from negative values). For example, `127n` is
    `0x7F` (1 byte), but `128n` is `0x00 0x80` (2 bytes, because `0x80` alone
    would be interpreted as `-128`).
  - Negative values use the fewest bytes such that the high bit of the first
    byte is `1`. For example, `-1n` is `0xFF` (1 byte), `-128n` is `0x80`
    (1 byte), and `-129n` is `0xFF 0x7F` (2 bytes).

### 4.6 `symbol`

```
Bytes: TAG_SYMBOL  KEY_STRING
       0x2A        <string, §4.4>
```

- **Key string**: The result of `Symbol.keyFor(s)` — a JavaScript string —
  encoded as a complete tagged string value per Section 4.4. Concretely,
  this emits either the direct form (`TAG_STRING` + LEB128 length + UTF-8
  bytes) for keys whose UTF-8 encoding is 64 bytes or fewer, or the hashed
  form (`TAG_STRING_HASH` + 32-byte SHA-256 of the UTF-8) for longer keys.

Only **registry-interned** symbols (those for which `Symbol.keyFor(s)`
returns a string) are hashable. **Unique** symbols (`Symbol(desc)`, where
`Symbol.keyFor(s)` returns `undefined`) have no portable representation; a
conforming implementation must throw rather than producing a hash. The
required error message is `"Cannot hash unique (uninterned) symbol"`.

The two-tag encoding (`TAG_SYMBOL` followed by `TAG_STRING` / `TAG_STRING_HASH`)
ensures that a `Symbol.for("foo")` and the string `"foo"` produce different
hashes, while inheriting the short/long string-encoding delegation
unchanged.

> **Conversion-gate cross-reference.** Whether a symbol value reaches this
> layer depends on the fabric-value conversion gate; see
> `1-fabric-values.md` Section 4.9. The byte-level encoding above is the
> hasher's contract regardless of how the value arrived.

### 4.7 `undefined`

```
Bytes: TAG_UNDEFINED
       0x21
```

Total: 1 byte. No payload.

### 4.8 `FabricBytes`

```
Bytes: TAG_BYTES  LENGTH_LEB128  RAW_BYTES
       0x25       <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the byte array length.

- **Length**: The number of bytes in the array, encoded as unsigned LEB128.
- **Payload**: The raw bytes of the underlying byte sequence, in order.

Empty byte array is encoded as `0x25 0x00` — the tag plus a zero-length prefix
and no payload bytes.

### 4.9 `FabricEpochNsec`

```
Bytes: TAG_EPOCH_NSEC  LENGTH_LEB128  TWO_COMP_BYTES
       0x27            <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the minimal encoding length.

`FabricEpochNsec` represents a nanosecond-precision Unix epoch timestamp. It
is a `FabricPrimitive` subclass and has a dedicated type tag.

- **Length**: The number of bytes in the two's-complement representation of the
  wrapped `bigint` value, encoded as unsigned LEB128.
- **Payload**: The value encoded identically to `bigint` (Section 4.5): signed
  two's-complement, big-endian, minimal bytes.

The encoding is structurally identical to `TAG_BIGINT` but uses a different type
tag (`0x27` instead of `0x26`), ensuring that `FabricEpochNsec(42n)` and
`42n` produce distinct hashes.

### 4.10 `FabricEpochDays`

```
Bytes: TAG_EPOCH_DAYS  LENGTH_LEB128  TWO_COMP_BYTES
       0x28            <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the minimal encoding length.

`FabricEpochDays` represents a day-precision Unix epoch timestamp. It is a
`FabricPrimitive` subclass and has a dedicated type tag.

- **Length**: The number of bytes in the two's-complement representation of the
  wrapped `bigint` value, encoded as unsigned LEB128.
- **Payload**: The value encoded identically to `bigint` (Section 4.5): signed
  two's-complement, big-endian, minimal bytes.

The encoding is structurally identical to `TAG_BIGINT` but uses a different type
tag (`0x28` instead of `0x26`), ensuring that `FabricEpochDays(42n)` and
`42n` produce distinct hashes. It also differs from `FabricEpochNsec` (`0x27`)
so the two temporal types are always distinguishable.

### 4.11 `FabricHash`

```
Bytes: TAG_HASH  ALG_TAG_STRING   HASH_LEN_LEB128  HASH_BYTES
       0x29       <string, §4.4>   <1+ bytes>       <varies>
```

`FabricHash` represents a content identifier — a hash with an algorithm
tag. It is a `FabricPrimitive` subclass and has a dedicated type tag.

- **Algorithm tag**: The algorithm tag string (e.g., `"fid1"`) encoded as a
  complete tagged string value per Section 4.4. Concretely, this emits either
  the direct form (`TAG_STRING` + LEB128 length + UTF-8 bytes) for tags whose
  UTF-8 encoding is 64 bytes or fewer, or the hashed form (`TAG_STRING_HASH` +
  32-byte SHA-256 of the UTF-8) for longer tags. Algorithm tags are always
  short in practice, so the direct form is used.
- **Hash byte length**: The number of raw hash bytes that follow, encoded as
  unsigned LEB128.
- **Hash bytes**: The raw hash bytes, in order.

The two-field encoding ensures that content IDs with different algorithm tags
but identical hash bytes produce different hashes, and vice versa.

### 4.12 Array

```
Bytes: TAG_ARRAY  ELEMENT_0  ELEMENT_1  ...  ELEMENT_N-1  TAG_END
       0x10       <varies>   <varies>        <varies>      0x00
```

- **Elements**: Each element is hashed recursively in index order (0, 1, 2,
  ...). Present elements are fed to the hasher as complete tagged values
  (starting with their own type tag). Holes are encoded using run-length
  encoding (see Section 4.15).
- **Terminator**: `TAG_END` (`0x00`) marks the end of the element sequence.
  This is unambiguous because `TAG_END` cannot appear as the start of any
  element value.

Empty array (`[]`) is encoded as `0x10 0x00` — the tag immediately followed by
`TAG_END`.

### 4.13 Object

```
Bytes: TAG_OBJECT  KEY_0  VALUE_0  KEY_1  VALUE_1  ...  TAG_END
       0x11        <var>  <var>    <var>  <var>          0x00
```

- **Key-value pairs**: Emitted in **sorted order**. Keys are sorted
  lexicographically by their UTF-8 byte representation (see Section 5). For each
  key-value pair:
  - The **key** is encoded as a complete tagged string value per Section 4.4
    — direct form (`TAG_STRING` + LEB128 length + UTF-8 bytes) for keys of 64
    UTF-8 bytes or fewer, or hashed form (`TAG_STRING_HASH` + 32-byte SHA-256
    of the UTF-8) for longer keys. The threshold applies per-key
    independently. Sort order is always by the UTF-8 bytes of the key itself
    (see Section 5), regardless of which encoding form is used for the hash
    feed.
  - The **value** is hashed recursively as a complete tagged value.
- **Terminator**: `TAG_END` (`0x00`) marks the end of the key-value sequence.

Empty object (`{}`) is encoded as `0x11 0x00` — the tag immediately followed by
`TAG_END`.

### 4.14 `FabricInstance`

```
Bytes: TAG_INSTANCE  TYPE_TAG_STRING  STATE
       0x12          <string, §4.4>   <recursive>
```

- **Type tag**: The `FabricInstance`'s type tag string (e.g., `"Error@1"`,
  `"Map@1"`, `"Set@1"`), as reported by its codec's `tagForValue()` (see
  `1-fabric-values.md` Section 2.4), encoded as a complete tagged string
  value per Section 4.4. Concretely, this emits either the direct form
  (`TAG_STRING` + LEB128 length + UTF-8 bytes) for type tags of 64 UTF-8 bytes
  or fewer, or the hashed form (`TAG_STRING_HASH` + 32-byte SHA-256 of the
  UTF-8) for longer type tags. Existing type tags are short, so the direct
  form is used in practice.
- **Encoded state**: The value returned by the codec's `encode()`, hashed
  recursively as a complete tagged value.

> **Note on types with dedicated tags.** `FabricBytes`,
> `FabricEpochNsec`, `FabricEpochDays`, `FabricHash`, and `FabricRegExp` are
> **not** hashed via `TAG_INSTANCE`. Each has a dedicated type tag and is
> encoded directly (see Sections 4.8, 4.9, 4.10, 4.11, and 4.16
> respectively). These are all `FabricPrimitive` subclasses — at this
> layer they are hashed from their own stored values, not via their wire
> codecs.

### 4.15 Holes (sparse array elements)

```
Bytes: TAG_HOLE  RUN_COUNT_LEB128
       0x01      <1+ bytes>
```

Total: 1 + len(LEB128) bytes per run (typically 2 bytes for small runs).

Holes appear only within array encodings (Section 4.12). Consecutive holes are
**always coalesced** into maximal runs:

- A single hole at index `i` with present elements at `i-1` and `i+1` is
  encoded as `TAG_HOLE` + LEB128 `1`.
- Three consecutive holes starting at index `i` are encoded as `TAG_HOLE` +
  LEB128 `3` (not three separate `TAG_HOLE` + `1` entries).
- Runs **must** be maximal: an implementation must not split a run of N
  consecutive holes into smaller runs. Doing so would produce a different byte
  stream and therefore a different hash.

> **Distinction.** `TAG_HOLE` (`0x01`), `TAG_UNDEFINED` (`0x21`), and `TAG_NULL`
> (`0x20`) are all distinct. The arrays `[1, , 3]`, `[1, undefined, 3]`, and
> `[1, null, 3]` produce three different hashes.

### 4.16 `FabricRegExp`

```
Bytes: TAG_REGEXP  SOURCE_STRING   FLAGS_STRING    FLAVOR_STRING
       0x2B        <string, §4.4>  <string, §4.4>  <string, §4.4>
```

`FabricRegExp` represents a regular-expression value. It is a
`FabricPrimitive` subclass and has a dedicated type tag; it is hashed from
its own stored strings (below) and is **not** hashed via `TAG_INSTANCE`.

- **Source**: The pattern source string (`regex.source`), encoded as a
  complete tagged string value per Section 4.4 (direct form for sources of 64
  UTF-8 bytes or fewer, hashed form for longer).
- **Flags**: The flag string (e.g. `"gi"`), encoded as a complete tagged
  string value per Section 4.4.
- **Flavor**: The regex dialect identifier (e.g. `"es2025"`), encoded as a
  complete tagged string value per Section 4.4.

The three strings are fed in order — source, then flags, then flavor — with no
enclosing container and no `TAG_END` terminator, since the field count is
fixed. Distinct regex dialects with identical source and flags therefore
produce distinct hashes (the `flavor` field disambiguates them).

---

## 5. Object Key Sorting

Object keys are sorted by their **UTF-8 byte representation**, using the
following comparison:

1. Compare byte-by-byte, treating each byte as an unsigned integer (0--255).
2. At each position, the byte with the smaller unsigned value comes first.
3. If one key is a prefix of another (all bytes match up to the shorter key's
   length), the shorter key comes first.

This is equivalent to the standard lexicographic ordering on byte sequences and
matches the behavior of `Uint8Array` comparison or C's `memcmp` with a
length tie-breaker.

Since all string data in the hash stream uses UTF-8 encoding (Section 4.4),
the sort order and the hash encoding use the same byte representation.

> **UTF-8 byte sort vs. JavaScript string comparison.** JavaScript's native
> string comparison (`<`, `>`, `localeCompare` with no locale) compares by
> UTF-16 code units. This is **not** the same ordering as UTF-8 byte sort when
> supplementary characters (U+10000 and above) are involved:
>
> - In UTF-16, supplementary characters are encoded as surrogate pairs
>   (0xD800--0xDFFF), which sort between BMP characters U+D7FF and U+E000.
> - In UTF-8, supplementary characters have a leading byte of 0xF0 or higher,
>   which sorts after all BMP characters (whose maximum leading byte is 0xEF,
>   for U+FFFF).
>
> For example, U+10000 (UTF-16: `D800 DC00`; UTF-8: `F0 90 80 80`) sorts
> *before* U+E000 (UTF-16: `E000`; UTF-8: `EE 80 80`) in UTF-16 code unit
> order, but *after* it in UTF-8 byte order.
>
> For strings containing only BMP characters (U+0000--U+FFFF) — the practical
> common case for object keys — the two orderings are equivalent. An
> implementation that needs to match the hash sort order must sort by
> UTF-8 bytes (or equivalently, by Unicode code point), not by JavaScript's
> default string comparison, if supplementary characters may appear in keys.

---

## 6. Traversal Order

The overall traversal is depth-first, left-to-right:

1. Feed the type tag byte.
2. For primitive types with variable-length payloads (string, bigint, bytes,
   epoch-nsec, epoch-days, content-id), feed the LEB128 byte-length prefix(es),
   then the payload.
3. For compound types (array, object), recursively hash each child, then feed
   `TAG_END`. Each child's bytes (starting with its own type tag) are fed to
   the **same** hasher — there is no per-child sub-hash.
4. The entire value tree is serialized into one contiguous byte stream, then
   digested once.

The type tags, length prefixes, and `TAG_END` sentinels provide unambiguous
framing.

---

## 7. Illustrative Examples

The following examples show the exact byte stream fed to SHA-256 for several
representative values. Bytes are shown in hexadecimal.

### 7.1 `null`

```
20
```

### 7.2 `true`

```
22 01
```

### 7.3 `false`

```
22 00
```

### 7.4 `42` (number)

```
23  40 45 00 00 00 00 00 00
```

IEEE 754 binary64 for `42.0` is `0x4045000000000000`.

### 7.5 `0` (number)

```
23  00 00 00 00 00 00 00 00
```

`-0` produces a distinct byte stream `23  80 00 00 00 00 00 00 00` (sign
bit set; see Section 4.3).

### 7.6 `"hello"` (string)

`"hello"` is 5 bytes in UTF-8: `0x68`, `0x65`, `0x6C`, `0x6C`, `0x6F`.
Length 5 in LEB128 is `0x05`.

```
24  05  68 65 6C 6C 6F
```

### 7.7 `""` (empty string)

```
24  00
```

### 7.8 `undefined`

```
21
```

### 7.9 `FabricEpochNsec(0n)`

```
27  01  00
```

`TAG_EPOCH_NSEC` (`0x27`), followed by the bigint `0n` encoded as minimal
two's-complement: length 1 (LEB128 `0x01`) and payload `0x00`.

### 7.10 `FabricEpochDays(42n)`

`42n` in minimal two's-complement is `0x2A` (1 byte).

```
28  01  2A
```

`TAG_EPOCH_DAYS` (`0x28`), length 1 (`0x01`), payload `0x2A`.

### 7.11 `FabricHash("fid1", <4 bytes: 0xDE 0xAD 0xBE 0xEF>)`

Algorithm tag `"fid1"` is 4 bytes in UTF-8: `0x66`, `0x69`, `0x64`, `0x31` —
well under the 64-byte threshold, so the direct string form applies. Hash
payload is 4 bytes: `0xDE`, `0xAD`, `0xBE`, `0xEF`.

```
29  24 04 66 69 64 31  04  DE AD BE EF
```

- `TAG_HASH` (`0x29`)
- Algorithm tag (string, §4.4 direct form): `TAG_STRING` (`0x24`), length 4
  (`0x04`), UTF-8 bytes `66 69 64 31`
- Hash byte length 4 (`0x04`)
- Hash bytes: `DE AD BE EF`

### 7.12 `FabricRegExp(/abc/gi)`

`FabricRegExp` is a `FabricPrimitive` with the dedicated tag `TAG_REGEXP`
(`0x2B`); it is hashed by feeding its three component strings — source, flags,
flavor — in that order (Section 4.16). A `FabricRegExp` built from `/abc/gi`
has source `"abc"`, flags `"gi"`, and the default flavor `"es2025"`. All three
strings are under the 64-byte threshold, so each uses the direct string form.

- RegExp tag: `2B`
- Source `"abc"` (3 bytes UTF-8): `24 03 61 62 63`
- Flags `"gi"` (2 bytes UTF-8): `24 02 67 69`
- Flavor `"es2025"` (6 bytes UTF-8): `24 06 65 73 32 30 32 35`

There is no enclosing object and no `TAG_END` terminator — the three fields are
fed positionally.

Full byte stream:
```
2B
24 03 61 62 63
24 02 67 69
24 06 65 73 32 30 32 35
```

### 7.13 `[1, , 3]` (sparse array)

Three elements: number `1`, one hole, number `3`. Terminated by `TAG_END`.

- Tag: `10`
- Element 0 (`1`): `23 3F F0 00 00 00 00 00 00` (IEEE 754 for `1.0`)
- Element 1 (hole, run of 1): `01 01`
- Element 2 (`3`): `23 40 08 00 00 00 00 00 00` (IEEE 754 for `3.0`)
- End: `00`

Full byte stream:
```
10
23 3F F0 00 00 00 00 00 00
01 01
23 40 08 00 00 00 00 00 00
00
```

### 7.14 `[]` (empty array)

```
10 00
```

`TAG_ARRAY` immediately followed by `TAG_END`.

### 7.15 `{ a: 1, b: 2 }` (object)

Two keys. UTF-8 sort order: `"a"` (0x61) < `"b"` (0x62). Terminated by
`TAG_END`.

- Tag: `11`
- Key `"a"` (1 byte in UTF-8): `24 01 61`
- Value `1`: `23 3F F0 00 00 00 00 00 00`
- Key `"b"` (1 byte in UTF-8): `24 01 62`
- Value `2`: `23 40 00 00 00 00 00 00 00` (IEEE 754 for `2.0`)
- End: `00`

Full byte stream:
```
11
24 01 61
23 3F F0 00 00 00 00 00 00
24 01 62
23 40 00 00 00 00 00 00 00
00
```

### 7.16 `{}` (empty object)

```
11 00
```

`TAG_OBJECT` immediately followed by `TAG_END`.

### 7.17 `[1, undefined, 3]` vs. `[1, , 3]` vs. `[1, null, 3]`

These three arrays produce different byte streams at the middle element:

- `[1, undefined, 3]`: middle element is `21` (`TAG_UNDEFINED`)
- `[1, , 3]`: middle element is `01 01` (`TAG_HOLE` + run of 1)
- `[1, null, 3]`: middle element is `20` (`TAG_NULL`)

### 7.18 Long string (hashed form)

A string whose UTF-8 encoding exceeds 64 bytes uses the hashed form (Section
4.4). Let `S` be any such string and let `H = SHA-256(utf8(S))` be its 32-byte
SHA-256 digest. The byte stream is:

```
F0  <32 bytes: H[0] H[1] ... H[31]>
```

Total: 33 bytes. The length of the original UTF-8 payload is not emitted —
the receiver simply reads a fixed-width 32-byte digest after `TAG_STRING_HASH`.

The **boundary case** at exactly 64 UTF-8 bytes uses the direct form, since
the rule is "64 bytes or fewer → direct". A 65-byte UTF-8 string uses the
hashed form.

This rule applies to every string the hasher feeds, including standalone
strings (Section 4.4), `symbol` keys (Section 4.6), object keys (Section
4.13), `FabricInstance` type tags (Section 4.14), `FabricHash`
algorithm tags (Section 4.11), and `FabricRegExp` source/flags/flavor
strings (Section 4.16). The threshold is evaluated per-string
independently: an object may mix short keys (direct form) and long keys
(hashed form) in the same key-value sequence.

---

## 8. Rejected Values

The following JavaScript values must never be passed to the hasher:

- **Unique (uninterned) `Symbol` values** — those for which
  `Symbol.keyFor(s)` returns `undefined`. Registry-interned symbols
  (`Symbol.for(key)`) **are** hashable; see Section 4.6. The required
  error message is `"Cannot hash unique (uninterned) symbol"`.
- **`Function` values** — opaque closures with no portable representation.

A conforming implementation should throw an error if it encounters either
of these rather than producing a hash. (`NaN`, `±Infinity`, and `-0` are
**not** rejected; they have well-defined byte encodings — see Section
4.3.)

---

## 9. Summary of Framing Mechanisms

| Context                           | Mechanism       | Details                          |
|:----------------------------------|:----------------|:---------------------------------|
| String direct form (≤ 64 UTF-8 bytes) | unsigned LEB128 | Byte count of UTF-8 payload, prefixed by `TAG_STRING` |
| String hashed form (> 64 UTF-8 bytes) | fixed 32 bytes  | Raw SHA-256 of UTF-8, prefixed by `TAG_STRING_HASH`; no length prefix |
| Bigint payload bytes              | unsigned LEB128 | Byte count of two's complement   |
| Byte sequence (`FabricBytes`)     | unsigned LEB128 | Byte count of raw payload        |
| `FabricEpochNsec` payload         | unsigned LEB128 | Byte count of two's complement   |
| `FabricEpochDays` payload         | unsigned LEB128 | Byte count of two's complement   |
| `FabricHash` algorithm tag        | string (§4.4)   | Emitted as a complete tagged string value (direct or hashed form) |
| `FabricHash` hash bytes           | unsigned LEB128 | Byte count of raw hash payload   |
| `FabricInstance` type tag         | string (§4.4)   | Emitted as a complete tagged string value (direct or hashed form) |
| `symbol` registry key             | string (§4.4)   | Emitted as a complete tagged string value (direct or hashed form), prefixed by `TAG_SYMBOL` |
| Object keys                       | string (§4.4)   | Emitted as complete tagged string values (direct or hashed form per key) |
| Hole run count                    | unsigned LEB128 | Number of consecutive holes      |
| Array elements                    | `TAG_END`       | Sentinel after last element      |
| Object key-value pairs            | `TAG_END`       | Sentinel after last pair         |
