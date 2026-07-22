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
implemented. Local command-line creation is implemented end to end. Automatic
updates exist only through a specialized path for same-toolshed system sources.
That path reconciles roots before bootstrap and checks other successfully
instantiated patterns in the background. It is not the target model: a space
root is an ordinary piece under this entire lifecycle. The general origin,
history, forking, following, reverting, and repointing model in this document
requires work unless the implementation table says otherwise.

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

2026-07-22

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
origin space. It does not create a secondary session. A conflicting seeded
route or previously accepted late hint fails the transition. After the origin
space opens, only the hint that was already registered can be confirmed. Any
other route attempt fails the transition. A later load hydrates the durable
route before resolving the canonical fabric target.

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
   including files outside that export's reachable import graph. Loading code
   never depends on an origin still being reachable.
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
   pattern, and active origin before it commits. A concurrent detach, repoint,
   or edit cannot be overwritten by a late origin check, including when both
   states happen to use the same pattern identity.
5. A direct source replacement detaches the piece unless the operation is an
   automatic refresh from its active origin or an explicit repoint.
6. Reverting selects an exact retained historical authored program and detaches.
   Repointing selects a historical origin and resolves its current program.
   These are separate user actions.
7. An unattended origin update that encounters a failed fetch, unreadable
   followed piece, invalid program, integrity failure, or structurally
   incompatible candidate leaves the current source and history unchanged. A
   piece that already has valid source can continue to run its last accepted
   source. A manual replacement still rejects invalid or unverifiable source,
   but it may apply a structural incompatibility after the user explicitly
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
| Retained authored program | An immutable version-1 manifest for the complete authored program accepted by the current revision, including unreachable files | **Program manifest required**: source documents can retain extra roots, but no piece revision binds the exact accepted file set |
| Runtime fingerprint | The trusted runtime identity used to calculate the accepted executable pattern identity | **Authoritative provider required**: the optional module-hash input exists, but production compilation and source verification still use the empty default |
| Runtime-neutral program digest | The version-1 digest of the canonical main filename and every authored file's runtime-neutral module identity | **Lifecycle comparison required**: the module hash can run with the empty fingerprint, but the complete program digest is not recorded |
| Active origin | No origin, an external `https://` URL with an entry export, a stable mutable fabric-entity URL, or a content-addressed fabric pattern URL with an export symbol | Partial: `patternSource` stores a string for system roots, but general web and fabric URL origins are not supported end to end |
| Revision head | The stable identifier of the latest accepted source and origin state | Revision head required |
| Source revision log | Ordered records of every accepted source and origin state, with a durable reference to each immutable authored-program manifest | Revision log required |
| Descriptive repository | Optional locator shown by tooling; never followed | Implemented as `patternRepository` metadata |

The runtime-neutral program digest is
`cf/runtime-neutral-program-digest/v1` from
[module-loading.md](module-loading.md). It covers the canonical main filename
and every authored file, including unreachable siblings. It excludes mounted
files, synthetic retention links, and the selected export. The digest is
comparison metadata. It is not a fabric URL target, an executable pattern
identity, or a revert target.

Lifecycle ingestion first materializes a complete `Program` with a canonical
`main` and an explicit `files` list. That list defines the authored program for
history. Command-line directory input, LLM output, and a web program manifest
must enumerate every intended file before import-closure resolution. A retained
authored-program manifest provides the list for fork, follow, revert, and
rebuild. A raw web entry point or another `ProgramResolver` that cannot enumerate
files defines its authored program as only the reachable closure it returns. It
cannot later report an unenumerated sibling as a source update. Duplicate
canonical filenames are rejected. Declaration stubs injected by the runtime for
type checking are not authored files and do not enter this list.

The current `ProgramResolver` interface exposes only `main()` and
`resolveSource()`, and `resolveProgram()` returns only the reachable import
closure. Complete-program enumeration for directory, generated, indexed web,
and retained-manifest sources is required integration work.

Each revision's source-retention reference names an immutable
`cf/authored-program-manifest/v1` value. The manifest contains the canonical
main filename and a UTF-8 filename-sorted list of every authored file with its
verified source-document identity. It directly retains those source documents
and the complete transitive graph of content-addressed fabric dependencies
pinned by the program. Recursive retention deduplicates dependency identities
and parses pinned fabric specifiers because source documents intentionally omit
fabric links. Its file list must reproduce the revision's runtime-neutral
program digest. It does not rely on the entry source document's synthetic root
links. Those links are non-normative and can be rewritten when another program
uses the same entry identity.

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
comparisons. A reported backward incompatibility becomes an actionable warning.
The UI requires explicit confirmation, and command-line tooling requires an
explicit flag, before applying it. An accepted manual replacement is a direct
edit, so it detaches the piece and appends a revision.

An automatic origin update has no user present to accept a warning. A known
structural incompatibility therefore blocks the transition. The piece keeps its
last accepted source, active origin, revision head, and history, and the UI
reports the rejected candidate.

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
| Manual incompatible replacement | Warn with details and require explicit confirmation or a command-line flag; an accepted replacement detaches | **Warning flow required**: `setPattern` currently rejects unless `dangerouslyAllowIncompatibleSchema` is supplied, and the command line exposes that flag without a first-class warning and confirmation flow |
| Automatic incompatible update | Reject a known structural incompatibility and keep the last accepted lifecycle state | **Automatic guard required**: the specialized system-source updater changes `patternIdentity` without the complete pre-apply comparison, and general origin reconciliation is not implemented |
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

If persistence fails after registration, the transition leaves the piece
unchanged. The accepted hint may remain available in that runtime until it
stops. A retry can confirm the same hint and attempt the durable write again.
The operation never persists a hint that the live registry has already
rejected.

The runtime does not open a short-lived secondary session for origin
resolution. A configured route and an existing live connection remain stable
for the current session. A seeded route can only be confirmed. Once a late hint
is accepted, a different hint is a conflict even before the space opens. After
the space opens, only the hint already in effect can be confirmed. Any other
attempt fails without changing the piece. It does not silently reconnect or
allow two live connections to disagree about where the same space resides.

This policy settles ingestion of a known host hint. It does not yet make route
discovery reliable. Host unavailability, replicated hosts, failover, stale
site-table entries, authenticated space relocation, and closing and reopening
an affected live session remain open design work.

| Capability | Repository status | Remaining work |
|---|---|---|
| Register a late host hint before a space opens | **Implemented** | `StorageManager.registerSpaceHost` adds the route. A seed can only be confirmed, and an opened space accepts only its previously registered matching hint |
| Keep an accepted late hint stable before opening | **Conflict guard required** | `StorageManager.registerSpaceHost` currently replaces a different late hint while the space remains unopened |
| Hydrate durable hints in a new runtime | **Implemented** | The runtime processor watches the home-space site table and registers its entries. Callers that need ordering must also register through IPC before the first open |
| Accept a host-qualified piece origin | **Origin integration required** | No source lifecycle operation persists and registers a `cf://` hint before resolving and committing the origin |
| Recover from host failure or space movement | **Reliability design required** | There is no authoritative route-change, failover, or live close-and-reopen protocol |

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
   without writing a revision. A changed retained program or origin revision is
   a source transition even when the executable identity is unchanged.
4. Compile fetched authored source under the authoritative current runtime
   fingerprint. For a fabric identity published elsewhere, verify every source
   document under its recorded effective fingerprint and check runtime
   compatibility without re-identifying it. Compare the candidate's argument
   and result schemas and retained inputs with the accepted source. Automatic
   reconciliation accepts only a backward-compatible candidate.
5. Write an immutable authored-program manifest for the verified candidate in
   the target space. Retain its exact source documents and pinned fabric
   dependency closures, and wait for every write to succeed. A failed write
   fails the transition. It is not converted into a background warning.
6. In one transaction, compare the expected revision head, current pattern,
   and active origin. If all remain current, append the revision, retain the
   active origin and accepted origin revision, set `patternIdentity` to the
   candidate value even when it is unchanged, and advance the revision head.
7. Start the accepted pattern on the existing piece result cell.

If reconciliation fails and the current source remains loadable, the runtime
starts that source and reports the origin check failure to the UI. An
incompatible candidate is blocked rather than applied automatically. A user
may explicitly fork or perform a detached manual replacement after accepting
the compatibility warning.

Compatibility descriptors needed for this check are retained with the source
state. This lets the runtime check a candidate without executing the prior
implementation. A legacy piece that has neither a loadable prior source nor
persisted compatibility descriptors cannot update automatically. The user
must explicitly choose a detached force update or fork instead.

The specialized system-root updater already demonstrates reconciliation before
bootstrap. It is a transitional implementation. Once this lifecycle is
available, roots use the same sequence above as every other piece. Retained
compatibility descriptors let that sequence replace an obsolete implementation
without executing it first. A root does not receive a narrower repair contract
or skip checks when prior source is unavailable.

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

## Current implementation

| Requested interaction | Status | Evidence and remaining work |
|---|---|---|
| Manually push local code with an identity key and create a piece | **Implemented** | `cf piece new` resolves a local file program, writes its content-addressed source closure in the target space, creates a piece, and authenticates through the supplied identity. `cf piece setsrc` updates the same piece. |
| Wish a new pattern into being with an LLM-backed UI | **Partial** | The `write-and-run` example asks an LLM for pattern code and passes it to `compileAndRun`, whose callback lets the browser worker register the new piece in a space. It is not a general product affordance and does not record a source revision. The runtime `wish()` builtin is discovery, not code generation. |
| Manually push code from a source URL and create a piece that remembers it | **CLI URL flow required** | The command-line `new` and `setsrc` commands accept local filesystem entries. `RuntimeClient.createPage(URL)` and `HttpProgramResolver` can fetch `http:` and `https:` source. Fabric resolution can resolve content-addressed patterns and same-toolshed piece references to a source identity, but its result does not carry the export symbol as origin state. Neither path gives the command line a general `https://` or `cf://` source-origin operation. `--repository` is descriptive metadata and is not an origin. |
| Use a UI affordance to push a known source URL into an owned space | **Partial** | `fetchProgram` with `compileAndRun`, the omnibox's `fetchAndRunPattern`, and `RuntimeClient.createPage(URL)` can fetch and run indexed web programs. The resulting piece does not receive a general active source URL or a source revision. There is no corresponding fabric URL affordance. |
| Load or create from an immutable fabric URL | **Immutable URL flow required** | The source cache and fabric resolver can load verified `cf:pattern:<identity>` source and honor a trailing pin on an entity-FID reference. No product operation normalizes that URL and export symbol into immutable piece origin metadata or appends the required revision. |
| Automatically refresh a mutable URL-origin piece when loaded | **Partial** | The shell reconciles system roots before bootstrap and checks other successfully instantiated same-toolshed system-source patterns in the background. The specialized updater changes `patternIdentity` without the complete pre-apply structural comparison. A running pattern's setup can refuse an incompatible argument shape and keep the old graph, but the metadata pointer has already changed. External web URLs and mutable fabric entity URLs do not use this path. A content-addressed or explicitly pinned fabric URL intentionally has nothing to refresh. |
| Retain authored declaration files | **Declaration identity work required** | `computeModuleHashes` follows type-import edges, but production engine paths remove authored `.d.ts` files before module identity calculation, source-document construction, and cache persistence. Declaration-only changes can therefore reuse stale executable identities and compiled bytes. |
| Record and propagate a runtime rebuild | **Provider and lifecycle required** | `computeModuleHashes` accepts `runtimeFingerprint`, and its unit test proves that changing the fingerprint changes a module with an external dependency. Production pattern compilation and source verification use the empty default. There is no authoritative executable-fingerprint provider. Source documents do not retain a non-empty identity fingerprint, and pieces have no revision log, runtime-neutral program digest, runtime-rebuild cause, owner-published propagation contract, or cross-runtime revert handling. |
| Manage a space root through the ordinary piece lifecycle | **Lifecycle unification required** | A root is already a piece and the specialized updater can replace its pattern in place. Creation still stamps a raw `patternSource`, reconciliation bypasses revision history, and update authority is not durable per piece. Root updates still use a separate controller path. The creation template currently lives on the mutable home root, relative source paths are not ordinary origins, and root linking does not validate a root interface. New-root creation, legacy-root migration, and later transitions do not yet use the ordinary lifecycle path. |
| Fork an existing piece and detach it | **Fork operation required** | Tooling can recover a piece's verified source closure, and the runtime can create another piece from a program. There is no fork operation or UI, no `forkedFrom` history, and no atomic detach contract. |
| Follow another piece and receive its source updates | **Follow operation required** | `cf:` resolution can read another piece's current `patternIdentity`, content-addressed source can be replicated, and a running piece watches its own `patternIdentity` for in-place swaps. No operation stores an unpinned, normalized fabric entity URL as the active origin, retains the accepted origin revision, reconciles it on load, subscribes to the origin's source revision while running, or exposes follow and unfollow UI. Cross-host routing also remains incomplete. |
| Wish an existing piece to change and detach it | **LLM edit UI required** | `PieceController.setPattern` and `cf piece setsrc` reject incompatible pattern or retained-input schemas unless `dangerouslyAllowIncompatibleSchema` is supplied. The command line exposes that override, but it does not first present the target warning and confirmation flow. There is no LLM-backed edit affordance or revision log. Existing setup writes also preserve `patternSource` and `patternRepository` when replacements omit them, so the required detach behavior is not implemented. |
| Revert to source previously used by the same piece | **Revert operation required** | Old immutable source documents may still exist by content identity, but the piece has no index of identities it previously used and no revert operation or UI. Cache retention is not a history contract. |
| Repoint to a web URL, mutable fabric entity URL, or immutable fabric URL previously used | **Repoint operation required** | There is no origin history, general origin resolver at piece load, repoint operation, or UI. |
| Record every previous source and origin | **History and manifests required** | `pieceLineageSchema` and `pieceSourceCellSchema` are declarations with no readers or writers. Current pieces retain only the current `patternIdentity`, optional `patternSource`, and optional `patternRepository`. There is no immutable per-revision manifest that binds a complete authored file set. |

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
- [`packages/runtime-client/runtime-client.ts`](../../packages/runtime-client/runtime-client.ts)
  and
  [`packages/runtime-client/backends/runtime-processor.ts`](../../packages/runtime-client/backends/runtime-processor.ts)
  for URL-backed page creation without origin stamping;
- [`packages/piece/src/ops/pieces-controller.ts`](../../packages/piece/src/ops/pieces-controller.ts)
  for system-root origin stamping and pre-start reconciliation;
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
  Presenting the mismatch as a warning before an explicit manual override is
  still required. The identity-only guard is a foundation, but it cannot
  protect an origin-only transition whose source identity stays unchanged.
- Fabric reference parsing and resolution support content-addressed pattern
  references, explicit pins, and same-toolshed mutable references by stable
  entity or slug. Static imports pin mutable references into source.
- System space roots carry a `patternSource` URL path when created through
  `ensureDefaultPattern`. Roots can check that source and replace
  `patternIdentity` before starting. Other successfully instantiated
  same-toolshed system-source patterns are checked in the background. This is a
  transitional implementation and migration input, not a target lifecycle
  exception.
- Storage supports late registration of a space-to-host hint before that space
  opens. The runtime processor hydrates durable hints from the home-space site
  table. A seeded route can only be confirmed. An opened space accepts only its
  previously registered matching hint. Before a space opens, however, a new
  late hint currently replaces the previous one. Piece-origin operations do
  not yet use this machinery.
- Tooling exposes the immutable source ref, optional repository locator,
  authored entry path, and optional current `patternSource` origin separately.

## Work required

1. Define a discriminated origin schema for external web URLs, stable mutable
   fabric-entity URLs, and immutable fabric URLs created by a direct pattern
   identity or a pin on an entity FID. Add a source-state schema with a stable
   revision head. Define immutable revision records and
   `cf/authored-program-manifest/v1`. Each manifest binds the canonical main and
   exact filename-to-source-identity set, including authored `.d.ts` files. It
   retains every transitive pinned fabric dependency once. Add a complete
   program enumeration path before import-closure resolution. Revisions also
   record the accepted runtime fingerprint,
   runtime-neutral program digest, separate operation and cause fields, and the
   compatibility descriptors needed without executing an old pattern. Replace
   the unused lineage declarations or remove them rather than treating dead
   declarations as a shipped feature. Implement the authoritative version-1
   executable runtime fingerprint and runtime-neutral program digest defined in
   [module-loading.md](module-loading.md). Treat an unavailable production
   fingerprint as an error rather than publishing under the legacy empty value.
2. Provide one atomic source-transition API used by every caller. It must wait
   for failure-propagating closure persistence and compare the expected
   revision head, current pattern, and active origin. Mutable-origin activation
   and reconciliation must guard every revision head and active origin traversed
   during cycle detection. A path that cannot validate the complete read set
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
   then open the origin space. Fail a conflicting seeded route or previously
   accepted late hint, including before the first open. Once the space opens,
   fail any hint that was not already registered and matching. Do not create a
   secondary session. Keep the supplied canonical URL in history. Do not make
   shortlink retention part of the lifecycle contract until the open provenance
   question is settled. Any later alias provenance must remain separate from
   active origins and repoint targets. Keep `patternRepository` separate and
   clear it when newly generated or directly edited code no longer belongs to
   that repository.
4. Add origin reconciliation to the ordinary piece start path. Add an
   event-driven subscription while an unpinned mutable fabric origin is
   running. Observe its source revision rather than only its executable
   identity, so source-only changes propagate. Do not subscribe for a
   content-addressed or explicitly pinned fabric origin. Reuse content
   verification, schema compatibility, guarded source transitions, and the
   existing in-place pattern watcher. Treat a new runtime fingerprint as a new
   executable identity even when the runtime-neutral program digest is
   unchanged. Automatic transitions must reject a known structural
   incompatibility and preserve the last accepted lifecycle state. Use this same
   path for space roots and retire the specialized root reconciler after
   migration. Move the current home-root
   `defaultAppUrl` into durable space-creation configuration outside any root
   piece. Space creation must
   resolve that configured default through the ordinary create transition and
   then link the resulting piece as the root. Creating or relinking that link
   must validate the runtime's root-interface contract.
5. Build the central source URL service. Apply the network policy and explicit
   ongoing-code consent to mutable web origins. Apply fabric authorization,
   content verification, pin handling, durable routing, and provenance checks
   to fabric origins. Store the required export selector and keep credentials
   in separately protected capabilities.
6. Add command-line URL creation and explicit detach, detach-and-rebuild,
   follow, revert, and repoint operations. Add matching UI affordances,
   including the LLM-backed create and edit flows. Before a manual source
   replacement, show structural compatibility findings and require explicit
   confirmation or a command-line flag to continue. An accepted incompatible
   replacement must detach. Root role validation remains mandatory after an
   override.
7. Expose revision history and origin-check failures through runtime-client
   protocol types and shell views. Distinguish runtime rebuilds from authored
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
9. Add CI golden replays that carry representative durable state from each
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
   route conflicts after a target opens, space-root creation from a default,
   changes to a default after root creation, tracked and detached root baseline
   migration, source-less legacy roots, relative-path normalization,
   root-interface rejection, runtime-fingerprint rebuilds, authorized upstream
   rebuild propagation, follower propagation of an enumerated unreachable-file
   edit with an unchanged executable identity, an authored `.d.ts` edit that
   changes importer identity and compiled bytes, blocked incompatible
   immutable-origin repoint, cross-runtime revert under a new executable
   identity, detach-and-rebuild recovery from an incompatible first
   immutable-origin revision, two source-only revisions that share an entry
   identity but restore different unreachable files, and a nested pinned fabric
   dependency restored after incidental source roots disappear. Tests must prove
   the current source, active origin, revision head, authored-program manifest,
   recursively retained dependency graph, and revision log after each operation.

## Relationship to pattern imports

Pattern imports and piece origins intentionally have different update rules.
An unpinned mutable `cf:` import is resolved and written back with an immutable
pin when source is deployed. The deployed importer does not track later
changes. The same fabric URL used as piece-origin metadata stays live when it
is unpinned and resolves to a mutable `patternIdentity`-bearing entity. The
piece can then follow that entity's current pattern. A fabric origin that
resolves to `pattern:<identity>`, or that was supplied as an entity-FID URL with
a trailing pin, is immutable and has no later update to discover.

Piece-origin metadata remains outside authored source. Mutable web and fabric
entity origins are checked when that piece loads. A content-addressed or pinned
fabric origin is verified when loaded but always resolves to the same exact
source.

This separation keeps a pattern's module identity deterministic while allowing
a stateful piece to adopt a new, separately content-addressed pattern through
an explicit tracking relationship.
