---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Investigation of the two July 2026 steps in the create-data-URI benchmark, and what each of them was made of."
---

# Where the create-data-URI benchmark's time went, August 2026

## Result

`Immutable cell - create data URI only (100x)` in
`packages/runner/test/cell-immutable.bench.ts` slowed by about three and a
half times over two days in July 2026. It got there in two steps of roughly
1.8 times each, one day apart, and both steps show on every processor with
enough runs behind it. On the AMD EPYC 7763 the series reads about 58 to 60
microseconds through 20 July, then about 108 to 112, then about 193 to 211
from 21 July onward.

The bench body has not changed across either step. It mints a hundred `data:`
URIs from the value `{ value: n }`, which is as small a value as the mint path
can be handed.

Both steps are changes to how a `data:` URI's payload is spelled, and each is
confined to one commit:

| Step | Landed in | What changed |
| --- | --- | --- |
| First | [#4838](https://github.com/commontoolsinc/labs/pull/4838), `e47882e3d`, 20 July | The payload text stopped being `JSON.stringify()` and became `jsonFromValue()`, the standard `FabricValue` encoding |
| Second | [#4847](https://github.com/commontoolsinc/labs/pull/4847), `4a3f6b9cf`, 21 July | The payload stopped being percent-encoded and became base64url of the UTF-8 bytes |

Most of the second step's cost was not the format. It was that the route to
those bytes ran through `TextEncoder.encode()`, which allocates and hands back
a fresh byte array on every call, and that allocation costs more than
everything else the mint does with the payload. Encoding into a buffer that is
already there removes the allocation, and what is then left is the format
itself: transcoding to UTF-8 and expanding by four thirds, which comes to
about twice what percent-encoding cost.

The first step's cost mostly is the format. Canonical encoding is what makes a
`data:` URI address its content rather than merely carry it, and there is no
version of it that does not walk the value and dispatch a codec per member.
Two things around it were avoidable and are now gone: the link-rewriting walk
that runs ahead of the encoder used to rebuild the whole value even when it
changed nothing, and `utf8SortedKeysOf()` used to sort keys that already
arrived in order. What is left is the price of the canonical encoding itself,
and it is deliberate.

## What was measured

Apple M5 Max, Deno 2.9.4 (the `mise.toml` pin). The machine was shared with
other work throughout, so runs alternated between worktrees within one series
and every comparison of two implementations was made inside a single process
wherever the shapes allowed it. Figures below are per iteration of the bench,
which is a hundred mints, unless stated per mint.

Checking out each end of each named commit range reproduces both steps:

| Commit | Bench, microseconds |
| --- | ---: |
| `be6323971` — before the range | 24.1, 24.9, 23.8 |
| `2a7caed2f` | 24.6, 24.8 |
| `e47882e3d` — **first step** | 50.5, 51.0 |
| `17079cc92` | 53.8, 52.7 |
| `a6671b5c7` | 36.7, 36.4 |
| `985a0759f` — end of the range | 34.8, 35.2, 35.3 |
| `644aed880` — before the range | 34.9, 34.5, 35.7 |
| `3961b483d` | 36.0, 36.0 |
| `4a3f6b9cf` — **second step** | 52.2, 55.0, 52.0 |
| `65d34e146` — tip of `main`, 7 August | 54.0, 51.4, 55.0 |

The first step is larger at the commit that lands it than it is at the end of
the range. `a6671b5c7` gives part of it back: it stopped wrapping the payload
in a `{ "value": ... }` document, so the encoder has one member to walk
instead of two nested ones.

## What each step is made of

Splitting the mint at the tip of `main` into its stages, all in one process,
per mint of `{ value: n }`:

| Stage | Nanoseconds |
| --- | ---: |
| the link-rewriting walk, and the rest of the outer function | 143 |
| `jsonFromValue()` — the payload text | 171 |
| `TextEncoder.encode()` and `toUnpaddedBase64url()` — the payload's spelling | 266 |
| assembling the URI string | 26 |
| the whole mint | 606 |

The two stages the steps replaced cost 25 nanoseconds (`JSON.stringify()`) and
82 nanoseconds (`encodeURIComponent()`) measured in the same process. So the
first step traded 25 for 171 and the second traded 82 for 266. Adding the
walk and the assembly back gives 276 nanoseconds for a mint before either
step, which is what the `be6323971` worktree measures.

Of the second step's 266, about 197 are inside `TextEncoder.encode()` and
about 69 in the base64 encoding. The 197 are not transcoding. The payload here
is sixteen bytes, and the same sixteen bytes written through `encodeInto()`
into a buffer that already exists cost 27 nanoseconds. What the rest buys is
the byte array itself, allocated by the runtime and handed back across the
boundary into JavaScript. It is a fixed cost: encoding a kilobyte through
`encode()` costs only about 60 nanoseconds more than encoding sixteen bytes.

## The fix

### The payload's bytes

`toUnpaddedBase64urlFromText()` in `packages/utils/src/base64url.ts` takes the
text and returns the base64url of its UTF-8 form, going through
`encodeInto()` and a scratch buffer held by the module. `encodeInto()` reports
how much of the string it consumed, which says whether the whole string fit;
anything that did not — a string longer than the buffer, or one whose
multi-byte characters overran it — falls back to `encode()` and pays what it
paid before. `dataUriFromValue()` calls it, and no longer builds a
`TextEncoder` per mint of its own.

Four routes from text to base64url were measured against each other in one
process, at five payload sizes:

| Payload | As shipped | Exact-size array, `encodeInto` | Scratch buffer, `encodeInto` | Character loop, no bytes |
| --- | ---: | ---: | ---: | ---: |
| 16 B | 238 ns | 286 ns | **140 ns** | 63 ns |
| 64 B | 279 ns | 280 ns | **151 ns** | 257 ns |
| 256 B | 276 ns | 288 ns | **152 ns** | 1.1 µs |
| 1 KB | 347 ns | 356 ns | **193 ns** | 4.2 µs |
| 64 KB | 4.6 µs | 5.3 µs | **4.5 µs** | — |

The two rejected routes are instructive. Allocating a byte array of the right
size in JavaScript and encoding into that is no better than letting
`encode()` allocate one, which says the cost is the allocation and not where
it happens. Building the base64url straight off the string's character codes,
with no byte array at any point, is the fastest thing there is at sixteen
bytes and is catastrophic past a few dozen: at 256 KB it takes 1.2
milliseconds against the shipped route's 16 microseconds. A `data:` URI can
carry a payload of any size, so the mint path cannot be tuned for the small
one at the large one's expense. The scratch buffer is the only route that is
at least as fast as what it replaces at every size.

### The walk ahead of the encoder

`dataUriFromValueWithResolvedLinks()` in `packages/runner/src/data-uri.ts`
walks the value rewriting relative cell links into full sigil links. It used
to rebuild every container it descended into, with
`Object.fromEntries(Object.entries(value).map(...))`, whether or not anything
under that container had been rewritten. Most values carry no link at all, and
for those the walk was allocating a complete copy of the value for the encoder
to read once and discard.

It is now copy-on-write, in the same shape as `findAndInlineDataUriLinks()`
further down the same file: a container whose members all come back
by identity is itself returned by identity, and only the first member that
changes forces a copy. The walk and the outer function around it go from 143
nanoseconds per mint of `{ value: n }` to 78. Measured on its own, against a
copy of the shipped walk in the same process, the walk goes from 117
nanoseconds to 65 for that value, and from 602 to 273 for a value with four
members and two levels of nesting.

This is not where either step landed — the walk is older than both. It became
worth fixing because of the first step: before it, the walk's output went to
`JSON.stringify()`, which reads a tree without allocating a parallel one;
after it, the output goes to a tree-encoding walk in JavaScript that visits
every member regardless. The copy the rewriting walk made had a reader before
and has none now.

Two consequences beyond speed. A value read out of storage arrives deep-frozen
and now reaches the encoder still frozen, so `utf8SortedKeysOf()`'s cache of
sorted keys, which only retains entries for frozen objects, can hold them.
And a value that has no fabric representation — a `Date`, a `Cell` — now
reaches the encoder as it came in and is refused there, where before the walk
emptied it into a plain object and an identifier was minted for the emptied
form. Neither of the two callers that pass data hands in such a value; both
pass values read out of storage.

### Sorting keys that are already sorted

`utf8SortedKeysOf()` in `packages/utils/src/utf8.ts` called
`Array.prototype.sort()` on every object's keys. Sorting with a comparator
costs more to set up than the comparisons it then performs on a short array,
and object keys usually arrive already in order. It now checks first and sorts
only when the check finds a pair out of order.

| Object | Before | After |
| --- | ---: | ---: |
| one key | 33 ns | 33 ns |
| four keys, in order | 91 ns | 46 ns |
| four keys, out of order | 103 ns | 119 ns |

The one-key row is the honest one to note: this change does nothing for the
benchmark this investigation is about, whose value has exactly one key, since
V8 already returns immediately from a sort of fewer than two elements. It is
here because the same function is what `value-hash.ts` uses to canonicalize
key order for every entity id in the system, and there the objects have more
than one key. The out-of-order row is the price: one failed comparison ahead
of a sort that then has to run anyway.

### One scan instead of two

`JsonCodec`'s plain-object arm built the encoded object, then walked
its keys again with `Object.keys(result).some((k) => k.startsWith("/"))` to
find out whether any key needed escaping. The question is now answered while
the keys are being walked the first time. Worth about 5 nanoseconds per
object.

## Where it lands

Twenty alternating rounds across three worktrees, on a machine carrying other
work throughout, so the absolute figures are inflated and the ratios are what
to read. The minimum of a series is the least contaminated figure available
under that condition, so both it and the median are given:

| Tree | Minimum, µs | Median, µs | Against the pre-step baseline |
| --- | ---: | ---: | ---: |
| `be6323971`, before both steps | 26.9 | 28.8 | 1.00 |
| `65d34e146`, tip of `main` | 61.8 | 70.8 | 2.30 to 2.45 |
| tip of `main` with this change | 39.6 | 45.7 | 1.47 to 1.59 |

The single-run figures in the reproduction table above, taken earlier and on a
quieter machine, put the same two ends at 24 and 53 microseconds — the same
ratio, with the whole series shifted down. The change removes about two fifths
of what the two steps added.

## What is left, and why

Per mint of `{ value: n }`, all three columns measured in one process each:

| Stage | Before both steps | Tip of `main` | With this change |
| --- | ---: | ---: | ---: |
| the walk and the outer function | 143 ns | 143 ns | 78 ns |
| the payload text | 25 ns | 171 ns | 168 ns |
| the payload's spelling | 82 ns | 266 ns | 176 ns |
| assembling the URI string | 26 ns | 26 ns | 31 ns |

The payload's spelling is now within about twice what percent-encoding cost,
and the difference that remains is transcoding to UTF-8 and expanding by four
thirds, which is what base64url is. There is no cheaper way to spell those
bytes; the alternative is a different format, which is a decision this change
does not reopen.

The payload text is where the remaining distance is, and it is deliberate.
`jsonFromValue()` walks the value, asks the codec registry what represents
each member, orders each object's keys by UTF-8 byte order, and only then
stringifies. `JSON.stringify()` does none of that, which is exactly why it was
wrong here: two runtimes holding the same value could mint two different
identifiers for it, and content addressing that depends on key insertion
history is not addressing content. That defect is what
[#4838](https://github.com/commontoolsinc/labs/pull/4838) fixed, and reverting
it would bring the defect back. Neither of the two encoder-side changes
described above moves that row: this value has one key, so there is no sort to
skip, and the escaping scan they save is a few nanoseconds. What recovers on
this benchmark from the first step is the walk in front of the encoder, not
the encoder.

Not all of the 168 nanoseconds is intrinsic even so. A walk hand-written to do
the same job for this value — cycle detection, plain-object check, keys in
UTF-8 order, escaping check, stringify — measures 81 nanoseconds in the same
process. The distance between that and the real encoder is codec-registry
dispatch, which fetches a prototype and consults a map for every member
including the primitives, and the tag-wrapping machinery around it. Both are
in `packages/data-model/src/codec-json/`, both are on the path of every value
the system encodes, and neither was touched here: this is the core encoder,
and reshaping its dispatch is a change that deserves its own investigation
rather than being carried along by a benchmark fix.

## Two things noticed along the way

`Runtime.getImmutableCell()` does not use
`dataUriFromValueWithResolvedLinks()` at all. It calls `dataUriFromValue()`
directly, on the output of `flattenBuilderArtifacts()` and
`fabricFromNativeValue()`. The benchmark this investigation is named for
exercises the other entry point, so the copy-on-write walk above does not
reach `getImmutableCell()`; the payload-spelling and encoder work does. The
builder-artifact walk it does run keeps reading into every member on purpose,
for the reason
[`2026-08-read-modify-write-artifact-walk.md`](2026-08-read-modify-write-artifact-walk.md)
gives: an entity id derived from the bytes of the whole value has to read
every member either way.

`toUnpaddedBase64url()` chooses between the platform's
`Uint8Array.prototype.toBase64` and a JavaScript polyfill, and the platform
one is the slower of the two below about a hundred bytes: 74 nanoseconds
against 59 at sixteen. It wins by orders of magnitude on anything large, so
the choice as it stands is right, but a reader of that function should not
assume the native path is faster everywhere.
