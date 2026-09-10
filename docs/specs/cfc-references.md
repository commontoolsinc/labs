# CFC references

The reference profile implements
[CFC §8.2](https://github.com/commontoolsinc/specs/blob/ca3b3e6cdac99a7b14951f48cec63949b39eaaa9/cfc/08-02-pass-through-via-references.md)
with independently labeled reference bindings. It is enabled by
`cfcFlowLabels: "persist"`; rejection follows the configured enforcement mode.

## Reference and content subjects

Writing `A.selected → B.item` writes A. A's reference entry records the complete
binding and the confidentiality of acquiring, selecting, and exposing it. B's
content labels remain on B. A public, independently acquired reference to secret
content can stay public. A private selection among public items produces a
private reference.

An application dereference consumes the reference restrictions at every hop and
the current target labels for the observation it makes. Holding a Cell across
transactions, narrowing its path or schema, recovering it from a query result,
and serializing it through a supported Runtime boundary preserve the acquisition
history. Immutable containers retain the trusted acquisitions of their reference
slots before encoding; decoding an address alone cannot restore that history.
Eager and lazy schema reads that box inline array objects capture references at
their original slots and rebase inherited scope caps onto the immutable result.
A later target-label change is resolved on the next content observation.

Precise immutable construction, raw reads and writes, and pattern result
projection preserve link-free instance values through their canonical codecs,
including native Error causes and extra properties. References inside opaque
instance state are unsupported and fail closed. General Cell-to-link and IPC
conversion retain their instance refusal.

The transaction records explicit identity and dereference observations alongside
its journal. A later covering trace cannot erase an earlier identity comparison.
Generic reference and container writes use the conservative observation/control
join, including triggers. Trusted coordinator bookkeeping may mark its own reads
as machinery; merely writing links or restamping membership proves no isolation.
Per-element execution can keep content computations pointwise while a shared
coordinator reference retains broader selection history from its creation or
reconciliation. Dereferencing through that coordinator still consumes its
history.

`LinkReference` integrity records a relationship. It does not endorse B's
contents. A receiver's `addIntegrity` declaration cannot satisfy a floor on a
different content subject. The schema attached to a handle is a read projection;
it is not proof that the target currently satisfies a content assertion.
Declared receiving policies apply to the reference slot and projected paths
structurally. Merely declaring confidentiality there does not inspect the
target's type or contents.

## Verification before storage submission

Runtime checks explicit content floors and copy requirements against the current
scoped target, using the shared link resolver. Nested requirements map through
the receiving binding. Supported wildcard floors enumerate concrete
contributions and verify each; unresolved evidence rejects. Reference exact-copy
compares the complete binding, while a claim about a linked descendant resolves
that content. Reference serialization consults the handle's carried schema. It
does not resolve the target merely to discover a schema or populate reference
labels.

A content assertion can itself reveal protected information through success or
failure. Its evidence, including traversed bindings and protected metadata, must
fit confidentiality the attempt already carries. Otherwise it returns the common
unavailable-evidence refusal. This guard applies to content assertions; ordinary
reference forwarding does not inspect or import target content labels.

Verification reads carry authorization dependencies separately from application
taint. Storage checks ordinary document revisions, including the confirmed and
pending revision basis captured with the read. CFC metadata, schema, binding,
and value changes cannot disappear through internal-read or mergeable-write
conflict filters. Storage does not interpret CFC policy and verification does
not write B.

Mutable content assertions across spaces are rejected when their evidence cannot
be bound atomically to A's commit. Reference-only forwarding does not require a
content assertion. The implementation has no persistent target-evidence cache.

## Transport and disclosure

Runtime owns reference provenance through private associations with live
carriers. A serialized label view cannot mint it. In the precise profile,
RuntimeProcessor exports opaque `cfcReferenceToken` values scoped to its fixed
authenticated security context and lifetime. Import restores the original
carrier, permits descendant paths, and preserves scope restrictions. Rebinding
identity, space, scope, or overwrite mode rejects. Persistence rejects a schema
projection that cannot encode the acquisition's retained scope caps. Stripped,
stale, or foreign tokens cannot recreate trusted acquisition through arbitrary
CellRef operations.

Explicit host acquisition APIs, including `GetCell(cause)`,
`RuntimeClient.acquireCell(address)`, and piece/home/slug loaders, remain
trusted entry points. The shell inspector and string-link components acquire
their independently selected addresses through that host operation. Ordinary
CellRef operations require the issued token. Address-only wire strings cannot
encode historical selection provenance. Metadata projections retain the
requesting handle's restrictions, including references returned in internal
manifests.

Display views preserve held-reference confidentiality as covering restrictions
under the existing view format. Inbound display fields are stripped. Render and
LLM observation gates therefore retain reference restrictions without treating
the view as authority to create references or endorse content.

Label introspection also observes metadata shape. Templates protect presence,
type, kind, count, order, and empty query results for derived labels and precise
reference labels. A public field classification adds no field-specific
restriction but cannot erase the selection context. A normalized denial retains
the observations used to decide it. When flow labels cannot carry a protected
query result, introspection returns the common unavailable result.

## Format and rollout

CFC envelope version 2 supports precise reference entries. Each stored reference
slot requires its own complete entry; upgrading one slot does not authenticate
untouched legacy references. `origin: "link"` with `observes: "followRef"`
carries reference confidentiality; content is resolved independently. Other
label components retain their existing update disciplines. Readers accept
versions 1 and 2 and reject unknown versions at protected reads. A metadata
retrieval failure propagates as a failure; it cannot establish that a reference
or its contents are unrestricted. Protected assertions normalize unreadable or
unsupported metadata to unavailable evidence, while unexpected storage failures
remain operational errors. Deploy compatible Runtime, worker, and boundary
readers before enabling precise writes; older readers that reject version 2
cannot participate in that profile. Cooperating reference writers must also
persist complete per-slot acquisition history before precise readers consume
their output. The shell, deployed CLI, production server preset, and serving
Runtime persist this history. Embedding controllers must select persistence when
writing for these readers; a flow-off writer can produce references they refuse.
Reader compatibility alone does not establish writer provenance.

Version 1 remains available to the legacy profile. Missing envelopes and slots
without complete reference entries also have unresolved acquisition history.
Keeping recorded restrictions does not reconstruct selection dependencies that
its writer omitted. Precise acquisition or traversal of a legacy stored
reference therefore requires trusted re-acquisition; unresolved history fails
closed. No bulk rewrite or automatic removal of legacy confidentiality is
performed. Direct, independently authorized acquisition of a document address is
a separate operation.

Diagnostic or disabled settings do not establish enforcement guarantees.
`enforce-strict`, persistent flow labels, enforcing floors, and enabled trigger
gating remain separate deployment choices described in the
[enforcement matrix](cfc-enforcement-matrix.md).
