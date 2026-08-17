---
status: historical
created: 2026-08-14
archived: 2026-08-14
reason: "Executed work order for enabling strict CFC defaults and making every required platform path safe under those defaults."
---

# CFC enforcement default rollout

This work order records the changes required to make contextual flow control
(CFC) enforcing by default throughout Labs while preserving every runtime
option as a rollback control. Loom continues to warn without rejecting commits.
Its harness and host boundaries now pin the complete observe posture explicitly
so they do not inherit the enforcing platform defaults.

Each numbered section is one commit. The order is intentional. The first
commit changes production defaults only. The second changes only tests that
directly inspect those defaults. Later commits repair or expose distinct
platform behavior that strict enforcement reaches.

## 1. Flip the CFC switches

Set the seven shared CFC defaults to their enforcing values:

- boundary enforcement becomes `enforce-strict`;
- flow-label handling becomes `persist`;
- the write floor becomes `enforce`;
- trigger-read gating becomes enabled;
- policy evaluation becomes `enforce`;
- label-metadata protection becomes `enforce`; and
- declared-label monotonicity becomes `enforce`.

Apply the same values to the first-party runtime preset and the CF harness
default. Set the shell's enforcement default to strict. Update only the
comments that state those switch values. This commit contains no test updates,
option transport, behavioral repairs, or broader documentation.

## 2. Update tests that directly inspect the switches

Change only assertions whose subject is the value of a default switch. This
includes the runtime option constants, first-party preset defaults, CF harness
configuration and diagnostics defaults, the FUSE and toolshed default runtime
posture, and the browser worker's absent-option behavior.

Do not add rollback-routing tests here. Do not change behavioral tests that
happen to fail because they were implicitly relying on an old default. Those
belong to the rollback or test-migration changes below.

## 3. Carry every rollback switch through the platform

Keep the default change reversible without another code change. Accept all
seven controls in the shared preset parameters. Forward explicit values through
the shell, runtime client initialization message, browser worker processor, and
runtime preset. Let omitted shell values reach the shared worker preset instead
of copying defaults into the shell.

Add focused tests that pass non-default values and prove that none are dropped
or replaced. This is the seam Loom and other hosts can use to remain at an
earlier rollout stage. Carry the cf-harness mode into both named-space and
DID-space Fabric sessions as a complete posture. Map Loom's existing `observe`
selection to the observe rung of every staged dial and leave trigger-read
gating off, so those sessions warn without rejecting. Pin the manifests made
by Loom's trusted local batch and interactive hosts to that observe posture as
well, instead of letting a missing manifest value inherit the platform default.
Reject non-observe command-line and interactive-policy overrides at the Loom
boundaries. Persist `observe` in interactive session status so it reports the
posture used for execution. Remove the two inherited enforcement variables
before invoking the shared CLI. Require both a resumed run's recorded state and
its Loom manifest to retain the observe posture.

Forward an explicit pattern-test enforcement override into every multi-user
participant worker as well as the single-user runtime. This keeps a test whose
subject is unrelated to CFC able to select the earlier enforcement mode
consistently across both harness paths.

The complete earlier posture also keeps flow labels off. Piece-root labeling
uses that control, so selecting the earlier values does not write new ambient
space labels or backfill old pieces.

## 4. Prepare every enabled CFC transaction before commit

Strict enforcement exposes commit paths that previously relied on observe mode
to call CFC preparation. Make the extended transaction prepare every relevant,
non-disabled transaction before commit. Keep completed transactions unchanged
when a caller asks to prepare or commit again.

Reactive actions record their observations immediately before committing.
Perform that bookkeeping before CFC preparation so the prepared digest covers
the final transaction rather than being invalidated by a later receipt write.

The background piece worker owns a raw edit transaction. Await its commit,
surface rejection reasons, and abort only when commit has not begun. The
transaction's commit method performs the preparation. Tests cover the worker
path and repeated commit handling.

## 5. Keep verifier metadata reads out of scheduling

CFC preparation reads stored labels and schemas for verification. Those reads
must not become application dependencies that schedule work. Mark them as
internal verifier reads wherever cells, schemas, or label metadata are loaded.

Classify the runner's document metadata fields in one place. Exclude only those
root storage fields from value-write policy processing while continuing to
treat user fields with the same names as ordinary values. Read both the current
standalone CFC document shape and the older nested shape.

## 6. Record policy and ceilings for runtime-generated writes

Strict verification needs a schema and writer identity for storage created by
the runner rather than directly authored by a pattern. Introduce one helper for
recording generated-write policy and use it for argument, result, internal,
seed-materialization, and builtin output cells.

Cover map, filter, flat-map, list-result, confidentiality inspection, and
generic data-updating paths. Mutable query proxies must record the schema of
their actual write target before changing a property or array. Event receipts
must record their inferred shape with the ambient space policy before storing
the handler result. Write redirects must record the schema against the resolved
destination as well as the link that initiated the write.

Raw builtins can create internal result cells without a result schema. Record a
generated root schema carrying the destination-space confidentiality in that
case. This gives schema-less builtin output a deterministic writer-fit ceiling.
Stamp streamed model-output batches as they are written. This keeps the final
partial value labeled when it equals the last streamed batch and the final
storage write is therefore a no-op.

Record `LlmDerived` provenance through a transaction-private list of the exact
model-output locations written by the LLM builtins. Include child documents
created while storing structured model output. Do not put this runtime mint in
caller-authored schema bytes. Recursive schemas remain subject to the ordinary
unsupported-policy-placement rejection, and a stored schema cannot arrange for
a later builtin write to mint provenance. Replace the runtime entry on another
model write and clear it on an ordinary overwrite.

Treat each model-authored dialog message as a generated output when recording
its integrity-stamping schema. The message document is created and typed in
the same transaction, so its required fields do not describe a migration of an
older document. Attribute the message document creation to the dialog builtin
before recording or writing it, so every policy input that contributes the
runtime-minted integrity has the trusted author identity.

Distinguish ordinary generated outputs from setup outputs so the verifier can
recognize the one transaction that constructs a cell without weakening policy
for later edits. Tests prove that generated writes carry policy and that
authored policies still win.

A generated output's implicit confidentiality ceiling is the destination
space. It must not borrow the confidentiality of the data flowing into it,
because that would manufacture authority from the value being checked.

Use the destination-space label as the implicit writer-fit ceiling only when a
generated output has no authored confidentiality declaration. Do not change the
general schema merge rules: an incompatible authored replacement remains a
rejection. Tests cover a generated write whose input is more confidential than
its destination permits and an explicit space ceiling receiving another
space's data.

Schemas can describe a value as `unknown` while another input or the stored
envelope retains its concrete type. Treat `unknown` as permissive during schema
accumulation. Keep the concrete type and merge the unknown side's other
constraints, including a cell-wrapper marker. This preserves validation while
allowing generated and authored schema inputs to contribute metadata around a
value whose shape they do not know. Match concrete generated array-item paths
to the wildcard item path in their schema. Concrete type changes continue to
require explicit migration authorization.

## 7. Label newly created pieces and setup-owned storage

Apply `Space(space)` confidentiality when `cf piece new` creates a piece and
when the root space piece is initialized, recreated, repaired, or updated. Pass
the root confidentiality through runtime setup, run, and pattern-update paths
so result, argument, and internal setup cells receive the same ambient label.
Apply that policy when setup projects an argument or result into another
document. Treat a policy containing only the destination's ambient space label
as document-wide policy rather than value shape. A projection alias can name a
path in a document whose actual value has a different root type, and the
ambient label must not manufacture an object envelope around that path. Allow
setup to record policy before a projected destination has a value.

Use the same ambient policy when a user-scoped or session-scoped instance is
first materialized after setup. A second user or session can create its own
instance long after the shared pattern was initialized, so setup-time metadata
alone cannot cover that first write. Treat a flow-precision-only declaration as
needing the ambient policy because it does not declare confidentiality or
integrity.

Only persist these labels while the flow-label switch is set to `persist`, so
selecting the earlier posture keeps existing behavior.

Refreshing an ambient schema without changing its value must preserve the
value's existing derived, link, and structure labels. A schema-only policy
write updates the declared component without pretending that the stored value
was replaced. When runtime-generated and authored schemas for the same target
arrive separately, retain the ambient `Space(space)` clause beside every
authored confidentiality clause. A generated schema that knows only the
ambient clause must not replace an authored restriction already accumulated or
stored for that target.

The ambient space label does not make two same-space pattern contracts
incompatible. Remove it temporarily during the same-space subset comparison
and writer-fit check while preserving every non-ambient restriction. Keep the
ambient atom in persisted flow metadata. Tests cover ordinary pieces, roots,
repairs, updates, same-space links, and same-space value flow.

Do not attempt to persist label metadata on immutable `data:` addresses. Treat
an existing frozen-existence entry that contains only the ambient destination
space as the initialization baseline. The first actual creation under labeled
control replaces that baseline with the creation join; later overwrites keep
the resulting frozen existence label. Update behavioral tests that now observe
the ambient space atom or the CFC envelope created for an otherwise plain
document.

## 8. Backfill missing piece labels before startup

Existing pieces can predate the new label. Route every persisted-piece start
through one preparation method that inspects the piece schema and writes a
missing `Space(space)` label before the runtime starts the piece.

Serialize this preparation by canonical piece identity. Concurrent starts of
the same piece share one preparation promise, while different pieces remain
independent. If another controller wins the same storage update, synchronize
and accept the winning label. There is no retry loop or timing delay. Tests
cover ordinary and root legacy pieces, same-controller concurrency,
cross-controller conflicts, and distinct-piece concurrency.

## 9. Cover generated deletes and array-length writes

Low-level deletes used by piece property updates bypass the ordinary cell setter
and therefore need an explicit schema-policy record. Resolve the redirect,
translate concrete array indices to schema wildcards, record the policy, write
the deletion, and prevent the storage layer from treating it as mergeable.

An array shrink writes its `length` while removing indexed links. Teach CFC link
coverage to associate those operations and preserve concrete schema paths when
building the verification envelope. Resolve each parent shape from both the
stored and already-recorded schemas. Encode concrete array indices through the
array's item schema without allocating tuple padding, while keeping numeric
object keys as object properties. Treat the synthetic `length` write as policy
for the array container only when the parent schema is an array. An object
property named `length` keeps its own policy path. Cache the stored envelope
read so verification reuses the same state. Tests cover array growth, array
shrink, sparse indices, numeric object keys, object `length` properties, and
existence-channel behavior.

## 10. Protect module-policy manifest documents

Policy manifest documents are themselves security-sensitive data. Give each
manifest a schema whose confidentiality names its module policy, symbol, digest,
and owning space. Require all three identity fields before resolving a durable
manifest and use the same schema for installation and consultation.

Tests prove that manifest consultation remains bound to the expected immutable
artifact while strict metadata protection is active.

## 11. Require a valid future writer during trusted initialization

Owner-protected schemas must name a structurally valid future writer. Classify
writer-authorization failures so trusted runtime initialization can bypass only
the live writer identity that is unavailable or intentionally different while
constructing or updating a projection for its declared future writer. Require
the trusted setup marker before accepting a different writer. Never bypass
malformed or empty claims, missing module identity, or missing trust
information.

Keep setup projection and seed materialization narrowly recognized as creation
operations. Subsequent writes use the declared writer policy. Tests cover
accepted trusted initialization and each rejected claim shape.

## 12. Make non-default test scenarios explicit

Some CFC tests intentionally exercise one rollout control in isolation. Set
their unrelated controls explicitly instead of inheriting the new product
posture. Piece and runner fixtures that test behavior outside CFC select the
complete earlier posture at the fixture boundary. Strict-default integration
coverage stays in the preceding implementation commits. Preserve the original
metadata-observation assertions instead of making a destination policy from
the sensitive flow the test has just consumed.

Trusted-event contract tests select enforcement while leaving flow-label
persistence off. Raw renderer-policy fixtures disable both controls before
seeding label documents directly. These settings preserve the scenario each
test was written to exercise. Pattern tests that invoke a reviewed trusted
surface supply the same trusted surface and action evidence as a renderer
click. Legacy CLI storage fixtures explicitly disable CFC when their subject
is unrelated to CFC behavior. Pattern-vintage capture uses the same
pre-enforcement posture as the file-backed runtime that owns its legacy
fixture store. The render-policy demo test uses the demo's labelled source and
trusted surface instead of constructing an unlabelled value for a confidential
input.

## 13. Isolate unrelated controls from confidential host content

Strict writer-fit checks consider the labels available to the pattern that
owns a handler. The trusted disclaimer examples placed confidential content
and an unrelated lookalike status handler in the same pattern. That made the
status handler carry the content's confidentiality even though the handler
read only its public message and wrote only its public status.

Move the lookalike button, message, status, and handler into a child pattern
whose inputs exclude the confidential content. Render that child from each
disclaimer host and preserve the existing status output and trigger stream.
This keeps the visible negative-path feedback while giving the status writer
only the data it actually uses. The gallery tests continue to run under the
enforcing defaults and prove that the lookalike status changes without changing
the trusted output. Drive the reviewed actions through their trusted streams so
the renderer evidence reaches the handler whose policy names that action. Keep
each handler within its declared output: capturing a direct command does not
clear the research brief owned by a different reviewed action. Before release,
verify that the prepared brief was derived from the currently captured command.
Recapturing a command therefore invalidates an older brief without crossing
the trusted actions' output boundaries.

Apply the same isolation to the render-policy demo's visibility control. Keep
the public boolean state and its handler in a child pattern that does not
receive the confidential health content. Use one toggle handler with no
caller-chosen target value, so its reviewed action can authorize only the next
visibility transition. Have the pattern test send the renderer-trusted evidence
directly to that stream. The test still instantiates the complete render demo,
so it also covers accumulation of its ambient and authored confidentiality
labels. Type each composed UI output as a renderable node so the child controls
and both disclosure surfaces pass standalone type checking.

## 14. Evaluate write floors against the values that actually land

A required-integrity floor can cover a container while its values arrive as
array items, plain descendants, or links. Credit each concrete array item with
the integrity declared by its item schema. Judge only the deepest plain writes
when storage also reports the containers it created along the way.

For a link, combine the source's carried integrity with the target schema's
integrity. When an ancestor link covers an optional nested floor, inspect the
nested source value. An absent value contributes nothing because the floor
governs values that are present. A present value without the required evidence
still fails. Expand wildcard floors to the concrete array items written by the
transaction, including linked cells. Tests cover each form and retain the
sibling-smuggling rejection.

Evaluate JSON Schema combinators together with their sibling constraints. An
`anyOf`, `oneOf`, or `allOf` determines whether its own branch condition
matches, but does not replace an adjacent discriminator. This keeps a policy
attached to a trusted union member from applying to an untrusted member merely
because that value matches the wider union.

Preserve sparse arrays while resolving linked values for branch and floor
checks. An absent array slot must remain absent rather than becoming a present
`undefined` value. Apply deletion checks uniformly at the document root and at
nested paths. A root deletion must inspect the previous value for restrictive
policy without using it to mint positive evidence.

## 15. Keep confidentiality and integrity inheritance independent

Resolve the confidentiality and integrity fields of a label independently
within each origin component. A child declaration that supplies only integrity
must not erase its parent's confidentiality. An explicit empty array still
overrides the corresponding parent field.

Carry an array container's confidentiality into an element schema when code
asks for the schema at a concrete index. Tests cover both schema traversal and
strict writer-fit when a child adds only integrity.

Persist an explicit empty child field when it shadows a non-empty ancestor
field in the same declared component. Keep confidentiality emptiness dependent
on positive branch evidence so an unresolved or nonmatching branch cannot
erase an ancestor restriction. Carry an empty override forward only while the
stored schema still declares the same shadowing relationship.

## 16. Store current-principal evidence on each written value

An `addIntegrity` claim that names the current principal changes with the actor.
It therefore cannot be a monotone declared store policy on a shared path. Keep
the placeholder in the schema for verification, but exclude its resolved value
from the declared label component. Resolve and store it as a derived component
at each concrete path written by that actor.

This lets two users append values carrying their own authorship evidence
without changing one shared declared wildcard from the first user's identity
to the second user's identity. Existing fixed integrity declarations remain
declared and retain the monotonicity gate.

## 17. Match parking-spot values to the list integrity floor

The parking coordinator requires its spot list to carry the parking-admin
integrity atom, but its item type did not add that atom to each generated spot.
Give the internal writer view of each spot the matching `AddIntegrity` policy
so strict write-floor verification can credit the values placed in the
protected list. Keep the public input contract unchanged so existing callers
are not required to supply evidence that the pattern itself adds.

## 18. Repair group-chat policy under strict CFC

The group-chat room list requires the group-chat-admin integrity atom, but its
item type did not add that atom to each room. Give the trusted room-add handler
an internal item view with the matching `AddIntegrity` policy so strict
write-floor verification can credit the rooms it places in the protected list.
Keep the public room-cell contract unchanged so existing callers are not
required to supply that evidence and recorded pattern contracts continue to
accept the same room values. Record the resulting compatible contract as a new
baseline.

Store untrusted imported messages separately from messages created by the
reviewed send action. Combine the two stores for display and participant
discovery. This prevents either writer from inheriting the other store's
authorization rule.

Retain the value-specific policy on the everyone-is-admin flag. The true value
carries the group-chat-admin evidence that grants every profile administrative
authority, while the false value does not.

## 19. Permit monotonic CFC policy evolution in pattern contracts

Pattern source changes alter the compiled module identity recorded in
`writeAuthorizedBy`, even when the authoring file and schema path stay the
same. Treat that identity rotation as compatible when both revisions name the
same schema path and the file spellings match the resolver's documented
leading-segment variants. Continue rejecting changes to the schema path or a
file spelling outside those variants.

Permit a candidate pattern to remove integrity stamps, which weakens the
declared trust claim in the same direction as the runtime's store-policy gate.
Mark authenticated piece source setup transactions so their stored schema
envelopes can apply the same removal instead of preserving or rejecting the
stale mint. Continue rejecting that envelope weakening outside a source update.
Continue rejecting new stamps, confidentiality changes, and every other CFC
policy change. Tests cover each accepted and rejected direction.

## 20. Keep the compilation cache portable under ambient labels

Treat source and compiled cache documents as runtime-generated storage. Record
their write schema even when a source document has no delegation metadata, so
strict writer-fit gives each cache write the destination space ceiling. Declare
that ambient confidentiality on both source and compiled write schemas while
retaining the compiler integrity claim. Carry the policy into entity documents
created while normalizing cache arrays and into new link-bearing documents that
the storage representation creates. Test repeated writes to the shared cache
documents in one strict runtime.

The source space's ambient `Space(space)` label is storage policy rather than a
restriction in the authored source bytes. Permit source recovery to another
space when that ambient label, the compiler's delegation attestation, and
link-origin `LinkReference` integrity for source links are the only stored CFC
metadata. Continue to reject custom confidentiality and every non-structural
integrity claim. Recompilation in the destination writes a fresh
destination-space label.

## 21. Scope schema authorization to the fields it covers

A schema policy input for one field must not authorize unrelated writes in the
same document. Match each affected label entry and write path against a schema
input that overlaps both. Treat an array's synthetic `length` write as covered
by the schema input for the concrete item that caused it. Resolve the parent
from both the candidate and stored schema envelopes and apply that companion
rule only when the parent is an array. Numeric object keys and an object
property named `length` remain independent fields.

This preserves independent field policies while allowing array mutations to
carry their companion storage update. The existing multi-field boundary test
proves that a policy recorded for one field cannot authorize its sibling.

Do not treat a container-level no-op attempt as an attempted write to every
protected descendant. An exact or descendant attempt remains subject to the
entry policy even when storage elides it as a no-op. An ancestor attempt
reaches the entry only when the write details show that the entry's presence
or value changed. Compare Common Fabric values with data-model equality and
unwrap raw document envelopes before making that decision. This keeps a
message-list update from demanding the identity authorized to edit an
unchanged sibling admin field in the same document.

## 22. Keep ambient storage policy out of integrity input gates

The destination space's own `Space(space)` confidentiality is baseline storage
policy. It does not identify application data that needs the endorsement named
by `requiredIntegrity`. Exclude a same-space ambient-only read from the
integrity input gate when its remaining integrity consists only of structural,
current-principal, or runtime-transformation provenance.

Keep the full read set for confidentiality ceilings. Keep custom
confidentiality and another space's ambient policy in the integrity gate. Tests
cover same-space and foreign-space ambient reads, including runtime
transformation provenance.

## 23. Permit confirmed scalar source migrations

A confirmed source replacement can deliberately change an existing scalar
field between string, number, integer, boolean, and null. Carry the confirmation
from both piece source replacement paths through runtime setup. Record it as a
transaction policy input that names the reviewed document target, schema path,
old scalar types, and new scalar types. Let each schema-envelope merge in
preparation accept only those exact transitions. A confirmed compatibility
review carries separate authorizations for the argument and result documents.
Collect result transitions with the same root generated-output scope used by
the setup commit, so adding a required generated field does not hide an
otherwise exact scalar migration.
Transaction-local candidate aggregation may recognize the same exact pair in
either order, but the final stored-to-candidate merge accepts only the reviewed
forward direction. Do not extend the exception to internal or otherwise
unrelated documents written by the same transaction.

Continue merging the old and new CFC declarations so the migration cannot
weaken confidentiality or integrity. Continue rejecting object or array shape
changes through this path. Unconfirmed source replacement remains subject to
the ordinary compatibility rules.

## 24. Treat source-space clone labels as ambient

Cross-space piece cloning inspects the stored label view before copying a source
snapshot. Permit the source document's own `Space(source)` confidentiality and
the structural `LinkReference` and `TransformedBy` integrity atoms. These labels
describe storage location and runtime representation rather than authored data
restrictions.

Reject another space's confidentiality, custom confidentiality, and every
non-structural integrity atom. Pass the source space into both preload and
snapshot checks so the exception is exact rather than accepting an arbitrary
space label.

## 25. Preserve local schema references through derived envelopes

Schema-envelope merging can retain an old validation branch while replacing
its definition map with a smaller candidate map. Preserve validation-only
definitions that remain reachable from the merged structure. Candidate
definitions win name collisions only when the existing structure does not use
that name. Namespace unequal definition scopes before combining them, then
merge their resolved constraints at each reference's value path. This keeps
one side's definition from rebinding the other side's reference. It also keeps
scalar-migration authorization and generated-output exemptions attached to the
value each reference describes. Stop repeated recursive reference pairs from
expanding again. Validate their sibling constraints at the current value path,
including scalar migrations and newly required fields. Keep one equal
reference, or point repeated unequal references to a synthetic definition
built from their merged targets. This applies authorized type changes, policy,
and preserved defaults throughout the recursive value. Reuse and update that
synthetic definition when the same candidate is merged again. Repeated setup
therefore reaches a stable envelope instead of accumulating renamed definitions
and nested carriers. Give independent local scopes separate synthetic
definitions even when they use the same local name. Preserve reachable
policy-bearing definitions as well. Reserve definition names from every input
scope before allocating a synthetic name. Fork a reused definition before
changing one of several sites that refer to it, or before applying an inline
or finite site-specific change to a recursive target. Reuse a recursive
definition only when both referenced targets cycle back through the same set
of schema paths. Keep unmatched stored and candidate recursion bound to its
original definition. Keep the reachable non-recursive definition closure in
the synthetic definition's owning definition map. Namespace those dependencies
without renaming the synthetic self-reference. Rewrite dependency back-edges to
the synthetic target, and count the reachable definition closure as one owned
graph when checking for external reference sites. Keep mutually recursive
helper nodes as references inside the active graph, and exclude that graph from
dependency lifting. Preserve a newly forked synthetic reference when sharing
prevents reuse, so later identical merges remain stable. Treat reference-only
aliases as transparent when comparing recursive schema paths, and bind their
back-edges to the active synthetic target. Track the definition scope while
counting external references so an independent nested scope with the same name
does not block reuse. When unequal recursive topologies have already produced a
derived envelope, keep it byte-for-byte if a scope-aware graph walk proves that
it contains every candidate constraint. Compare object properties, array
items, equal-length tuple slots, object rest properties, required fields, and
CFC policy through their reference scopes. Compare policy and validation
siblings on a reference instead of treating that reference as a transparent
alias. Recognize generated recursive definitions in nested schema scopes.
Accept exact values for other schema applicators only when they contain no
references whose meaning could differ between definition scopes. Fall through
to the strict merge for an unsupported shape or any mismatch. Reject
reference-only cycles that never reach a concrete schema. Do not use this
shortcut for an authenticated integrity weakening. A retained reference must
continue to resolve to its original policy so its writer and integrity rules
can be evaluated during a later strict commit.

UI-contract discovery must resolve a property whose reference and definitions
are declared together against that property's definition scope. Establish the
child scope before resolving the property root, then carry it through recursive
contract discovery. Tests cover both the retained empty-object definition and
the property-local contract reference.

Schema-envelope merging must compare required fields after resolving each side
against its own current definition scope. Carry scopes through nested merges so
a definition map on an object or array governs its descendants. Use the
resolved properties when checking that a newly required field supplies a
default. Ignore undefined reference-site siblings when combining them with the
referenced schema, so they do not erase required fields supplied by the
definition.

Do not manufacture a `default` property whose value is `undefined` while
merging referenced schemas. Distinguish absence from an authored default.
Recognize previously generated recursive envelopes from their structural
schema markers rather than from a synthetic undefined default, so repeated
merges remain stable.

Track UI-contract reference cycles by definition-scope identity and reference
text together. Nested definition scopes may reuse the same local reference name
without hiding the inner trusted-action contract.

## 26. Exclude ambient storage confidentiality at render boundaries

The renderer should not require a declassifier merely to display a value from
the space that stores the rendered cell. Resolve the cell's effective storage
space together with its label view and remove only the exact `Space(storage)`
atom before applying render-policy gates. Apply the same rule to the schema
fallback used when no persisted label view exists.

Keep foreign-space and custom confidentiality gated. A value carrying its own
ambient space label plus a custom health label still requires declassification
of the health label before rendering.

## 27. Update the rollout documentation

Update the live experimental-option reference, enforcement matrix, feature and
testing notes, and runtime option comments to describe the enforcing defaults
and the still-supported rollback values. Add this work order to the historical
index.

This commit contains documentation only. It does not change a switch, runtime
behavior, or test expectation.

## 28. Let pattern actions finish their work

The pattern-test command currently supplies an implicit five-second action
timeout. Multi-user pattern tests impose similar action and worker-call limits.
Strict schema preparation can legitimately take longer for a large pattern,
after which the completed action and all following assertions still pass.
Remove the timeout option and its internal races. Await single-user and
multi-user action settling, full settle steps, and runtime teardown to
completion.

The previous races did not cancel the losing operation. A timed-out action or
teardown could continue mutating its runtime or storage while the runner moved
to the next test file. Tests now finish their work in sequence and report the
result of that work.

## 29. Preserve unchanged branch-local policy during schema merges

Some existing contracts use mutually exclusive value branches whose CFC
policy differs by value. Continue rejecting any merge that changes such a
branching policy: combining the branches could silently drop or manufacture
authority.

Allow a branching subtree to survive when it is equal on both sides or appears
on only one side. No policy is combined in either case; the subtree is retained
exactly. Resolve property rest claims and array rest claims before deciding
that a subtree is one-sided. Check both directions so any subtree that both
sides actually describe must still agree. This lets the group-chat
everyone-is-admin contract retain its value-specific integrity evidence while
the surrounding result schema gains independent fields.

Resolve local references in each schema's own definition scope before making
that comparison. Equal reference text does not make the referenced definitions
equal. Compare only reachable definitions, and treat an omitted field like an
explicitly undefined field. A changed definition must receive the same
branch-policy check as an inline schema. Resolve a reference used directly as
an alternative before checking whether that alternative contains CFC policy.
Use the same reference-aware walk when the other side has no corresponding
combinator. Follow references nested below an alternative, and identify cycles
from the unresolved schema position and its definition root before expanding a
reference. This finds policy behind direct, nested, one-sided, and recursive
references without overflowing the call stack.

Compare corresponding alternatives before considering policy beside the
union. An unchanged `anyOf`, `oneOf`, or `allOf` remains safe when the merge
adds a root confidentiality label, cell-materialization marker, default, or
unrelated reachable definition. The branch policy itself must still compare
equal in order and through each side's definition scope.

Recognize a stored, defaulted concrete object as the populated projection of
an empty-or-value union. Require the discarded branch to be a closed empty
object with no policy. Compare the populated branch and projection by resolved
value shape while allowing their CFC declarations to merge through the normal
schema-policy rules. This permits a generated union to add nested policy to an
older concrete projection without treating that monotonic policy addition as
a change to the union's value branches.

An integrity claim inside an `anyOf` or `oneOf` branch is evidence about the
value that matched that branch, rather than a permanent claim made by the
storage path. Retain the selected alternative and its enclosing schema as
conditions on the schema entry. The enclosing condition preserves constraints
beside the alternatives and the exact-one rule of `oneOf`. An `allOf` member
also retains the enclosing conjunction so evidence from one member is not
minted when another member rejects the value. Store branch-local
`integrity` and `addIntegrity` atoms as derived evidence only when all those
conditions match the attempted write. The condition includes sibling fields
that select an object branch.

Use the complete schema value validator for conditions. Numeric limits,
patterns, negation, conditional schemas, object and array cardinality, and the
other supported constraints must participate in the decision. Treat an
explicitly present `undefined` as a value and check it against the supported
`undefined` schema type. An unresolved reference or cell link cannot prove a
minting condition. The same indeterminate value remains subject to restrictive
policy. Let a definite mismatch dominate an indeterminate sibling constraint,
regardless of property order. Resolve linked values recursively for this
decision, including links nested in objects and arrays and chains of stored
links. Reject a link cycle as unevaluable. Track resolution separately from
the resolved value so a present linked property whose value is `undefined`
remains a valid value.

Evaluate wildcard conditions separately for every concrete item so one
matching item cannot mint integrity for its siblings. Apply the same matching
rule when schema integrity is offered as credit toward a write floor. This
keeps the declared policy monotone while allowing an authorized value to move
between alternatives. Tests cover the schema merge, reference resolution, the
persisted component, unmatched and unevaluable branches, mixed arrays,
sibling-selected branches, separated floor and mint branches, and an enforcing
transition from the unprivileged false value back to the integrity-bearing
true value.

Determine exact-copy and projection labels from the current concrete source
path. Do not require that source to be rewritten in the same transaction.
Filter conditional confidentiality restrictively and conditional integrity as
positive evidence. Resolve wildcard source entries against the selected array
item or record member, so a matching sibling cannot label a plain source. For
exact copies, resolve confidentiality and integrity independently at the most
specific covering source entry. This preserves ancestor fields that a child
does not replace and honors an explicit child replacement. Projection keeps
its specified all-covering confidentiality and scoped-integrity behavior.
Compare Common Fabric values with data-model equality so different links or
other special values cannot verify as copies merely because they have the same
runtime class. Require positive branch matching before verifying or carrying
an exact-copy or projection claim, including the exact-one rule of `oneOf`.
Apply the same concrete source-label calculation to pending same-transaction
links and to write-floor credit.

Record whether each storage write leaves its addressed slot present. Preserve
that fact separately from the value in native transaction inspection. A
present `undefined` and an absent slot therefore remain distinct across direct
writes, ancestor writes, and linked reads. A deletion uses the previous value
only for restrictive policy checks. It never mints authority from the deleted
value. Apply that rule to concrete paths, array and record wildcards, and whole
ancestor replacements. Enumerate removed wildcard members for restrictive
checks, and use data-model equality when deciding whether a nested special
value changed. Creation-only setup, seed, child-document, generated-output,
schema-default, and flow-label exceptions use recorded previous presence
instead of value definedness. Raw document-envelope writes inspect whether the
previous envelope owned its `value` member.

Derive policy carried by a newly written link against the concrete linked
source path. Evaluate the link schema's relative branch conditions at that
path, not at the containing document root. Split branch-local literal and
added integrity into the same positive per-value path used by ordinary
persistence. A nonmatching link schema or pending source schema cannot mint
its branch's integrity, while matching confidentiality continues to carry.

Apply the branch member condition to restrictive CFC claims and trusted UI
contracts. A property contract in one object alternative must not protect the
same property in a sibling alternative selected by a different discriminator.
Do not let a failed enclosing `oneOf` exclusivity check or another failed
conjunct make an invalid value escape a restriction whose own branch member
matches. Positive integrity evidence must satisfy both the branch member and
the enclosing union or conjunction. Keep indeterminate values restrictive
while refusing to treat them as evidence that mints authority.

Compare recursive branch schemas after resolving each side in its own local
definition scope. Track pairs of visited schema nodes to stop at corresponding
cycles. Local definition names can differ without making otherwise equal
branch policy divergent, while a changed referenced constraint still rejects
the merge.

Verify a generated write schema and the stored claims selected for link writes
as two policy envelopes. Both must pass. Do not merge them or wrap them in a
synthetic `allOf`: merging can lift an integrity claim across alternatives,
while a wrapper creates enclosing conditions that are not part of either
contract. Persisted schema merging remains a separate operation.

Treat an array's recorded `length` update as structural bookkeeping when a
write floor judges the values placed in that array. An endorsed linked item
must not fail because the same push also changed the array length. Plain sibling
values still contribute separately and must each satisfy the container floor.

Reject CFC declarations in schema positions whose logical value path cannot be
represented safely. This includes conditional and negated applicators,
property-name and containment checks, mixed named properties with a labeled
rest-property schema, and recursive policy shapes. Perform the check on raw
write-policy inputs and again after loading or merging the stored schema.

Search every schema applicator, including validation-only conditional branches,
when deciding whether an unsupported or recursive position contains CFC. A
policy hidden under an unused `if` branch is still policy. Preserve a
branch-local contract that contains an explicit empty `maxConfidentiality`
ceiling even when the branch does not match the current value; the empty ceiling
is a future restriction, not the absence of policy.

Reconstruct the current value from the raw document envelope when available.
Replay fallback write details in transaction order so a later ancestor write
wins over an earlier child write. Preserve explicit `undefined`, deletion, and
slot presence. Follow stored link chains during verification. Scope
creation-only exceptions to the exact target document and accept only a root
value creation, not a child write or a similarly named document.

## 30. Stamp generated policy on inline LLM descendants

An LLM builtin records the root location of each model-produced value. A
structured result can also have generated policy on concrete descendants in
the builtin's schema. Stamping only the recorded root leaves those inline
fields without the `LlmDerived` evidence that the runtime generated them.

Expand each runtime-owned stamp through matching concrete paths in the
generated schema. Include inline descendants and normalized child documents.
Keep the mint in transaction-private runtime state rather than caller-authored
schema bytes. Tests cover structured output whose final storage write is a
no-op after the last streamed batch.

## 31. Normalize raw document-root writes for CFC checks

New storage documents are written at the document root as an envelope whose
`value` member contains the logical cell value. Later edits are commonly
reported below that `value` member. Treat both representations as writes to the
same logical path when reconstructing current values, previous values, and
presence. Apply the same normalization when a wildcard policy inspects changed
values beneath a document-root write.

This normalization makes writer-fit and floor checks see a creation write in
the same form as a later field edit. Tests cover current and previous envelope
reconstruction, wildcard-label persistence on creation, and rejection of an
untrusted creation of a protected profile list.

## 32. Validate compilation-cache dependencies before importers

Replicate Fabric dependencies before the importer that links to them. Strict
verification must be able to read the dependency's CFC metadata before it
accepts the importer's integrity-bearing link.

Treat a fresh cache entry with an absent or unstamped dependency as a miss. An
out-of-band dependency loss can leave a previously stamped importer readable
as a partial closure. Recompile that case from the verified source closure and
heal the compiled namespace instead of evaluating the partial graph.

## 33. Apply CFC policy to fully elided ancestor writes

An exact or descendant write attempt remains subject to the matching policy
when storage elides it as a no-op. A fully elided ancestor attempt must also
reach descendant policies because there are no write details that identify a
narrower changed path. For wildcard entries, read the stored current value to
evaluate both an exact concrete attempt and an ancestor attempt that storage
fully elided.

Once any value in the document changes, use the resulting write details to
select affected descendants. This prevents a container attempt that changed
one field from demanding authority for every unchanged protected sibling.
Record the concrete writes produced by each logical write call. A later
redundant child attempt must not take ownership of an earlier ancestor write.
A later direct write must not make an earlier no-op attempt appear non-elided.
Keep attempted-write markers recorded outside those logical write calls as
independent attempts, even when another logical write touches the same document.
Later direct writes remain separate from those independent attempts as well.
Reconstruct each logical call for every document it visits through a redirect,
scope boundary, or anchored value.

## 34. Reject isolated cross-space metadata writes cleanly

CFC preparation can discover that a schema policy input needs metadata in a
different space after an ordinary write has already opened the transaction's
single-space writer. Do not opt the transaction into broader write authority on
the basis of verifier-owned metadata. This includes module-policy manifests
carried beside the labels that refer to them. Convert the storage-isolation
error into an ordinary CFC preparation reason instead. Enforcing modes reject
the commit, observe modes diagnose it, and the scheduler can finish the action
without an uncaught preparation exception.

Keep other storage failures exceptional. Direct regression tests prove that
preparation reports second-space label metadata and module-policy manifests
without throwing or widening the transaction.

## 35. Establish value schemas after ambient initialization

Piece initialization can persist an exact root schema whose only rule is the
ambient `Space(space)` confidentiality label. That schema establishes storage
policy, but it does not describe the shape of the value that the piece will
later store. Treat the first structural schema as the value-shape baseline and
retain the ambient confidentiality clause on it.

Apply the same rule while combining policy inputs within one transaction and
while combining a candidate with stored metadata. Restrict it to the exact
single-clause ambient schema, so an existing structural schema or any authored
restriction still goes through the ordinary additive migration checks. A
regression test initializes an empty document with the ambient-only schema and
then writes its first object with a required field.

## 36. Retry held-window edits after CFC metadata catch-up

Strict CFC preparation can add a metadata dependency to an edit while a runner
test deliberately holds the per-element result documents that the scheduler
needs. The first commit attempt can therefore report that the dependency is
still pending. Use the runner's edit retry helper for that input change and
assert that the edit eventually commits before checking the resumed result.

Keep the result documents held throughout the edit. The test still exercises
the intended stale reconciliation window for append, removal, `flatMap`, and
`filter`; it no longer assumes that a one-shot raw transaction can ignore CFC
metadata catch-up.

## 37. Preserve module policy identity in narrowed captures

TypeScript expands the type of a property captured by a generated lift. That
expansion retains the structural shape of `PolicyOf`, but it drops the
`typeof exportedRules` reference that identifies the policy's defining module
and exported symbol. The schema generator then sees an unresolved optional
marker instead of the concrete module policy. Strict schema merging rejects
the two structural forms of that unresolved marker as a policy weakening.

Read the property's authored type declaration before TypeScript expands it.
Replace each verified `PolicyOf<typeof exportedRules>` use with the existing
compiler-only policy identity marker. Continue to carry the original semantic
type beside the generated type node. When capability analysis narrows the
capture to the properties that the callback reads, prefer the generated shape
that still has that marker over the expanded shape that lost it. The schema
generator resolves the marker to the policy module identity, exported symbol,
and policy digest before it emits the runtime schema.

A transformer regression defines the rules and protected property in one
module, captures that property from another module, and checks that the lift
input schema contains the defining module policy. The direct-release pattern
test then proves that both its default and custom protected messages can be
read by their assertions while enforcement is enabled.

## 38. Merge matching closed-empty unions by meaning

An object cell with an empty-object default can reach the runtime as an
`anyOf` with two branches. One branch is a closed empty object. The other is
the stored value. Type expansion can reverse those branches and can add policy
to the stored-value branch without changing either branch's structural
meaning. Treating the arrays as positional makes those equivalent unions look
divergent. Strict preparation then rejects an authorized write before the
ordinary policy merge can examine it.

Recognize only the two-branch form with exactly one policy-free closed empty
object. Match the remaining value branches after resolving local references
and ignoring their policy fields. Continue checking nested alternatives for
unsupported divergence. Merge the matching value branches with the ordinary
schema and policy rules, then retain the stored union's branch order. This
keeps added integrity evidence, preserves existing restrictions, and rejects a
replacement integrity atom as a weakening.

A schema-merge regression presents the empty and value branches in opposite
orders. The candidate adds integrity to each stored list item. The merged
schema must retain both the list requirement and the item evidence, and it must
remain stable when merged with itself. The existing changed-policy regression
continues to prove that the matched-union case does not permit a policy
replacement.

## 39. Preserve the complete group-chat admin registry on writes

The group-chat admin registry also uses an empty-or-stored object union. The
admin-list-only path wrote through `adminRegistry.key("admins")`. Transaction
preparation therefore compared the complete union from the cell contract with
a projected object containing only the admin list. The projection did not
carry enough structure to match the union's stored-value branch, so strict
preparation rejected an otherwise authorized grant.

Read the current registry and write the complete registry object when the
admin list changes. Replace the list while retaining the bootstrap role and
the value-specific everyone-is-admin flag when they are present. This uses the
same complete schema as the other admin-toggle paths and keeps every existing
value-specific policy attached to its field.

Record the resulting pattern contract as a new compatible baseline. The
multi-runtime group-chat integration test proves that a room added by an admin
reaches another user and that an admin can grant the role to that user while
strict CFC enforcement is active.

## 40. Restrict empty-union matching to the literal empty object

The closed-empty-union merge relies on the empty branch accepting exactly the
empty object. An object schema can have no declared properties and disallow
additional properties while also carrying another constraint such as
`minProperties`, `required`, `not`, or a conditional. Treating that schema as
the literal empty-object branch could discard the extra constraint when the
stored branch is retained.

Recognize only the three-key schema consisting of `type: "object"`, an empty
`properties` map, and `additionalProperties: false`. Any other validation
keyword leaves the union on the ordinary merge path, which retains the
candidate restriction. Strengthen the matching-union regression to inspect
the two policy declarations at their exact paths and compare the second merge
structurally with the first. A second regression proves that a constrained
object is not handled by the special matcher.

## 41. Preserve open admin-registry extensions

The group-chat registry schema permits stored fields beyond the three fields
currently understood by this version of the pattern. Reconstructing the whole
registry from only those known fields would remove a valid extension written
by another version or another participant.

Start both whole-registry writes with the current stored object. Override only
the fields supplied by the admin action. This keeps unknown fields as well as
the known bootstrap and everyone-is-admin fields while still presenting the
complete object schema required by strict preparation. Record the changed
pattern contract as another compatible baseline.

## 42. Permit removal of eagerly materialized argument defaults

Pattern evolution compares defaults below constraints that can observe
recursive default insertion. Adding or changing a default below one of those
constraints remains unsafe. Removing an argument default is different. The
runner already materialized the previous default in every stored piece, so an
update does not remove that value from an existing argument. New pieces use
the candidate pattern's own initialization path.

Permit an evolution comparison only when the candidate argument's extracted
default is an unchanged subset of the previous extracted default. Treat links,
arrays, primitives, and Fabric special values as indivisible. Continue to
reject added defaults, changed values, and removed result defaults. Focused
compatibility tests cover the permitted argument removal and both rejected
directions.

## 43. Move the parking spot default behind its integrity boundary

The parking coordinator's public spot default was written into the argument
before the pattern started. Its public contract requires `parking-admin`
integrity, but the unendorsed default could not satisfy that floor. Removing
the public default lets an absent input reach the pattern before any spot list
is materialized.

Create one stable per-space fallback cell before the lifted nullish selection.
Its schema adds `parking-admin` integrity to every default spot and to the list
root, while retaining the list's required-integrity floor. The root label is
needed because seed materialization writes the complete list at the root.
Caller-supplied spot lists remain subject to the unchanged public requirement.

Remove the redundant raw spot list from the browser integration input so the
test exercises the trusted fallback. Record the resulting public contract as
a compatible baseline and run the complete manager and admin interaction under
strict enforcement.

## Deliberately excluded work

The previous combined patch rewrote a runner concurrency test to use an
explicit barrier. That test cleanup is independent of CFC enforcement defaults
and is not part of this stack. It should be landed separately if still needed.
