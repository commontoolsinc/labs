---
status: historical
created: 2026-07-14
archived: 2026-07-14
reason: "Protocol-level Memory websocket traffic and repetition analysis for the July 14, 2026 Lunch Poll run."
---

# Memory protocol traffic analysis: Lunch Poll

## Question

What does the Memory websocket protocol transmit during the real two-browser
Lunch Poll flow, which data is already content-addressed or safely internable,
and how much repeat traffic could a bounded cache remove?

## Method

The command was:

```sh
deno task integration patterns lunch-poll-vote
```

The run exercised six browser Memory connections while two users joined a
poll, added options, cast concurrent votes, and observed cross-browser updates.
The behavioral test passed.

Accounting classified every canonical UTF-8 byte in the `fvj1:` Memory
websocket text payload into an additive semantic category. Noncanonical,
malformed, oversized, or over-complex payloads were counted exactly as opaque
encoding bytes. Candidate values retained only a random-salted,
connection-partitioned fingerprint, semantic category, cacheability scope, and
exact encoded size. Candidate roots were selected leaf-first, so their JSON
subtrees did not overlap. Raw payloads, identifiers, schemas, documents, SQL,
tokens, and stable unsalted hashes were not retained in the report.

The same-run baseline is the fully expanded server message. Actual is the
negotiated `syncSchemaTableV2` message. Physical websocket framing,
permessage-deflate, HTTP upgrade, TLS, and TCP bytes are excluded.

Cache opportunity uses an idealized 12-byte reference. Connection-local
figures assume a perfect unbounded cache for the life of one connection. They
include reference cost but not cache negotiation, miss recovery, eviction, or
implementation overhead. Fingerprints are deliberately partitioned by
connection, so the diagnostic does not expose cross-connection or cross-space
content equality.

## Headline

| Browser connections | Baseline bytes | Actual bytes | Saved bytes | Saved |
| ------------------: | -------------: | -----------: | ----------: | ----: |
|                   6 |      5,058,477 |    4,320,545 |     737,932 | 14.6% |

The existing frame-local sync schema table removed 14.6% overall. The
remaining actual traffic was 2,316,224 bytes of documents (53.6%), 913,231
bytes of schemas or schema references (21.1%), and 594,903 bytes of identity
and address data (13.8%).

## Semantic composition

| Semantic category | Actual bytes | Share | Addressing interpretation |
| ----------------- | -----------: | ----: | ------------------------- |
| Entity documents and values | 2,316,224 | 53.6% | Mutable, seq-addressed state; repetition is measurable but equality does not replace revision identity |
| Schemas and schema references | 913,231 | 21.1% | Canonically hashable; exact non-overlapping candidates are split below by current addressing status |
| Entity, space, session, branch, and scope identities | 594,903 | 13.8% | Identity-addressed; suitable for connection-local dictionary handles, not content identity |
| Patch and operation payloads | 194,063 | 4.5% | Ordered, state-dependent transitions; repeated exact programs/leaf values can be measured |
| Session and protocol control | 114,493 | 2.6% | Ordering, negotiation, request routing, and lifecycle data |
| Query/watch selectors excluding schema bytes | 74,656 | 1.7% | Immutable descriptors; selector candidates containing nested schema candidates are conservatively omitted |
| Sequence/order fields | 62,271 | 1.4% | Required seq/localSeq/seenSeq watermarks |
| Uncategorized remainder | 18,754 | 0.4% | Small residual protocol fields |
| JSON/Fabric wire framing | 15,970 | 0.4% | Prefix and structural encoding attributed outside semantic fields |
| Errors | 9,383 | 0.2% | Conflict/error details |
| Authentication/capability data | 5,778 | 0.1% | Fresh challenge, audience, invocation, token, and signature material |
| SQLite/scheduler data | 819 | <0.1% | Negligible in this workload |

Memory v2 deliberately keeps mutable JSON revisions sequence-addressed.
Content addressing is already appropriate for schemas, blobs, CIDs, code
artifacts, and signed immutable envelopes. Equal document bytes at different
sequences remain distinct history and must not be collapsed.

## Dominant protocol streams

| Direction and class | Actual bytes | Main contents |
| ------------------- | -----------: | ------------- |
| outbound `session.watch.add` response sync | 2,182,192 | 1,982,639 document bytes (90.9%), 126,559 schema bytes (5.8%), 38,821 identity bytes (1.8%) |
| inbound `transact` | 836,446 | 304,770 identity bytes (36.4%), 192,712 schema bytes (23.0%), 158,553 document bytes (19.0%), 122,164 operation bytes (14.6%) |
| inbound `session.watch.add` | 562,165 | 325,311 inline schema bytes (57.9%), 149,780 identity bytes (26.6%), 73,850 selector bytes (13.1%) |
| outbound `session/effect` sync | 301,776 | 163,892 schema bytes (54.3%), 106,245 document bytes (35.2%), 23,985 identity bytes (7.9%) |
| outbound `transact` response | 319,229 | 104,687 schema bytes (32.8%), 71,899 operation bytes (22.5%), 68,466 document bytes (21.4%), 41,684 identity bytes (13.1%) |

Initial watch expansion dominates the run: its response is 50.5% of all
actual traffic and is overwhelmingly document state. The request side is also
schema-heavy because watch selectors still send schemas inline. Transaction
requests and receipts both carry substantial schema, document, operation, and
identity data, making request/receipt echo suppression a separate candidate
from sync caching.

## Repetition and idealized connection-local opportunity

| Candidate class | Exact non-overlapping candidate bytes | Occurrences | Repeats in same connection | Repeat bytes | 12-byte-ref net saving |
| --------------- | ------------------------------------: | ----------: | -------------------------: | -----------: | ---------------------: |
| Inline/internable schemas | 609,163 | 1,513 | 1,257 | 418,278 | 403,194 |
| Already-content-addressed schemas/references | 270,051 | 1,114 | 818 | 166,926 | 157,110 |
| Identity/address strings | 285,491 | 7,857 | 6,250 | 201,008 | 126,008 |
| Seq-addressed documents/values | 1,856,638 | 829 | 482 | 25,788 | 20,004 |
| Patch/operation payloads | 63,221 | 362 | 219 | 32,316 | 29,688 |

The idealized connection-local total is 736,004 additional bytes, or 17.0% of
the current actual payload. Combined with the existing frame-local saving, that
would reduce 5,058,477 baseline bytes to approximately 3,584,541 bytes, a 29.1%
reduction. This is a simulation ceiling, not a protocol benchmark.

## Recommendations

1. Extend schema interning to inbound watch/query selectors and transact
   payloads. Inline/internable schemas are the largest practical
   connection-local target at about 403 KB net in this run.
2. Add a negotiated connection-local handle table for verified schema hashes
   and repeated entity/space/session identities. The combined idealized schema
   plus identity opportunity is about 686 KB.
3. Investigate a smaller transact receipt that avoids echoing request document,
   schema, and operation content the client already has. Preserve accepted seq,
   conflict, and authoritative revision semantics.
4. Do not transparently content-address ordinary mutable documents. The
   connection-local document opportunity was only about 20 KB. Equal document
   bytes still do not replace sequence-addressed revision identity.
5. Before changing the protocol, simulate bounded cache capacities, reconnect
   resets, misses, eviction, reference widths, and permessage-deflate physical
   bytes. The current numbers model semantic text payloads and a perfect cache.
