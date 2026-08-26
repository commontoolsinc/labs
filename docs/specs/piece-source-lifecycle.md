# Piece source lifecycle

How code enters the fabric, how a piece remembers where that code came from,
how tracked code changes reach a piece, and how a user can detach, revert, or
resume tracking.

This is the design of record for source origins and source history on pieces.
[`pattern-imports/README.md`](pattern-imports/README.md) remains the design of
record for static imports inside pattern source.
[`pattern-imports/pattern-updates.md`](pattern-imports/pattern-updates.md)
describes the narrower same-toolshed system-source update mechanism that exists
today and must be migrated into this lifecycle.

## Status

The content-addressed source and in-place pattern replacement foundations are
implemented. Local command-line creation is implemented end to end. The shared
piece menu can detach a piece from its current origin. Its history panel can
restore an exact retained source revision or resume following an origin from an
earlier revision. These operations append guarded source revisions, and direct
source edits now detach. The specialized updater also appends guarded revisions
for same-toolshed system sources. A lifecycle-aware detached revision prevents
that updater from reconstructing the cleared origin as legacy provenance.
Direct Piece API creation records a detached creation revision when the exact
source closure is available. `RuntimeClient.createPage(URL)` instead records the
canonical HTTP or HTTPS URL as the active origin in the same transaction as its
source-backed creation revision. Programmatically constructed patterns without
retained source continue to run without restorable history. Retained source
closures are reverified in the transaction that publishes each history entry.
An unseeded space now uses the default host provisionally until a stateful
operation is issued there. Before that cutoff, its first accepted host hint
replaces the route and replays prior reads, including when a pattern followed a
link before site-table hydration completed.
Per-space route seeds, live hints, and durable site-table entries accept only an
HTTP or HTTPS origin. Host-qualified historical fabric origins use the same
route parser when they register a hint.

This lifecycle slice is partial. Revisions retain the existing verified
`pattern:<identity>` source-document closure rather than the complete authored
program manifest specified below. Fabric URL creation, the remaining web URL
creation paths, host-qualified fabric-link receipt, live mutable fabric
subscriptions, complete cross-space policy enforcement, forking, and
runtime-fingerprint handling still require work. The specialized updater still
reconciles roots before bootstrap and checks other successfully instantiated
same-toolshed system-source patterns in the background. A space root remains an
ordinary piece in the target model. Cross-space history repoint is rejected
until the checked source-replication path exists.

Following an origin as ONE mechanism, triggered by a user opening a piece, is
specified here and not built. Nothing on this branch changes behavior. The
statuses below describe the shipped system, in which a space root reconciles
before it is bootstrapped through a path of its own, every other piece is
checked in the background after it instantiates, and both are gated by the
`systemPatternAutoUpdate` flag. The design they are measured against is the one
this document describes.

Status labels in this document have exact meanings:

- **Implemented** means the interaction works end to end now.
- **Partial** means a recognizable path performs the interaction in a limited
  form, but one or more required guarantees are missing.
- A status ending in **required** names the missing capability. Lower-level
  building blocks may exist, but no user-facing operation performs the
  interaction.

The status table evaluates each requested interaction separately. The revision
log is a cross-cutting requirement in its own row; its absence does not turn an
otherwise complete first-time creation command into an unimplemented command.

## Last updated

2026-08-26

## Terms

A **pattern source** is an authored program. The fabric stores its verified
module closure under a content-derived identity.

A **piece** is a stateful instance that runs one exported pattern. Its
`patternIdentity` metadata contains the identity and export symbol of the exact
pattern it currently runs.

A **space root** is an ordinary piece selected by the space's `defaultPattern`
link. When a space is created, the system chooses the new root piece's initial
source from the configured default. After creation, the root has the same
source lifecycle as every other piece. The configured default is not a durable
controller for existing roots.

A **space-creation template** is configuration that the system consults when
choosing that initial source. It is not stored as lifecycle state on any root
piece. The current `defaultAppUrl` field lives on the home root; moving that
value into configuration independent of a mutable root is required before root
lifecycle unification is complete.

An **origin** is an optional source URL that a piece remembers durably. URL in
this document includes both web URLs and fabric-internal URLs:

- A `system:<path>` ref identifies a pattern this deployment's toolshed serves
  from its patterns directory, addressed relative to that route. It is
  host-relative on purpose, so a space that moves hosts goes on following the
  same file, and it resolves against whichever host serves the piece's space.
  It is the one origin whose releases the deployment itself gates, which is why
  the compatibility policy below treats it differently.
  [`pattern-imports/pattern-updates.md`](pattern-imports/pattern-updates.md)
  is its design of record.
- An `https://` URL identifies an external program endpoint that can return new
  source later. Its origin record also stores the entry export name that should
  run.
- A fabric `cf:` URL, including the host-qualified `cf://...` form, resolves
  inside the fabric. An unpinned URL that resolves to a stable piece follows
  that piece's current pattern identity and export symbol. The same live rule
  applies to another stable, mutable cell that carries `patternIdentity`, such
  as the planned lightweight publication pointer. A URL that directly names a
  content-addressed pattern is immutable and stores the selected export symbol.
  A trailing `@<identity>` pin also makes an accepted entity-FID URL immutable,
  even when the unpinned text names a piece or publication pointer. The
  tentative policy below does not accept a slug-shaped piece origin, even when
  the slug carries a pin.

Two states a recorded origin can be in are neither of these. A rooted path is
the spelling system origins carried before the `system:` ref existed; it is
rewritten to the ref naming the same file the next time the piece is opened. A
string no resolver can follow — a rooted path addressing nothing under the
patterns route, a relative string, a URL whose scheme serves no program, a
malformed fabric URL — is not an origin and is not detachment either: the piece
carries something a person can read and repair, and nothing follows it.

For example, a host-qualified fabric URL can resolve through
`cf://toolshed.example/<space-did>/of:fid1:<piece-id>` to a piece, or through
`cf://toolshed.example/<space-did>/pattern:<identity>` to exact pattern source.
The shorter `cf:<ref>` and `cf:/<space>/<ref>` forms use the same fabric URL
grammar.

The tentative durable fabric-URL policy admits stable identifiers, not names,
into the lifecycle resolver. In current repository terminology, a canonical
URL uses a DID for an explicit space, an entity FID for a mutable piece or
publication pointer, or a content identity for an immutable pattern. A
current-space shorthand for an unpinned mutable entity is expanded to the
target space's DID before it becomes origin state. A direct pattern identity or
an explicit pin on an entity-FID URL instead normalizes to the space-free
content identity form. A host remains a routing hint under the rules below.

The fabric parser is shared with static imports and may parse a slug-shaped
reference such as `cf:/<space-did>/<slug>`. The tentative piece-origin
validator rejects that form, including when it has a trailing pin. It also
rejects a space-root shorthand with no entity reference. An outer authoring
layer may resolve a slug or root shorthand, but it must pass the lifecycle a
canonical piece FID or pattern content identity. Static imports keep their
existing alias-and-pin behavior because the deployed source records the
terminal content identity.

A future shortlink service may accept a custom string and return a canonical
identifier URL before the lifecycle operation begins. The shortlink is not the
active origin or a repoint target. Whether a revision retains it in a separate
optional provenance field remains open. The active origin contains only the
identifier URL. This answer remains tentative while the identifier vocabulary
and shortlink ownership, reassignment, and history semantics receive further
study.

Classification happens before the origin is stored. An explicit pin on an
accepted entity-FID URL wins over the target's mutable shape. It normalizes to
`cf:pattern:<identity>` plus the selected export symbol. An unpinned URL that
resolves to a mutable `patternIdentity`-bearing entity normalizes to that stable
entity rather than its slug.

A host in `cf://...` is a routing hint, not target identity. The transition
retains the supplied URL in history and must persist the space DID to host route
before it commits a hostless canonical target. If the route cannot be persisted,
the origin transition fails without changing the piece. The transition also
registers the accepted hint on the ordinary storage manager before opening the
origin space. It does not create a secondary session. A seeded route or a
previously accepted late hint is authoritative, so a conflicting hint fails the
transition.

The default host is only a provisional route for a space that has neither a
seed nor an accepted hint. The first accepted hint may replace that provisional
route after its provider opens. Storage clears the provisional replica, closes
its session, and cancels connection, initial or reconnect session signature
creation, mount, and ACL setup work that is still in progress. It does not wait
for the provisional host to respond. Storage opens the same provider through
the hinted host and replays every document read registered on it. An
asynchronous read-only operation that overlaps replacement restarts on the
hinted replica and returns that result instead of the provisional replica's
closure error. These operations include document reads, entity listing and
lookup, and SQLite queries.
An existing `synced()` barrier follows the replacement and waits for those
replayed reads on the hinted replica.
Replay also loads CFC schema documents discovered from the hinted data.
Reactive consumers therefore receive the intended data when site-table
hydration loses the race with link traversal.

A transaction keeps the replica from which it read its basis. Replacement
makes a transaction holding the provisional replica inconsistent. Its commit
is rejected and may be retried from the hinted data; it cannot carry a result
calculated from missing provisional data into the intended host.
Immediately before a transaction mutation is accepted for issue, storage
rechecks every replica that supplied the transaction's read basis. This
includes read spaces other than the mutation's target space. If any read-basis
replica was replaced, storage rejects the transaction before handing the
mutation to any host.

Replacement is allowed until the provisional session accepts a stateful
operation for issue. Stateful operations are ordinary transactions, ACL setup
transactions, and injected SQLite source registration.
Work that is still waiting for a session does not prevent replacement. When the
hint wins that race, the old replica is invalidated before the waiting work can
issue. A failure before issuance also leaves the route provisional.

Once a stateful operation is handed to the provisional host, the route becomes
authoritative. This remains true when the client later reports an error because
the host may have committed the operation before its acknowledgment was lost.
A hint naming another host is then a conflict. A hint matching the default host
makes the route authoritative without reconnecting. After the first hint is
accepted, a different hint remains a conflict. A later load hydrates the
durable route before resolving the canonical fabric target.

An origin is not proof of the bytes currently running. The content-addressed
`patternIdentity` is that proof. A fabric URL that names a content-addressed
pattern repeats the exact identity, so resolving it cannot discover an update.
It remains useful as durable provenance and as a repoint target. An origin is
also not the descriptive `patternRepository` value exposed by tooling. A
repository locator can help a person find a project, but the runtime does not
fetch it or track it for updates.

A piece with no active origin is **detached**. Manually authored code and
LLM-generated code start detached. Forking, directly editing, and reverting
also detach a piece.

In this document, **wishing code into being** means a product authoring
affordance that asks an LLM to write pattern source. It is distinct from the
runtime `wish()` builtin. The builtin discovers and connects to existing
pieces; it does not generate pattern source.

## Core invariants

1. `patternIdentity` and its export symbol identify the exact executable export
   a piece runs. The current revision retains the complete authored program,
   including files outside that export's reachable import graph and the exact
   public-subpath map. Loading code never depends on an origin still being
   reachable.
2. At most one source URL is active at a time. It resolves as an external web
   endpoint, a mutable fabric `patternIdentity`-bearing entity, or an immutable
   fabric pattern.
3. Every successful transition records the new exact authored program, the
   active origin after the transition, and the reason for the transition in an
   append-only revision log. Each revision is a storage-retention root for its
   immutable authored-program manifest, verified source documents, and pinned
   fabric dependency closures in the piece's space. Revert never depends on an
   origin or an incidental compile-cache entry still existing.
4. Every accepted state gets a fresh, stable revision identifier. Updating the
   current source, the active origin, and the revision log is one atomic
   operation. The transaction compares the expected revision head, current
   pattern, and active origin before it commits. It also compares the piece's
   stored argument, because accepting a candidate restages that argument
   against the candidate's schema, and a transition that staged a value written
   after it was prepared would install one nobody asked for. A concurrent
   detach, repoint, edit, or argument change cannot be overwritten by a late
   origin check, including when both states happen to use the same pattern
   identity.
5. A direct source replacement detaches the piece unless the operation is an
   automatic refresh from its active origin or an explicit repoint.
6. Reverting selects an exact retained historical authored program and detaches.
   Repointing selects a historical origin and resolves its current program.
   These are separate user actions.
7. An unattended origin update that encounters a failed fetch, unreadable
   followed piece, invalid program, or integrity failure leaves the current
   source and history unchanged. A piece that already has valid source can
   continue to run its last accepted source. An unattended update from an
   origin whose releases this deployment gates adopts its candidate as it
   stands; from any other origin it adopts one only if the candidate is an
   acceptable replacement for what the piece runs, and otherwise leaves the
   piece unchanged and offers its owner the candidate to accept. A manual
   replacement rejects invalid or unverifiable source, and rejects a candidate
   that cannot use the piece's actual retained input. It may apply an
   incompatible pattern contract or retained link after the user explicitly
   accepts the warning. Semantic compatibility is established by tests rather
   than inferred by the runtime.
8. Static `cf:` imports keep their existing snapshot semantics. Following a
   piece does not make imports in that piece or in another pattern live.
9. Creation and every later transition use ordinary authorization for the
   target piece's space. Following grants no write access to the origin piece.
10. A space root follows every ordinary piece lifecycle rule. The system selects
    its initial source only when creating the space. A mutable default becomes
    an active origin only through the ordinary explicit-consent rule. A later
    change to the configured default does not update or repoint an existing
    root.
11. The root role has an interface contract even though it has no special source
    lifecycle. Creating or relinking `defaultPattern` validates that the piece
    exposes the operations and state the space runtime requires. An arbitrary
    piece cannot become a root merely because it is a piece.
12. Within a space, every cell and document that makes a pattern resolvable,
    including its authored-program manifests, revision history, and verified
    source documents, uses that space's ACL. The source therefore has the same
    visibility as the pattern in that space. Anyone authorized to resolve the
    pattern there may read its source. A fabric URL, slug, or content identity
    does not grant access by itself. The same content identity can have replicas
    in spaces with different ACLs.
13. Moving source between spaces is an information flow, not just a read. The
    operation propagates CFC provenance labels and fails closed before copying
    source when those labels do not permit the destination flow.
14. A content-addressed or explicitly pinned fabric URL never reports an
    update. Reconciliation verifies and loads the named source, but the URL
    cannot resolve to a different pattern identity later.

## Logical state

The names below describe the logical model. They do not require the eventual
storage schema to use these exact TypeScript field names.

| State | Meaning | Repository status |
|---|---|---|
| Current pattern | `{ identity, symbol }` for the exact executable export | Implemented as `patternIdentity` metadata on the piece result cell |
| Verified identity closure | The authored implementation and declaration files that determine the current executable identity | **Implementation files stored**: `pattern:<identity>` source documents exist, but production filters authored `.d.ts` files before identity and persistence |
| Retained authored program | An immutable version-1 manifest for the complete authored program accepted by the current revision, including unreachable files and its exact public-subpath map | **Manifest and exports required**: source documents can retain extra roots, but no piece revision binds the exact accepted file set or public map |
| Runtime fingerprint | The trusted runtime identity used to calculate the accepted executable pattern identity | **Authoritative provider required**: the optional module-hash input exists, but production compilation and source verification still use the empty default |
| Runtime-neutral program digest | The version-1 digest of the canonical main filename, every authored file's runtime-neutral module identity, and the public-subpath map | **Digest and lifecycle required**: the module hash can run with the empty fingerprint, but the complete program digest is not recorded |
| Active origin | No origin, an external `https://` URL with an entry export, a stable mutable fabric-entity URL, or a content-addressed fabric pattern URL with an export symbol | **Partial**: `patternSource` stores the active origin string. `RuntimeClient.createPage(URL)` initializes a canonical HTTP or HTTPS origin atomically with creation. Explicit history actions can clear it or restore an earlier web or fabric origin. Fabric creation, the remaining web creation paths, and reconciliation do not yet use the complete origin policy |
| Revision head | The stable identifier of the latest accepted source and origin state | **Partial**: the last valid `pieceSourceHistory` entry is the guarded head. It is not yet mirrored in the complete source-state schema |
| Source revision log | Ordered records of every accepted source and origin state, with a durable reference to each immutable authored-program manifest | **Partial**: source-backed direct Piece API creation, URL-backed Runtime Client creation, lifecycle-aware edits, detach, revert, repoint, provenance repair, and specialized updates append guarded records. Each record links to an existing source-document closure that is verified in the lifecycle write transaction. Programmatically constructed patterns without retained source, other creation paths, and immutable authored-program manifests remain required |
| Last reconciliation | What following the active origin last did — followed, could not reach it, or refused what it offered — with when, why, and the identity the origin offered | **Required**: reconciliation outcomes exist only as log lines, so a piece that has stopped following its origin is indistinguishable from one that is up to date |
| Descriptive repository | Optional locator shown by tooling; never followed | Implemented as `patternRepository` metadata |

The runtime-neutral program digest is
`cf/runtime-neutral-program-digest/v1` from
[module-loading.md](module-loading.md). It covers the canonical main filename
and every authored file, including unreachable siblings. It also covers the
normalized exact map from public subpaths to authored filenames. It excludes
mounted files, synthetic retention links, and the selected executable export.
The digest is comparison metadata. It is not a fabric URL target, an executable
pattern identity, or a revert target.

Lifecycle ingestion first materializes the repository's current `Program`
shape, with a canonical `main` and an explicit `files` list. It pairs that value
with a normalized public-subpath map. Together they define the authored program
for history. Command-line directory input, LLM output, and a web program
manifest must enumerate every intended file before import-closure resolution.
They must also supply the public map, or the canonical empty map when only the
implicit entry is public. A retained authored-program manifest provides both
for fork, follow, revert, and rebuild. A raw web entry point or another
`ProgramResolver` that cannot enumerate files defines its authored program as
only the reachable closure it returns. It cannot later report an unenumerated
sibling as a source update. Duplicate canonical filenames are rejected.
Invalid public names and targets outside the authored file set are also
rejected. Declaration stubs injected by the runtime for type checking are not
authored files and do not enter this list.

A direct `cf:pattern:<identity>` URL is one of these resolver-only inputs. The
module identity binds its reachable source closure, but it does not bind one
complete authored-program manifest. Creating a piece from that URL therefore
retains the reachable closure with an empty public-subpath map. A mutable piece
or publication origin can preserve and propagate its complete retained
manifest, including unreachable files and explicit public subpaths.

The current `ProgramResolver` interface exposes only `main()` and
`resolveSource()`, and `resolveProgram()` returns only the reachable import
closure. Complete-program enumeration for directory, generated, indexed web,
and retained-manifest sources is required integration work.

Each revision's source-retention reference names an immutable
`cf/authored-program-manifest/v1` value. The manifest contains the canonical
main filename and a UTF-8 filename-sorted list of every authored file with its
verified source-document identity. It also contains a UTF-8 key-sorted exact
map from public subpaths to canonical authored filenames. The empty subpath
implicitly selects the canonical main and does not appear in the map. The
manifest directly retains its source documents and the complete transitive
graph of content-addressed fabric dependencies pinned by the program. Recursive
retention deduplicates dependency identities and parses pinned fabric
specifiers because source documents intentionally omit fabric links. Its file
list and public map must reproduce the revision's runtime-neutral program
digest. It does not rely on the entry source document's synthetic root links.
Those links are non-normative and can be rewritten when another program uses
the same entry identity.

The revision embeds this value or points to a content-addressed copy. It never
points through a mutable piece, slug, origin, or entry-document retention list.

A revision record contains at least:

- a stable revision identifier and the preceding revision identifier, if any;
- the pattern identity and export symbol accepted by the piece;
- the runtime fingerprint used for that identity and the runtime-neutral program
  digest;
- a durable reference to the immutable authored-program manifest;
- the compatibility descriptors needed to validate a later replacement;
- the active origin after that transition, if any;
- the origin revision accepted from a followed piece, when applicable;
- the user-supplied source URL and routing hint when normalization changed it;
- the operation, such as local create, web URL create, fabric pattern create,
  follow, automatic update, direct edit, fork, revert, or repoint;
- the cause, such as baseline, authored-source change, origin update, origin
  runtime rebuild, runtime rebuild, historical-source restore, or origin-only
  change; and
- the selected revision for a revert or repoint, or the stable source-piece
  reference for a fork, or the preceding revision selected by detach and
  rebuild, when applicable.

The initial creation is the first revision. Keeping creation in the same log
lets a fork record `forkedFrom` without making the original piece an active
origin. A fork does not copy the other piece's revision log. That history
belongs to the other piece and may contain references the new owner cannot
read. `forkedFrom` records derivation only. It is not offered as a repoint
target unless this piece also followed that origin in another revision.

Fork, follow, revert, and source replication read the selected revision's
immutable authored-program manifest. They do not reconstruct a program by
walking the entry source document's current synthetic retention links.

The current pattern, retained-program reference and digest, accepted origin
revision, and active origin remain directly readable metadata. The revision head
names a latest revision that mirrors them. They are written together so the log
cannot claim a transition that the piece did not adopt.

Changing only the manifest's public-subpath map is an accepted source revision.
It changes the retained manifest and runtime-neutral program digest while
preserving every module identity and the executable `patternIdentity`. A piece
advertises that revision to downstream followers like any other source-only
revision. Existing pinned static imports do not move until their owners perform
an explicit dependency update.

A runtime fingerprint change that produces a new executable pattern identity is
an accepted source revision even when the authored source is unchanged. For an
ordinary transition, the cause is a runtime rebuild only when all of these
comparisons with the preceding revision hold: the executable identity changed,
the accepted runtime fingerprint changed, and the runtime-neutral program
digest, selected export, and active origin remained equal. A revert performs the
same source and fingerprint comparisons against its selected historical
revision. It intentionally clears that revision's former origin. The operation
records how the transition was requested, while the cause records why the
executable identity differs from its comparison revision. A manual detached
rebuild performs the same comparison against the preceding revision and
intentionally clears its origin. A runtime rebuild does not otherwise detach or
repoint the piece.

A piece may have downstream followers regardless of its own origin state. A
detached piece may publish a runtime rebuild through its owner or a deployment
migration service with write authority for its space. A web-origin piece may
publish only the result of resolving and compiling its active web origin. A
mutable fabric follower may publish only a revision it adopted from its upstream
origin. An immutable fabric-origin piece cannot publish a different identity
while retaining that origin.

Every accepted revision becomes the piece's advertised source revision for its
downstream followers. A middle piece in a follow chain first adopts its upstream
revision and then advertises that accepted local revision downstream. It never
recompiles the upstream source locally while continuing to claim that origin.
Its revision records the automatic-update operation and the
origin-runtime-rebuild cause. A follower that cannot execute the upstream
fingerprint stays on its last accepted revision and reports an origin
incompatibility. Its owner may detach or fork before rebuilding locally.

Observing a different runtime fingerprint does not authorize an arbitrary client
to rewrite a piece. The deployment-selected value comes from the authoritative
`getExecutableRuntimeFingerprint()` provider defined in
[module-loading.md](module-loading.md). The empty value remains only a legacy
source-document interpretation. Coordinating the selected non-empty value
across clients and hosts remains part of the separate runtime-skew and
host-reliability work.

When lifecycle history is introduced, the first lifecycle-aware load or
mutation of an existing piece creates a baseline revision from its current
pattern and recognized origin metadata. The runtime first verifies and retains
the current source closure. If it cannot do so, it leaves the piece in its
legacy state and reports that history migration is blocked. It does not invent
a revision whose source cannot be restored.

A baseline for an affected legacy identity records the canonical empty identity
fingerprint. It does not relabel that identity with the current provider value.
Any subsequent rebuild follows the piece's active-origin rule above and appends
another revision. If the current runtime cannot execute the legacy fingerprint
and no authorized transition is available, the piece remains unchanged and the
UI reports that runtime migration is blocked.

This migration treats an existing space root exactly like any other legacy
piece. A raw `patternSource` is migration provenance, but it does not alone
prove that the piece granted its source permission to supply future code. The
current implementation stamps that field independently from the flags that
enable updates. Migration creates an active origin only when a durable tracking
choice can be established under the ordinary consent rule. Otherwise it records
the locator as inactive historical provenance and creates a detached baseline.

A legacy relative toolshed path is not retained as a root-only origin kind.
Migration resolves it against the accepted toolshed host for the root's space
and persists the resulting absolute web URL. A later host remapping does not
silently change that origin; changing it requires an ordinary repoint. If the
host cannot be established, migration does not invent an active origin.

A source-less legacy home root does not gain an origin merely because it is the
home root. Its specialized updater currently derives `home.tsx`, while a
source-less non-home root remains pinned. Migration preserves both as detached
unless a durable tracking choice explicitly supplies and authorizes an origin.
New spaces create their root through the ordinary source-creation transition
and link that new piece as the space root.

## Source transitions

| Interaction | Exact source after the interaction | Active origin after the interaction | History effect |
|---|---|---|---|
| Create from local code with the command line | The pushed local program | None | Append a local-create revision |
| Create from LLM-generated code | The generated program | None | Append a generated-create revision |
| Create from a source URL with the command line | The program resolved from the `https://` URL or identifier-only fabric `cf:` URL, including `cf://` | The normalized URL and any required export selector | Append a web URL create, follow, or fabric pattern create revision according to what the URL resolves to |
| Create from a known source URL in the UI | The program resolved from the `https://` URL or identifier-only fabric `cf:` URL, including `cf://`; an outer authoring layer resolves any alias first | The normalized URL and any required export selector | Append a web URL create, follow, or fabric pattern create revision according to what the URL resolves to |
| Create the root for a new space | The program resolved from the system-selected default source | Whatever origin the ordinary source-creation rules derive from that source | Append the same creation revision that the equivalent user-created piece would receive |
| Refresh from an external web URL | The newly fetched program, if its executable identity, export symbol, or complete-program digest changed and it passed validation | The same `https://` URL and entry export | Append an automatic-update revision when the executable export or retained authored program changes |
| Load from a content-addressed URL or a pinned entity-FID URL | The exact executable source graph named by the identity or trailing pin; synthetic retention roots are excluded | The normalized fabric pattern URL and export symbol | Do not append an automatic-update revision because the resolved executable source graph cannot change |
| Fork a piece | The source currently used by the selected piece | None | Append a fork revision with `forkedFrom`; do not copy the source piece's log |
| Follow a piece through an unpinned fabric URL | The source currently used by the selected piece | A normalized fabric URL containing a stable reference to that piece | Append a follow revision |
| Refresh from a mutable fabric entity | The entity's retained authored program, if its source revision changed and it passed validation | The same stable fabric entity URL | Append an automatic-update revision when the accepted origin revision changes, including when its executable identity is unchanged |
| Directly edit or wish an existing piece to change | The newly authored or generated program, after the user explicitly accepts any structural compatibility warning | None | Append a direct-edit revision; the prior revision retains the former origin |
| Detach and rebuild current source | The current revision's retained authored program compiled under the current runtime | None | Append a direct-edit revision with `rebuiltFrom` naming the preceding revision |
| Revert | The exact retained authored program named by a selected earlier revision | None | Append a revert revision that names the selected revision |
| Repoint | The current source resolved from a selected earlier origin | The selected web or fabric URL | Append a repoint revision |

Direct command-line source updates follow the same detach rule as LLM edits.
Otherwise a later load could silently replace a user's edit with a refresh
from an origin they no longer intended to follow.

After space creation, the root can detach, follow, update, fork, revert, or
repoint through the same operations as any other piece. Changing the system's
default source affects only roots created afterward. Changing an existing
space's root is an explicit piece lifecycle operation or an explicit relink to
another ordinary piece that passes the root-interface compatibility check.

## Compatibility policy

Uploading, compiling, or publishing content-addressed pattern source does not
change an existing piece. These operations have no prior piece contract to
compare, so piece compatibility does not gate them. Compatibility is evaluated
when a candidate pattern is applied to an existing piece.

The runtime can compare the previous and candidate argument schemas, result
schemas, and retained input links. Before a manual source replacement, the
caller compiles and verifies the candidate and runs these structural
comparisons. An incompatible pattern contract or retained link becomes an
actionable warning. The UI requires explicit confirmation, and command-line
tooling requires an explicit flag, before applying it. A materialized retained
input that does not satisfy the candidate argument schema is not confirmable.
The runtime rejects that source until the input is repaired. An accepted direct
replacement detaches the piece and appends a revision. Refollowing an accepted
historical origin retains that origin.

Whether an automatic origin update runs these comparisons turns on one
question: did anything gate the release that produced the candidate?

A `system:` origin names source this deployment itself serves, released through
the golden replays in `pattern-update-testing.md`, which load representative
state written by the previous version and check the new one still reads it.
That is a better check than the runtime can make, and repeating a weaker
version of it at update time would only refuse releases the replays already
cleared. Such a candidate is adopted as it stands.

Every other origin — an external endpoint, another piece, exact pinned source —
is somebody else's, and nobody promised anything about it. A candidate from one
is adopted only if it is an acceptable replacement for what the piece runs,
under the same relation a replacement made by hand has to satisfy: the
candidate accepts every argument the accepted source did, and produces only
values the accepted result contract described. One relation, one definition,
whether a person or a reconciliation applies it.

A refusal is not the end of it. The origin is a choice the piece's owner made,
and they may want what it now offers regardless. The source panel names the
refusal, names its reason, and offers to take the candidate anyway. Accepting
adopts that exact candidate — the same one-use confirmation a manual
incompatible replacement uses, bound to the reviewed candidate and the guarded
state it was reviewed against — and **keeps the active origin**, because the
owner is choosing to go on following it rather than to hand-pick source. That
is what separates this from an accepted manual replacement, which detaches.
The acceptance covers one candidate: if the origin later offers another the
piece cannot take, it is refused again.

What a refusal really wants is a data migration, and building one is required
work. Until it exists, an accepted refusal is the owner asserting that the
piece's data is fine, and an unaccepted one leaves the piece on its last
accepted source, active origin, revision head, and history — which the source
panel must say, because a piece that has stopped following its origin looks
exactly like one that has not.

Where that refusal happens depends on whether the piece is running, and the two
are not equally safe. A piece that is not running has the candidate staged over
its document by the transition itself, so a refusal fails the transaction and
nothing moves. A running piece has only its pointer moved, because the pattern
watcher owns re-instantiating it; staging happens afterwards, in the watcher's
own transaction. A refusal there leaves the pointer on the candidate and the
graph on the accepted source. The next open reconciles against the pointer,
finds it matches what the origin offers, and reports the piece current, so
neither reconciliation nor the runner's cold-start repair can undo it. Only a
revert, repoint, or detach can. The source panel does not catch it either. The
panel names the outcome the last reconciliation reached, and that reconciliation
compared the pointer, so the panel reports the piece as following an origin
whose source it is not running. Staging the candidate in the transition for a
running piece too, so that a refusal costs nothing in either case, is required
work.

For a `system:` candidate, which no comparison holds, the only check left is
setup — and setup looks at this piece's own stored argument and nothing else.
It says nothing about the piece's RESULT: a new version whose outputs no longer
fit the shape the accepted one promised is adopted, and every piece and view
linked into those outputs starts reading values it was not built for. The
release gate is where that is caught, and a reader's own contract check is
where it should also be caught, because the piece being updated cannot see who
reads it.

Stable keys and causes, intended data migration, and behavior are semantic
contracts. The runtime cannot reliably infer them from schemas. CI tests and
golden replays must load representative state created by the previous source,
apply the proposed source, and verify that the new code reads and preserves the
intended state. Deployment does not repeat those tests or use runtime guesses
to enforce semantic compatibility.

The root role adds one independent structural requirement. Creating or
relinking a root, and every later source transition on that root, must leave it
with the operations and state the space runtime requires. Explicit acceptance
of a schema warning does not waive this root-interface contract.

| Concern | Target policy | Repository status |
|---|---|---|
| Structural schema comparison | Compare argument and result schemas and validate retained inputs when replacing an existing piece's source | **Implemented** for `PieceController.setPattern` |
| Manual incompatible replacement | Warn about an incompatible pattern contract or retained link and require explicit confirmation or a command-line flag. Reject a candidate that cannot use the actual retained input | **Partial**: source-history actions return a one-use confirmation bound to the reviewed candidate and guarded state. `setPattern` rejects unless `dangerouslyAllowIncompatibleSchema` is supplied, and the command line exposes that flag without a first-class warning and confirmation flow |
| Automatic update from a gated origin | Adopt a `system:` candidate as it stands; the release that produced it was gated by golden replays over representative state | **Release-gate rule required**: the specialized updater applies no comparison to a root, and exact argument and result schema equality to every other same-toolshed piece. Neither is this rule |
| Automatic update from an ungated origin | Compare the candidate with the accepted source in both directions, and adopt only an acceptable replacement | **Release-gate rule required**: no origin outside the same toolshed is followed at all, so nothing reaches this comparison. `PieceController.setPattern` already applies the relation it needs |
| Overriding a refused automatic update | Name the refusal and its reason on the source panel, and offer to adopt that exact candidate anyway, keeping the active origin | **Override affordance required**: a refusal is a log line, so it is neither visible nor actionable. `PieceController.changeSource` already returns the one-use confirmation this needs |
| Migrating a piece's data across a contract change | Migrate rather than refuse, so a contract change does not stop a piece following its origin | **Migration required**: an unaccepted refusal leaves the piece on its last accepted state |
| Downstream result contract | Keep a piece's readers from silently receiving values outside the contract they were built against | **Reader-side check required**: exact schema equality holds an ordinary same-toolshed candidate to the accepted result contract today, and a root to nothing. Once a candidate may differ from what it replaces, only a reader's own check can catch outputs it was not built for, because the piece being updated cannot see who reads it |
| Semantic state continuity | Verify intended stable-key, stable-cause, migration, and behavior contracts in CI | **Broader CI coverage required**: synthetic home-shaped and default-app-shaped golden replays exist, but general version-to-version fixtures remain |
| Root-interface contract | Enforce the root role after every creation, relink, and source transition | **Root validation required**: root linking and source replacement do not validate that contract |

For an unpinned fabric URL that resolves to a mutable entity, the stored
reference names the stable entity, not a slug. A piece is the product case in
this lifecycle. A lightweight publication pointer uses the same resolution and
subscription rule if that feature is added. Under the tentative identifier-only
policy, a shortlink or other human-readable alias resolves outside the
lifecycle and supplies a fully qualified reference containing the space DID and
stable entity. Reassigning that alias must not redirect existing followers to a
different entity. Self-following is rejected.

Every operation that activates a mutable fabric origin walks the active-origin
chain with a visited set. This includes follow creation, repoint, and legacy
migration. Reconciliation repeats the check before accepting an upstream
revision. An unreadable link or repeated stable entity fails closed.

The guarded transition records the revision head and active origin of every
piece read during the walk. Its commit verifies the complete read set along with
the destination piece. Concurrent reciprocal follows therefore conflict instead
of both committing from stale acyclic snapshots. The operation does not retry
automatically. If the storage path cannot atomically validate every traversed
guard, including across hosts, mutable-origin activation remains unavailable on
that path. This limitation belongs to the open cross-host reliability work.

For an accepted fabric URL that directly names content-addressed pattern
source, or that contains a trailing pin on an entity FID, the stored reference
names that exact pattern identity. Slug reassignment, piece updates, and
publication changes cannot move it. The selected export symbol is stored beside
the URL because one pattern source can expose more than one export. A pin fixes
the pattern identity, not the export symbol. The operation therefore stores an
explicit selector or loads the pinned source and chooses its normal entry
export. It does not copy a symbol from a mutable target unless that export
exists in the pinned source.

No selector is stored yet. The origin string carries only the pinned identity,
so following one reuses the export the piece already runs. A pinned origin
therefore cannot move a piece to a different export of the source it names, and
storing the selector is required work.

An external web URL is an absolute, canonical fetch location. Its origin record
also stores the resolved entry export name. An omitted export uses the
compiler's normal entry export at creation, and the chosen name is then
persisted. Persistent origin metadata must not contain credentials. An
authenticated fetch uses a separate credential or capability reference. Every
source URL stays under the target piece's ordinary access controls because it
can disclose where private code came from.

## Source URL policy

A source URL is both a source locator and a code trust decision. Mutable URLs
also grant an endpoint or piece permission to change the code later. The
general origin implementation must enforce these rules before it is enabled:

- External web origins use HTTPS in production. A deployment may explicitly
  allow HTTP for local development origins. Other web schemes are rejected.
- User information and secret-bearing query parameters are not stored in the
  URL. Credentials are supplied through a separately protected capability.
- Redirects are checked as new destinations. Same-origin redirects may be
  followed. A cross-origin redirect requires the user to repoint and confirm
  the new origin. A redirect may not weaken HTTPS to HTTP.
- The fetch service applies the deployment's outbound-network policy after
  DNS resolution. Private, loopback, and link-local destinations are denied
  unless the deployment explicitly allows them. The checks also apply after
  every redirect.
- Configured limits cover each response, the number of modules, and the total
  source closure. Exceeding a limit fails the transition before source is
  retained or run.
- One runtime source service handles both command-line and UI callers. It sends
  `https://` URLs through the checked network fetch path and `cf:` URLs through
  authenticated fabric resolution. UI code does not bypass either path.
- A host component in `cf://...` is a routing hint. Fabric authorization and
  content verification still apply at the destination. The URL does not become
  an ordinary unauthenticated HTTP fetch. A hostless canonical origin is not
  committed until the routing hint is in the durable site table.
- Creating or repointing an `https://` origin or a mutable fabric-entity origin
  requires explicit consent to future automatic code changes from that
  endpoint or entity. HTTPS authenticates a web endpoint in transit, while the
  accepted content identity records the exact executable source graph. If an
  origin names an expected publisher identity, each update must also carry a
  valid signature from that publisher.
- A content-addressed or explicitly pinned fabric origin is a one-time trust
  decision about an exact executable source graph. It does not grant any
  publisher, piece, slug, or host permission to replace that graph later.

Without a publisher signature, a web URL update is trusted because the user
granted the HTTPS endpoint permission to change the piece's code. Content
addressing detects substitution after acceptance; it does not turn a new
response from that endpoint into publisher-signed code.

## Fabric route registration

A host-qualified fabric URL supplies a route hint for a space DID. A lifecycle
operation first validates the hint and registers it with the runtime's ordinary
per-space storage manager. After registration accepts the route, the operation
durably records it in the home-space site table. It then opens and resolves the
origin space. The operation may commit a hostless canonical origin only after
registration and persistence succeed.

Every route source uses one origin-only grammar. A route is an absolute HTTP or
HTTPS origin with no credentials, path beyond `/`, query, or fragment. It is
normalized with a trailing slash. Production routes require HTTPS. An explicit
local-development or test policy may permit HTTP. This grammar applies to the
default host, `spaceHostMap` seeds, live registration, site-table hydration,
host-qualified share links, and the effective host returned to an embedder. An
invalid default or seed fails runtime initialization. An invalid live hint is
rejected before it changes the route. Hydration ignores invalid legacy entries
and selects the last valid entry for each DID.

The authority in `cf://<authority>/<space-did>/<ref>` does not carry a transport
scheme. Lifecycle ingestion derives HTTPS by default. Under the explicit local
HTTP policy, a loopback authority derives HTTP instead. The resulting absolute
origin passes through the same route normalization before registration. No
caller derives this scheme from the shell frontend origin.

If persistence fails after registration, the transition leaves the piece
unchanged. The accepted hint may remain available in that runtime until it
stops. A retry can confirm the same hint and attempt the durable write again.
The operation never persists a hint that the live registry has already
rejected.

Registration and persistence use one dedicated runtime operation. The
runtime-client exposes it to embedders through a dedicated request. Lifecycle
code in the worker calls the same underlying operation directly. The operation
validates the DID and host again. It synchronizes the home-space site-table cell
before reading its value or changing the live route. A synchronization failure
fails the operation. After synchronization, it selects the last valid existing
route for the target DID by the same rule as hydration. It offers that route to
the live registry before it offers the newly supplied hint. A rejection of the
existing table route means that a seed or earlier live route is already
authoritative. The operation then offers the supplied hint to that same
registry. A conflict fails the operation without writing. This direct ordering
does not depend on the asynchronous hydration watcher having processed the
table.

An accepted or confirmed supplied route is transactionally appended to the
site-table value that was synchronized. The entry contains the DID, normalized
host, operation-specific source, and an ISO timestamp assigned by the worker.
The transaction keeps the synchronized table value as a commit precondition.

The operation awaits `transaction.commit()` and inspects its result. It returns
success only for an `ok` result. A resolved result containing `ConflictError` or
`StoreError` fails the operation, as does a thrown commit error. The operation
does not retry any of these failures automatically. A live route accepted
before a commit failure may remain until the runtime stops.

Generic optimistic cell writes do not satisfy this contract. The current
`CellHandle.set()` and `CellHandle.push()` paths do not propagate remote commit
failure to their caller. The dedicated request must expose live conflict and
durable commit failure separately so a lifecycle operation or the shell can
stop before using the target.

### Host-qualified fabric-link receipt

The shell can also learn a route from a user-facing fabric link that opens
existing data instead of selecting a piece's source. Link receipt is not a
source lifecycle transition. It uses the same route registry and durable site
table because later lifecycle operations and ordinary pattern reads must agree
about where the named space lives.

The browser-facing share-link form is a shell URL:

`<shell-http-or-https-origin>/<space-did>[/<piece-id-or-slug>]?spaceHost=<encoded-toolshed-origin>`

`spaceHost` occurs exactly once. Its decoded value is an absolute HTTP or HTTPS
origin with no credentials, path beyond `/`, query, or fragment. The receiver
normalizes it with a trailing slash. The path contains an explicit space DID.
It names either the space root or a piece that the ordinary shell `AppView`
supports. A host-qualified `cf://` source reference is a different input form.
Its bare authority does not supply the explicit HTTP or HTTPS scheme required
by this browser-facing link.

The outer URL origin identifies the shell frontend. Production share links use
HTTPS. Local-development and test shells may use HTTP. The shell may use
`globalThis.location.origin` for this outer origin. That value never supplies
`spaceHost`. The shell's **Copy link** action obtains `spaceHost` from the
effective host reported by the runtime's per-space storage manager. It does not
substitute the shell's default API host when the space has a different
effective host.

A shell URL without `spaceHost` is an ordinary hostless navigation and supplies
no new route. A URL with a malformed or repeated `spaceHost`, or with a space
name instead of a DID, fails link receipt without navigation. Receiving a valid
link does not grant read access. Ordinary fabric authorization and content
verification still apply.

Before the shell opens, mounts, or navigates to the target, it performs these
steps:

1. Parse the shell path into its DID-based `AppView`. Validate and normalize the
   `spaceHost` toolshed origin.
2. Send that DID and host through the dedicated failure-propagating route
   request. The worker uses the live registry behavior exposed by
   `RuntimeClient.registerSpaceHost` and records `source: "share-link"` in the
   site-table entry.
3. Wait for the request to confirm the durable transaction. Then remove
   `spaceHost` and hand the canonical hostless `AppView` to ordinary shell
   navigation.

A rejected live hint is a route conflict. The shell does not persist that hint
or navigate to the target through it. If persistence fails after live
registration, the shell reports that link receipt failed and does not navigate.
The accepted route may remain live until the runtime stops. Repeating receipt
can confirm the same route and attempt the durable write again.

Patterns receive no new routing API. They continue to store and follow
hostless fabric references. A later runtime hydrates their routes from the
home-space site table. Hydration may finish after a running pattern has already
read the target space through the provisional default host. The replacement
and replay rules below must then update that same running pattern with the
intended data. This recovery does not require a page reload or a pattern
restart.

The runtime does not open a short-lived secondary session for origin
resolution. A seeded route can only be confirmed. Once a late hint is accepted,
a different hint is a conflict before or after the space opens.

Opening an unseeded space on the default host does not accept that fallback as
its route. If no stateful operation has been issued, the first late hint still
wins. If it names another host, the storage manager invalidates and closes the
provisional replica, replaces it in place, and settles its queued and in-flight
reads even if its connection has not opened. Route cancellation closes
connection, initial or reconnect session signature creation, mount, and ACL
setup work that is still in progress. The manager then replays its registered
document reads on the hinted host. Asynchronous document reads, entity listing
and lookup, and SQLite queries that overlap replacement follow the hinted
replica rather than returning the provisional close result. A `synced()` call
that already started also waits for the replacement and its replay. Replay
includes CFC schema documents discovered from the hinted entities. Existing
reactive readers observe the hinted space's data, and convergence does not
remain blocked on the provisional connection.

Work already holding the invalidated replica cannot commit through it. A
transaction that read from that replica becomes inconsistent and must recompute
from the hinted data. The issue boundary checks every read-basis space, not only
the write target, before it hands a mutation to a host. Session construction
checks the route generation before each mount and after each asynchronous setup
step. It also receives the route cancellation signal, so an abandoned
connection, signature operation, mount, or ACL query settles instead of
remaining alive beside the replacement.

The manager refuses to replace a provisional replica after its session accepts
any stateful operation for issue. Stateful operations include ordinary
transactions, ACL setup transactions, and injected SQLite source
registration. The route is fixed at issuance rather than successful
acknowledgment because a reported error does not prove that the host rejected
the operation. A hint can still replace work that is waiting for a session or
is rejected before the session accepts it. Route generations prevent
invalidated work from starting a later mount or issuing a mutation after
replacement. Waiting SQLite registrations settle against the invalidated
replica instead of blocking convergence. A hint that names the default host
confirms the provisional route without rebuilding the replica.

This policy settles ingestion of a known host hint. It does not yet make route
discovery reliable. Host unavailability, replicated hosts, failover, stale
site-table entries, authenticated replacement of an explicit route, and
replicated-host failover remain open design work.

| Capability | Repository status | Remaining work |
|---|---|---|
| Register a late host hint before a space opens | **Implemented** | `StorageManager.registerSpaceHost` adds the route. A seed can only be confirmed, and the first accepted late hint becomes authoritative |
| Keep an accepted late hint stable before opening | **Implemented** | `StorageManager.registerSpaceHost` accepts the first late hint and rejects a different hint before or after the space opens |
| Replace a provisional default route after opening | **Implemented** | The first late hint invalidates an unseeded provider that opened through the default host before its session accepts a stateful operation. It cancels unfinished connection, initial or reconnect session signature creation, mount, and ACL work. Registered document reads, existing sync barriers, and overlapping read-only calls continue through the hinted host, including verified CFC schema documents discovered from the hinted data. Transactions based on the old replica are rejected as inconsistent at issue time, including when they write another space. A matching default-host hint confirms without reconnecting. Ordinary transactions, ACL setup, and SQLite source registration fix the route when issued, even if acknowledgement later fails |
| Hydrate durable hints in a new runtime | **Implemented** | The runtime processor watches the home-space site table, selects its last origin-only HTTP or HTTPS route for each space, and registers those hints. It ignores credentials, paths, queries, fragments, malformed URLs, unsupported schemes, and entries whose `did` does not start with `did:`. Hydration can replace a provisional default route. A route already accepted through IPC remains fixed; a conflicting table route accepted first makes later IPC registration fail |
| Apply one origin-only grammar to every route | **Partial** | `normalizeSpaceHost` rejects credentials, a non-root path, a query, and a fragment. Seeds, live hints, and hydration use it. The shared fabric-authority helper defaults to HTTPS and derives HTTP only for loopback when the current runtime route explicitly uses HTTP. Applying the grammar to the default host, future share-link receipt, and future effective-host results remains required |
| Append an accepted route with commit acknowledgment | **Runtime persistence API required** | Generic `CellHandle` writes either overwrite the table or return before a remote append failure can reach the caller. There is no dedicated operation that synchronizes and applies the table's existing candidate, registers the supplied route, transactionally appends it, inspects the commit result, and reports live conflict separately from persistence failure |
| Accept a host-qualified piece origin | **Origin integration required** | No source lifecycle operation persists and registers a `cf://` hint before resolving and committing the origin |
| Receive a host-qualified fabric link in the shell | **Link-receipt integration required** | **Copy link** still copies the frontend URL. No shell path emits or receives the `spaceHost` share-link form, asks the runtime for the effective per-space host, or waits for acknowledged route persistence before navigation |
| Replace an explicit route after host failure or space movement | **Reliability design required** | There is no authenticated route-change or failover protocol after a seed or late hint becomes authoritative |

## Reconciliation when a piece loads

Loading a piece with an active origin performs these steps before starting its
pattern:

1. Read the current `patternIdentity`, retained-program digest, active source
   URL, accepted origin revision, and stable revision head.
2. Resolve the origin.
   - For an external web URL, apply the network URL policy, fetch the complete
     authored module closure, compute its content identity, and select the
     stored entry export.
   - For an unpinned fabric URL that names a mutable entity, read that entity's
     current source revision, `patternIdentity`, runtime-neutral program digest,
     and immutable authored-program manifest. Make the manifest and its verified
     source available in the following piece's space.
   - For a fabric origin normalized from a direct content identity or an
     accepted entity-FID URL with a pin, load and verify that exact source
     closure and select the stored export symbol.
   - Before any cross-space copy, enforce the source's CFC provenance labels
     for the destination and fail closed when the flow is not permitted.
3. If the resolved identity, symbol, complete-program digest, and origin revision
   equal the values accepted by the current revision, start the current pattern
   without writing a revision. That shortcut requires the accepted source to
   still be loadable in this space: an identity is a fact about what the origin
   offers, not about what this space holds, and a piece whose compiled artifact
   is gone cannot start however current its identity is. Resolution continues
   for such a piece, which puts the artifact back and writes no revision. A
   changed retained program or origin revision is a source transition even when
   the executable identity is unchanged.
4. Compile fetched authored source under the authoritative current runtime
   fingerprint. For a fabric identity published elsewhere, verify every source
   document under its recorded effective fingerprint and check runtime
   compatibility without re-identifying it. Unless the origin is one whose
   releases this deployment gates, compare the candidate's argument and result
   schemas with the accepted source, and accept only a candidate that can
   replace it. A piece whose current pattern cannot be loaded has nothing left
   to compare and nothing left to protect, so its origin's source is adopted
   without one.
5. Write an immutable authored-program manifest for the verified candidate in
   the target space. Retain its exact source documents and pinned fabric
   dependency closures, and wait for every write to succeed. A failed write
   fails the transition. It is not converted into a background warning.
6. In one transaction, compare the expected revision head, current pattern,
   active origin, and stored argument. If all remain current, append the
   revision, restage the argument against the candidate's schema, retain the
   active origin and accepted origin revision, set `patternIdentity` to the
   candidate value even when it is unchanged, and advance the revision head.
7. Start the accepted pattern on the existing piece result cell.

If reconciliation fails and the current source remains loadable, the runtime
starts that source. A piece in that state is not following its origin any
more, and it must say so.

Adopting a candidate whose contract differs from the accepted one is a data
migration, and performing that migration is required work. Until it exists, a
candidate whose contract the piece's stored data does not satisfy is refused by
setup, which fails the transition and leaves the piece on its last accepted
source. That is safe, but it is a refusal rather than a repair, and it does not
resolve itself: the origin goes on offering source the piece goes on refusing,
every time it is opened.

Compatibility descriptors are retained with the source state so that a
migration can compare an accepted contract with a candidate's without executing
the prior implementation.

### Saying when a piece has stopped following its origin

A piece's source panel names the origin it records. That is not the same as
running what the origin offers, and the two must be told apart. A piece whose
last reconciliation failed shows the same panel as one that is up to date, so
the reader concludes it is current when it is not — and the divergence is
permanent for every reason but an unreachable host.

The panel therefore distinguishes these states, and names the last
reconciliation's outcome and time in each:

- **Following.** The origin resolved and the piece runs what it named.
- **Could not reach the origin.** Resolution failed. The piece runs its last
  accepted source. This one may resolve itself on the next open, and the panel
  says so.
- **Refused the origin's current source.** The origin resolved, and the piece
  did not adopt what it offered — the candidate is not an acceptable
  replacement for what the piece runs, its stored data does not satisfy the
  candidate's contract, the source did not compile, or the source did not
  produce the identity its origin advertised. This does not resolve itself. The
  panel names the reason, and offers the actions that end it: take the
  candidate anyway, detach, or repoint.
- **Detached.** The piece records no origin; nothing supplies code for it.
- **Unusable origin.** The piece records a string no resolver can follow. This
  is not detached — the piece is carrying something a person can read and fix —
  and it is not following either.

One case escapes these states while a running piece's transition moves only its
pointer. A refusal there leaves the pointer on a candidate the graph never ran,
and every later reconciliation agrees with that pointer, so the panel reports
Following for a piece that runs its accepted source. Staging the candidate in
that transition, described under the compatibility policy, is what removes it.

Telling could-not-reach from refused needs a finer answer than reconciliation
gives today. It reports one outcome for an origin it could not reach and for
one that resolved and offered source it could not use — a program that did not
compile, one that did not produce the identity its origin advertised, one whose
setup the piece's data refused. The first may fix itself and the rest will not,
so they cannot share a state on the panel, and separating them is part of this
work.

Distinguishing these needs the outcome of the last reconciliation to outlive
the reconciliation, so the panel can show it to a reader who opened the piece
later or in another session. The outcome is durable state on the piece,
alongside the active origin: the outcome, when it was reached, and the
identity the origin offered when one was resolved. It is not a revision — a
refused candidate was never accepted, and the revision log records only what
the piece adopted.

A refused candidate is worth surfacing beyond the panel, because a piece
nobody opens says nothing at all and the owner of the origin is usually not
the owner of the piece. How that reaches a person is open design work.

Reconciliation is triggered by a user opening the piece. Nothing reconciles a
piece nobody opened: a serving tenure owes a space the existence of its root,
not the freshness of anyone's source. The specialized system-root updater
demonstrates reconciliation before bootstrap, but it is a transitional
implementation on a trigger of its own; under this sequence a root follows its
origin exactly as every other piece does. Retained compatibility descriptors
let this sequence replace an obsolete implementation without executing it
first. A root does not receive a narrower repair contract or skip checks when
prior source is unavailable.

## Following while a piece is running

Load-time reconciliation recovers updates missed while a following piece was
stopped. While it is running, the runtime also subscribes when its unpinned
fabric URL resolves to a stable mutable entity. It observes that entity's source
revision head rather than only its `patternIdentity`. This propagates an update
to an unreachable authored file even when the executable identity is unchanged.
A content-addressed or explicitly pinned fabric URL has no subscription because
its target cannot change. Each notification enters the same guarded transition
described above. There is no separate unguarded update path.

The subscription ends when the following piece stops, detaches, or repoints.
Authorization loss, a prohibited cross-space information flow, unavailable
source, and validation failure leave the last accepted source running and
surface an origin error. A concurrent local edit or repoint advances the
revision head, so an in-flight notification from the former origin cannot
commit. Restoring authorization does not require polling: a new subscription
or the next load performs reconciliation from the origin's current state.

## Revert and repoint semantics

Revert and repoint answer different questions:

- **Revert** asks, "Restore this retained authored program and its exact pins."
  It uses the immutable authored-program manifest, selected export, and pinned
  dependency identities from the revision log. It does not contact the
  revision's former origin and does not resume updates.
- **Repoint** asks, "Follow this place again." It selects a source URL from
  history, restores its normalized web or fabric form, resolves that origin
  now, and adopts its current source.

When the current runtime is equal to or explicitly compatible with the
revision's recorded fingerprint, revert may reuse the historical executable
identity. Otherwise it restores the same authored program and pins, compiles
them under the authoritative current fingerprint, and produces a new executable
identity. Both outcomes append a detached revision with the revert operation and
a `revertedFrom` reference. The rebuilt outcome also records a runtime-rebuild
cause. It does not alter the historical revision or claim that the old and new
executable identities are equal. If the retained source cannot compile under the
current runtime, the revert fails without changing the piece.

Fingerprint equality is compatible by default. A runtime may execute another
recorded fingerprint only through an explicit, versioned compatibility
declaration. Successful compilation alone does not establish compatibility.

A manual **detach and rebuild** uses the current revision's immutable authored
program manifest. It compiles that program under the authoritative current
fingerprint, clears the active origin, and appends a direct-edit revision with a
`rebuiltFrom` reference to the preceding revision. It is not a revert because it
does not select earlier code. This operation also works for a piece that has only
its creation revision.

Repointing a content-addressed or explicitly pinned fabric URL adopts the same
exact executable identity again because that URL is immutable. It fails if the
current runtime cannot execute the identity's recorded fingerprint. A user who
wants its current retained authored program rebuilt locally uses detach and
rebuild. A user who wants an earlier retained program uses revert. Repointing an
unpinned mutable fabric entity URL resumes following that entity's current
pattern. Repointing an external web URL fetches its current response.

This distinction avoids a surprising state in which a user reverts to repair a
regression and the next load immediately reapplies the origin's broken source.

History is append-only. Reverting or repointing does not remove the selected
record or truncate later records. Repeated transitions may therefore name the
same pattern identity more than once, with different reasons or origin states.

## Trust model

Choosing a mutable active origin is an ongoing trust decision. A later program
from that web endpoint or mutable fabric entity runs with the following piece's
authority after it passes verification and compatibility checks. A
content-addressed or explicitly pinned fabric origin cannot change. The content
identity proves which executable source graph was accepted and detects corrupted
transfer. It does not prove that a publisher, piece owner, or URL owner made a
safe change.

Within a space, every cell and document that makes a pattern resolvable,
including its authored-program manifests, source revision history, and verified
source documents, is protected by that space's ACL. The source therefore has the
same visibility as the pattern in that space. There is no separate source
publication permission. Naming a pattern with a slug or revealing its URL or
content identity does not broaden the space's ACL.

Forking or following across spaces also moves authored source into the target
space. Read authorization alone does not authorize that information flow. CFC
provenance checks run before replication on the same toolshed as well as
across toolsheds.

After an allowed copy, the accepted closure and its history revision live under
the destination space's ACL. The same content identity can therefore have
different visibility in its origin and destination spaces. If access to a
mutable origin is later revoked, the follower keeps its last accepted source
and retained revisions. The revocation prevents reconciliation and future
updates; it does not erase already accepted history.

The UI must distinguish detached pieces, immutable fabric-origin pieces, and
pieces that update automatically. It shows the active source URL and whether
that URL resolved to a web endpoint, mutable fabric entity, or exact fabric
pattern. It also shows when a trailing pin made an entity-FID input immutable.
It identifies runtime rebuild revisions separately from authored-source changes.
It offers detach and revert actions near mutable-origin controls. A revert
preview says whether the runtime can reuse the historical executable identity or
must rebuild the retained authored source under the current fingerprint. The
revision log provides an authored-source rollback target after a bad but valid
update even when its historical runtime is no longer executable. If the current
immutable origin is incompatible, the UI offers detach and rebuild without
mislabeling the current creation revision as a revert target.

The piece menu, opened by right-clicking a rendered piece, belongs to
`cf-piece-menu` in the component package rather than to the shell. Every host
that renders pieces through `cf-render`, including Loom, therefore receives the
same lifecycle controls. It names the origin kind and shows the canonical origin
URL alongside the recorded string when normalization changed it. It says a
piece is detached when it records no origin. It shows the current pattern
identity and export symbol, the identity whose setup state was installed, and
the pattern identity a specialized update displaced. It lists the retained
authored source files.

The menu's **Clone fresh piece into new space** action creates a copy with
default input data in a unique named space owned by the current user. **Clone
piece and copy data into new space** instead seeds the copy with detached
snapshots of the selected piece's current input and stateful internal data.
Computed values are recomputed in the new space. Data linked from another space
is rejected because storage cannot capture a cross-space atomic snapshot. Clone
progress and failures appear in a dialog. A detached selected piece becomes the
copy's mutable fabric origin. A selected piece with an active origin passes that
origin to the copy, so parallel copies follow one upstream source instead of
forming a longer chain. A followed piece also has a **Stop following source**
context-menu action. The history panel lists every recorded revision. An
earlier revision offers **Use this version**, which restores its retained source
and detaches. A revision that records an origin also offers **Follow this source
again**, which resolves that origin now and keeps it active. A known structural
incompatibility leaves the piece unchanged until the user explicitly confirms
the warning. The confirmation token is bound to the exact compiled candidate
and guarded piece source snapshot. It is also bound to the retained argument
and the durable producer contracts that were checked. It cannot approve
different code fetched later from a changed mutable origin or a different
retained link. The warning collects pattern-contract and durable-link
incompatibilities before asking for confirmation. A candidate that cannot use
the actual retained argument is rejected without offering confirmation.

## Current implementation

| Requested interaction | Status | Evidence and remaining work |
|---|---|---|
| Manually push local code with an identity key and create a piece | **Implemented** | `cf piece new` resolves a local file program, writes its content-addressed source closure in the target space, creates a piece, and authenticates through the supplied identity. `cf piece setsrc` updates the same piece. |
| Wish a new pattern into being with an LLM-backed UI | **Partial** | The `write-and-run` example asks an LLM for pattern code and passes it to `compileAndRun`, whose callback lets the browser worker register the new piece in a space. It is not a general product affordance and does not record a source revision. The runtime `wish()` builtin is discovery, not code generation. |
| Manually push code from a source URL and create a piece that remembers it | **CLI URL flow required** | The command-line `new` and `setsrc` commands accept local filesystem entries. `RuntimeClient.createPage(URL)` fetches an HTTP or HTTPS program and records its canonical URL as the active origin with the creation revision. Fabric resolution can resolve content-addressed patterns and same-toolshed piece references to a source identity, but its result does not carry the export symbol as origin state. The command line still has no general `https://` or `cf://` source-origin operation. `--repository` is descriptive metadata and is not an origin. |
| Use a UI affordance to push a known source URL into an owned space | **Partial** | A host can call `RuntimeClient.createPage(URL)` to fetch and run an indexed HTTP or HTTPS program with its canonical URL recorded as the active origin. `fetchProgram` with `compileAndRun` and the omnibox's `fetchAndRunPattern` can also fetch and run indexed web programs, but those paths remain history-free. There is no corresponding fabric URL affordance. |
| Follow an immutable fabric URL | **Immutable URL follow required** | Following one resolves the pinned identity, adopts its source once, and can then never report a move again. Nothing follows a fabric origin at load today, and such an origin stores no export selector, so an implementation has either to store one or to choose the pinned source's normal entry export. |
| Load or create from an immutable fabric URL | **Immutable URL flow required** | The source cache and fabric resolver can load verified `cf:pattern:<identity>` source and honor a trailing pin on an entity-FID reference. No product operation normalizes that URL and export symbol into immutable piece origin metadata or appends the required revision. |
| Automatically refresh a mutable URL-origin piece when loaded | **Partial** | The shell reconciles system roots before bootstrap and checks other successfully instantiated same-toolshed system-source patterns in the background, under the `systemPatternAutoUpdate` flag. An accepted update changes the pattern, active origin, and guarded revision history atomically. The specialized updater requires exact argument and result schema equality for an unattended ordinary-piece update, applies no comparison to a root, and handles only same-toolshed web sources. External web URLs and mutable fabric entity URLs do not use this load path, and a content-addressed or explicitly pinned fabric URL resolves once and then has nothing to refresh. What this document specifies instead is one mechanism, resolving every origin kind the same way and triggered by a user opening the piece — a `system:` ref through the toolshed's `?identity` route, an external `https://` endpoint through a revalidating fetch of its closure, a mutable fabric entity through the pattern identity it currently runs — with the release-gate rule deciding which candidates must prove themselves first, and with nothing reconciling a piece nobody opened. |
| Retain authored declaration files | **Declaration identity work required** | `computeModuleHashes` follows type-import edges, but production engine paths remove authored `.d.ts` files before module identity calculation, source-document construction, and cache persistence. Declaration-only changes can therefore reuse stale executable identities and compiled bytes. |
| Publish explicit source subpaths | **Exports-map support required** | The `cf:` grammar parses a subpath. Compile resolution and the shared pin/update chase reject it before entry resolution, so current tooling cannot create a misleading subpath pin. There is no immutable authored-program manifest or exact public exports map. Entry imports continue to pin the entry identity. |
| Record and propagate a runtime rebuild | **Provider and lifecycle required** | `computeModuleHashes` accepts `runtimeFingerprint`, and its unit test proves that changing the fingerprint changes a module with an external dependency. Production pattern compilation and source verification use the empty default. There is no authoritative executable-fingerprint provider. Source documents do not retain a non-empty identity fingerprint. The partial revision log has no runtime-neutral program digest, runtime-rebuild cause, owner-published propagation contract, or cross-runtime revert handling. |
| Manage a space root through the ordinary piece lifecycle | **Partial** | A root is already a piece. The shared menu actions work on it, and the specialized updater appends the same guarded history records. A first lifecycle transition freezes a legacy relative source path against the space's accepted host and retains the recorded path. Creation still stamps a raw `patternSource`, update authority is not a complete durable origin record, and root updates still enter through a separate controller path. Under this design the only thing left particular to a root is repair rather than update: a root that cannot start, and that records no origin or the same official system source, rolls forward to that source so its space stays openable. The creation template currently lives on the mutable home root, and root linking does not validate a root interface. |
| Clone an existing piece into a new space and follow its upstream source | **Partial** | `cf-piece-menu` offers a default-data clone and a clone seeded with detached snapshots of the selected piece's input and stateful internal data. Computed values are recomputed in the new space. The menu creates a unique named space through the current user's runtime, reports progress and failures in a dialog, and navigates to the clone. `PieceController.cloneTo` copies one guarded snapshot of the selected piece's verified current program. It records the selected piece as a mutable fabric origin when the piece is detached, or passes through the piece's active origin. Relative fabric origins are qualified with their source space. The pattern updater observes a mutable upstream piece while the clone runs, applies compatible source changes, and restores that observation when the clone starts. Under this design a clone is opened rather than merely started, so the reconciliation an open performs is what installs that subscription. Cross-space source copies reject confidentiality and integrity labels that the copy cannot preserve. The clone receives an ordinary creation revision. Origin-chain cycle checks, same-identity origin-revision observation, and cross-host guarded observation remain required. |
| Fork an existing piece and detach it | **Fork operation required** | Tooling can recover a piece's verified source closure, and the runtime can create another piece from a program. The clone action follows an upstream source and is not a fork. There is no detached fork operation or UI, no `forkedFrom` history, and no atomic detach contract. |
| Stop following an active origin without changing the current source | **Partial** | `cf-piece-menu` exposes **Stop following source** for a piece with an active origin. `PieceController.changeSource` verifies the retained current source, atomically clears the origin without rerunning setup, and appends a detach revision. A later specialized update recognizes that revision as intentional detach. It works through `RuntimeClient` in every `cf-render` host. The complete authored-program manifest and runtime-rebuild distinction remain required. |
| Follow another piece and receive its source updates | **Partial** | A history repoint can resolve an unpinned fabric entity URL to the source piece's current pattern, copy its verified authored program into the destination space, apply it, and retain that URL as the active origin. A running piece observes a mutable fabric origin and accepts compatible pattern changes. Starting the piece restores the observation and performs an immediate check. Cross-space copies fail closed when source labels cannot be preserved. The menu exposes clone, detach, and refollow controls. Fabric URL creation outside the clone flow, the remaining web creation paths, same-identity origin-revision observation, origin-chain cycle checks, and durable cross-host routing remain required. |
| Wish an existing piece to change and detach it | **Partial** | `PieceController.setPattern` now clears the active origin and appends a guarded direct-edit revision. When a detached, history-free, programmatically constructed predecessor has no retained source, the edit records its displaced executable identity outside restorable history and begins the source log with the new exact source. A piece with recorded history still rejects the edit when its current source is unavailable. It also rejects incompatible pattern or retained-input schemas unless `dangerouslyAllowIncompatibleSchema` is supplied. The command line exposes that override without a first-class warning flow, and there is no general LLM-backed edit affordance. |
| Revert to source previously used by the same piece | **Partial** | The source history indexes prior pattern identities, retains their source-document closures, and exposes each retained version through **view source**. **Use this version** restores the selected program, clears the active origin, and appends a revert revision after compatibility checks. A complete authored-program manifest, runtime fingerprint, unreachable-file guarantee, and cross-runtime rebuild path remain required. |
| See whether a piece is actually following its origin | **Reconciliation state required** | The source panel names the origin a piece records, which says nothing about whether the piece runs what that origin offers. A failed or refused reconciliation is a log line, so a piece permanently stuck on old source looks exactly like one that is up to date. The last reconciliation's outcome, time, and offered identity have to become durable state on the piece and reach the panel, which must distinguish following, could-not-reach, refused, detached, and unusable — and offer the actions that end a refusal. |
| Point a piece at an origin it has never followed | **Manual origin entry required** | The piece menu can stop following an origin, restore a retained revision, and refollow an origin the piece already used, but every one of those selects from history. Nothing lets a person type an origin. It needs a field on the source panel that accepts a web or fabric URL, normalizes it under the source URL policy, records it with a repoint revision, and resolves it immediately so the piece adopts its source there and then — with a resolution failure reported rather than the piece left pointed at something unreachable. |
| Repoint to a web URL, mutable fabric entity URL, or immutable fabric URL previously used | **Partial** | **Follow this source again** resolves a selected historical web or fabric origin now, applies its current source, retains the origin, and appends a repoint revision. Cross-space fabric origins read their verified source closure from the source space and compile it into the destination. An incompatibility confirmation applies the exact candidate that produced the warning. Fabric origin creation outside the clone flow, the remaining web authoring paths, full normalization and policy enforcement, load reconciliation, origin-chain guards, and running subscriptions remain required. |
| Record every previous source and origin | **Partial** | `pieceSourceHistory` is an append-only list guarded by its last revision identifier, current pattern, and active origin. Each entry records the pattern, origin, operation, selected historical revision, and a link that retains a source-document closure verified in the same transaction. Direct Piece API creation records its detached initial source. URL-backed Runtime Client creation records its canonical active origin and initial source together. Recovery from an unavailable legacy source records its displaced executable identity outside restorable history rather than inventing a broken revision. Other creation paths, complete authored-program manifests, runtime fingerprints, program digests, causes, and origin revision identifiers remain required. |

The implementation evidence for this table is concentrated in:

- [`packages/runner/src/runner.ts`](../../packages/runner/src/runner.ts) for
  current pattern, origin, and repository metadata and the in-place watcher;
- [`packages/runner/src/compilation-cache/cell-cache.ts`](../../packages/runner/src/compilation-cache/cell-cache.ts)
  and
  [`packages/runner/src/pattern-manager.ts`](../../packages/runner/src/pattern-manager.ts)
  for verified source closures and cross-space closure replication;
- [`packages/cli/commands/piece.ts`](../../packages/cli/commands/piece.ts) and
  [`packages/cli/lib/piece.ts`](../../packages/cli/lib/piece.ts) for local-file
  creation and source replacement;
- [`packages/runtime-client/src/runtime-client.ts`](../../packages/runtime-client/src/runtime-client.ts)
  and
  [`packages/runtime-client/src/backends/runtime-processor.ts`](../../packages/runtime-client/src/backends/runtime-processor.ts)
  for URL-backed page creation with canonical origin and creation-history
  stamping;
- [`packages/piece/src/ops/pieces-controller.ts`](../../packages/piece/src/ops/pieces-controller.ts)
  for system-root origin stamping and pre-start reconciliation;
- [`packages/piece/src/ops/piece-origin.ts`](../../packages/piece/src/ops/piece-origin.ts)
  for origin classification, resolving historical web and fabric origins, and
  reading a piece's source state;
- [`packages/piece/src/ops/piece-controller.ts`](../../packages/piece/src/ops/piece-controller.ts)
  for detach, revert, repoint, compatibility checks, and direct-edit
  transitions;
- [`packages/ui/src/v2/components/cf-piece-menu/cf-piece-menu.ts`](../../packages/ui/src/v2/components/cf-piece-menu/cf-piece-menu.ts)
  and
  [`packages/ui/src/v2/components/cf-render/cf-render.ts`](../../packages/ui/src/v2/components/cf-render/cf-render.ts)
  for the piece menu, its source and origin panels, and the right-click that
  opens them;
- [`packages/patterns/system/common-fabric.tsx`](../../packages/patterns/system/common-fabric.tsx),
  [`packages/patterns/system/omnibox-fab.tsx`](../../packages/patterns/system/omnibox-fab.tsx),
  and
  [`packages/patterns/system/suggestion.tsx`](../../packages/patterns/system/suggestion.tsx)
  for the current indexed-URL UI flow;
- [`packages/patterns/examples/write-and-run.tsx`](../../packages/patterns/examples/write-and-run.tsx)
  and
  [`packages/runner/src/builtins/compile-and-run.ts`](../../packages/runner/src/builtins/compile-and-run.ts)
  for the example LLM-backed creation machinery; and
- [`packages/runner/src/schemas.ts`](../../packages/runner/src/schemas.ts) for
  the unused lineage declarations.

## Implemented foundations to preserve

- A compiled pattern has a content-derived entry identity. The source-doc
  closure under `pattern:<identity>` can recover the authored files.
- A piece stores only `{ identity, symbol }` as its executable pattern pointer.
- Changing `patternIdentity` can re-instantiate a running piece in place on the
  same result cell.
- `PieceController.setPattern` uses the previous identity as a concurrency
  guard and validates backward-compatible pattern and retained-input schemas.
  It can bypass both checks through `dangerouslyAllowIncompatibleSchema`.
  It now detaches and appends source history. The history actions present a
  mismatch as a warning before an explicit override. The command-line and
  general edit flows still need the same warning interaction.
- The atomic source-transition helper compares the revision head, current
  pattern, and active origin. It therefore protects origin-only transitions
  whose source identity stays unchanged.
- Fabric reference parsing and resolution support content-addressed pattern
  references, explicit pins, and same-toolshed mutable references by stable
  entity or slug. Static imports pin mutable references into source.
- System space roots carry a `system:` `patternSource` ref when created through
  `ensureDefaultPattern`, naming a pattern the toolshed serves relative to its
  patterns route. Roots can check that source and replace `patternIdentity`
  before starting. Other successfully instantiated patterns are checked in the
  background, and only a `system:` ref is fetched. This is a transitional
  implementation and migration input. Under the design above a `system:` ref
  still selects a policy — its releases are gated where they are made, so its
  candidates are adopted as they stand — but it selects no separate path.
- Storage supports late registration of a space-to-host hint before that space
  opens. The runtime processor hydrates durable hints from the home-space site
  table by selecting its last origin-only HTTP or HTTPS entry for each space. A
  seeded route can only be confirmed. An unseeded default-host provider remains
  provisional until its session accepts a stateful operation. The first
  accepted hint can replace it, cancel unfinished session setup, clear its
  replica, and replay its reads so running patterns observe the hinted space.
  A provisional provider can move while an operation is waiting for a session.
  Invalidated transactions are rejected and recompute from the hinted replica.
  Once an ordinary transaction, ACL setup transaction, or SQLite
  source registration is issued, the route remains fixed even if its
  acknowledgment fails. The first accepted late hint remains stable,
  including against a later table update.
  IPC callers must check the registration result and stop before mounting on a
  conflict. Historical fabric origin resolution can register a matching live
  route, but it does not yet persist that route through the site table. Generic
  runtime-client cell writes do not propagate remote commit failure, so they
  cannot provide acknowledged site-table persistence. The shell's **Copy link**
  action copies its frontend URL and cannot ask the runtime for a space's
  effective host.
- Tooling exposes the immutable source ref, optional repository locator,
  authored entry path, current origin, revision history, and lifecycle actions
  separately.

## Work required

1. Define a discriminated origin schema for external web URLs, stable mutable
   fabric-entity URLs, and immutable fabric URLs created by a direct pattern
   identity or a pin on an entity FID. Add a source-state schema with a stable
   revision head. Define immutable revision records and
   `cf/authored-program-manifest/v1`. Each manifest binds the canonical main and
   exact filename-to-source-identity set, including authored `.d.ts` files. It
   also binds the normalized exact public-subpath map. Add validation that
   accepts only authored-file targets and includes the map in the manifest
   identity and runtime-neutral program digest. It retains every transitive
   pinned fabric dependency once. Add a complete program enumeration path
   before import-closure resolution. Revisions also record the accepted runtime
   fingerprint, runtime-neutral program digest, separate operation and cause
   fields, and the compatibility descriptors needed without executing an old
   pattern. Replace the unused lineage declarations or remove them rather than
   treating dead declarations as a shipped feature. Implement the authoritative
   version-1 executable runtime fingerprint and runtime-neutral program digest
   defined in [module-loading.md](module-loading.md). Treat an unavailable
   production fingerprint as an error rather than publishing under the legacy
   empty value.
2. Provide one atomic source-transition API used by every caller. It must wait
   for failure-propagating closure persistence and compare the expected
   revision head, current pattern, active origin, and stored argument.
   Mutable-origin activation and reconciliation must guard every revision head
   and active origin traversed during cycle detection. A path that cannot validate the complete read set
   atomically fails closed. Add baseline revision migration for existing pieces,
   including roots whose legacy origin is a raw `patternSource` string.
   Materialize a durable tracked-or-detached choice; do not infer update
   authority from the string, rollout flags, or the root role. When no durable
   active choice can be established, migrate detached. Resolve a relative legacy
   path against the accepted toolshed host before storing an absolute web origin.
   Preserve an unconfirmed locator only as inactive historical provenance.
3. Make local edits explicitly clear active origin metadata. Make source URL
   creation accept and normalize both `https://` and fabric `cf:` inputs,
   including `cf://`. Under the tentative identifier-only policy, produce a
   durable mutable origin with an explicit space DID and a stable entity FID.
   Produce a durable immutable origin with a space-free content identity.
   Normalize current-space shorthand for an unpinned mutable entity to the
   explicit space DID and entity FID. Normalize a direct pattern identity or a
   pin on an entity FID to its space-free content identity. Keep human-readable
   alias resolution outside the lifecycle resolver. Persist an
   accepted space-to-host route before removing the host from the canonical
   target. Validate and register the route before writing it to the site table,
   then open the origin space. Honor the conflict guards for seeded routes and
   previously accepted late hints. Treat an unseeded default-host provider as
   provisional until its first hint arrives or a stateful operation is issued.
   Before a stateful operation is issued, allow the first hint to replace and
   reload the provider. Do not create a secondary session.
   Keep the supplied canonical URL in history. Do not make shortlink retention
   part of the lifecycle contract until the open provenance question is
   settled. Any later alias provenance must remain separate from active origins
   and repoint targets. Keep `patternRepository` separate and clear it when
   newly generated or directly edited code no longer belongs to that
   repository.
4. Observe an unpinned mutable fabric origin's source revision rather than only
   its executable identity, so source-only changes propagate. Treat a new
   runtime fingerprint as a new executable identity even when the
   runtime-neutral program digest is unchanged. Migrate the piece's data when an
   automatic transition adopts a candidate whose contract differs from the
   accepted one, so a contract change does not silently stop a piece from
   following its own origin. Store the export selector a pinned fabric origin
   chose, so following one is not confined to the export the piece already
   runs. Move the current home-root `defaultAppUrl` into
   durable space-creation configuration outside any root piece. Space creation
   must resolve that configured default through the ordinary create transition
   and then link the resulting piece as the root. Creating or relinking that
   link must validate the runtime's root-interface contract.
5. Build the central source URL service. Apply the network policy and explicit
   ongoing-code consent to mutable web origins. Apply fabric authorization,
   content verification, pin handling, durable routing, and provenance checks
   to fabric origins. Store the required export selector and keep credentials
   in separately protected capabilities.
6. Add command-line URL creation and explicit detach, detach-and-rebuild,
   follow, revert, and repoint operations. Add matching UI affordances,
   including the LLM-backed create and edit flows. The piece menu must offer to
   adopt a candidate an automatic update refused, applying that exact reviewed
   candidate through the existing one-use confirmation and keeping the active
   origin. The piece menu must also let a person type an origin directly: a field that accepts a web or fabric URL,
   normalizes it under the source URL policy, records it as the active origin
   with a repoint revision, and immediately resolves it and adopts its source,
   reporting a resolution failure rather than leaving the piece silently
   pointed at something unreachable. This is how a piece is moved to a source
   it has never followed, which history-based repoint cannot express. Before a manual source
   replacement, show incompatible pattern contracts and retained links. Require
   explicit confirmation or a command-line flag to continue. Reject a candidate
   that cannot use the piece's actual retained input. An accepted incompatible
   direct replacement must detach. Root role validation remains mandatory after
   an override.
7. Record the last reconciliation's outcome, time, and offered identity as
   durable state on the piece, and expose it — with revision history — through
   runtime-client protocol types and shell views. The source panel must
   distinguish a piece that is following its origin from one that could not
   reach it, one that refused what it offered, one that is detached, and one
   carrying an origin nothing can follow, and must offer the actions that end a
   refusal. Today all of these render identically, so a piece permanently stuck
   on old source reads as current. Distinguish runtime rebuilds from authored
   source changes. Show whether revert can reuse the historical executable
   identity or must rebuild the exact retained authored program and pins under
   the current runtime. Do not infer history from source-cache contents.
8. Enforce CFC provenance on every cross-space source flow, including spaces
   on the same toolshed. Preserve ordinary read authorization and verify every
   replicated source closure by content identity. Connect host-qualified origin
   ingestion to the implemented late-bound route registry and durable site
   table. Design reliable discovery, authenticated route replacement, host
   failover, and explicit close-and-reopen behavior for unavailable or moved
   spaces.
9. Apply `normalizeSpaceHost` to the default host, share-link receipt, and
   effective-host results. `spaceHostMap` seeds, live registration, and
   site-table hydration already reject credentials, paths, queries, fragments,
   malformed URLs, and unsupported schemes. The shared `cf://` authority
   helper defaults to HTTPS. It derives HTTP only for loopback when its caller
   requests that transport. The historical-origin caller requests HTTP when
   the configured runtime route already uses HTTP. Add the deployment-level
   local-development or test policy before another caller selects HTTP. Reject
   an invalid default during initialization. Test every remaining route input
   and both default-host transports.
10. Add a dedicated failure-propagating route operation and expose it through
   the runtime-client protocol. Revalidate its DID and normalized origin in the
   worker. Synchronize the home site table before reading it or registering the
   live route. Apply the synchronized table's last valid candidate for the
   target DID to the live registry before evaluating the supplied hint. Do not
   rely on the asynchronous hydration watcher to establish that ordering.
   Return a conflict without writing when the supplied route is rejected. For an
   accepted route, transactionally append the site-table entry with the
   synchronized table read as a commit precondition. Await the commit and
   inspect its result before returning success. Propagate resolved
   `ConflictError` and `StoreError` results as well as thrown commit failures. Do
   not retry them. Do not implement this operation with the optimistic
   `CellHandle.set()` or `CellHandle.push()` paths. Expose the effective host for
   a space through runtime IPC so share-link creation uses the per-space route.
11. Add host-qualified fabric-link creation and receipt to the shell. **Copy
   link** emits the specified DID-based shell URL and `spaceHost` parameter.
   Receipt validates the shell path and toolshed origin, calls the dedicated
   route request, and removes the parameter before ordinary `AppView`
   navigation. Intercept an initial share URL before the target `AppView` opens
   its space. Report malformed links, live conflicts, and durable-write failures
   without navigating. Keep this route discovery outside pattern APIs and
   source-origin state.
12. Add a browser-level shell integration test with two independent toolshed
   servers and real patterns as the user interface. Put the target data only on
   the non-default toolshed. Open that target in a producing shell and invoke its
   production **Copy link** action. Read the emitted URL from the browser
   clipboard. Assert that its outer origin is the shell frontend, its path names
   the target by explicit DID, and its sole `spaceHost` value equals the
   non-default effective host reported by the runtime. Open that exact copied URL
   in a receiving shell. Prove that receipt records the route durably.

   Tear down the receiving runtime. Start a fresh shell runtime with the same
   identity and durable home space. Do not provide a `spaceHostMap` seed, call
   live registration directly, or write the site table through test setup. Run a
   pattern whose retained input contains the corresponding hostless cross-space
   reference. Use an observable test gate to let its provisional default-host
   read report the missing target before site-table hydration publishes the
   receipt's persisted hint. Then release hydration and prove that the same
   running pattern renders the target data without a page reload or pattern
   restart. The test may control event ordering, but it must not inject the hint
   through a test-only registration endpoint.

   Add worker-path persistence cases. Begin receipt before the initial local
   site-table value has synchronized while the remote table already contains an
   unrelated entry. Prove that receipt synchronizes first and preserves that
   entry. Make synchronization fail and prove that no live registration, append,
   navigation, or retry occurs.

   Put a conflicting route for the target DID in the remote table. Hold the
   asynchronous hydration watcher before it registers that route. Prove that
   receipt itself applies the synchronized table candidate first, rejects the
   supplied hint, and performs no append or navigation.

   Start two receipts for different target DIDs from one synchronized table
   snapshot. Use an event gate after both transactions capture that snapshot.
   Commit one append, then prove that the other resolves with a real
   `ConflictError` from the table precondition. The final table retains its
   original entries and the successful append. The conflicted receipt does not
   navigate or retry. Separately make an awaited commit resolve with a
   `StoreError` and require the same shell failure behavior. A main-thread stub
   that fails before the worker attempts the commit does not cover this
   contract.
13. Add CI golden replays that carry representative durable state from each
   supported prior source to its proposed replacement. These tests cover
   stable keys and causes, intended migration, and behavior that schemas cannot
   prove. Extend the current synthetic system-root replays with general
   version-to-version fixtures. Test each transition, concurrent source and
   origin races, failed and incompatible updates, baseline migration,
   self-follow, repoint and migration cycles, concurrent reciprocal follows
   where at most one transition commits,
   subscription cancellation, authorization loss, source unavailability,
   cross-space authorization and provenance, web and fabric URL policy,
   mutable versus content-addressed fabric targets, explicit pins, durable host
   routing after reload, conflicts between late hints before a target opens,
   replacement of a provisional default route after a target opens, conflicts
   with an explicit route after a target opens, space-root creation from a default,
   changes to a default after root creation, tracked and detached root baseline
   migration, source-less legacy roots, relative-path normalization,
   root-interface rejection, runtime-fingerprint rebuilds, authorized upstream
   rebuild propagation, follower propagation of an enumerated unreachable-file
   edit with an unchanged executable identity, an authored `.d.ts` edit that
   changes importer identity and compiled bytes, blocked incompatible
   immutable-origin repoint, cross-runtime revert under a new executable
   identity, detach-and-rebuild recovery from an incompatible first
   immutable-origin revision, two source-only revisions that share an entry
   identity but restore different unreachable files, a public-subpath-map-only
   revision that propagates through a follower and can be reverted, and a
   nested pinned fabric dependency restored after incidental source roots
   disappear. Tests must prove the current source, active origin, revision
   head, authored-program manifest, recursively retained dependency graph, and
   revision log after each operation.

## Relationship to pattern imports

Pattern imports and piece origins intentionally have different update rules.
An unpinned mutable `cf:` import is resolved and written back with an immutable
pin when source is deployed. An entry import pins the target piece's entry
module identity. An explicitly published subpath resolves through the current
authored-program manifest and pins the selected module identity. This includes
type-only imports because Common Fabric uses imported types to generate runtime
schemas. Supported ESM-style type imports follow this rule. Unsupported
import-equals syntax is rejected rather than left mutable. The deployed
importer does not track later changes to the piece or its public-subpath map.
The same fabric URL used as piece-origin metadata stays live when it is unpinned
and resolves to a mutable
`patternIdentity`-bearing entity. The piece can then follow that entity's
current pattern. A fabric origin that resolves to `pattern:<identity>`, or that
was supplied as an entity-FID URL with a trailing pin, is immutable and has no
later update to discover.

Piece-origin metadata remains outside authored source. Mutable web and fabric
entity origins are checked when that piece loads. A content-addressed or pinned
fabric origin is verified when loaded but always resolves to the same exact
source.

This separation keeps a pattern's module identity deterministic while allowing
a stateful piece to adopt a new, separately content-addressed pattern through
an explicit tracking relationship.
