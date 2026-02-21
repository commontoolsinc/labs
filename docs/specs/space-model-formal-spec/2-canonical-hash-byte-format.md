# Canonical Hash Byte Format

This document specifies the precise byte-level format for canonical hashing of
`StorableValue`s. It is the implementation-ready companion to Section 6.3 of the
formal spec (`1-storable-values.md`), which defines the algorithm at the
pseudocode level.

An implementer can work from this document alone to produce a byte-for-byte
compatible canonical hasher. All encodings are deterministic; two conforming
implementations must produce identical byte streams (and therefore identical
hashes) for any given `StorableValue`.

## Status

Draft byte-level spec — extracted from the formal spec Section 6.3 and the
implementation plan Phase 6.1.

---

## 1. Digest Algorithm

The hash function is **SHA-256** (FIPS 180-4). All byte sequences described in
this document are fed to a SHA-256 context in the order specified.

The output is **32 raw bytes** (256 bits). String encoding of the output (e.g.,
base64) is a separate concern at the call site and is not part of this
specification.

> **Future addition.** BLAKE2b is listed as a recommended second algorithm in
> the formal spec. When added, it will use the same byte-level input format
> defined here; only the digest function changes.

---

## 2. Type Tag Bytes

Every value fed to the hasher begins with a single-byte type tag. The tag
prevents cross-type collisions (e.g., the number `0` and the boolean `false`
produce different hashes even though both could be represented as a zero byte).

| Tag          | Hex    | Decimal | Used for                        |
|:-------------|:-------|:--------|:--------------------------------|
| `TAG_NULL`   | `0x00` | 0       | `null`                          |
| `TAG_BOOL`   | `0x01` | 1       | `boolean`                       |
| `TAG_NUMBER` | `0x02` | 2       | `number` (finite, non-NaN)      |
| `TAG_STRING` | `0x03` | 3       | `string`                        |
| `TAG_BIGINT` | `0x04` | 4       | `bigint`                        |
| `TAG_UNDEF`  | `0x05` | 5       | `undefined`                     |
| `TAG_BYTES`  | `0x06` | 6       | `StorableUint8Array`            |
| `TAG_DATE`   | `0x07` | 7       | `StorableDate`                  |
| `TAG_ARRAY`  | `0x08` | 8       | plain arrays                    |
| `TAG_OBJECT` | `0x09` | 9       | plain objects                   |
| `TAG_STOR`   | `0x0A` | 10      | `StorableInstance` (general)    |
| `TAG_HOLE`   | `0x0B` | 11      | sparse array holes (run-length) |

Tags `0x0C`--`0xFF` are reserved for future use.

---

## 3. Integer Encoding Conventions

Unless stated otherwise:

- **uint32 BE** — unsigned 32-bit integer, big-endian (4 bytes, most significant
  byte first). Used for lengths and counts.
- **int64 BE** — signed 64-bit integer, big-endian (8 bytes, two's complement).
  Used for `StorableDate` timestamps.

---

## 4. Encoding Per Type

For each type, the subsections below specify the exact byte sequence fed to the
SHA-256 context. "Feed" means the bytes are appended to the running hash state
in order; the overall hash is finalized only after the entire value tree has been
traversed.

### 4.1 `null`

```
Bytes: TAG_NULL
       0x00
```

Total: 1 byte. No payload.

### 4.2 `boolean`

```
Bytes: TAG_BOOL  PAYLOAD
       0x01      0x01   (true)
       0x01      0x00   (false)
```

Total: 2 bytes.

### 4.3 `number`

```
Bytes: TAG_NUMBER  IEEE_754_FLOAT64_BE
       0x02        <8 bytes>
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

- **`NaN`** must not appear. `toStorableValue()` rejects `NaN` values; a
  conforming hasher may assume `NaN` is never encountered. If a hasher does
  encounter `NaN`, it should throw rather than produce a hash.

- **`Infinity` / `-Infinity`** must not appear. Like `NaN`, these are rejected
  by `toStorableValue()`. A conforming hasher should throw if encountered.

### 4.4 `string`

```
Bytes: TAG_STRING  LENGTH_U32BE  CODE_UNITS
       0x03        <4 bytes>     <2 * length bytes>
```

Total: 1 + 4 + (2 * N) bytes, where N is the number of UTF-16 code units.

- **Length**: The number of UTF-16 code units (not bytes, not Unicode scalar
  values), encoded as uint32 big-endian.
- **Code units**: Each UTF-16 code unit is encoded as 2 bytes, big-endian.
  Surrogate pairs (for characters above U+FFFF) appear as two code units, each
  encoded as a 2-byte big-endian value.

Empty string (`""`) is encoded as `0x03 00 00 00 00` — the tag plus a
zero-length prefix and no code unit bytes.

### 4.5 `bigint`

```
Bytes: TAG_BIGINT  LENGTH_U32BE  TWO_COMP_BYTES
       0x04        <4 bytes>     <length bytes>
```

Total: 1 + 4 + N bytes, where N is the minimal encoding length.

- **Length**: The number of bytes in the two's-complement representation,
  encoded as uint32 big-endian.
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
Bytes: TAG_UNDEF
       0x05
```

Total: 1 byte. No payload.

### 4.7 `StorableUint8Array` (bytes)

```
Bytes: TAG_BYTES  LENGTH_U32BE  RAW_BYTES
       0x06       <4 bytes>     <length bytes>
```

Total: 1 + 4 + N bytes, where N is the byte array length.

- **Length**: The number of bytes in the array, encoded as uint32 big-endian.
- **Payload**: The raw bytes of the underlying `Uint8Array`, in order.

Empty byte array is encoded as `0x06 00 00 00 00` — the tag plus a zero-length
prefix and no payload bytes.

### 4.8 `StorableDate`

```
Bytes: TAG_DATE  MILLIS_INT64BE
       0x07      <8 bytes>
```

Total: 9 bytes.

- **Payload**: The timestamp as milliseconds since the Unix epoch
  (1970-01-01T00:00:00Z), encoded as int64 big-endian (signed two's complement).
  This matches the value returned by `Date.prototype.getTime()`.

### 4.9 Array

```
Bytes: TAG_ARRAY  LENGTH_U32BE  ELEMENT_0  ELEMENT_1  ...  ELEMENT_N-1
       0x08       <4 bytes>     <varies>   <varies>        <varies>
```

- **Length**: The **logical** array length (i.e., `array.length`), encoded as
  uint32 big-endian. This includes both populated indices and holes.
- **Elements**: Each element is hashed recursively in index order (0, 1, 2,
  ...). Present elements are fed to the hasher as complete tagged values
  (starting with their own type tag). Holes are encoded using run-length
  encoding (see Section 4.12).

Empty array (`[]`) is encoded as `0x08 00 00 00 00` — the tag plus a
zero-length prefix and no element data.

### 4.10 Object

```
Bytes: TAG_OBJECT  KEY_COUNT_U32BE  KEY_0  VALUE_0  KEY_1  VALUE_1  ...
       0x09        <4 bytes>        <var>  <var>    <var>  <var>
```

- **Key count**: The number of own enumerable string-keyed properties, encoded
  as uint32 big-endian.
- **Key-value pairs**: Emitted in **sorted order**. Keys are sorted
  lexicographically by their UTF-8 byte representation (see Section 5). For each
  key-value pair:
  - The **key** is encoded as a `TAG_STRING`-style value: `TAG_STRING` + uint32
    BE code unit count + UTF-16 BE code units (same format as Section 4.4).
  - The **value** is hashed recursively as a complete tagged value.

Empty object (`{}`) is encoded as `0x09 00 00 00 00` — the tag plus a zero
key count and no key-value data.

### 4.11 `StorableInstance`

```
Bytes: TAG_STOR  TYPE_TAG_LEN_U32BE  TYPE_TAG_UTF8  STATE_HASH
       0x0A      <4 bytes>           <varies>       <recursive>
```

- **Type tag length**: The byte length of the type tag string in UTF-8,
  encoded as uint32 big-endian.
- **Type tag**: The `StorableInstance`'s type tag string (e.g., `"Error@1"`,
  `"Map@1"`, `"Set@1"`), encoded as raw UTF-8 bytes.
- **Deconstructed state**: The value returned by `[DECONSTRUCT]()`, hashed
  recursively as a complete tagged value.

> **Note on `StorableDate` and `StorableUint8Array`.** These two wrapper types
> are **not** hashed via `TAG_STOR`. They have dedicated type tags (`TAG_DATE`
> and `TAG_BYTES` respectively) and are hashed using their logical content
> directly (see Sections 4.8 and 4.7). This reflects their nature as
> fundamental data types rather than general storable instances.

### 4.12 Holes (sparse array elements)

```
Bytes: TAG_HOLE  RUN_COUNT_U32BE
       0x0B      <4 bytes>
```

Total: 5 bytes per run.

Holes appear only within array encodings (Section 4.9). Consecutive holes are
**always coalesced** into maximal runs:

- A single hole at index `i` with present elements at `i-1` and `i+1` is
  encoded as `TAG_HOLE` + uint32 BE `1`.
- Three consecutive holes starting at index `i` are encoded as `TAG_HOLE` +
  uint32 BE `3` (not three separate `TAG_HOLE` + `1` entries).
- Runs **must** be maximal: an implementation must not split a run of N
  consecutive holes into smaller runs. Doing so would produce a different byte
  stream and therefore a different hash.

> **Distinction.** `TAG_HOLE` (`0x0B`), `TAG_UNDEF` (`0x05`), and `TAG_NULL`
> (`0x00`) are all distinct. The arrays `[1, , 3]`, `[1, undefined, 3]`, and
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

> **Note.** The sort order is determined by the UTF-8 encoding of the keys, not
> the UTF-16 encoding used in the hash stream. Keys are _sorted_ by UTF-8 but
> _hashed_ as UTF-16 (using the `TAG_STRING` format from Section 4.4). This
> distinction matters for strings containing characters above U+007F, where
> UTF-8 and UTF-16 byte orderings can differ.

---

## 6. Traversal Order

The overall traversal is depth-first, left-to-right:

1. Feed the type tag byte.
2. Feed any fixed-size metadata (lengths, counts).
3. For compound types, recursively hash each child. Each child's bytes
   (starting with its own type tag) are fed to the **same** hasher — there is
   no per-child sub-hash. The entire value tree is serialized into one
   contiguous byte stream, then digested once.

There are no separators or terminators between elements. The type tags and
length prefixes provide unambiguous framing.

---

## 7. Illustrative Examples

The following examples show the exact byte stream fed to SHA-256 for several
representative values. Bytes are shown in hexadecimal.

### 7.1 `null`

```
00
```

### 7.2 `true`

```
01 01
```

### 7.3 `false`

```
01 00
```

### 7.4 `42` (number)

```
02  40 45 00 00 00 00 00 00
```

IEEE 754 binary64 for `42.0` is `0x4045000000000000`.

### 7.5 `0` (number)

```
02  00 00 00 00 00 00 00 00
```

Note: `-0` produces the same byte stream (normalized to `+0`).

### 7.6 `"hello"` (string)

`"hello"` has 5 UTF-16 code units: `0x0068`, `0x0065`, `0x006C`, `0x006C`,
`0x006F`.

```
03  00 00 00 05  00 68 00 65 00 6C 00 6C 00 6F
```

### 7.7 `""` (empty string)

```
03  00 00 00 00
```

### 7.8 `undefined`

```
05
```

### 7.9 `[1, , 3]` (sparse array)

Logical length = 3. Elements: number `1`, one hole, number `3`.

- Tag + length: `08 00 00 00 03`
- Element 0 (`1`): `02 3F F0 00 00 00 00 00 00` (IEEE 754 for `1.0`)
- Element 1 (hole, run of 1): `0B 00 00 00 01`
- Element 2 (`3`): `02 40 08 00 00 00 00 00 00` (IEEE 754 for `3.0`)

Full byte stream:
```
08 00 00 00 03
02 3F F0 00 00 00 00 00 00
0B 00 00 00 01
02 40 08 00 00 00 00 00 00
```

### 7.10 `{ a: 1, b: 2 }` (object)

Two keys. UTF-8 sort order: `"a"` (0x61) < `"b"` (0x62).

- Tag + key count: `09 00 00 00 02`
- Key `"a"` (1 code unit, `0x0061`): `03 00 00 00 01 00 61`
- Value `1`: `02 3F F0 00 00 00 00 00 00`
- Key `"b"` (1 code unit, `0x0062`): `03 00 00 00 01 00 62`
- Value `2`: `02 40 00 00 00 00 00 00 00` (IEEE 754 for `2.0`)

Full byte stream:
```
09 00 00 00 02
03 00 00 00 01 00 61
02 3F F0 00 00 00 00 00 00
03 00 00 00 01 00 62
02 40 00 00 00 00 00 00 00
```

### 7.11 `[1, undefined, 3]` vs. `[1, , 3]` vs. `[1, null, 3]`

These three arrays produce different byte streams at the middle element:

- `[1, undefined, 3]`: middle element is `05` (`TAG_UNDEF`)
- `[1, , 3]`: middle element is `0B 00 00 00 01` (`TAG_HOLE` + run of 1)
- `[1, null, 3]`: middle element is `00` (`TAG_NULL`)

---

## 8. Rejected Values

The following JavaScript values are rejected by `toStorableValue()` and must
never be passed to the canonical hasher:

- `NaN`
- `Infinity`
- `-Infinity`
- `Symbol` values
- `Function` values

A conforming implementation should throw an error if it encounters any of these
rather than producing a hash.

---

## 9. Summary of Length Prefix Usage

| Context                          | Encoding       | Counts            |
|:---------------------------------|:---------------|:------------------|
| String code units                | uint32 BE      | UTF-16 code units |
| Bigint payload bytes             | uint32 BE      | Bytes             |
| Byte array (`StorableUint8Array`)| uint32 BE      | Bytes             |
| Array logical length             | uint32 BE      | Elements + holes  |
| Object key count                 | uint32 BE      | Key-value pairs   |
| `StorableInstance` type tag      | uint32 BE      | UTF-8 bytes       |
| Hole run count                   | uint32 BE      | Consecutive holes |
