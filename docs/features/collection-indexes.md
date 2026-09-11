# Collection indexes

Array-valued Cells expose `groupBy(selector)` and `keyBy(selector)`. Each
selector receives one source element. The compiler lowers it to reactive key
extraction; the runtime owns membership maintenance for each source occurrence.

`groupBy` retains every occurrence under its selected key. `keyBy` retains the
occurrence with the smallest collection occurrence identity under UTF-8 ordering.
Reordering the same linked elements preserves this winner; removing it exposes
the next candidate. Groups use the same identity order, independent of source
position. Replacing an inline value follows ordinary collection identity rules.

Both operators return a typed handle. `lookup(key)` observes one bucket and
returns an ordinary reactive group or optional original element. Missing groups
are empty arrays; missing unique entries are `undefined`. `keys()` separately
observes occupied-key enumeration. Lookup does not read that enumeration or scan
the source collection.

## Keys

Keys are strings, finite numbers, booleans, or Cell references. Primitive domains
are distinct, and positive and negative zero share a numeric key. Nullish keys
omit an occurrence. Unsupported keys fail through the shared key resolver.

A Cell key denotes its resolved space, document, path, and scope. Its schema and
stored contents do not participate in equality. Selecting a Cell preserves that
identity before serialization; selecting a primitive field reads the field's
value. Changing only a selected Cell's contents does not rerun key extraction.
Link retargeting remains reactive.

## Ownership and recovery

Each index owns its bucket descriptor and maintenance records. Bucket values
retain links to original source elements, so consumers can observe non-key
fields directly. Removing the last member deletes the bucket and its occupied
key; an existing lookup can observe subsequent reinsertion.

Maintenance children declare materializer write envelopes covering possible
bucket destinations. This keeps a source assigned to B demanded when only A is
observed and the source may move to A. Each maintenance transaction updates its
old and new buckets and participates in ordinary conflict and policy checks.

Coordinator setup state belongs to one serving principal and session. On resume,
the coordinator confirms its source, selector collection, descriptor, and
maintenance records before reconciling membership. Child setup propagates the
resume synchronization requirement. Pending selector tags preserve existing
membership. Teardown releases owned children and prevents pending synchronization
from rearming a released coordinator. A rejected confirmation is reported and
leaves membership intact; a later input change can start confirmation again.

## Work and limitations

Membership reconciliation scans source occurrence identities. `groupBy` rebuilds
and sorts each affected bucket; a bucket with M members can require O(M log M)
work. `keyBy` writes one member entry and compares an inserted occurrence with
the cached winner. Non-winning updates avoid enumerating the bucket. Removing
the winner scans the remaining members in O(M) work to choose its replacement.
A missing winner cache is reconstructed from durable membership, and a missing
published bucket is restored from its selected member.

Occupied-key metadata is maintained with membership. A separate child enumerates
and sorts K occupied keys when `keys()` is demanded, which can
require O(K log K) work. Lookup-only demand does not rebuild this enumeration
for membership updates. Retained live membership records are proportional
to source occurrences and occupied keys; storage history follows the ordinary
storage retention policy.

Materializer envelopes can introduce scheduler ordering edges proportional to
source size even when an unrelated lookup does not rerun. These operators make
no constant-time update guarantee. Group consumers also pay for the members they
read. Scale measurements and join operators are tracked by the
[implementation plan](../plans/pattern-computation-cost-implementation.md) and
[index contract](../plans/collection-index-contract.md).
