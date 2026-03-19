# Canonical Hash Byte Format

This document specifies the precise byte-level format for canonical hashing of
`FabricValue`s. It is the implementation-ready companion to Section 6.4 of the
formal spec (`1-fabric-values.md`), which defines the algorithm at the
pseudocode level. The tag byte assignments used here are defined in formal spec
Section 6.3.

An implementer can work from this document alone to produce a byte-for-byte
compatible canonical hasher. All encodings are deterministic; two conforming
implementations must produce identical byte streams (and therefore identical
hashes) for any given `FabricValue`.

## Status

Draft byte-level spec — extracted from the formal spec Section 6.3 and the
implementation plan Phase 6.1.

---

## 1. Digest Algorithm

The hash function is **SHA-256** (FIPS 180-4). All byte sequences described in
this document are fed to a SHA-256 context in the order specified.

The digest output is **32 raw bytes** (256 bits). The `modernHash()` function
wraps the raw bytes into a `FabricHash` instance (Section 1.4.9 of the
formal spec) with algorithm tag `fid1`. Callers who need a string
representation call `toString()` on the result, which produces
`fid1:<base64urlhash>` (unpadded base64url, RFC 4648 Section 5).

> **Future addition.** BLAKE2b is listed as a recommended second algorithm in
> the formal spec. When added, it will use the same byte-level input format
> defined here; only the digest function changes.

---

## 2. Type Tag Bytes

Every value fed to the hasher begins with a single-byte type tag. The tag
prevents cross-type collisions (e.g., the number `0` and the boolean `false`
produce different hashes even though both could be represented as a zero byte).

The authoritative tag assignments are in formal spec Section 6.3. Tags are
organized into three categories by high nibble: **meta** (`0x0N`) for structural
markers like `TAG_END` and `TAG_HOLE`, **compound** (`0x1N`) for containers
whose children are tagged values, and **primitive** (`0x2N`) for leaf value
types. All unassigned values are reserved for future use.

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
big-endian byte order.

**Normalization rules:**

- **Negative zero (`-0`)** must be normalized to positive zero (`+0`) before
  encoding. That is, the 8-byte payload for `-0` is
  `00 00 00 00 00 00 00 00`, not `80 00 00 00 00 00 00 00`. This ensures `-0`
  and `+0` produce identical hashes, matching JavaScript semantics where
  `-0 === 0` is `true`.

- **`NaN`** must not appear. `fabricFromNativeValue()` rejects `NaN` values; a
  conforming hasher may assume `NaN` is never encountered. If a hasher does
  encounter `NaN`, it should throw rather than produce a hash.

- **`Infinity` / `-Infinity`** must not appear. Like `NaN`, these are rejected
  by `fabricFromNativeValue()`. A conforming hasher should throw if encountered.

### 4.4 `string`

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

### 4.6 `undefined`

```
Bytes: TAG_UNDEFINED
       0x21
```

Total: 1 byte. No payload.

### 4.7 `FabricUint8Array` (bytes)

```
Bytes: TAG_BYTES  LENGTH_LEB128  RAW_BYTES
       0x25       <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the byte array length.

- **Length**: The number of bytes in the array, encoded as unsigned LEB128.
- **Payload**: The raw bytes of the underlying `Uint8Array`, in order.

Empty byte array is encoded as `0x25 0x00` — the tag plus a zero-length prefix
and no payload bytes.

### 4.8 `FabricEpochNsec`

```
Bytes: TAG_EPOCH_NSEC  LENGTH_LEB128  TWO_COMP_BYTES
       0x27            <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the minimal encoding length.

`FabricEpochNsec` represents a nanosecond-precision Unix epoch timestamp. It
is a direct `FabricDatum` member (not a `FabricInstance`) and has a dedicated
type tag.

- **Length**: The number of bytes in the two's-complement representation of the
  wrapped `bigint` value, encoded as unsigned LEB128.
- **Payload**: The value encoded identically to `bigint` (Section 4.5): signed
  two's-complement, big-endian, minimal bytes.

The encoding is structurally identical to `TAG_BIGINT` but uses a different type
tag (`0x27` instead of `0x26`), ensuring that `FabricEpochNsec(42n)` and
`42n` produce distinct hashes.

### 4.9 `FabricEpochDays`

```
Bytes: TAG_EPOCH_DAYS  LENGTH_LEB128  TWO_COMP_BYTES
       0x28            <1+ bytes>     <length bytes>
```

Total: 1 + len(LEB128) + N bytes, where N is the minimal encoding length.

`FabricEpochDays` represents a day-precision Unix epoch timestamp. It is a
direct `FabricDatum` member (not a `FabricInstance`) and has a dedicated type
tag.

- **Length**: The number of bytes in the two's-complement representation of the
  wrapped `bigint` value, encoded as unsigned LEB128.
- **Payload**: The value encoded identically to `bigint` (Section 4.5): signed
  two's-complement, big-endian, minimal bytes.

The encoding is structurally identical to `TAG_BIGINT` but uses a different type
tag (`0x28` instead of `0x26`), ensuring that `FabricEpochDays(42n)` and
`42n` produce distinct hashes. It also differs from `FabricEpochNsec` (`0x27`)
so the two temporal types are always distinguishable.

### 4.10 `FabricHash`

```
Bytes: TAG_CONTENT_ID  ALG_TAG_LEN_LEB128  ALG_TAG_UTF8  HASH_LEN_LEB128  HASH_BYTES
       0x29            <1+ bytes>          <varies>      <1+ bytes>       <varies>
```

Total: 1 + len(LEB128) + A + len(LEB128) + H bytes, where A is the byte length
of the algorithm tag in UTF-8 and H is the number of hash bytes.

`FabricHash` represents a content identifier — a hash with an algorithm
tag. It is a direct `FabricDatum` member (not a `FabricInstance`) and has a
dedicated type tag.

- **Algorithm tag length**: The byte length of the algorithm tag string in
  UTF-8, encoded as unsigned LEB128.
- **Algorithm tag**: The algorithm tag string (e.g., `"fid1"`) encoded as raw
  UTF-8 bytes.
- **Hash byte length**: The number of hash bytes, encoded as unsigned LEB128.
- **Hash bytes**: The raw hash bytes, in order.

The two-field encoding ensures that content IDs with different algorithm tags
but identical hash bytes produce different hashes, and vice versa.

### 4.11 Array

```
Bytes: TAG_ARRAY  ELEMENT_0  ELEMENT_1  ...  ELEMENT_N-1  TAG_END
       0x10       <varies>   <varies>        <varies>      0x00
```

- **Elements**: Each element is hashed recursively in index order (0, 1, 2,
  ...). Present elements are fed to the hasher as complete tagged values
  (starting with their own type tag). Holes are encoded using run-length
  encoding (see Section 4.14).
- **Terminator**: `TAG_END` (`0x00`) marks the end of the element sequence.
  This is unambiguous because `TAG_END` cannot appear as the start of any
  element value.

Empty array (`[]`) is encoded as `0x10 0x00` — the tag immediately followed by
`TAG_END`.

### 4.12 Object

```
Bytes: TAG_OBJECT  KEY_0  VALUE_0  KEY_1  VALUE_1  ...  TAG_END
       0x11        <var>  <var>    <var>  <var>          0x00
```

- **Key-value pairs**: Emitted in **sorted order**. Keys are sorted
  lexicographically by their UTF-8 byte representation (see Section 5). For each
  key-value pair:
  - The **key** is encoded as a `TAG_STRING`-style value: `TAG_STRING` +
    LEB128 byte length + UTF-8 bytes (same format as Section 4.4).
  - The **value** is hashed recursively as a complete tagged value.
- **Terminator**: `TAG_END` (`0x00`) marks the end of the key-value sequence.

Empty object (`{}`) is encoded as `0x11 0x00` — the tag immediately followed by
`TAG_END`.

### 4.13 `FabricInstance`

```
Bytes: TAG_INSTANCE  TYPE_TAG_LEN_LEB128  TYPE_TAG_UTF8  STATE_HASH
       0x12          <1+ bytes>           <varies>       <recursive>
```

- **Type tag length**: The byte length of the type tag string in UTF-8,
  encoded as unsigned LEB128.
- **Type tag**: The `FabricInstance`'s type tag string (e.g., `"Error@1"`,
  `"Map@1"`, `"Set@1"`, `"RegExp@1"`), encoded as raw UTF-8 bytes.
- **Deconstructed state**: The value returned by `[DECONSTRUCT]()`, hashed
  recursively as a complete tagged value.

> **Note on types with dedicated tags.** `FabricUint8Array`,
> `FabricEpochNsec`, `FabricEpochDays`, and `FabricHash` are **not**
> hashed via `TAG_INSTANCE`. Each has a dedicated type tag and is encoded
> directly (see Sections 4.7, 4.8, 4.9, and 4.10 respectively).

### 4.14 Holes (sparse array elements)

```
Bytes: TAG_HOLE  RUN_COUNT_LEB128
       0x01      <1+ bytes>
```

Total: 1 + len(LEB128) bytes per run (typically 2 bytes for small runs).

Holes appear only within array encodings (Section 4.11). Consecutive holes are
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
> implementation that needs to match the canonical hash sort order must sort by
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

Note: `-0` produces the same byte stream (normalized to `+0`).

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

Algorithm tag `"fid1"` is 4 bytes in UTF-8: `0x66`, `0x69`, `0x64`, `0x31`.
Hash payload is 4 bytes: `0xDE`, `0xAD`, `0xBE`, `0xEF`.

```
29  04  66 69 64 31  04  DE AD BE EF
```

`TAG_CONTENT_ID` (`0x29`), algorithm tag length 4 (`0x04`), algorithm tag
`"fid1"`, hash byte length 4 (`0x04`), hash bytes.

### 7.12 `FabricRegExp(/abc/gi)`

`FabricRegExp` is a `FabricInstance` and is hashed via `TAG_INSTANCE`.

Type tag `"RegExp@1"` is 8 bytes in UTF-8: `0x52`, `0x65`, `0x67`, `0x45`,
`0x78`, `0x70`, `0x40`, `0x31`.

Deconstructed state is `{ source: "abc", flags: "gi" }`, an object with keys
sorted by UTF-8 bytes: `"flags"` (0x66...) < `"source"` (0x73...).

- Instance tag: `12`
- Type tag length 8 (LEB128): `08`
- Type tag `"RegExp@1"`: `52 65 67 45 78 70 40 31`
- State (object):
  - Object tag: `11`
  - Key `"flags"` (5 bytes): `24 05 66 6C 61 67 73`
  - Value `"gi"` (2 bytes): `24 02 67 69`
  - Key `"source"` (6 bytes): `24 06 73 6F 75 72 63 65`
  - Value `"abc"` (3 bytes): `24 03 61 62 63`
  - End: `00`

Full byte stream:
```
12
08  52 65 67 45 78 70 40 31
11
24 05 66 6C 61 67 73
24 02 67 69
24 06 73 6F 75 72 63 65
24 03 61 62 63
00
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

---

## 8. Rejected Values

The following JavaScript values are rejected by `fabricFromNativeValue()` and must
never be passed to the canonical hasher:

- `NaN`
- `Infinity`
- `-Infinity`
- `Symbol` values
- `Function` values

A conforming implementation should throw an error if it encounters any of these
rather than producing a hash.

---

## 9. Summary of Framing Mechanisms

| Context                           | Mechanism       | Details                          |
|:----------------------------------|:----------------|:---------------------------------|
| String byte length                | unsigned LEB128 | Byte count of UTF-8 payload      |
| Bigint payload bytes              | unsigned LEB128 | Byte count of two's complement   |
| Byte array (`FabricUint8Array`) | unsigned LEB128 | Byte count of raw payload        |
| `FabricEpochNsec` payload       | unsigned LEB128 | Byte count of two's complement   |
| `FabricEpochDays` payload       | unsigned LEB128 | Byte count of two's complement   |
| `FabricHash` algorithm tag | unsigned LEB128 | Byte count of algorithm tag UTF-8|
| `FabricHash` hash bytes    | unsigned LEB128 | Byte count of raw hash payload   |
| `FabricInstance` type tag       | unsigned LEB128 | Byte count of type tag UTF-8     |
| Hole run count                    | unsigned LEB128 | Number of consecutive holes      |
| Array elements                    | `TAG_END`       | Sentinel after last element      |
| Object key-value pairs            | `TAG_END`       | Sentinel after last pair         |
