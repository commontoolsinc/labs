# Collection indexes and keyed lookup

Status: proposed B1/B2 contract for the
[computation-cost implementation](pattern-computation-cost-implementation.md).
These operators are pending implementation. The decisions below define the first
implementation and its acceptance tests; measured complexity belongs in the
feature documentation when the operators ship.

## Key domain and equality

Keys are strings, finite numbers, booleans, or Cell references. Null and
undefined mean that an element has no key and does not enter an index. NaN,
infinities, plain objects, arrays, symbols, and functions are invalid keys.
Number and string keys occupy different domains; positive and negative zero
share a numeric key. Reject invalid keys with an authored-source diagnostic.

Cell keys compare by resolved Cell identity, using the same address equality as
`Cell.equals`: space, document ID, path, and scope. Schema and stored contents
do not define identity. Two different Cells storing equal values remain separate
keys. Cross-space keys are supported subject to ordinary read access.

Resolve key references in ordinary reactive transactions. Record dependencies on
each link traversal so retargeting a key moves membership without requiring an
edit to its containing element. Changing only the target's contents does not
change index membership. Missing, loading, denied, or cyclic references must
follow the runtime's existing resolution and error behavior; a provisional
missing read is not evidence that a durable group should be cleared.

Reuse `resolveLink`, normalized link equality, and the collection identity
helpers. Any durable bucket address must be derived with canonical data-model
hashing from the owning index instance and a typed key representation.
Separate indexes must not share bucket state merely because their keys match. A serialized key is internal routing
data, not a public substitute for the original Cell key.

## Grouping and unique-key selection

`groupBy` retains every source occurrence with a valid key. `keyBy` returns at
most one source occurrence for each key. For duplicate keys, `keyBy` chooses the
smallest existing collection element-occurrence identity under UTF-8 ordering.
Reordering the same linked elements does not change that winner. Removing the
winner exposes the next candidate. Authors who need all matches use `groupBy`.

Groups use the same deterministic identity order, rather than source position.
Repeated occurrences remain repeated, following `listElementKeys`. Inline values
inherit the identity behavior of the source collection machinery; there is no
promise of stable identity for a replacement inline value.

An absent group lookup returns an empty collection. An absent unique lookup
returns undefined. A lookup with a missing key has the corresponding absent
result. An invalid lookup key produces the same diagnostic as an invalid
extracted key.

Group enumeration contains occupied keys only and has deterministic typed-key
order: booleans, numbers, strings, then Cell addresses. Within a domain use
boolean order, numeric order, UTF-8 string order, or UTF-8 canonical address
order respectively. Empty groups disappear from enumeration, but an existing
lookup must remain subscribed so later insertion becomes visible.

## Lookup and join surface

Provide `groupBy(selector)` and `keyBy(selector)` on collection Cells, with
transformer lowering for ordinary authored array syntax. A selector receives one
element and must retain Cell identity when returning a reference. Avoid index or
whole-array callback arguments in the first API: they would make source
reordering a dependency of every key extractor.

The result is a typed index handle. Its `lookup(key)` returns an ordinary
reactive Cell containing a group or an optional original element. A separate
`keys()` operation observes occupied-key membership. Each lookup subscribes to
one key's bucket and the lookup key's resolution path; it must not subscribe to
index enumeration. The exact type declarations and branded-handle lowering must
be prototyped before the implementation contract is marked complete.

The first join is a left lookup join against a `keyBy` index: one output per
left occurrence, with its original left element and an optional right element.
Unmatched left rows remain present. Duplicate right keys use `keyBy`'s winner.
Output order and occurrence identity follow the left collection's existing `map`
contract. A right update affects only matching left rows; a left key change
retargets only that row. Both key extractors and lookup keys retain
link-retargeting dependencies.

Many-to-many joins are deferred. They require a separate cardinality and
output-identity contract; `groupBy(...).lookup(...)` exposes all matches without
claiming an incremental many-to-many join.

## Ownership and work bounds

Index membership, per-element key extraction, bucket results, and lookup results
use ordinary reactive child runs and transaction rollback. Follow
[runner child ownership](../specs/runner-child-run-ownership.md) for removal,
independent readers, teardown, and reload. Reusing a key after removal should
address the same deterministic bucket; retired children must not leak merely
because another key remains populated.

The implementation must distinguish these costs:

| Operation                                | Required bound or explicit limitation                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Initialization                           | Reads each source occurrence and extracts each key once; sorting may cost O(N log N).                                       |
| Membership edit                          | May reconcile O(N) source identities, as current list builtins do. Report this separately from value updates.               |
| Independently linked element changes key | Reevaluate that extractor and maintain its old and new buckets; do not reevaluate unrelated extractors or lookup consumers. |
| Non-key element field changes            | Keep bucket membership unchanged; consumers reading that field react through the original element link.                     |
| Lookup                                   | Resolve its key and address one bucket; no source or key-enumeration scan.                                                  |
| Group materialization                    | Reading a group with M members costs at least O(M). Do not describe returning a group as constant-cost materialization.     |
| Join update                              | Reevaluate affected left rows; a popular right key can legitimately affect many rows.                                       |
| Retained state                           | O(N + K + L) membership, buckets, and active lookups, excluding source payloads; explain any persistent tombstones.         |

No exact logarithmic update guarantee is asserted until the bucket-maintenance
prototype demonstrates it. Rebuilding an affected bucket can cost its group size
even while unrelated-key invalidation remains bounded. The motivating roster
uses unique keys, so its lookup benchmark must separately cover skewed duplicate
groups.

## Implementation sequence and acceptance

- [ ] Prototype the typed index handle and its transformer/schema boundary. Keep
      key lookup separate from ordinary object-property `Cell.key`.
- [ ] Implement shared key resolution and per-element extraction, reusing
      runtime identity and ownership machinery.
- [ ] Implement `groupBy`, unique-key selection, and per-key lookup.
- [ ] Test primitive domains, missing/invalid keys, duplicate occurrences,
      source reorder, key edits, link-only retargeting, and cross-space keys.
- [ ] Test absent lookup before insertion, last-member removal, reinsertion,
      rejected transactions, teardown, cold resume, and independent readers.
- [ ] Count callback and consumer runs. A change to key A must leave a key B
      lookup's run count unchanged when its declared dependencies are unchanged.
- [ ] Implement the left lookup join; cover both-side updates and unmatched
      rows.
- [ ] Benchmark initialization, membership reconciliation, one linked-row edit,
      lookup, and skewed duplicates independently at increasing sizes.
- [ ] Publish contracts, measured limits, and a synthetic roster/tally demo.
      Live poll migration remains subject to coordination with Mike.
