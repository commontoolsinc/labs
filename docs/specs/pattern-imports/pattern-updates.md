# Pattern Updates — rolling a running piece forward

How a running piece moves from the pattern version it was created with to a
newer one — automatically for **system patterns** (home, default-app), and (a
later phase) on demand for **published** patterns. Companion to `README.md`
(which covers `cf:` imports and publishing-as-naming); this doc covers the
*update propagation* side.

## Status

Phase 1 shipped: the `systemPatternAutoUpdate` flag is on in the shell for
non-home default-app roots (`systemPatternAutoUpdateHome` stays off pending the
home.tsx stable-addressing audit). URL-based creation and recreation stamp
update provenance; verified legacy system roots can recover missing provenance;
and an unloadable tracked root is repaired by compiling its source directly,
even when build metadata is unavailable. The executed milestone map and the
corrections found during implementation are archived at
[`docs/history/specs/pattern-imports/system-pattern-updates-implementation-plan.md`](../../history/specs/pattern-imports/system-pattern-updates-implementation-plan.md).
Home root and published-pattern updates remain design (Phases 2–4).

## Last Updated

2026-07-21

## Motivation

- **System patterns must self-heal and roll forward.** `home.tsx` /
  `default-app.tsx` are the most critical patterns to keep current. Existing
  roots are resolved without starting, reconciled against their tracked system
  source, and only then bootstrapped. The manual `recreateDefaultPattern`
  (shell Debugger button / CLI) remains a state-losing escape hatch: it mints a
  new piece and relinks it. URL-based recreation stamps the new root's source so
  the replacement remains eligible for future automatic repair.
- **Two hazard cases to handle explicitly.** (1) We shipped a broken system
  pattern — once a fix ships, recovery must be automatic. (2) An
  schema-incompatible update slips through — the damage must be *bounded*
  (fast rollback), because the schema-valid-but-semantically-wrong case is not
  reliably detectable.
- **One mechanism, two audiences.** The same "resolve a source pointer to a
  current identity, swap in place" loop serves system patterns (auto) now and
  published patterns (on click) later; they differ only in the resolver.

## Non-goals (this doc / v1)

- **Published-pattern update UX** (a shell "update available" affordance) —
  designed-*for* here, implemented later (§ Phasing).
- **Lineage / fork detection.** No substrate exists today — `parents` was
  deleted with the pattern-id retirement, and `pieceLineageSchema`
  (`packages/runner/src/schemas.ts`) is dead code, referenced nowhere.
  Deferred; system roots aren't user-iterated in the common case.
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
| Pattern pointer `patternIdentity = {identity, symbol}` on the piece result cell | write `runner.ts:1012`, read `getPatternIdentityRef` `runner.ts:4441` | The thing an update rewrites |
| **In-place re-run watcher** — `setupPatternWatcher` sinks the `patternIdentity` meta; on change it cancels the old pattern's nodes and re-instantiates the new pattern **onto the same result cell** | `runner.ts:1246` (enabled unless `doNotUpdateOnPatternChange`, `runner.ts:1341`) | Applies a metadata swap when the piece is already running; at space open, bootstrap reads the reconciled metadata directly |
| Space root: `spaceCell.defaultPattern` link → root piece → `patternIdentity` | `packages/piece/src/manager.ts` (`linkDefaultPattern`/`getDefaultPattern`) | What a system update rewrites |
| `ensureDefaultPattern` (resolve → reconcile → start) / `recreateDefaultPattern` (manual, **not** state-preserving) | `packages/piece/src/ops/pieces-controller.ts` | The automatic self-heal hook (ensure) and the state-losing escape hatch (recreate); both URL-based creation paths stamp `patternSource` |
| System patterns = **raw TSX served by path**, bundled via `deno compile --include`; **no name→identity manifest** | `packages/toolshed/routes/patterns/patterns-server.ts`, `patterns.routes.ts` | Where the current system source + its identity come from |
| Per-space host resolution: `mappedHostFor(space)` / `registerSpaceHost` (3-tier: seed `spaceHostMap` → learned site-table → default) | `runtime.ts:1423` / `:1444`, `storage/v2-remote-session.ts` | Which toolshed a space's source is fetched from |
| Build identity: `/api/meta` → `{ did, gitSha }` | `packages/toolshed/routes/meta/` | The version-skew signal |
| Identity computation: `transformInjectHelperModule` + `computeModuleIdentities` | `harness/pretransform.ts`, `sandbox/module-record-compiler.ts` | What toolshed runs to answer `?identity` |
| Entry-doc `annotations` + `annotatePattern` | `pattern-manager.ts`, `cell-cache.ts` | **Rejected as the carrier** — see below |

**Why not the source-doc `annotations` field.** It exists (`annotatePattern`,
non-hashed, excluded from `verifySourceDocs`) and looks like a natural home for
"where updates live" — but it is **space-local**: `writeSourceDocs` preserves
the *destination* cell's annotations, and replication does not copy the
*source's* (`cell-cache.ts:475`). An `updatesAt` written in a publisher's space
would not appear on a consumer's replicated copy. The **piece** is the reliable
carrier: it is created in the consumer's space with the ref the creator chose,
so it travels by construction.

## The model

Two decisions carry the whole design:

1. **Every updatable piece carries a `patternSource` provenance string** — the
   source it tracks for updates. (`patternSource`, *not* `source`: the latter
   is the doc-level producer annotation the server-primary work uses.)
2. **Update = resolve `patternSource` → current identity; if it differs from
   the persisted `patternIdentity.identity`, write the new `{identity, symbol}`
   to the piece's `patternIdentity` meta.** At space open this happens before
   root bootstrap, so `start()` loads the reconciled identity. For an already
   running root, the existing watcher (`runner.ts:1246`) re-instantiates in
   place. No new apply machinery.

A root created before provenance stamping may be admitted to this loop only
when the verified, content-addressed source closure for its stored identity
names the exact official system entry appropriate to the space (`home.tsx` for
Home, `default-app.tsx` otherwise). The updater then back-fills
`patternSource`. Space type alone is not provenance: an unverified or custom
sourceless root stays pinned.

System patterns run this loop automatically at space open (always-update);
published patterns will run it behind an explicit user action (§ Phasing).

### `patternSource`: one field, two variants

A string meta on the piece result cell (space root: on the root piece).
Dispatched by the `cf:` prefix:

- **`cf:` fabric ref** (published) → resolve via the fabric chase
  (`fabric-ref-resolution.ts`: slug → piece → `patternIdentity`). A
  `cf:pattern:<hash>` ref is **frozen** (resolves to a constant → never
  updates); a bare slug **tracks**. Immutability is just a pinned ref.
- **non-`cf:` toolshed source path** (system, e.g.
  `/api/patterns/system/default-app.tsx`) → for a loadable root, resolve via
  `?identity` against the space's host; for an unloadable root, fetch and compile
  the source directly under the current runtime (below).

**Born-from determinism.** The *string* is frozen at birth (which source); the
*resolved identity* is live (which version). A non-home space's root
`patternSource` is seeded at creation from home's `defaultAppUrl`, then frozen —
so editing `defaultAppUrl` later does **not** silently migrate existing spaces
(pushing a new default app to them is an explicit re-point).

`defaultAppUrl` (on the space cell) is thus the **template** that seeds new
spaces' root `patternSource`; it is distinct from the per-piece frozen
`patternSource`, and it itself migrates to a `cf:` ref under the grammar below.

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
so an obsolete pattern that cannot load never blocks its replacement. If the
piece is already running, the watcher cancels its old reactive nodes and
re-instantiates the new pattern onto the **same result cell**.

- **Survives**: the result cell's entity and inbound links; any state cells the
  new pattern still reads (addressed by stable key/cause).
- **Does not survive**: data under keys the new pattern drops or renames — the
  **schema-compat crux**, and the boundary between the two hazard cases
  ("missing data" vs "stuck/wrong"). The mitigating discipline is an authoring
  one: durable state addressed by stable key/cause, not positionally. We do
  **not** gate on a pre-apply schema dry-run in v1.

## System patterns v1 — the loop

**Toolshed side (memoized per file for the process lifetime; patterns are fixed
for a toolshed's lifetime).** Add a `?identity` query param to the pattern route
(`patterns.routes.ts`). For a requested file: walk its authored import closure
via single-file reads (works in a compiled binary — no directory enumeration) →
hash the **pristine** authored bytes → return the entry identity. **No
type-check, no emit** — the light computation (`resolveEntryIdentity` in the
runner); exact **within a build version** (all we ever compare within — see the
gate).

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

**Runtime side (at space open, in the per-space worker).** Resolve the persisted
root with `runIt=false`, run this loop, re-resolve the cell after any metadata
transaction, and only then start it:

1. `url` = the root piece's stored `patternSource`. If it is absent, recover it
   only from a verified source closure whose exact entry path identifies the
   official system root appropriate to this space; otherwise leave the root
   pinned. `host` = `mappedHostFor(space) ?? apiUrl`. Only same-origin toolshed
   sources participate in this v1 loop.
2. Probe whether the stored `patternIdentity` can load in the current runtime
   (for example, aged source may import a runtime API removed by the new build).
3. **Broken-root repair.** If it cannot load (including a thrown cold-load
   failure), fetch and compile `{host}{url}` directly. The compiler-produced
   entry ref is authoritative: write it in place if it differs and back-fill
   verified legacy provenance. This path deliberately uses neither the build
   gate nor `?identity`. Fetch or compile failure performs no metadata write;
   the subsequent root start retains its normal loud failure.
4. **Healthy-root version gate** (§ below). Not the same known build → skip;
   signal the shell only on a proven mismatch (both shas known).
5. `currentId` = **cached** `GET {host}{url}?identity` (cache keyed by
   `(host, url)`; cleared on socket reset — the identity is fixed for the
   toolshed's lifetime, and a socket reset is the proxy for "maybe a restarted
   or different toolshed"). Steady state is an in-memory compare, no request.
6. `currentId === running patternIdentity.identity` → done (after stamping
   provenance if this is a verified legacy root).
7. Else fetch `{host}{url}` source, `compilePattern(program, { space })`, and
   write the compiler-produced `{ identity, symbol }` entry ref.
8. Start the reconciled root. A newly created root skips the check because it
   was compiled from the current source in the same ensure operation; a root
   discovered after a creation race is treated as persisted and reconciled.

## Version-skew gate

For a healthy, loadable root, the light `?identity` is only comparable to the
worker's identity when
**toolshed and worker are the same build** (then `computeModuleIdentities` is
literally the same function). So gate on it:

- Compare the client's `gitSha` to the space's toolshed `gitSha` (`/api/meta`,
  cached per host).
- **Match** → direct compare against the running `patternIdentity` is valid;
  **no sidecar id is stored.**
- **Proven mismatch** (both shas known, different) → touch nothing; emit an
  IPC signal to the shell
  (`versionSkew: { space, clientVersion, toolshedVersion }`). The shell
  visualizes it and may restart/reload the worker to pick up a matching client
  build (a page reload / cache-bust is what actually swaps the client bundle;
  the shell owns that UX).
- **Unknown build on either side** (dev/source servers carry no sha) → skip the
  healthy-root update **silently** (`skipped-unknown-build`). Nothing is
  provably newer, so there is nothing to tell the user — signalling here would
  raise the reload banner on every space open in local dev, where no reload
  helps.

**The gate is exactly what makes the light `?identity` sound, not a precondition
for repairing a broken root.** An unloadable root cannot continue as-is, so its
already-proven source is compiled under the current runtime and that compiler's
entry ref is installed. This works for CLI/daemon and source-run toolsheds that
carry no build SHA, while preserving the no-cross-build-compare rule.

For healthy roots, the only failure mode of the light computation is
cross-build drift, and we now never compare across builds. Multi-toolshed makes
the gate **per-space** (client vs *that* space's toolshed); rough edges accepted
for v1, and a stale-client banner is useful hygiene beyond patterns.

**The gate is a system-pattern concern only.** Published-pattern updates
resolve by reading a slug's target `patternIdentity` (a cell read of a value
some publisher's runtime already computed) — no local identity recomputation,
so no build-dependence and no gate.

## Detecting and bounding bad updates

- **CI golden replay** against the short, controlled system list before
  shipping — the primary defense (feasible precisely because the list is short
  and we own the source).
- **Self-heal from a borked ship**: fix source → new identity → next space open
  compiles and swaps it before bootstrap → recovered even when the old identity
  cannot load and neither process exposes a build SHA.
- **Rollback = redeploy**: ship the prior source → toolshed serves the prior
  identity → the same swap rolls back. No per-piece rollback state needed.
- **Escape hatch**: manual `recreateDefaultPattern` remains (state-losing; last
  resort).
- **Residual**: schema-valid-but-semantically-wrong is not reliably detectable;
  it is *bounded* by fast rollback + golden replay, not gated on.

## Build sketch (seams)

- **Toolshed**: `?identity` handler + boot-time `{ name → identity }` cache in
  the patterns route (`patterns.routes.ts` / `patterns.handlers.ts` /
  `patterns-server.ts`); import `computeModuleIdentities` +
  `transformInjectHelperModule` from the runner.
- **Runtime worker**: an update-check step at space open, next to
  `handleGetSpaceRootPattern` / `ensureDefaultPattern`
  (`runtime-client/backends/runtime-processor.ts`, `pieces-controller.ts`):
  per-space host resolution, verified legacy-provenance recovery, broken-root
  direct compilation, healthy-root version gate and `?identity` cache, and an
  in-place `patternIdentity` swap.
- **Piece**: `patternSource` meta getter/setter; stamped by URL-based creation
  and recreation from the applicable source (system path, or a `cf:` ref derived
  from `defaultAppUrl`). Custom `RuntimeProgram` recreation remains unstamped;
  its optional repository locator is separate provenance.
- **Space cell**: `defaultAppUrl` generalizes to a `cf:` ref (template). A
  per-space host-hint store is a later addition.
- **IPC**: a worker→shell `versionSkew` message; shell banner + worker-restart
  control.
- **Grammar/resolver**: implement `cf://host/...` (register-on-ingest; today
  it throws "M3 not yet supported"); slug-optional = space root.

## Phasing

1. **Default (non-home) space root, always-update.** Least risky —
   `default-app.tsx` carries little durable state. `patternSource` field +
   in-place swap + toolshed `?identity` + version gate + IPC.
2. **Home root.** Carries real user data (favorites/journal/spaces) → depends
   on the stable-addressing discipline and golden coverage of `home.tsx`.
3. **Published-pattern updates.** `patternSource` = `cf:` ref; lazy check +
   shell "update available" + click-to-apply; fork/lineage handling
   (needs the deferred lineage substrate).
4. **Cross-host published** + persisted space→host hints + CFC provenance
   labels on fetched source.

## Open questions

1. **`?identity` vs ETag/HEAD.** A conditional GET (`ETag: <identity>`,
   `If-None-Match`) is the idiomatic HTTP form; `?identity` is simpler. Recommend
   `?identity` for v1.
2. **Where the root's `patternSource` lives** — the root piece meta (general;
   recommended) vs the space cell (co-located with `defaultPattern`). Recommend
   the piece; the space cell holds only the `defaultAppUrl` template.
3. **IPC skew policy** — auto-restart the worker on skew, or banner-and-let-the-
   user-reload? Start with a banner; auto-restart is a follow-up.
4. **Home-data stable addressing** — verify `home.tsx` addresses its durable
   state by stable key/cause before enabling always-update on the home root
   (Phase 2 gate).
