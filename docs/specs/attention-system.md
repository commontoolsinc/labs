# Attention System

A canonical runtime substrate for managing user attention: a per-user
**attention ledger** written by a single trusted **ranker** under the user's
own **policies**, **seen-state over artifacts** derived from the version
history the runtime already keeps, and **surface adapters** that project the
ledger onto shell lanes, digests, and (eventually) OS notifications. An OS
push notification is the *most degraded projection* of this system, not its
model.

## Status

Draft — seeking framework author review. None of this is implemented in labs
today (§3 inventories what exists), and §10 names the net-new runtime surface
this design requires — most importantly a version-exposure API (§10.1) and
write-authorization gating for sqlite (§10.2). The Loom product's in-flight
attention framework and Pond's spatial shell are the first intended
consumers; this spec defines the runtime primitives their product surfaces
should compile onto, so each stops hand-rolling its own attention state
(Appendix A maps Loom's candidate shape onto the envelope). Derived from the
2026-05-21 multi-user/notifications design sessions and the 2026-07 attention
reframe; revised 2026-07-12 after adversarial runtime and product review.

## Last Updated

2026-07-12

## Summary

Every existing notification system is biased toward interruption because the
*emitter* chooses how loudly to surface, and emitters' incentives favor
loudness. This design inverts that: **sources only request a posture; the
user's ranker — running with the user's policies, structurally on the user's
side — decides**. The runtime's job is to make that inversion enforceable
(CFC write-gating on the canonical ledger), cheap (pull-based derived
queries, no second event journal), and portable across surfaces (one
envelope, per-platform adapters).

Five load-bearing moves:

1. **One ledger, four postures.** Attention items land in exactly one rung of
   a posture ladder — `silent` → `review` → `heads-up` → `interrupt` — and
   the rung is the promise made to the user (§4.2). The system is biased
   downward: a source earns its way up, and every ignore/dismiss/mute pushes
   its future items back down.
2. **The ranker is the only writer.** The canonical ledger carries a
   `writeAuthorizedBy` claim; untrusted patterns can emit candidates and
   render their own local views, but cannot spam the ledger (§6).
3. **Attention over artifacts is derived, not emitted.** The runtime already
   versions every entity (memory-v2 `seq`) — though exposing that version to
   patterns is net-new API work (§10.1). Seen-state is one small relation —
   last observed version per (user, entity) — and "unseen change", "while
   you were away", and the artifact lifecycle all fall out as queries (§5).
   For in-fabric sources, an attention item is a *view over* "an artifact
   you care about changed", which dissolves the "every pattern must remember
   to emit notifications" problem.
4. **Policies are user-owned cells**, not ranker code. The core ships a
   good-enough default fold; the bespoke last 20% ("library book due"
   escalations, quiet hours, per-thread mutes) is data the user — or a
   pattern, on proposal — writes (§7).
5. **Multi-user needs almost nothing new.** Attention is a per-(user, item)
   relation: a shared space emits one candidate and each member's ranker
   lanes it independently. "Who has seen this" — and, per disclosure policy,
   "who has handled this" — is the same state contributed into shared space,
   read the other direction (§8).

### Division of labor

This spec owns **routing, terminal state, seen-state, and delivery**.
Everything upstream of a candidate — deciding whether an agent may *start*
work, preparing material, continuity ownership, receipts, onboarding
interviews that seed policy — is product-side and stays there. A product
framework (e.g. Loom's attention framework) enters this pipeline as a
*trusted source* emitting well-prepared candidates with a requested posture;
the runtime ranker's job for such a source is cross-source arbitration and
enforcement of the user's posture caps, not re-litigating the product's
preparation decisions.

## Goals

- A single canonical attention envelope and ledger that shell, product
  surfaces (Loom, Pond), patterns, and OS adapters all read.
- Make autonomous/agent work *visible* without interruption — the user can
  always see that something was done on their behalf, at zero notification
  cost ("quiet disposition" must not mean "invisible disposition").
- Structural downward bias: interruption is the exception and must be earned;
  the emitter cannot force it.
- User-owned, inspectable, editable routing policy — when the system
  mis-lanes something, the fix is a one-line policy edit, not a black box.
- Per-viewer lanes over shared state: the same event can interrupt one member
  of a space and be texture for another.
- OS delivery (Web Push, APNs/FCM) as replaceable adapters over the same
  ledger, honoring per-platform replace/retract semantics.

## Non-goals

- **Product surface design.** Which views exist (Today block, attention
  center, donut zones), their copy, and their capacity budgets are product
  decisions; this spec only guarantees the queries they need are cheap and
  the data they render is trustworthy.
- **Work-start authorization and preparation.** Policies governing whether
  an agent may autonomously begin work, budgets, authority ceilings, and
  continuity ownership are product-side (§Division of labor). The runtime
  never decides what work happens — only how its results claim attention.
- **Policy seeding / onboarding flows.** How a product interviews the user
  and proposes an initial policy set is product-scope; the runtime primitive
  is only "patterns propose, the user disposes" (§7) — adoption *is* the
  write, and proposed-but-unadopted policies never enter the ranker's fold.
- **Coverage/miss measurement** ("earn the right to say all caught up") —
  product-layer analytics over the ledger; the ledger just has to be
  complete enough to measure.
- **V1 delivery breadth.** No SMS/email channels, no iOS Live Activities, no
  `time-sensitive`/`critical` interruption levels (both need platform
  entitlements), no wearables. The envelope reserves room; adapters come
  later (§9.3).
- **A "list all members of a space" primitive.** The runtime deliberately
  lacks one (see `docs/specs/shared-profile-rosters.md`); multi-user features
  here are designed within that constraint, not around it.
- **Replacing source UIs.** An attention item opens its focused destination
  (the artifact, the draft, the conversation); it displaces the source
  occurrence rather than duplicating it (`displaces`, §4.4).

## 3. Background — what exists today

In labs, effectively nothing:

- `packages/ui/src/v2/components/cf-toast/` and `cf-alert` are polished
  presentation components, but no toast provider is mounted anywhere in
  `packages/shell` — the only real usage is a demo pattern
  (`packages/patterns/mobile-app-demo.tsx`).
- The shell header (`packages/shell/src/views/HeaderView.ts`) has no bell, no
  badge, no activity surface.
- No read/seen tracking exists anywhere — `packages/patterns/group-chat-room.tsx`
  has no read receipts or unread counts.
- No push transport of any kind: no service-worker push, no APNs/FCM, no
  device registration in `packages/toolshed` or `packages/identity`.
- The two adjacent primitives are ingress- or scheduling-shaped, not
  attention-shaped: webhook ingress delivers external POSTs into a reactive
  stream (`docs/specs/webhook-ingress/`, `packages/toolshed/routes/webhooks/`),
  and `packages/background-piece-service` polls registered pieces every ~60s
  with documented reliability caveats.

Meanwhile the products above the runtime are already building attention
systems without runtime support: Loom's attention framework (in flight, on a
feature branch as of 2026-07-12) defines *prepared claims*, an
attention-posture ladder, a capacity-bounded Today block, and a
default-weekly digest — materialized in product-local storage; its current
"unseen" affordance is a localStorage last-seen timestamp per browser.
Pond's donut prototype ranks pieces spatially by an attention score. Both
need the same substrate: durable per-user seen-state, a trustworthy
canonical ledger, and per-user routing policy. This spec is that substrate —
and only that substrate; Loom's work-start machinery and stance-bearing
judgment policies stay product-side (§Division of labor).

## 4. Model

### 4.1 The unit: a claim on attention

An attention item is a **claim on the user's attention with a focused
destination**. Borrowing the product framing: a raw source occurrence, or the
bare fact that an agent ran, is not by itself a claim on attention. The
envelope therefore always carries *where to go* (`target`, a stored cell
link) and *what is ready there* (title/body describing the prepared result or
the change), never just "something happened".

The runtime does not — cannot — enforce that items are well-prepared; it
enforces the things preparation depends on: who may write the ledger, which
posture a claim actually gets, and that handled claims retract everywhere.

### 4.2 The posture ladder

Every visible item occupies exactly one rung. The rung is a promise:

| Posture | Promise to the user | Typical projection |
|---|---|---|
| `silent` | "Recorded; you'll find it if you look." | seen-state dots on artifacts, history views |
| `review` | "Batched for your next review; no urgency." | digest, review queue — bounded history, not a feed |
| `heads-up` | "Look when you next check in; we'll hold it." | shell bell/badge count, quiet OS delivery |
| `interrupt` | "Worth breaking your flow for." | OS banner/sound, in-shell takeover |

Plus one policy *effect* that is not a rung: `suppress` (never materialize
for this user; distinct from `silent`, which is findable).

Two invariants:

- **Downward bias.** Defaults sit low (`silent`/`review`). Sources *request*
  a posture; the ranker assigns the real one, capped by policy, and repeated
  dismiss-without-open or mute feeds back as posture caps. Crucially,
  **no emitter-controlled field may raise posture**: eligibility for
  `interrupt` (and `heads-up` above a source's baseline) comes only from a
  user-granted posture floor in policy (§7) — never from urgency claims,
  expiry times, or any other field the emitter writes. An emitter cannot buy
  `interrupt` with enthusiasm.
- **Attention ≠ confidence.** How sure the system is about an item and how
  loudly it surfaces are separate axes. Uncertain-but-urgent goes to
  `heads-up` with its uncertainty stated; certain-but-routine stays in
  `review`. The envelope carries them separately.

The ladder deliberately matches the posture vocabulary the Loom product
already uses (silent memory → daily review → timely heads-up → interrupt), so
product surfaces map 1:1 onto runtime postures. Within a rung, ordering is
the ranker-assigned `weight` (§4.4) — an opaque scalar that never crosses
rungs and never gates delivery; it exists so continuous surfaces (Pond's
radial layout, "ordered by the ranker" lists) don't have to invent one.

### 4.3 The pipeline

```text
Sources                         emit candidates (requested posture = advisory)
  agents/pieces running as me     │
  pieces I joined, running        │  per-source prefilter: "important within
    as others (group chat)        │   my world?" — cannot judge cross-source
  sharing directed at me          │
  artifact changes (derived, §5)  │
  external ingress (webhooks)     ▼
Candidate intake (durable, per-source quotas)    §6.1
  ▼
Ranker (per-user, trusted single writer)         §6
  folds candidates × policy cells (§7)
  assigns posture; coalesces; writes the ledger
  ── writeAuthorizedBy gate: only the ranker's verified
     module identity may write the canonical ledger ──
Ledger (per-user, durable, queryable)            §4.5
  ▼
Surfaces (pull-based readers)                    §9
  shell lanes / bell · product views (Today, donut, digest)
  · patterns rendering their own slices · OS adapters (push)
```

Untrusted patterns are not locked out of *rendering* — any pattern may show
its own local, clearly-attributed view of its own events. What untrusted code
cannot do is write the canonical ledger the shell and OS adapters trust.

### 4.4 The envelope

```ts
// Shown for illustration only.
// A source-entity version: memory-v2 seq is per-space (a space-global
// Lamport clock, monotone per entity), so versions are only comparable
// within the same space. Exposing this to patterns is net-new API (§10.1).
type EntityVersion = { space: string; seq: number };

type AttentionItem = {
  // Identity — THE load-bearing field. Every surface adapter targets it for
  // replace/retract (iOS UNNotificationRequest.identifier + apns-collapse-id,
  // Android notify(id), Web Push options.tag). Deterministic, and derived by
  // the RANKER from verified provenance (source space DID + entity id
  // [+ event key]) — never from candidate-supplied strings, so a hostile
  // source cannot collide another source's id to hijack coalescing or
  // OS replace/retract.
  id: string;

  // Pointer to the source of truth (a stored cell link, not a query string).
  // The item is the invitation; the source is the truth. Used to evaluate
  // active(), to navigate, and as the key for source-scoped policies.
  source: unknown;            // asCell: ["cell"]
  // Source classification ("group-chat", "importer", "agent-run", ...).
  // First-class because policy matching (§7) and digest grouping (§9.2)
  // both key on it.
  sourceKind: string;
  // The source entity's version at emission. Drives replace, retract, and
  // re-emerge semantics.
  sourceVersion: EntityVersion;
  // Optional grouping key for presentation (one conversation, one task,
  // one agent run — see §5 on run-level grouping).
  threadKey?: string;

  // Content. Snapshot at emission (title/body) plus the live destination.
  title: string;
  body: string;
  // Focused destination: a stored cell link navigated with navigateTo().
  target: unknown;            // asCell: ["cell"]
  // Optional link to prepared material (draft, diff, packet) when it is a
  // different artifact than target.
  prepared?: unknown;         // asCell: ["cell"]
  // Cross-item displacement: item ids this claim supersedes. A prepared
  // result displaces the raw occurrence's claim — the ranker terminates the
  // displaced items (system-on-behalf action) so source and result never
  // both surface unless each has an independent live claim.
  displaces?: string[];

  // Routing. requestedPosture is advisory input from the source; posture is
  // assigned by the ranker and is the only one surfaces read.
  requestedPosture: "silent" | "review" | "heads-up" | "interrupt";
  posture: "silent" | "review" | "heads-up" | "interrupt";
  // Intra-rung ordering, ranker-assigned. Opaque; never crosses rungs;
  // never gates delivery (§4.2).
  weight?: number;
  // Confidence is orthogonal to posture (§4.2); surfaces may render it.
  confidence?: number;        // 0..1

  emittedAt: number;
  notBefore?: number;         // embargo: hold materialization until then
  expiresAt?: number;         // time-bound claims retract themselves —
                              // evaluate-on-read semantics, see §9.3

  // Opaque product extension. The runtime never interprets it; products
  // round-trip their own fields (e.g. Loom's why_now, channel,
  // authorization_state — Appendix A) here instead of smuggling them
  // into body.
  ext?: Record<string, unknown>;
};

// Append-only per-item action log. Replaces {active, dismissed} booleans:
// cause is preserved, multi-device writes merge, re-emerge is well-defined.
type AttentionAction = {
  itemId: string;
  type: "seen" | "dismissed" | "snoozed" | "archived" | "acted" | "muted";
  at: number;
  // Which surface the action came from (shell, os-tray, digest, ...). Lets
  // policy decide e.g. "os-tray dismiss clears that device only".
  surface: string;
  by: string;                 // DID; may be a module identity for
                              // system-on-behalf actions (auto-expiry,
                              // displacement)
  // The sourceVersion the action was taken against. A dismissal tombstones
  // that version; if the source advances past it, the item re-emerges and
  // the old dismissal no longer applies. Comparable only within
  // sourceVersion.space.
  againstVersion: EntityVersion;
  payload?: unknown;          // snoozeUntil, acted result, mute scope, ...
  ext?: Record<string, unknown>; // product extension (e.g. calibration
                              // feedback like "not-useful")
};
```

Nothing stores `active`, `dismissed`, or `unread` flags. They are **derived,
pull-evaluated queries** — computed when a surface demands them:

```ts
// Shown for illustration only.
const sameSpaceGte = (a: EntityVersion, b: EntityVersion) =>
  a.space === b.space && a.seq >= b.seq;
const active = (n: AttentionItem) =>
  // pull-read of the source's current head version (§10.1); a claim's
  // currency is the source's call
  !sameSpaceGte(currentVersion(n.source), advancedPast(n));
const terminal = (n: AttentionItem, log: AttentionAction[]) =>
  log.some((a) =>
    (a.type === "dismissed" || a.type === "archived" || a.type === "acted") &&
    sameSpaceGte(a.againstVersion, n.sourceVersion)
  );
const visible = (n: AttentionItem, log: AttentionAction[], now: number) =>
  !terminal(n, log) && active(n) && !snoozedUntil(log, now) &&
  (n.notBefore === undefined || now >= n.notBefore) &&
  (n.expiresAt === undefined || now < n.expiresAt);
```

A caveat on "cheap": pull-based scheduling makes *unobserved* queries free
(`docs/specs/pull-based-scheduler/README.md`), not observed ones. A mounted
lane is a live subscription and re-evaluates when its inputs change; §4.5 and
§10.1 bound how often that happens (conditional seen writes, non-reactive
version reads by default, seen-state segregated from lane queries).

### 4.5 Storage

The ledger lives in the **user's home space** (home space DID = user identity
DID; the established home for durable per-user state, alongside favorites and
journal — see `docs/common/conventions/HOME_SPACE.md`). It is **three
stores with three writer models**, not one:

1. **`items`** — written *only* by the ranker. Backing for phase 1:
   a **durable array cell carrying the `writeAuthorizedBy` claim**, the
   mechanism already protecting profile links in production
   (`docs/common/conventions/HOME_SPACE.md`,
   `packages/runner/src/cfc/prepare.ts`). Coalescing (same `id`, source
   advanced) is an in-place element update by the single leased ranker
   instance (§6.2). This is deliberately *not* sqlite yet: `writeAuthorizedBy`
   is enforced on the cell-write prepare path and **does not gate
   `db.exec`** today — sqlite's implemented CFC covers confidentiality
   ceilings and row-label rules, not write authorization
   (`docs/specs/sqlite-builtin/06-cfc.md`). Migrating `items` to a sqlite
   table (better ranking/pagination/retention at volume) is gated on the
   net-new work item in §10.2, and on giving `items` **its own database**:
   every `db.exec` serializes on the database handle cell's `rev`, so one
   shared db cannot hold both a ranker-only table and an
   everyone-writes table without gating both or neither.
2. **`actions`** — written by every surface on every device. Backing: a
   durable array cell appended with **mergeable ops only** (`push`,
   `addUnique`), so concurrent user actions from two devices merge against
   durable state instead of clobbering (memory is optimistic-concurrency
   with path-aware validation, not CRDT — and this design needs no CRDT:
   the canonical writer is singular per store, and user actions are
   mergeable appends). The ranker periodically compacts actions for
   terminal, swept items.
3. **`seen`** — the seen ledger (§5), highest write rate in the system,
   ships in phase 0 and gets its own store so its writes never wake lane
   queries. One mark per (entity), upserted: recommended backing is a small
   **sqlite database private to seen-state** (upsert-by-key is what SQL is
   for; no trust gating needed — every surface of the *user's own runtime*
   may write the user's own marks), with an array-cell fallback. Write
   discipline is part of the spec, not an optimization: a mark is written
   **only when it advances** (`newSeq > seenSeq`, so re-renders and repeat
   views are no-ops — this is also what breaks any render→write→render
   cycle) and **debounced per focus session** (at most one write per entity
   per focused open). Retention is trivial — one row per cared-about
   entity, reaped when the care-relation drops the entity.

Two rules regardless of backing:

- **Never model a ledger itself as `asCell: ["stream"]`** — stream cells
  are ephemeral (only the marker persists; payloads do not — see
  `docs/specs/space-model/4-cells.md`). Streams are append *endpoints*, not
  logs. This matters doubly for ingress: webhook payloads ride an ephemeral
  stream, so a **receiving handler must persist candidates durably at
  ingress** — otherwise external candidates arriving while no ranker is
  live are lost permanently, not delayed (§6.1).
- **Never `set()` a whole array** that has more than one writer.

Retention: `expiresAt` handles time-bound claims (evaluate-on-read, §9.3); a
sweep reaps items that are terminal with `sourceVersion` below a watermark,
plus their actions. Sweeping is a ranker duty (it owns `items`), bounded and
boring by design. Because sweeping only reaps *terminal* rows, per-source
intake quotas (§6.1) are what bound a flooding source, not retention.

## 5. Seen-state and attention over artifacts

The most common attention event in practice is not "interrupt me" — it is
"an agent (or another member) did work while I wasn't looking, and I need to
be able to *see that it happened*". That is not a notification; it is
seen-state.

**The seen ledger** is one small relation per user: the last version the
user actually observed, per entity. "Observed" is defined strictly:
**seen = focused open** — the user navigated to the entity (or an item whose
`target` is the entity) and it was the focus of their attention. Scrolling
past a row in a list is *not* seen; rendering a lane is *not* seen. This
single definition is load-bearing three ways: it keeps unseen dots honest,
it keeps disclosed read-receipts meaningful (§8), and it keeps seen writes
rare (§4.5.3).

```ts
// Shown for illustration only.
type SeenMark = {
  entity: unknown;            // asCell: ["cell"] — the artifact/piece
  seenVersion: EntityVersion; // last observed version
  at: number;
};
```

Everything else is a query over marks joined against current heads (which
requires the version-exposure API, §10.1 — the versions exist in memory-v2;
reading them from pattern/shell code is net-new):

- `unseen(entity) = head(entity).seq > seenVersion.seq` (same space) →
  change dots on artifacts and their containers (space lists, home).
- **"While you were away"** = all cared-about entities with unseen changes,
  grouped by space, ordered by the ranker. Renders as a pattern on the home
  context. This is the first-run view and the every-return view — the same
  query. The affordance must answer *what changed, by whom, since you
  looked* — author and time of the unseen changes, and a jump-in that
  emphasizes the changed region (memory-v2 holds both versions; the diff is
  derivable). A bare dot that says "something happened" does not meet the
  bar (§4.1). Note the *by whom* half is gated on commit attribution
  exposure (§10.1); until it lands, the view can say what changed but only
  approximate who.
- **Artifact lifecycle** falls out of the same two numbers plus a timestamp:
  *fresh* (unseen changes) → *seen* → *stale* (untouched for N) →
  *archived*. No new subsystem.

**Derivation beats emission.** For in-fabric sources, an attention candidate
is *derived from* artifact-change + care-relation — the attention system
watches; patterns just write their artifacts. Explicit candidate emission
remains for sources with no artifact (external ingress, transient events),
but it is the minority path. This is the platform's grain: derived state over
stored state, and no parallel event journal duplicating what memory-v2's
commit log already records.

**Run-level grouping.** One agent run touching twelve artifacts must not be
twelve scattered dots. From phase 1, agent-shaped sources emit one
receipt-shaped candidate per run (`threadKey` = run id, `displaces` covering
the per-artifact noise), and "while you were away" groups by `threadKey`
before space. Phase 0 — dots only — does not have this, which is a stated
limitation, not an oversight: phase 0 makes agent work *visible*; run-level
legibility is phase 1's tracked follow-through (§11).

**The care-relation** answers "which entities produce dots at all":
approximately *touched-recently ∪ agent-did-it-for-you ∪ explicitly-watched*,
itself tunable by policy. Getting this right is an open question (§12.2);
getting it wrong in the "too broad" direction is the failure mode to avoid
(dots everywhere = dots nowhere).

## 6. The ranker

**One logical ranker per user.** It folds candidates and policies into the
ledger, assigns postures and weights, coalesces (same `id` when the same
source object advances; same `threadKey` when distinct events share a
conversation or run), applies displacement, computes re-emergence, and
sweeps retention.

### 6.1 Candidate intake

Candidates must be **durable before ranking**: the ranker may be asleep or
absent (interim mode, closed clients), and ephemeral candidates would be
silently lost, not delayed. Intake shape:

- In-fabric artifact changes need no intake at all — they are derived (§5).
- Pattern-emitted candidates land in a durable per-source candidate cell in
  the space where they arise; a small forwarder (part of the emitting
  pattern's contract) or the user's runtime copies them into a **candidate
  inbox in the user's home space**, making the ranker's whole world
  home-space-local (this is also what makes server-side execution viable
  before cross-space wake exists — §6.3).
- Webhook ingress: the receiving handler persists the payload durably at
  ingress (§4.5); the ephemeral stream is transport, not storage.
- **Per-source quotas** apply at intake (candidates per source per window).
  Retention only reaps terminal items, so quotas — not retention — are the
  bound on a flooding source. Quota state feeds the same source-reputation
  signal as dismiss-without-open.

### 6.2 Trust and instance discipline

The `items` store carries a CFC `writeAuthorizedBy` claim. Two viable
bindings:

1. **Verified module identity** (recommended): the ranker ships as a pattern
   with a content-addressed module identity; `writeAuthorizedBy` binds to it.
   The ranker stays in pattern-space — inspectable, forkable in principle,
   updated like any pattern — and "trusted" means *this exact code*, not
   "runs on a server".
2. **Trusted builtin**: a runtime builtin id in the claim. Stronger, but
   moves the fold out of pattern-space and makes policy-fold evolution a
   runtime release.

Recommendation: (1), with the fold's *inputs* (policies) as data so the code
rarely needs to change. Note the identity subtlety: *acting as the user*
(session `as` / `actingPrincipal` = the user's DID) and *being authorized to
write the ledger* (module identity matching the claim) are two separate
checks, and the design uses both — every ranker write is attributable
`onBehalfOf` the user and provably from the ranker's code.

`writeAuthorizedBy` authorizes *code*, not an *instance*: two devices running
the ranker both pass the claim. The single-writer premise therefore needs
instance discipline, not just CFC: **the interim client-side ranker takes a
lease** (a mutex cell claimed with an expiry; the sqlite spec's
`tryClaimMutex` shape) and only the leaseholder folds. Independent of the
lease, the fold is specified **idempotent and commutative over the candidate
inbox** (deterministic ids; coalescing recomputes from source state rather
than incrementally mutating), so a lease handoff or a brief double-writer
window degrades to wasted work, not divergence.

### 6.3 Execution

- **Target: the server-primary execution model**
  (`docs/specs/server-side-execution/`). With intake home-space-local
  (§6.1), the ranker is a *standing registration on the user's home space* —
  work whose value is its effects rather than client-read output — woken by
  commits to the candidate inbox or cared-about entities' forwarded events.
  Execution is attributed `onBehalfOf` the user. Named dependencies, since
  that spec's workers, registrations, and wake-on-commit are all
  **per-space**: standing registrations are its own later phase; scoped
  (`PerUser`) state claims are gated (its G16); server-side *cross-space*
  reads/wake are explicitly deferred there — which is exactly why intake
  forwards into the home space instead of the ranker reading N spaces.
- **Interim: client-side, under lease** (§6.2). Until standing registrations
  land, the leaseholder client runs the ranker as an ordinary piece. This
  degrades gracefully for in-fabric state (candidates are durable; folding
  happens on next lease) — what's lost is only *timeliness* while no client
  is open, which matters from phase 2 (OS delivery) onward and not before.
- **Not: `background-piece-service` as-is.** It is per-space (the ranker is
  per-user), ~60s polling (the ranker is wake-on-commit shaped), and its own
  README documents async-completion unreliability. If bps is pressed into
  interim service, treat that as scaffolding, not the design.

**Laziness.** The ranker materializes *rows*; it does not keep derived
predicates hot. `active()`/`visible()` evaluate on surface demand. The one
push-shaped duty is OS delivery (§9.3), which is explicitly an edge adapter
fed by wake-on-commit, not a hot loop.

## 7. Policies

A policy is a small declarative record the ranker folds over — **data, not
ranker code**:

```ts
// Shown for illustration only.
type AttentionPolicy = {
  match: {
    source?: unknown;         // asCell: ["cell"] — a specific source/thread
    sourceKind?: string;      // "group-chat", "importer", "agent-run", ...
    spaceDid?: string;
    threadKey?: string;
  };
  effect: {
    postureCap?: "suppress" | "silent" | "review" | "heads-up";
    // The ONLY path to interrupt: a user-granted floor (§4.2).
    postureFloor?: "review" | "heads-up" | "interrupt";
    coalesceWindowMs?: number;
    quietHours?: { start: string; end: string };
  };
  reason?: string;            // human-legible: why this policy exists
  createdBy: string;          // user DID, or module identity for proposals
  ext?: Record<string, unknown>; // product dimensions (e.g. stances),
                              // opaque to the runtime fold
};
```

- Policies live in the user's home space (`PerUser` scope). The core ships a
  handful of defaults: messages-from-humans → `heads-up`;
  agent-completions → `silent` (visible as seen-state, never buzzing).
  There is deliberately **no default that maps any emitter-supplied field to
  `interrupt`** — deadline-driven interruption ("library book due
  tomorrow") exists only as a user-adopted policy floor on a named source.
- **Mute is a policy, not a special relation.** "Mute this thread" writes
  `{match: {threadKey}, effect: {postureCap: "suppress"}}`. The ledger item
  that carried the mute action just records that it happened.
- **Patterns propose, the user disposes.** A pattern can ship a suggested
  policy with its artifacts ("library book due → heads-up 3 days before");
  adoption goes through a trusted surface, exactly like other user-consented
  writes — adoption *is* the write, and unadopted proposals never enter the
  fold. This is where the bespoke 20% lives, and why the ranker doesn't
  have to be perfect: when it mis-lanes something, the fix is a legible
  one-line policy, written by the user or by their agent on request.
  (Onboarding flows that propose an initial policy set are this same
  primitive N times, batch-confirmed by a product surface — out of scope
  here, §Non-goals.)
- **Policy privacy, honestly stated.** Policy cells are never directly
  readable by other principals — they are ordinary confidential home-space
  data. But *behavioral* inference cannot be fully prevented: in a space
  that discloses read receipts, a muted member's persistent silence is
  statistically visible to a patient observer. The runtime's guarantee is
  scoped: no direct exposure, and inference surface bounded by the space's
  own disclosure policy (§8, §12.5). Ranker *output* ordering/timing is not
  considered a protected channel in v1.

## 8. Multi-user

Three properties, all falling out of "attention is a per-(user, item)
relation" plus existing constraints:

- **One candidate, N ledgers.** A shared space emits one candidate per event;
  each member's own ranker lanes it under their own policies. A new message
  can be `interrupt` for the on-call member and `silent` for the member who
  muted the thread. The emitter cannot know or decide this — correctly so.
- **"Who has seen this" — and "who handled this" — is contributed, not
  enumerated.** There is no runtime primitive for listing a space's members
  or reaching into their home spaces
  (`docs/specs/shared-profile-rosters.md`), and this design does not add
  one. Shared attention state follows the roster idiom: members' runtimes
  write their own **seen marks and, per disclosure policy, terminal
  actions** into `PerSpace` state in the shared space — *if* the space's
  disclosure policy says to. Read receipts, "3 people haven't seen the new
  plan", and *"Bea already handled this"* are queries over that contributed
  state. Disclosing terminal actions matters because handling often doesn't
  touch the source artifact (triaged verbally, replied off-fabric): when the
  source *is* mutated, everyone's `active()` flips false for free; when it
  isn't, a disclosed `acted` is the only retraction signal others can get.
  A per-space opt-in policy — *"acted-by-any-member demotes to `silent` for
  all"* — turns that signal into collective quiet. Disclosure is a per-space
  policy cell (some spaces want receipts, some don't); a member who
  discloses nothing simply doesn't appear.
- **Escalation across people is a policy.** "If nobody attends to this
  within 2h, raise it to `heads-up` for the space owner" is a policy cell on
  the shared space, evaluated by the owner's ranker against contributed
  state. No siloed notification system can express this; here it is one
  record.

## 9. Surfaces

### 9.1 Shell

The shell renders the ledger; it does not own attention logic. Per the
"pattern on the context" resolution: the home/shell context declares how the
attention surface renders, so it is replaceable like the rest of the home
experience. Concretely:

- lanes: `interrupt` (modal-adjacent), `heads-up` (bell + badge count),
  `review` (digest entry point), `silent` (dots via seen-state, §5);
- unseen-change dots on artifacts and containers;
- a snoozed lane (snoozed items must stay discoverable);
- **focused opens** — not renders — write `seen` (an `AttentionAction` for
  the item, a `SeenMark` for its target entity), under §4.5's
  advance-only + debounced discipline. Rendering a lane never writes.

Presentation components exist (`cf-toast`/`cf-toast-provider`, `cf-alert`,
badge conventions); the net-new work is mounting them against ledger
queries. One CFC note for badge counts: aggregates over a rule-bearing
store refuse unless every row is readable by the counting principal —
for a home-space ledger this holds as long as item rows' clauses always
include the owner; state that invariant in the schema rather than
discovering it when someone adds a per-row rule.

### 9.2 Digests

A digest is **bounded history, not a feed**: a periodic artifact-shaped
summary over the ledger and seen-state — quiet dispositions, artifact
updates, prepared material, grouped by `sourceKind` — rendered by a pattern.
The runtime contribution is only that the queries behind it (terminal items
since T, unseen changes since T, actions by surface) are cheap and complete.
Whether a digest's *summary* may itself claim `heads-up` is a policy
decision, default no.

### 9.3 OS delivery

Only `interrupt` (and optionally `heads-up`, quietly) ever reaches the OS.
Adapters compile the envelope down; the ledger stays canonical and
"Android-shaped" (live update + auto-retract), and platforms degrade from
there:

- **Replace/retract rides `id`** everywhere: iOS
  `UNNotificationRequest.identifier` / `apns-collapse-id`, Android
  `notify(id)`, Web Push `options.tag`. When `visible()` flips false *on
  evaluation*, the dispatcher retracts on every delivered surface. Two
  honesty notes. First, `visible()` is evaluated on commit-driven wakes and
  on read — **nothing wakes anything at `expiresAt`**: server-side timers
  don't exist yet (they are "(Future)" in
  `docs/specs/server-side-execution/`), so an expired item may linger on an
  OS tray until the next wake or app-open re-evaluates it. Timer
  registrations that feed the dispatcher are named net-new work (§10.4);
  until they land, `expiresAt` is evaluate-on-read with explicitly stale OS
  surfaces. Second, iOS replaces but does not tick (text refreshes when the
  shade reopens); genuinely-live claims are a Live Activities track,
  explicitly out of V1.
- **Two transports, not one.** Browser/PWA: Web Push (VAPID + service
  worker). Wrapped mobile apps: native APNs/FCM via the wrapper's plugin —
  embedded webviews do not get Web Push. The server side (toolshed) needs a
  device-registration table `{userDid, deviceId, transport, token}` and a
  delivery ledger `{itemId, deviceId, platformIdentifier, deliveredAt,
  retractedAt}` so retraction can target what was actually delivered.
  Ship Web Push first; the envelope is transport-agnostic.
- **The PWA is the floor.** The canonical shape includes nothing that cannot
  be expressed on the most-constrained surface; richer platforms are adapter
  opt-ins, not envelope fields.
- **Tray-dismiss is per-device by default.** An OS-tray dismissal writes an
  action with `surface: "os-tray"`; whether it terminates the item globally
  is policy (default: clears that device only; the shell is canonical).

## 10. Net-new runtime surface

This design mostly composes existing primitives, but not entirely. Naming
the gaps is the point of this section — each is a prerequisite of the phase
that first needs it (§11), and each needs its own (small) design pass.

1. **Version exposure** *(phase 0)*. Patterns and the shell currently cannot
   read an entity's memory-v2 head `seq` — the `Cell` interface exposes no
   version, deliberately. Seen-state needs: (a) a **non-reactive** per-entity
   head-version read (non-reactive by default is essential — a reactive seq
   read re-fires on every change, exactly what seen writes must not do);
   (b) a *changed-since(version)* enumeration over a set of cared-about
   entities for "while you were away"; (c) eventually, commit-attribution
   exposure (who wrote) — memory-v2 reserves `invocationRef` /
   `authorizationRef` for a later signed-write pass, so phase 0's "by whom"
   is approximate until that lands. CFC story required: observing a head
   version reveals *that* activity occurred; version reads must be gated by
   the same read authority as the entity itself.
2. **Write-authorization for sqlite** *(pre-migration of `items` to sqlite;
   not needed for phase 1's array-cell backing)*. `writeAuthorizedBy` is
   enforced on the cell-write prepare path only; `db.exec` today checks
   confidentiality ceilings and row-label rules but not write authorization.
   Gating `db.exec` per database handle (the `rev` bump is a cell write, so
   the prepare path sees it) needs specification and a security review of
   its own, including whether any sqlite write path bypasses the rev write.
3. **Ranker lease** *(phase 1)*. A small mutex-cell convention (claim with
   expiry, renew, steal-on-expiry) for single-instance election of the
   interim client-side ranker (§6.2). Generalizes beyond attention.
4. **Timer wake** *(phase 2+)*. Executor-pool timer registrations
   (`notBefore`, `expiresAt`, snooze expiry, digest cadence) feeding
   wake-on-commit's machinery, so time-driven transitions don't depend on
   coincidental commits. Until then: evaluate-on-read, stale OS surfaces
   acknowledged (§9.3).
5. **Push transports** *(phase 2/3)*. Web Push then APNs/FCM: device
   registration, delivery ledger, retraction dispatch (§9.3). Net-new but
   conventional.

## 11. Phasing

Each phase is independently shippable and none re-shapes the data model.

- **Phase 0 — seen-state.** The seen ledger (§5) with its write discipline
  (§4.5.3), unseen dots in the shell, and a "while you were away" home
  pattern. Requires version exposure (§10.1). No ranker, no candidates, no
  push. Acceptance bar: the user can see *what changed and since when* (by
  whom, to the extent §10.1c allows), and jump in with the changed region
  emphasized — not merely that a dot exists. This makes agent work
  **visible** — the single most-requested product gap — while run-level
  *legibility* (one claim per agent run, not twelve dots) is explicitly
  phase 1's follow-through.
- **Phase 1 — ledger + lanes.** Envelope, home-space `items` (array cell +
  `writeAuthorizedBy`) and `actions` stores, candidate inbox with quotas
  (§6.1), a minimal client-executed ranker under lease (defaults + mute +
  posture caps/floors + displacement), shell bell/lanes, receipt-shaped
  candidates for agent runs. Policies v0.
- **Phase 2 — server ranker + first transport.** Ranker as a standing
  registration on the home space under server-primary execution
  (dependencies named in §6.3); Web Push with device registration and
  retraction; digest queries; timer wake (§10.4).
- **Phase 3 — breadth.** Wrapped-app APNs/FCM; full action vocabulary
  (snooze/archive surfaced); shared seen-state + disclosed terminal actions
  + escalation policies (§8); `items` on sqlite once §10.2 lands;
  coalescing refinements. Live Activities remain a separate track.

## 12. Open questions

1. **Ranker trust binding.** Verified module identity is recommended (§6.2),
   but the "wholly-system service" alternative keeps resurfacing; if the
   server executor itself writes the ledger, is that a builtin identity, and
   does that preempt user-forkable rankers? Resolve before phase 1.
2. **The care-relation.** Which entities produce seen-state dots (§5)?
   Touched ∪ agent-authored ∪ watched is the working answer; validate
   against real spaces before hardening, and decide whether "touched" decays.
3. **Forwarder contract.** §6.1 makes intake home-space-local via
   forwarders. Who runs them (the emitting pattern? the user's runtime on
   visit?), and what happens for spaces the user hasn't opened in weeks?
4. **Seen-mark granularity.** Per-entity marks are the floor. Do container
   views (a space list showing N dots) warrant container-level marks, and
   does "seen the container" imply anything about members?
5. **Disclosure defaults** for shared seen-state and terminal actions (§8):
   receipts on or off by default, what the non-disclosing member's absence
   reveals, and how much of §7's policy-privacy bound this sets.
6. **Policy expressiveness boundary.** V1 is plain predicates. Content
   regexes and LLM-judged predicates ("only interrupt if actually urgent")
   are clearly coming — as ranker inputs they inherit the ranker's authority,
   so they need their own integrity story before admission.
7. **Coalescing.** Same `id` vs same `threadKey` heuristics; displacement
   chains (a prepared result displacing an item that itself displaced);
   sub-object edge cases (a thread whose items have their own lifecycles).
8. **Cross-space lane cost.** A rendered lane is a ledger query plus N
   cross-space source reads (per-item `active()`), each through the user's
   ordinary session against the source space. Fine at dozens; model the
   cost before hundreds, and decide how stale a lane's `active()` may be.
9. **Digest self-promotion.** May a digest claim `heads-up` on a schedule
   (§9.2)? Leaning policy-gated, default off.
10. **Convergence with product stores.** Loom currently materializes
    attention candidates in product-local storage with localStorage
    seen-timestamps. Appendix A is the field mapping; the remaining
    question is sequencing — which loom surface adopts the runtime ledger
    first, and whether loom's materializer becomes the trusted source or a
    second ranker (§Division of labor says: trusted source).

## Appendix A — mapping Loom's `attention-candidate-v1`

For the first consumer's adoption review. Loom fields → envelope:

| Loom candidate field | Envelope home |
|---|---|
| `id` / source identity | `id` (re-derived by ranker from verified provenance) |
| subject / focused target | `target` (cell link); `focused_view_fallback` → `ext` |
| prepared material | `prepared` |
| `title`, body copy | `title`, `body` |
| `why_now` | `ext.why_now` (product copy, runtime-opaque) |
| `claim_kind` (act-now / review / notice / …) | `sourceKind` + `requestedPosture` (kind is classification; posture is the loudness request derived from it) |
| `channel` (important-and-urgent / yours-in-progress / might-interest-you) | `ext.channel` — audience/genre, orthogonal to posture; product lanes render it |
| `relation_to_trigger: supersedes` | `displaces` |
| other `relation_to_trigger` values | `ext.relation_to_trigger` |
| `authorization_state` (proposal-required / …) | `ext.authorization_state` — the "needs your approval" affordance is product chrome; posture only governs loudness |
| `authority_class` | `ext` (work-start domain, product-side per §Division of labor) |
| `not_before` | `notBefore` |
| delivery/interrupt eligibility | `requestedPosture`, capped/floored by user policy (§7) |
| feedback: done / later | actions `acted` / `snoozed` |
| feedback: never-for-this-class | a policy write (`postureCap`) via the trusted surface |
| feedback: not-useful | action `dismissed` + `ext.feedback: "not-useful"` (calibration signal round-trips to the product) |

Not mapped, deliberately: Work-start Policies, continuity owners, typed
receipts' internals, stance vocabularies — upstream product machinery
(§Division of labor). A receipt *summary* enters as an ordinary candidate.

## References

- `docs/specs/shared-profile-rosters.md`, `docs/specs/shared-profile-space.md`,
  `docs/common/conventions/HOME_SPACE.md` — multi-user substrate; the
  contribute-your-own idiom; `writeAuthorizedBy` in production.
- `docs/specs/server-side-execution/README.md` — standing registrations,
  wake-on-commit, `onBehalfOf` attribution (ranker execution home; §6.3
  names this spec's dependencies on it).
- `docs/specs/memory-v2/` (esp. `01-data-model.md`, `03-commit-model.md`,
  `08-conflict-granularity.md`) — `seq`, optimistic concurrency, mergeable
  ops, reserved commit-attribution fields.
- `docs/specs/sqlite-builtin/` (esp. `05-reactivity.md`, `06-cfc.md`) —
  seen-ledger backing; why trust-bearing tables wait on §10.2; `reactOn`
  coarseness; the rev-serialized write path.
- `docs/specs/space-model/4-cells.md` — stream-cell ephemerality.
- `docs/specs/pull-based-scheduler/README.md` — demand-driven evaluation
  (and its limits for observed queries, §4.4).
- `docs/specs/webhook-ingress/README.md` — external candidate ingress
  (durable persistence at the handler required, §6.1).
- `packages/home-schemas/` (`journal.ts`, `favorites.ts`, `home.ts`) — the
  durable-array + stream-append precedent and stable-key discipline.
- `packages/runner/src/cfc/prepare.ts`, `packages/runner/src/cfc/ui-contract.ts`
  — `writeAuthorizedBy` enforcement (cell-write path); trusted surfaces.
- `packages/runner/src/builtins/navigate-to.ts`,
  `docs/common/conventions/wish.md` — navigation from stored cell links;
  well-known targets.
- `packages/ui/src/v2/components/cf-toast/`, `cf-alert`, `cf-badge` —
  existing presentation components.
- `packages/background-piece-service/README.md` — why the ranker does not
  run there.
