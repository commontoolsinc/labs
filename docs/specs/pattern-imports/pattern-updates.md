# System-source pattern updates — rolling running pieces forward

How the currently implemented, specialized updater moves pieces backed by a
same-toolshed **system source** from one pattern version to another. This
includes home, default-app, and other successfully instantiated system-source
patterns. The general lifecycle for ordinary pieces, including external
`https://` origins, fabric `cf://` origins, following another piece, source
history, revert, and repoint, is specified in
[`../piece-source-lifecycle.md`](../piece-source-lifecycle.md).
The specialized root path is transitional. In the target model, a space root
uses the same source lifecycle as every other piece.

This document is also a companion to `README.md`, which covers static `cf:`
imports and publication through naming and placement. Static imports remain
pinned and do not adopt the live update behavior specified for piece origins.

## Status

The `systemPatternAutoUpdate` flag is on in the shell. Persisted system roots,
home included, reconcile before bootstrap; every other successfully instantiated
pattern checks its verified authored entry path in the background. A same-origin
source becomes tracked only when its `?identity` route works. The downloaded
source and import closure must compile to the advertised entry identity before
the persisted pointer can change, so startup never waits for an ordinary-piece
check and failed checks leave its already-running graph intact.

URL-based root creation and recreation stamp update provenance; a
pre-provenance root can recover it only under the stricter root admission policy,
and an unloadable tracked root is repaired before bootstrap through the same
`?identity`-driven update path. The executed root milestone map and corrections
found during implementation are archived at
[`docs/history/specs/pattern-imports/system-pattern-updates-implementation-plan.md`](../../history/specs/pattern-imports/system-pattern-updates-implementation-plan.md).
The home root rides the shipped root machinery since the second flag's removal;
general piece origins and source history remain design. When that work lands,
new roots use the ordinary piece creation transition and existing roots migrate
into the same active-origin and revision model.

## Last Updated

2026-07-22

## Motivation

- **System patterns must self-heal and roll forward.** `home.tsx` /
  `default-app.tsx` are the most critical patterns to keep current. Existing
  roots are resolved without starting, reconciled against their tracked system
  source, and only then bootstrapped. The manual `recreateDefaultPattern`
  (shell Debugger button / CLI) remains a state-losing escape hatch: it mints a
  new piece and relinks it. URL-based recreation stamps the new root's source so
  the replacement remains eligible for future automatic repair.
- **The rest of the system source tree must move too.** A non-root pattern may
  have been compiled from any file served by the toolshed pattern route. Once
  its current graph is instantiated, the runtime checks that source in the
  background and lets the existing pattern watcher apply a verified move. The
  current instantiation never waits for network or compilation.
- **Two hazard cases to handle explicitly.** (1) We shipped a broken system
  pattern — once a fix ships, recovery must be automatic. (2) A
  schema-incompatible update slips through — the damage must be *bounded*
  (fast rollback), because the schema-valid-but-semantically-wrong case is not
  reliably detectable.
- **A reusable mechanism.** The existing "resolve a source pointer to a current
  identity, then swap in place" loop is a foundation for general piece origins.
  Roots and other pieces need the same history, detach, compatibility,
  authorization, and concurrency guarantees before they can share one path.

## Non-goals (this doc / v1)

- **General piece origins and source history.** This specialized updater does
  not provide the ordinary lifecycle that roots will eventually use. Web URL
  origins, fabric URLs that name pieces or content-addressed patterns, detach,
  fork, revert, and repoint are specified in
  [`../piece-source-lifecycle.md`](../piece-source-lifecycle.md).
- **Lineage / fork detection.** No substrate exists today — `parents` was
  deleted with the pattern-id retirement, and `pieceLineageSchema`
  (`packages/runner/src/schemas.ts`) is dead code, referenced nowhere.
  Deferred; automatic system-source updates continue to track one exact source
  path and do not attempt to infer user fork relationships.
- **CFC provenance of fetched source.** Pattern source can carry private data;
  labeling fetched/replicated source is follow-up work (README § Security),
  not built here.
- **Cross-host published refs + persisted space→host discovery.** v1 system
  updates only ever read a space's *own* toolshed.
- **Semver / version ranges.** An update tracks a mutable pointer's *current
  identity*, never a version string.

## Background: what exists today

| Mechanism | Where | Role here |
|---|---|---|
| Pattern pointer `patternIdentity = {identity, symbol}` on the piece result cell | `runner.ts` (`applySetupState` / `getPatternIdentityRef`) | The thing an update rewrites |
| **In-place re-run watcher** — `setupPatternWatcher` sinks the `patternIdentity` meta; on change it cancels the old pattern's nodes and re-instantiates the new pattern **onto the same result cell** | `runner.ts` (enabled unless `doNotUpdateOnPatternChange`) | Applies a metadata swap when the piece is already running; at space open, bootstrap reads the reconciled metadata directly |
| `PatternUpdater` | `packages/runner/src/pattern-updater.ts` | Shared identity lookup, verified closure compile, provenance repair, and compare-and-swap for awaited roots and background ordinary-piece checks |
| Space root: `spaceCell.defaultPattern` link → root piece → `patternIdentity` | `packages/piece/src/manager.ts` (`linkDefaultPattern`/`getDefaultPattern`) | What a system update rewrites |
| `ensureDefaultPattern` (resolve → reconcile → start) / `recreateDefaultPattern` (manual, **not** state-preserving) | `packages/piece/src/ops/pieces-controller.ts` | The automatic self-heal hook (ensure) and the state-losing escape hatch (recreate); both URL-based creation paths stamp `patternSource` |
| System patterns = **raw TSX served by path**, bundled via `deno compile --include`; **no name→identity manifest** | `packages/toolshed/routes/patterns/patterns-server.ts`, `patterns.routes.ts` | Where the current system source + its identity come from |
| Per-space host resolution: `mappedHostFor(space)` / `registerSpaceHost` (3-tier: seed `spaceHostMap` → learned site-table → default) | `runtime.ts:1423` / `:1444`, `storage/v2-remote-session.ts` | Which toolshed a space's source is fetched from |
| Identity computation: `transformInjectHelperModule` + `computeModuleIdentities` | `harness/pretransform.ts`, `sandbox/module-record-compiler.ts` | What toolshed runs to answer `?identity` |
| Entry-doc `annotations` + `annotatePattern` | `pattern-manager.ts`, `cell-cache.ts` | **Rejected as the carrier** — see below |

**Why not the source-doc `annotations` field.** It exists (`annotatePattern`,
non-hashed, excluded from `verifySourceDocs`) and looks like a natural home for
"where updates live" — but it is **space-local**: `writeSourceDocs` preserves
the *destination* cell's annotations, and replication does not copy the
*source's* (`cell-cache.ts:475`). An `updatesAt` written in a publisher's space
would not appear on a consumer's replicated copy. The **piece** is the reliable
carrier: explicit source provenance travels with it. For an unstamped non-root
piece, its verified source-doc closure supplies the authored entry path; the
runtime persists that path on the piece only after the matching same-toolshed
`?identity` route succeeds.

## The implemented specialized model

Two decisions carry the whole design:

1. **Every updatable piece carries a `patternSource` provenance string** — the
   source it tracks for updates. (`patternSource`, *not* `source`: the latter
   is the doc-level producer annotation the server-primary work uses.) Roots
   stamp it at URL-based creation. An unstamped non-root may recover its verified
   authored entry filename and stamp it after that same-origin route proves it
   implements `?identity`.
2. **Update = resolve `patternSource` → current identity; if it differs from
   the persisted `patternIdentity.identity`, write the new `{identity, symbol}`
   to the piece's `patternIdentity` meta.** At space open this happens before
   root bootstrap, so `start()` loads the reconciled identity. Every other
   pattern starts first; its successful instantiation commit launches a
   fire-and-forget check, and the existing watcher re-instantiates a verified
   replacement in place. No new apply machinery.

A root created before provenance stamping may be admitted to this loop only
when its stored `{ identity, symbol }` exactly equals the advertised current
official entry appropriate to the space (`home.tsx` for Home,
`default-app.tsx` otherwise). The updater then back-fills `patternSource`.
Neither space type nor an author-controlled source filename is provenance: a
stale, custom, or repository-pinned sourceless root stays pinned.

One exception, covering every space's **default pattern** (the root the space
cell's `defaultPattern` ref names — never a non-root piece): a stale sourceless
root whose stored pattern the current runtime **explicitly cannot load** is
replaced with the official system root for the space kind (`home.tsx` for
Home, `default-app.tsx` otherwise). The 2026-07-21 estuary migration bricked
every pre-provenance home root — no explicit-migration tool can reach a
private home whose owner key lives only in a browser — and a loom vendor
update then hit the same wall on a non-home space root, so the exception
covers both (originally home-only; widened at the flag owner's direction).
The exception's semantics are deliberately narrow:

- Replacement is authorized only when the load probe resolves `undefined` —
  the artifact unavailable through every supported recovery path. A probe
  **exception** is a failed check, not evidence: the updater logs and stays
  pinned.
- The probe asks "loadable in the **current runtime**" (in-memory artifact
  index, live evaluated modules, then durable storage) — not "survives a cold
  restart". A warm artifact can only cause extra pinning, never extra
  replacement.
- Under `cfcEnforcementMode: "disabled"` the by-identity probe is unsupported
  (it returns `undefined` unconditionally), so the updater stays pinned there.
- The replaced root records the displaced `{ identity, symbol, displacedAt }`
  under `displacedPattern` meta. This is an audit/forensic pointer — the
  displaced program's compiled artifacts remain content-addressed in the
  space — not (yet) an automated restoration mechanism.

Default system roots run this loop before bootstrap. Every other pattern runs it
after successful instantiation, without delaying that instantiation. The
general lifecycle replaces this specialized path after its source-state and
history requirements are implemented.

This specialized implementation does not define different target semantics for
roots. Under the general lifecycle, every piece with an active origin,
including a space root, reconciles through the ordinary piece path.

### Legacy `patternSource` and planned migration

`patternSource` is currently a string meta on the piece result cell. For a space
root it is stored on the root piece. Once ordinary lifecycle storage is
available, this string is migration input only. It is dispatched by the `cf:`
prefix:

- **`cf:` fabric ref** (published) → resolve via the fabric chase
  (`fabric-ref-resolution.ts`: slug → piece → `patternIdentity`). A
  `cf:pattern:<hash>` ref is **frozen** (resolves to a constant → never
  updates); a bare slug **tracks**. Immutability is just a pinned ref.
- **non-`cf:` toolshed source path** (system, e.g.
  `/api/patterns/system/default-app.tsx`) → use `?identity` against the space's
  host, then fetch and compile whenever the persisted artifact needs an update
  or repair.

General source URL origins use the discriminated active-origin and revision
schemas defined by the piece source lifecycle spec. They do not permanently
overload this raw string with origin-kind-specific behavior.

Baseline migration preserves the current pattern independently from update
authority. It creates an active origin only when a durable tracking choice can
be established under the ordinary consent rule. Otherwise it keeps the legacy
locator only as inactive historical provenance and migrates the piece as
detached. Rollout flags are not durable per-piece consent.

Migration resolves a relative system path against the currently accepted
toolshed route for the space and stores the resulting absolute web URL. If no
accepted host can be established, migration does not invent an active origin.
A later host remapping does not rewrite the stored URL; that requires an
ordinary repoint.

A source-less legacy root does not gain an origin merely because it is a root.
The specialized updater can derive an official candidate path, but ordinary
migration keeps the root detached unless a durable tracking choice explicitly
supplies and authorizes an origin.

**Born-from determinism.** The system chooses a root's initial source when it
creates the space. In the target model, it passes that source through the same
creation transition used for any other piece. The current implementation
instead seeds a non-home root's raw `patternSource` from the home root's
`defaultAppUrl`. Editing that template later does not change an existing root.
Changing that root's source is an ordinary repoint, edit, revert, or other
lifecycle operation.

Today `defaultAppUrl` is output state on the home root. That is not a durable
home for creation configuration once the home root can be repointed or
relinked like any other piece. Root lifecycle unification moves the value into
space-creation configuration outside any root piece. It is never origin state
for an existing root.

### Grammar extension: host as a hint

`README.md`'s grammar gains the host authority as a **resolvable hint**, not
new per-ref storage:

```
cf:[[//toolshed.url]/space/][slug]
```

- The `//toolshed.url` host means *"this space lived at this URL at least at
  some point"* — a bootstrap hint for when the runtime does not already know
  where a space is hosted (we have not built host-discovery-without-hints yet;
  this is a first step toward it).
- **On ingest**, a host-bearing ref is normalized: extract the host →
  `runtime.registerSpaceHost(space, host)` (feeds the learned site-table) →
  store the **canonical host-less form** `cf:/<space-did>/<slug>`. The host is
  routing, not identity; it is never smeared across every provenance ref.
- Host **hints belong to the space**, not to each cross-space link — a
  per-space host-hint store is the right long-term home (and the seed of
  host-discovery). Deferred; v1 needs none.
- **Optional slug**: `cf://toolshed/space/` (no slug) = *that space's root
  pattern* (resolve via the space cell's `defaultPattern` → its
  `patternIdentity`). This is how a template like `defaultAppUrl` says "point
  at another space and track whatever it runs as its root."
- Space is a **DID** (names still require name→DID resolution — README open
  question).

## In-place apply

The apply is: ensure the new closure is loadable in the space
(`compilePattern(program, { space })` writes source + compiled docs), then
write `{ identity, symbol }` to the piece's `patternIdentity` meta. During space
open, `ensureDefaultPattern` performs this write before calling `startPiece`,
so an obsolete pattern that cannot load can be replaced before bootstrap. If
the piece is already running, the
watcher cancels its old reactive nodes and re-instantiates the new pattern onto
the **same result cell**.

- **Survives**: the result cell's entity and inbound links. State remains
  reachable when the new pattern reads it through the same stable keys and
  causes.
- **Can become unreachable**: data under keys the new pattern drops or
  renames. This continuity is a semantic contract. CI and golden replay tests
  must exercise representative prior state and verify that the proposed source
  still reads and preserves it. The deployment runtime does not try to infer
  stable-key or stable-cause compatibility.

The specialized system-source updater does not perform the complete pre-apply
structural comparison specified for the general piece lifecycle. Automatic
origin updates in that lifecycle reject known argument, result, or
retained-input incompatibilities and keep the last accepted source. A manual
source replacement reports a known incompatibility as a warning and can proceed
only after explicit acceptance. Neither structural check proves semantic state
continuity. The root-interface contract remains mandatory in both cases. See
the [`Compatibility policy`](../piece-source-lifecycle.md#compatibility-policy).

## System-source patterns — the loop

**Toolshed side (memoized per file for the process lifetime; patterns are fixed
for a toolshed's lifetime).** Add a `?identity` query param to the pattern route
(`patterns.routes.ts`). For a requested file: walk its authored import closure
via single-file reads (works in a compiled binary — no directory enumeration) →
hash the **pristine** authored bytes → return the entry identity. **No
type-check, no emit** — the light computation (`resolveEntryIdentity` in the
runner). The worker independently checks the result by compiling the downloaded
closure and comparing its compiler-produced entry identity.

Two implementation facts make the light identity equal what the worker stores as
`patternIdentity`, verified by a parity test against the real `default-app.tsx`
and `home.tsx`:

- **Hash pristine, not injected.** The engine restores each module's original
  pre-injection bytes (`pristineModuleSources`) before hashing, so the light
  path must hash the authored source, not the helper-injected pretransform
  output. Hashing the injected form silently diverges.
- **Name modules by their URL pathname.** A module's identity folds in its
  authored path (`computeModuleHashes`). The worker compiles system patterns
  over HTTP, where `HttpProgramResolver` names every module by its URL pathname
  (`/api/patterns/…`). The toolshed therefore computes `?identity` over
  pathname-prefixed names — **not** patterns-root-relative names — or the two
  identities never match and the check re-updates forever.

Both the `?identity` representation and every source-module representation use
strong checksum `ETag`s with `Cache-Control: public, no-cache`. The identity
itself is the `?identity` validator; a source module's validator is the SHA-256
of its exact response bytes. Clients therefore retain unchanged bytes but must
conditionally revalidate them before every update attempt.

**Runtime side (at space open, in the per-space worker).** Resolve the persisted
root with `runIt=false`, run this loop, re-resolve the cell after any metadata
transaction, and only then start it:

1. `url` = the root piece's stored `patternSource`. If it is absent, derive the
   official candidate URL for the space, but do not treat that path as
   provenance. A root with explicit repository provenance remains pinned.
   `host` = `mappedHostFor(space) ?? apiUrl`. Only same-origin toolshed sources
   participate in this v1 loop.
2. `currentId` = a revalidating `GET {host}{url}?identity` for this attempt
   (`fetch` cache mode `no-cache`). A matching `ETag` may reuse the cached body
   after a `304`; the browser may not replay it without validation. An HTTP
   failure, empty response, or exception performs no metadata write; the
   subsequent root start retains its normal loud failure.
3. If `patternSource` is absent, admit the root only when its stored ref is
   exactly `{ identity: currentId, symbol: "default" }`; otherwise leave it
   pinned.
4. If `currentId === running patternIdentity.identity`, probe that exact stored
   artifact. A successful load is done (and may back-fill proven provenance).
   A missing or unloadable artifact continues to repair rather than taking the
   fast path.
5. Revalidate `{host}{url}` and every module in its complete authored import
   closure with the same `no-cache` fetch policy, then compile with
   the route's official `default` export. Apply only when the compiler supplies
   an entry ref whose identity exactly equals `currentId` and whose symbol is
   `default`; never synthesize a ref or fall back around `?identity`. A fetch,
   compile, evaluation,
   missing-entry-ref, or identity-mismatch failure leaves the root metadata
   unchanged.
6. Provenance repair and identity replacement are transactional
   compare-and-swap writes: the captured identity, source, and repository must
   still match on every retry, so a concurrent custom-root replacement wins.
7. Start the reconciled root. A newly created root skips the check because it
   was compiled from the current source in the same ensure operation; a root
   discovered after a creation race is treated as persisted and reconciled.

**Runtime side (ordinary pattern instantiation).** The runner registers the
check on the instantiation transaction's successful commit callback. It never
awaits the check from `start()`:

1. Exclude the space's `defaultPattern`; that root has already taken the path
   above. Also exclude starts with `doNotUpdateOnPatternChange`, because they
   deliberately install no watcher that could apply a pointer change.
2. Use the piece's stored `patternSource` when present. Otherwise skip a
   repository-pinned piece, recover the current identity's verified source-doc
   closure, and take its entry filename as the candidate URL.
3. Ask that same-origin URL for `?identity`. A missing/failing route means the
   candidate was not a system source: do nothing and do not stamp provenance.
   If the advertised identity equals the running identity, transactionally
   stamp the proven source (when it was inferred) and stop.
4. On a changed identity, revalidate and compile the whole closure with the
   running ref's export symbol. Require both the compiler-produced identity and
   symbol to equal the advertised identity and existing symbol.
5. Compare-and-swap `{ patternIdentity, patternSource, patternRepository }`.
   A concurrent setsrc/custom replacement wins. A successful swap wakes the
   already-installed watcher; fetch, compile, evaluation, mismatch, and commit
   failures leave the current graph running.

## End-to-end identity check

The safety condition is about the content used for this attempt, not the git
revision reported by either process. The toolshed advertises an authored-closure
identity through `?identity`; the worker then downloads the entry and every
import, compiles them locally, and accepts only the compiler-produced entry ref
with that exact identity.

This also fails closed across a rolling deployment. If `?identity`, the entry
source, or any import comes from a different revision, the assembled closure
normally hashes to a different entry identity and the pattern pointer is not
written. The same rule covers an identity-algorithm incompatibility between an
older worker and a newer toolshed: disagreement prevents the update. No
`/api/meta` request, git-SHA comparison, pattern response build header, or
worker-to-shell version-skew signal is part of the authorization path.

Authored identity deliberately does not fingerprint bare runtime imports or the
runtime's implementation. Local compilation and evaluation are a capability
check: a closure that needs an unavailable API, cannot be transformed, or does
not reproduce `currentId` leaves the root unchanged. They are not proof that two
API-compatible runtime builds assign identical semantics to the same closure;
that residual is bounded by system-pattern golden replay and fast redeploy, as
with other schema-valid but semantically wrong updates.

`COMMIT_SHA` remains build metadata only. A source-run toolshed may use it as
the fallback `gitSha` returned by `/api/meta`, matching the field a compiled
binary populates from baked build metadata; the updater does not consult it.

## Detecting and bounding bad updates

- **CI golden replay** against the short, controlled system list before
  shipping — the primary defense (feasible precisely because the list is short
  and we own the source). Synthetic home-shaped and default-app-shaped replays
  prove that the update mechanism preserves representative stable-key state.
  Broader release coverage still needs fixtures for each supported
  version-to-version transition.
- **Self-heal from a borked ship**: fix source → new identity → a root's next
  space open compiles and swaps it before bootstrap; an ordinary pattern's next
  instantiation starts its current graph and then rolls it forward in place.
- **Rollback = redeploy**: ship the prior source → toolshed serves the prior
  identity → the same swap rolls back. No per-piece rollback state needed.
- **Escape hatch**: manual `recreateDefaultPattern` remains (state-losing; last
  resort).
- **Residual**: schema-valid-but-semantically-wrong is not reliably detectable;
  it is *bounded* by fast rollback + golden replay, not gated on.

## Build sketch (seams)

- **Toolshed**: `?identity` handler + boot-time `{ name → identity }` cache in
  the patterns route (`patterns.routes.ts` / `patterns.handlers.ts` /
  `patterns-server.ts`); strong checksum `ETag` + mandatory revalidation for
  identity and source responses; import `computeModuleIdentities` +
  `transformInjectHelperModule` from the runner.
- **Runtime worker**: `PatternUpdater` owns per-space host resolution,
  conditionally revalidated `?identity` and source-closure fetches, locally
  compiled source-closure verification, and compare-and-swap. The piece
  controller awaits it before root bootstrap; `Runner.startCore` schedules it
  from the successful instantiation commit for every other watched pattern.
- **Piece**: `patternSource` meta getter/setter; stamped by URL-based creation
  and recreation from the applicable source (system path, or a `cf:` ref derived
  from `defaultAppUrl`). Custom `RuntimeProgram` recreation remains unstamped;
  its optional repository locator is separate provenance.
- **Home root and creation configuration**: `defaultAppUrl` currently lives on
  the home root. Root lifecycle unification moves it into durable
  space-creation configuration outside any root piece. A per-space host-hint
  store is a later addition.
- **Grammar/resolver**: implement `cf://host/...` (register-on-ingest; today
  it throws "M3 not yet supported"); slug-optional = space root.

## Phasing

1. **Default (non-home) space root, always-update.** Least risky —
   `default-app.tsx` carries little durable state. `patternSource` field +
   in-place swap + toolshed `?identity` + local compiled-identity check.
2. **Home root.** Carries real user data (favorites/journal/spaces). A
   representative golden replay enabled its rollout with the other system
   roots. Broader version-to-version CI coverage remains release discipline,
   not a deployment-time semantic check.
3. **Other system-source patterns.** Recover a non-root's verified authored
   entry path at instantiation, recognize a system source by its same-toolshed
   `?identity` route, and check it without delaying the current graph.
4. **General piece source lifecycle.** Create every new space root through the
   ordinary piece source transition using the system-selected default. Move the
   home root's `defaultAppUrl` into creation configuration outside any root.
   Migrate existing roots into baseline revisions without treating
   `patternSource`, rollout flags, or the root role as consent to future
   updates. Reconcile external web URLs and fabric URLs before the ordinary
   start of any piece, including a root. Add atomic revision history, detach,
   fork, revert, and repoint semantics as specified in
   [`../piece-source-lifecycle.md`](../piece-source-lifecycle.md). Retire the
   specialized root lifecycle path after migration. Validate the root-interface
   contract whenever `defaultPattern` is created or relinked.
5. **Cross-host origins.** Persist accepted space-to-host hints and enforce CFC
   provenance labels on fetched source.

## Resolved questions

1. **System-pattern identity query.** Keep the implemented `GET …?identity`
   application protocol. It returns the identity of the complete authored
   pattern closure, so neither a raw source-file `ETag` nor a `HEAD` request can
   replace it. Strong `ETag`s and conditional revalidation apply independently
   to each HTTP representation and complement the closure identity.
2. **Space-root lifecycle and migration.** A space root is an ordinary piece.
   The system chooses its initial source when creating the space and uses the
   same source-creation transition as every other piece. The configured default
   affects only future roots. Existing roots migrate into the ordinary revision
   and active-origin model. Migration does not infer tracking consent from a raw
   `patternSource`, a rollout flag, or the root role. After creation or
   migration, update, detach, follow, fork, revert, and repoint use the ordinary
   piece rules. Assigning the root role separately requires root-interface
   compatibility.
3. **Home-data stable addressing.** `home-golden-replay.test.ts` pins
   representative favorites, journal, and spaces state across an in-place
   update. That evidence allowed the home root to use the same updater as other
   system roots. Future supported source transitions need CI fixtures using
   representative prior state.
4. **Compatibility checks and deployment boundary.** Publishing or uploading
   pattern source does not compare it with an existing piece. A manual
   replacement compares argument, result, and retained-input schemas, warns on
   a known incompatibility, and requires explicit acceptance to continue. An
   automatic origin update blocks the same known structural incompatibility
   because no user is present to accept it. The root-interface contract remains
   mandatory. Stable keys, stable causes, intended migration, and behavior are
   verified by CI audits and golden replays. The runtime does not try to infer
   those semantic contracts during deployment.
