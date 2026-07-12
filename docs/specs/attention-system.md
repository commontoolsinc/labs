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
this design requires — most importantly the **changes projection** (§10.1), a
small read-only query primitive over shipped memory-v2 machinery, and a
cross-principal append gate for candidate intake (§10.2). The Loom product's
in-flight attention framework and Pond's spatial shell are the first intended
consumers; this spec defines the runtime primitives their product surfaces
should compile onto, so each stops hand-rolling its own attention state
(Appendix A maps Loom's candidate shape onto the envelope). Derived from the
2026-05-21 multi-user/notifications design sessions and the 2026-07 attention
reframe; revised 2026-07-12 after two adversarial review rounds (runtime +
product, then Android-as-gold-standard + primitive-shape + parsimony).

## Last Updated

2026-07-12

## Summary

Every existing notification system is biased toward interruption because the
*emitter* chooses how loudly to surface, and emitters' incentives favor
loudness. This design inverts that: **sources only request a posture; the
user's ranker — running with the user's policies, structurally on the user's
side — decides**. The runtime's job is to make that inversion enforceable
(CFC write-gating on the canonical ledger), cheap (derived queries over
stores the user already holds, no second event journal), and portable across
surfaces (one envelope, per-platform adapters).

Five load-bearing moves:

1. **One ledger, one posture scale.** Attention items land on exactly one
   rung of an ordered scale — `silent` → `review` → `heads-up` →
   `interrupt` — and the rung is the promise made to the user (§4.2). The
   system is biased downward: a source earns its way up through **learned
   policies** the user can read and edit (§7), and every
   dismiss-without-open pushes its future items back down.
2. **The ranker is the only writer.** The canonical ledger carries a
   `writeAuthorizedBy` claim; untrusted patterns can emit candidates and
   render their own local views, but cannot spam the ledger (§6).
3. **Attention over artifacts is derived, not emitted.** The runtime already
   versions every entity (memory-v2 `seq`), and the version already crosses
   the wire on every query result; exposing it is one small read-only
   primitive, the changes projection (§10.1). Seen-state is one small
   relation — last observed version per (user, entity) — and "unseen
   change", "while you were away", item currency, and the artifact
   lifecycle all fall out as joins against it (§5). For in-fabric sources,
   an attention item is a *view over* "an artifact you care about changed",
   which dissolves the "every pattern must remember to emit notifications"
   problem.
4. **Policies are user-owned cells**, not ranker code. The core ships a
   good-enough default fold; the bespoke last 20% ("library book due"
   escalations, quiet hours, per-thread mutes) is data the user — or a
   pattern, on proposal, or the ranker itself, legibly (§7) — writes.
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
enforcement of the user's posture clamps, not re-litigating the product's
preparation decisions.

### Vocabulary

*Item* — a materialized record in the ledger (*claim* when speaking of what
it means to the user). *Candidate* — the same envelope before the ranker
assigns `id`, `posture`, and `weight`; not a separate type. *Ledger* — the
items store specifically. *Attention state* — the triple of stores (items,
actions, seen — §4.5). *Lane* — a shell projection over attention state
(most lanes correspond to a posture rung; some, like the snoozed lane, are
lifecycle views).

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
  This includes what the system learns on its own: learned policies are
  visible and editable, never hidden state.
- Close the loop without a context switch where the platform allows it:
  one-tap approve/deny/done and direct reply from the surface (§4.6).
- Per-viewer lanes over shared state: the same event can interrupt one member
  of a space and be texture for another.
- OS delivery (Web Push, APNs/FCM) as replaceable adapters over the same
  ledger, honoring per-platform replace/retract semantics and the item's
  confidentiality labels (§9.3).

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
  (the artifact, the draft, the conversation); within a thread, the newest
  live claim displaces older ones (§6.4) rather than piling on.

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

### 4.2 The posture scale

One ordered scale:

```text
suppress < silent < review < heads-up < interrupt
```

`suppress` is rank zero: never materialized for this user (distinct from
`silent`, which is recorded and findable). Every materialized item occupies
exactly one rung, and the rung is a promise:

| Posture | Promise to the user | Typical projection |
|---|---|---|
| `silent` | "Recorded; you'll find it if you look." | seen-state dots on artifacts, history views |
| `review` | "Batched for your next review; no urgency." | digest, review queue — bounded history, not a feed |
| `heads-up` | "Look when you next check in; we'll hold it." | shell bell/badge count, quiet OS delivery |
| `interrupt` | "Worth breaking your flow for." | OS banner/sound, in-shell takeover |

Two invariants:

- **Downward bias.** Defaults sit low (`silent`/`review`). Sources *request*
  a posture; the ranker assigns the real one via the policy clamp (§7), and
  repeated dismiss-without-open feeds back as learned clamps. Crucially,
  **no emitter-controlled field may raise posture**: reaching `interrupt`
  (or `heads-up` above a source's learned baseline) requires a user-adopted
  policy floor — never urgency claims, expiry times, or any other field the
  emitter writes. An emitter cannot buy `interrupt` with enthusiasm.
- **Attention ≠ confidence.** How sure the system is about an item and how
  loudly it surfaces are separate axes. Uncertain-but-urgent goes to
  `heads-up` with its uncertainty stated (product copy; `ext` if structured);
  certain-but-routine stays in `review`.

The rung names deliberately match the posture vocabulary the Loom product
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
Candidate intake (durable; quota-gated append)   §6.1, §10.2
  ▼
Ranker (per-user, trusted single writer)         §6
  folds candidates × policy cells (§7)
  assigns posture + weight; coalesces; writes the ledger
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

A **candidate** is this envelope minus the ranker-assigned fields (`id`,
`posture`, `weight`); the ranker *promotes* candidates to items. One type,
two stages.

```ts
// Shown for illustration only.
// A source-entity version: memory-v2 seq is per-space (a space-global
// Lamport clock, monotone per entity), so versions are only comparable
// within the same space. Read via the changes projection (§10.1).
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
  // The item is the invitation; the source is the truth.
  source: unknown;            // asCell: ["cell"]
  // Source classification ("group-chat", "importer", "agent-run", ...).
  // First-class because policy matching (§7) and digest grouping (§9.2) key
  // on it. BOUND BY THE RANKER to the source's verified identity: the
  // first-seen kind for a given source sticks; a source changing its
  // declared kind is itself a reputation signal (and does not escape
  // kind-matched clamps, which follow the source identity).
  sourceKind: string;
  // The source entity's version at emission. Drives coalescing (same id,
  // advancing version) and re-emergence tombstones (§4.7).
  sourceVersion: EntityVersion;
  // Grouping key for presentation AND displacement: within a threadKey,
  // only the newest live claim is visible (§6.4). One conversation, one
  // task, one agent run (threadKey = run id).
  threadKey?: string;
  // Who this claim is about/from (a DID when known): "Ana: running late"
  // vs "New message". Serves OS payloads, digest grouping, and §5's
  // "by whom" in one field.
  actor?: string;

  // Content. Snapshot at emission (title/body) plus the live destination.
  title: string;
  body: string;
  // Redacted variant for untrusted displays: lockscreens and push relays
  // (§9.3). When absent and labels forbid egress, adapters send a generic
  // envelope and fetch full content on unlock/open.
  redacted?: { title: string; body: string };
  // Focused destination: a stored cell link navigated with navigateTo().
  target: unknown;            // asCell: ["cell"]
  // Optional link to prepared material (draft, diff, packet) when it is a
  // different artifact than target.
  prepared?: unknown;         // asCell: ["cell"]
  // Close-the-loop affordances rendered on the surface itself (§4.6):
  // approve/deny, done/later, inline reply — act without opening the app.
  actions?: Array<{
    key: string;              // semantic key, recorded in the acted action
    label: string;
    input?: "text";           // direct reply / free-text input
    // Durable endpoint in the source space; acting appends
    // {key, input?, itemId, at} under the user's ordinary session
    // authority — the same authority the user would have acting in-app.
    // No new trust surface.
    handler?: unknown;        // asCell: ["cell"]
  }>;
  // Live progress for ongoing work ("agent is 60% through your refactor").
  // Progress updates are same-rung coalesces and therefore silent (§9.3).
  // Absent total = indeterminate. Rich live chrome (Live Activities) is a
  // later adapter track; the field is the floor every surface can render.
  progress?: { done: number; total?: number };

  // Routing. requestedPosture is advisory input from the source; posture is
  // assigned by the ranker and is the only one surfaces read.
  requestedPosture: "silent" | "review" | "heads-up" | "interrupt";
  posture: "silent" | "review" | "heads-up" | "interrupt";
  // Intra-rung ordering, ranker-assigned. Opaque; never crosses rungs;
  // never gates delivery (§4.2).
  weight?: number;

  emittedAt: number;
  notBefore?: number;         // embargo: hold materialization until then
  expiresAt?: number;         // evaluate-on-read; swept terminally by the
                              // ranker (§4.7, §9.3)

  // Opaque product extension. Disciplined by invariant: NO runtime-derived
  // predicate, NO ranker fold step, and NO policy match may read ext — it
  // is a round-trip channel for product fields (Loom's why_now, channel,
  // authorization_state — Appendix A), not a side door into routing. An
  // ext key consumed by two independent products is a candidate for
  // promotion to the envelope (or a sign the envelope is wrong).
  ext?: Record<string, unknown>;
};

// Append-only per-item action log — the state-bearing user dispositions.
// Deliberately small: "seen" is NOT an action (it lives in the seen store,
// §4.5/§5, and item-seen is a join); "muted" is NOT an action (mute IS a
// policy write, §7). Cause-preservation across the three terminal types is
// the point: undo, history, and calibration all key on it.
type AttentionAction = {
  itemId: string;
  type: "dismissed" | "snoozed" | "archived" | "acted";
  at: number;
  // Which surface the action came from (shell, os-tray, digest, ...). Lets
  // policy decide e.g. "os-tray dismiss clears that device only".
  surface: string;
  by: string;                 // DID; or the ranker's module identity for
                              // system-on-behalf actions (expiry sweep,
                              // thread displacement — §4.7)
  // The sourceVersion the action was taken against. A dismissal tombstones
  // that version; if the source advances past it, the item re-emerges (the
  // ranker's coalesce advances sourceVersion past the tombstone — one
  // operation, not a separate mechanism) and the old dismissal no longer
  // applies. Comparable only within sourceVersion.space.
  againstVersion: EntityVersion;
  payload?: unknown;          // snoozeUntil, acted {key, input?}, ...
  ext?: Record<string, unknown>; // product extension (e.g. calibration
                              // feedback like "not-useful"); same
                              // discipline as item.ext
};
```

Nothing stores `active`, `dismissed`, or `unread` flags — dispositions are
derived. And critically, **currency is a local join, not a cross-space
read**: an item is *observed-satisfied* once the user's own seen mark on its
target reaches the item's version. This is the Android behavioral gold
standard — view the source anywhere, the notification retracts everywhere —
computed entirely from the user's own stores:

```ts
// Shown for illustration only.
const sameSpaceGte = (a: EntityVersion, b: EntityVersion) =>
  a.space === b.space && a.seq >= b.seq;
const terminal = (n: AttentionItem, log: AttentionAction[]) =>
  log.some((a) =>
    (a.type === "dismissed" || a.type === "archived" || a.type === "acted") &&
    sameSpaceGte(a.againstVersion, n.sourceVersion)
  );
const observedSatisfied = (n: AttentionItem, seen: SeenStore) =>
  sameSpaceGte(seen.versionOf(n.target), n.sourceVersion);
const visible = (
  n: AttentionItem, log: AttentionAction[], seen: SeenStore, now: number,
) =>
  !terminal(n, log) && !observedSatisfied(n, seen) &&
  !snoozedUntil(log, now) &&
  (n.notBefore === undefined || now >= n.notBefore) &&
  (n.expiresAt === undefined || now < n.expiresAt);
```

Claims that should outlive observation (a todo is not done because you
looked at it) are *re-emitted deliberately* — a deadline policy or the
source's own artifact change produces a fresh claim at a newer version —
rather than the runtime guessing which glances "count". Source-side
satisfaction that doesn't involve the user looking (someone else handled it;
the trip ended) is the ranker's job: its fold observes the source change and
terminally retracts the item (system `acted`/`dismissed` by module
identity).

A caveat on "cheap": pull-based scheduling makes *unobserved* queries free
(`docs/specs/pull-based-scheduler/README.md`), not observed ones. A mounted
lane is a live subscription over the user's own three stores — no per-item
cross-space reads (that was a design bug this revision fixed; cross-space
reading happens once, in the ranker's fold) — and §4.5's write discipline
bounds how often those stores change.

### 4.5 Storage

Attention state lives in the **user's home space** (home space DID = user
identity DID; the established home for durable per-user state, alongside
favorites and journal — see `docs/common/conventions/HOME_SPACE.md`). It is
three stores, and the three backings are not ad-hoc — they derive from a
2×2 of **writer authority × reactivity coupling**:

| | wakes lane queries | must never wake lane queries |
|---|---|---|
| **ranker-only writes** | `items` | *(learned policies live with §7 policies, not here — they are user-visible data)* |
| **any-surface writes** | `actions` | `seen` |

1. **`items`** — written *only* by the ranker. Backing for phase 1:
   a **durable array cell carrying the `writeAuthorizedBy` claim**, the
   mechanism already protecting profile links in production
   (`docs/common/conventions/HOME_SPACE.md`,
   `packages/runner/src/cfc/prepare.ts`). Coalescing (same `id`, source
   advanced) is an in-place element update by the single leased ranker
   instance (§6.2); coalescing **refreshes** content, `expiresAt`, and
   `progress` — a re-emerged claim carries the new emission's lifetime, not
   a stale one. This is deliberately *not* sqlite yet: `writeAuthorizedBy`
   is enforced on the cell-write prepare path and **does not gate
   `db.exec`** today — sqlite's implemented CFC covers confidentiality
   ceilings and row-label rules, not write authorization
   (`docs/specs/sqlite-builtin/06-cfc.md`). Migrating `items` to a sqlite
   table (better ranking/pagination/retention at volume) is gated on the
   net-new work item in §10.3, and on giving `items` **its own database**:
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
3. **`seen`** — the seen store (§5), highest write rate in the system,
   ships in phase 0 and gets its own store so its writes never wake lane
   queries eagerly (lanes sample it; the join is evaluated on lane
   re-render, not per seen-write). One mark per entity, upserted:
   recommended backing is a small **sqlite database private to seen-state**
   (upsert-by-key is what SQL is for; no trust gating needed — every
   surface of the *user's own runtime* may write the user's own marks),
   with an array-cell fallback. Write discipline is part of the spec, not
   an optimization: **seen = focused open** (§5), a mark is written **only
   when it advances** (`newSeq > seenSeq` — re-renders and repeat views are
   no-ops, which is also what breaks any render→write→render cycle) and
   **debounced per focus session** (at most one write per entity per
   focused open). A focused open writes *only* the seen mark — item-seen
   is a join (`observedSatisfied`, §4.4), not a second record; the earlier
   draft's duplicate "seen" action defeated this store's whole reason to
   exist. Retention is trivial — one row per cared-about entity, reaped
   when the care-relation drops the entity.

Two rules regardless of backing:

- **Never model a store as `asCell: ["stream"]`** — stream cells are
  ephemeral (only the marker persists; payloads do not — see
  `docs/specs/space-model/4-cells.md`). Streams are append *endpoints*, not
  logs. This matters doubly for ingress: webhook payloads ride an ephemeral
  stream, so a **receiving handler must persist candidates durably at
  ingress** — otherwise external candidates arriving while no ranker is
  live are lost permanently, not delayed (§6.1).
- **Never `set()` a whole array** that has more than one writer.

Retention: the ranker's sweep terminally retracts expired items (system
action, `by` = module identity — this is the *one* expiry mechanism;
`visible()`'s expiry check is the read-side shadow of it, so an expired item
is hidden immediately and reaped eventually) and reaps items that are
terminal with `sourceVersion` below a watermark, plus their actions.
Sweeping is a ranker duty (it owns `items`), bounded and boring by design.
Because sweeping only reaps terminal rows, per-source intake quotas (§6.1)
are what bound a flooding source, not retention.

### 4.6 Actions on the claim

The most attention-respecting affordance in existing systems (Android
actions + direct reply) is closing the loop *without opening the app* —
approve/deny, done/later, reply, from the shade or the bell. The envelope's
`actions` field carries it:

- Rendering: shell lanes and OS adapters render `actions` as buttons (plus
  an inline input when `input: "text"`). Android compiles to
  `Notification.Action`/`RemoteInput`; Web Push to `showNotification`
  actions (buttons; inline text where supported); the shell renders
  natively. The PWA floor holds — Web Push supports action buttons.
- Acting: writes the ordinary `acted` action (`payload: {key, input?}`),
  which is terminal; and, when `handler` is present, appends
  `{key, input?, itemId, at}` to the handler cell in the source space
  **under the user's ordinary session authority** — exactly the authority
  the user would exercise replying in-app. No new trust surface: the
  source granted itself read on its own cell, and the user could always
  write there through the source's own UI.
- The "needs your approval" genre (Loom's `authorization_state:
  proposal-required`) compiles to `actions: [approve, deny]` — the approval
  affordance travels with the claim instead of forcing navigation.

### 4.7 Lifecycle

For review clarity, the full per-(user, item) state machine, every
transition named once:

```text
(candidate) --ranker fold: clamp > suppress--> MATERIALIZED
MATERIALIZED --now < notBefore--> EMBARGOED --time--> VISIBLE
VISIBLE --user: dismissed|archived|acted--> TERMINAL
VISIBLE --ranker: source satisfied / thread displaced / expiry sweep
         (system action)--> TERMINAL
VISIBLE --user: snoozed--> SNOOZED --snoozeUntil--> VISIBLE
VISIBLE --seen mark on target reaches sourceVersion--> OBSERVED-SATISFIED
         (hidden; no action row — pure join)
VISIBLE --now ≥ expiresAt--> hidden immediately (read-side),
         TERMINAL at next sweep (write-side)
TERMINAL --ranker coalesce advances sourceVersion past tombstone-->
         VISIBLE (re-emergence: a consequence of coalescing, not a
         separate mechanism)
TERMINAL + below watermark --sweep--> reaped
```

Posture may change after materialization (escalation raises it, collective
handling demotes it — §8); §9.3 defines alerting and retraction in terms of
these posture transitions. **Policy changes re-fold**: policy cells are fold
inputs, so a policy commit wakes the ranker and materialized items re-lane —
muting a thread demotes its existing items, not just future ones.

## 5. Seen-state and attention over artifacts

The most common attention event in practice is not "interrupt me" — it is
"an agent (or another member) did work while I wasn't looking, and I need to
be able to *see that it happened*". That is not a notification; it is
seen-state.

**The seen store** is one small relation per user: the last version of an
entity the user actually observed. "Observed" is defined strictly:
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

Everything else is the **changes projection** (§10.1) joined against marks:

- `unseen(entity)` = `changes([entity], sinceSeq: seenVersion.seq)` is
  non-empty → change dots on artifacts and their containers (space lists,
  home).
- **"While you were away"** = one `changes(careSet, basis: seenWatermark,
  attribution: true)` call, grouped by run/thread then space, ordered by
  the ranker. Renders as a pattern on the home context. This is the
  first-run view and the every-return view — the same query. The affordance
  must answer *what changed, by whom, since you looked* — the projection's
  `author` field gives session-grain attribution from day one (§10.1) — and
  a jump-in that emphasizes the changed region (memory-v2 holds both
  versions; the diff is derivable). A bare dot that says "something
  happened" does not meet the bar (§4.1).
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
receipt-shaped claim per run (`threadKey` = run id), and the
while-you-were-away view folds entity changes under the run's receipt by
**attribution**: changes whose `author` is the run's session group beneath
the receipt rather than appearing as free-floating dots. (Attribution-based
folding, not an envelope field — the changes projection already carries the
join key.) Phase 0 — dots only — does not have this, which is a stated
limitation, not an oversight: phase 0 makes agent work *visible*; run-level
legibility is phase 1's tracked follow-through (§11).

**The care-relation** is not a fourth kind of policy — it is **the ranker's
watch set**: the entity set handed to the changes projection, seeded by
derived defaults (*touched-recently ∪ agent-did-it-for-you*) and extended by
explicit watch/unwatch policies (§7). Getting the defaults right is an open
question (§12.2); getting them wrong in the "too broad" direction is the
failure mode to avoid (dots everywhere = dots nowhere).

## 6. The ranker

**One logical ranker per user.** It folds candidates and policies into the
ledger, assigns postures and weights, coalesces (same `id` when the same
source object advances — re-emergence is this same operation crossing a
tombstone), applies thread displacement (§6.4), retracts source-satisfied
claims, and sweeps retention (§4.5).

### 6.1 Candidate intake

Candidates must be **durable before ranking**: the ranker may be asleep or
absent (interim mode, closed clients), and ephemeral candidates would be
silently lost, not delayed. Intake shape:

- In-fabric artifact changes need no *emission* — they are derived (§5).
  (They do need *reach*: until server-side cross-space wake exists, changes
  in other spaces reach a server-side ranker via the same forwarding path as
  explicit candidates below; a client-side ranker reads them directly
  through the user's ordinary sessions.)
- Pattern-emitted candidates land in the **candidate inbox in the user's
  home space** — a cross-principal, quota-gated append surface, named
  net-new work (§10.2), because it is the one place untrusted-ish writers
  meet the user's home space: the write gate enforces per-source quotas
  against the *verified writer identity*, not against self-reported fields.
  Until §10.2 lands, candidates rest in a durable per-source cell in the
  space where they arise and the ranker reads them there (client-side
  interim), with quotas enforced at fold time — weaker (a flood bloats the
  source-space cell, not the home space) but sound.
- Webhook ingress: the receiving handler persists the payload durably at
  ingress (§4.5); the ephemeral stream is transport, not storage.
- Quota pressure and dismiss-without-open feed the same **learned-policy**
  signal (§7): the source's baseline clamps down, legibly.

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
  commits to the candidate inbox, the policy cells, or forwarded
  care-events. Execution is attributed `onBehalfOf` the user. Named
  dependencies, since that spec's workers, registrations, and wake-on-commit
  are all **per-space**: standing registrations are its own later phase;
  scoped (`PerUser`) state claims are gated (its G16); server-side
  *cross-space* reads/wake are explicitly deferred there — which is exactly
  why intake forwards into the home space instead of the ranker reading N
  spaces.
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
predicates hot. `visible()` evaluates on surface demand over the user's own
stores (§4.4). The one push-shaped duty is OS delivery (§9.3), which is
explicitly an edge adapter fed by wake-on-commit, not a hot loop.

### 6.4 Coalescing and thread displacement

Three mechanisms in the earlier draft (`id`-coalescing, `threadKey`
grouping, an emitter-declared `displaces` list) are two in this one, at
distinct altitudes:

- **`id` is identity**: the same claim at a newer source version. Coalescing
  updates the item in place (refreshing content, expiry, progress);
  crossing a dismissal tombstone is re-emergence. Identity is
  ranker-derived from verified provenance (§4.4), so it cannot be forged.
- **`threadKey` is the thread**, and displacement is a *derived rule over
  it*: **within a threadKey, only the newest live claim is visible**; older
  live claims in the thread are terminally retracted by the ranker (system
  action) when a newer one materializes. A prepared result therefore
  displaces the raw occurrence by *sharing its thread*, not by naming item
  ids — no displacement chains, no tombstone bookkeeping for the emitter,
  and "the displaced item's source advances again" needs no special case
  (it is simply the thread's newest claim again). Cross-thread or
  multi-target displacement is deliberately not expressible; a consumer
  who needs it should make the case with a concrete scenario (§12.7).

## 7. Policies

A policy is a small declarative record the ranker folds over — **data, not
ranker code**:

```ts
// Shown for illustration only.
type AttentionPolicy = {
  match: {
    source?: unknown;         // asCell: ["cell"] — a specific source/thread
    sourceKind?: string;      // as bound by the ranker, §4.4
    spaceDid?: string;
    threadKey?: string;
  };
  effect: {
    // One clamp on the one ordered scale (§4.2):
    // suppress < silent < review < heads-up < interrupt.
    clamp?: { min?: "review" | "heads-up" | "interrupt";
              max?: "suppress" | "silent" | "review" | "heads-up" };
    // Exempts this policy's min from quiet-hours clamping (the babysitter
    // thread breaks through). User-set only.
    bypassQuietHours?: boolean;
    coalesceWindowMs?: number;
    // Time-conditional clamp sugar: during these hours, max = "review".
    quietHours?: { start: string; end: string };
    watch?: boolean;          // extend/prune the care-relation (§5)
  };
  reason?: string;            // human-legible: why this policy exists
  createdBy: string;          // user DID; a pattern's module identity for
                              // proposals; the RANKER's module identity for
                              // learned policies (see below)
};
```

**Composition is one formula.** Effective posture =
`clampScale(baseline, max(matching mins), min(matching maxes))` where
`baseline` is the requested posture bounded by the source's learned
baseline; **maxes dominate mins** on conflict, with one exception —
a user-created min marked `bypassQuietHours` survives the quiet-hours max.
`quietHours` is defined as nothing more than a time-conditional
`max: "review"`. The canonical case — "quiet hours 22:00–07:00, but the
babysitter thread always breaks through" — is two records and zero
ambiguity.

- Policies live in the user's home space (`PerUser` scope). The core ships a
  handful of defaults: messages-from-humans → `heads-up`;
  agent-completions → `silent` (visible as seen-state, never buzzing).
  There is deliberately **no default that maps any emitter-supplied field to
  `interrupt`** — deadline-driven interruption ("library book due
  tomorrow") exists only as a user-adopted policy min on a named source.
- **Mute is a policy, not a special relation** (and not an action type).
  "Mute this thread" writes `{match: {threadKey}, effect: {clamp: {max:
  "suppress"}}}`; the re-fold rule (§4.7) demotes existing items too.
- **Patterns propose, the user disposes.** A pattern can ship a suggested
  policy with its artifacts ("library book due → heads-up 3 days before");
  adoption goes through a trusted surface, exactly like other user-consented
  writes — adoption *is* the write, and unadopted proposals never enter the
  fold. (Onboarding flows that propose an initial policy set are this same
  primitive N times, batch-confirmed by a product surface — out of scope,
  §Non-goals.)
- **Learned policies: the reputation loop, made legible.** The downward
  feedback the spec promises (dismiss-without-open, quota pressure ⇒ the
  source's items sink) has to live *somewhere*, and hidden ranker state
  would break the inspectability goal. It lives here: the ranker — which is
  already the trusted fold, not a third party petitioning for adoption —
  writes ordinary policy records (`createdBy` = its module identity,
  `reason` = the evidence, e.g. "7 of 8 items dismissed without open over
  30d") into a designated **learned** section of the policy store. They are
  visible, editable, and deletable exactly like hand-written policies; a
  user deleting one is itself a signal. Learned policies may only *lower*
  (set maxes / lower the baseline) — raising posture remains exclusively
  user-authored (§4.2). This follows the platform's existing precedent for
  system-inferred-but-user-owned data (`packages/home-schemas/learned.ts`).
- **Product policy dimensions compile down.** Stance-like vocabularies
  (Loom's `attention-policy-v1`) do not ride an opaque field on runtime
  policies — there is deliberately no `policy.ext`, because an opaque blob
  on the user's routing rules would imply a second, shadow interpreter of
  the same cells. Product policy systems keep their own records and
  *compile* to plain runtime clamps/watches, exactly as a trusted source
  compiles its channel semantics to requested postures.
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
  source *is* mutated, everyone's claims coalesce or satisfy for free; when
  it isn't, a disclosed `acted` is the only retraction signal others can
  get. A per-space opt-in policy — *"acted-by-any-member demotes to
  `silent` for all"* — turns that signal into collective quiet.
  Disclosure is a per-space policy cell (some spaces want receipts, some
  don't); a member who discloses nothing simply doesn't appear.
- **Escalation across people is a policy.** "If nobody attends to this
  within 2h, raise it to `heads-up` for the space owner" is a policy cell on
  the shared space, evaluated by the owner's ranker against contributed
  state. No siloed notification system can express this; here it is one
  record. (Escalation is a posture *raise* after materialization; §9.3's
  transition rule makes it alert exactly once.)

## 9. Surfaces

### 9.1 Shell

The shell renders attention state; it does not own attention logic. Per the
"pattern on the context" resolution: the home/shell context declares how the
attention surface renders, so it is replaceable like the rest of the home
experience. Concretely:

- lanes: `interrupt` (modal-adjacent), `heads-up` (bell + badge count),
  `review` (digest entry point), `silent` (dots via seen-state, §5);
- unseen-change dots on artifacts and containers;
- a snoozed lane (snoozed items must stay discoverable);
- item `actions` rendered in place (§4.6);
- **focused opens** — never renders — write the seen mark, under §4.5's
  advance-only + debounced discipline. Rendering a lane writes nothing.

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

- **Alerting rides posture transitions, not writes.** A delivered item
  alerts when it first materializes at an alert-bearing rung and again only
  when the ranker *raises* its posture (escalation, §8); every same-rung
  coalesce — new message in the thread, progress tick, content refresh —
  **replaces silently** on every surface (Android `setOnlyAlertOnce`
  semantics, made unconditional: the emitter cannot choose to re-buzz).
  Posture *demotion* and visibility flips are retraction triggers: the
  dispatcher retracts or downgrades the delivered surface when either
  occurs. Without this rule a coalescing thread would legally buzz on
  every advance — louder than Android, inverting the spec's promise.
- **Replace/retract rides `id`** everywhere: iOS
  `UNNotificationRequest.identifier` / `apns-collapse-id`, Android
  `notify(id)`, Web Push `options.tag`. Two honesty notes. First,
  transitions are evaluated on commit-driven wakes and on read — **nothing
  wakes anything at `expiresAt`**: server-side timers don't exist yet (they
  are "(Future)" in `docs/specs/server-side-execution/`), so an expired
  item may linger on an OS tray until the next wake re-evaluates it. Timer
  registrations that feed the dispatcher are named net-new work (§10.5);
  until they land, expiry is evaluate-on-read with explicitly stale OS
  surfaces (the ranker's sweep is the terminal write-side, §4.5). Second,
  iOS replaces but does not tick (text refreshes when the shade reopens);
  genuinely-live claims (`progress`) render best-effort per platform, and
  rich live chrome (Live Activities) is a separate later track.
- **Confidentiality crosses the push boundary explicitly.** Push payloads
  and lockscreens are untrusted displays: they carry `redacted` when
  present, otherwise a generic envelope ("Update from <sourceKind>"), with
  full content fetched on unlock/app-open (the conventional
  mutable-content/fetch-on-receive shape). Items whose confidentiality
  labels forbid egress to the push relay get the generic envelope
  unconditionally — the same CFC labels that govern every other flow govern
  this one; a system that gates reading a version number (§10.1) does not
  get to mail full message bodies through third-party relays unexamined.
- **Two transports, not one.** Browser/PWA: Web Push (VAPID + service
  worker). Wrapped mobile apps: native APNs/FCM via the wrapper's plugin —
  embedded webviews do not get Web Push. The server side (toolshed) needs a
  device-registration table `{userDid, deviceId, transport, token}` and a
  delivery ledger `{itemId, deviceId, platformIdentifier, deliveredAt,
  retractedAt}` so retraction can target what was actually delivered.
  Ship Web Push first; the envelope is transport-agnostic.
- **The PWA is the floor.** The canonical shape includes nothing that cannot
  be expressed on the most-constrained surface (action buttons included —
  Web Push has them); richer platforms are adapter opt-ins, not envelope
  fields.
- **Tray-dismiss is per-device by default.** An OS-tray dismissal writes an
  action with `surface: "os-tray"`; whether it terminates the item globally
  is policy (default: clears that device only; the shell is canonical).

## 10. Net-new runtime surface

This design mostly composes existing primitives, but not entirely. Naming
the gaps is the point of this section — each is a prerequisite of the phase
that first needs it (§11), and each needs its own (small) design pass.

1. **Changes projection** *(phase 0)*. Patterns and the shell cannot read an
   entity's memory-v2 head `seq` — `Cell` exposes no version, deliberately —
   yet `seq` already crosses the wire in every query result
   (`FactEntry.seq`, memory-v2 §5.7.1), and changed-since-a-basis is
   precisely the session catch-up computation (memory-v2 §5.4.2,
   `SessionSync.fromSeq/toSeq`). Rather than a Cell method, seen-state
   needs one small **read-only, one-shot, session-independent query**:

   `graph.changes(roots, branch, sinceSeq?, attribution?) →
   { toSeq, entries: [{id, seq, deleted?, author?}] }`

   (a) With a single root and no basis it is the **non-reactive head read**
   — a one-shot query, not a watch, so re-renders never re-fire. (b) With
   the care-relation as roots and the seen watermark as basis it is the
   **"while you were away" enumeration** — one indexed scan of the `head`
   table (add a `(branch, seq)` index). (c) With `attribution: true` it
   joins the commit log's already-persisted `sessionId` — **session-grain,
   server-asserted "by whom" from day one**, upgrading in place to
   `invocationRef`-backed proof when the signed-write pass lands (a join,
   not a cryptography project). CFC: an entity may appear in a changes
   result iff the caller may read the entity on that branch — strictly less
   than a materialized read reveals. Not attention-specific: offline
   catch-up UIs, activity/audit views, incremental derived indexes, and
   retention watermarks consume the same query. It is the entity-grain,
   payload-free member of the projection family memory-v2 §07 sketches —
   and deliberately *not* built on §07's annotations plane, which is
   range-anchored collaborative-field machinery, self-declared future work;
   the one annotation prototype's review (PR #4132) documents why
   side-table indexes invisible to the reactive graph are the wrong shape.
2. **Candidate inbox append gate** *(phase 1; hardened by phase 2)*. A
   home-space inbox cell with **restricted cross-principal append**: other
   principals' patterns may append candidates (the rosters
   contribute-your-own idiom, reversed) but the write gate enforces
   per-source quotas against the verified writer identity. This is what
   makes dead-device delivery an authority question with an answer instead
   of an open question — the full chain "someone messages me while all my
   devices are closed → my phone buzzes" is inbox append → home-space
   wake → ranker fold → dispatcher push.
3. **Write-authorization for sqlite** *(pre-migration of `items` to sqlite;
   not needed for phase 1's array-cell backing)*. `writeAuthorizedBy` is
   enforced on the cell-write prepare path only; `db.exec` today checks
   confidentiality ceilings and row-label rules but not write authorization.
   Gating `db.exec` per database handle (the `rev` bump is a cell write, so
   the prepare path sees it) needs specification and a security review of
   its own, including whether any sqlite write path bypasses the rev write.
4. **Ranker lease** *(phase 1)*. A small mutex-cell convention (claim with
   expiry, renew, steal-on-expiry) for single-instance election of the
   interim client-side ranker (§6.2). Generalizes beyond attention.
5. **Timer wake** *(phase 2+)*. Executor-pool timer registrations
   (`notBefore`, `expiresAt`, snooze expiry, digest cadence) feeding
   wake-on-commit's machinery, so time-driven transitions don't depend on
   coincidental commits. Until then: evaluate-on-read, stale OS surfaces
   acknowledged (§9.3). Note this also bounds the "library book due"
   genre: alarm-shaped interruption is only as timely as the wake source.
6. **Push transports** *(phase 2/3)*. Web Push then APNs/FCM: device
   registration, delivery ledger, retraction dispatch (§9.3). Net-new but
   conventional.

## 11. Phasing

Each phase is independently shippable and none re-shapes the data model.

- **Phase 0 — seen-state.** The changes projection (§10.1), the seen store
  with its write discipline (§4.5.3), unseen dots in the shell, and a
  "while you were away" home pattern. No ranker, no candidates, no push.
  Acceptance bar: the user can see *what changed, by whom (session-grain),
  and since when*, and jump in with the changed region emphasized — not
  merely that a dot exists. This makes agent work **visible** — the single
  most-requested product gap — while run-level *legibility* (one claim per
  agent run, not twelve dots) is explicitly phase 1's follow-through.
- **Phase 1 — ledger + lanes.** Envelope, home-space `items` (array cell +
  `writeAuthorizedBy`) and `actions` stores, candidate intake (inbox gate
  §10.2, or interim source-space cells), a minimal client-executed ranker
  under lease (defaults + clamp composition + learned policies + thread
  displacement), shell bell/lanes with item actions (§4.6), receipt-shaped
  claims for agent runs with attribution folding (§5). Policies v0.
- **Phase 2 — server ranker + first transport.** Ranker as a standing
  registration on the home space under server-primary execution
  (dependencies named in §6.3); Web Push with device registration,
  redaction rules, and retraction; digest queries; timer wake (§10.5).
- **Phase 3 — breadth.** Wrapped-app APNs/FCM; shared seen-state +
  disclosed terminal actions + escalation policies (§8); `items` on sqlite
  once §10.3 lands; snooze/archive surfaced fully; `progress` rich chrome
  (Live Activities) as its own track.

## 12. Open questions

1. **Ranker trust binding.** Verified module identity is recommended (§6.2),
   but the "wholly-system service" alternative keeps resurfacing; if the
   server executor itself writes the ledger, is that a builtin identity, and
   does that preempt user-forkable rankers? Resolve before phase 1.
2. **Care-relation defaults.** Touched ∪ agent-authored ∪ watched is the
   working answer for the watch set (§5); validate against real spaces
   before hardening, and decide whether "touched" decays.
3. **Forwarder contract.** Cross-space reach for a server-side ranker
   (§6.1, §6.3): who runs the forwarding (the emitting pattern? the user's
   runtime on visit?), and what happens for spaces the user hasn't opened
   in weeks? Partially subsumed by §10.2's inbox gate; the residue is
   *derived* care-events from spaces with no cooperating emitter.
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
7. **Displacement scope.** Thread displacement (§6.4) deliberately cannot
   express cross-thread or multi-target displacement. If a real consumer
   produces a scenario that needs it, revisit with that scenario on the
   table; until then the simpler rule stands.
8. **Learned-policy dynamics.** Decay (does a learned clamp relax after N
   weeks of the user opening that source's items?), evidence thresholds,
   and whether a user deleting a learned policy suppresses re-learning for
   a period.
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
| `title`, body copy | `title`, `body` (+ `redacted` where the product wants lockscreen-safe copy) |
| `why_now` | `ext.why_now` (product copy, runtime-opaque) |
| `claim_kind` (act-now / review / notice / …) | `sourceKind` + `requestedPosture` (kind is classification; posture is the loudness request derived from it) |
| `channel` (important-and-urgent / yours-in-progress / might-interest-you) | `ext.channel` — audience/genre, orthogonal to posture; product lanes render it |
| `relation_to_trigger` (augments / supersedes / resolves / …) | `ext.relation_to_trigger`, whole; *supersedes* additionally = share the trigger's `threadKey` (thread displacement, §6.4, does the retraction) |
| `authorization_state: proposal-required` | `actions: [{key:"approve"…},{key:"deny"…}]` (§4.6) + `ext.authorization_state` — the approval affordance travels with the claim |
| `authority_class` | `ext` (work-start domain, product-side per §Division of labor) |
| `not_before` | `notBefore` |
| sender / subject person | `actor` |
| delivery/interrupt eligibility | `requestedPosture`, clamped by user policy (§7) |
| feedback: done / later | actions `acted` / `snoozed` |
| feedback: never-for-this-class | a policy write (`clamp.max`) via the trusted surface |
| feedback: not-useful | action `dismissed` + `ext.feedback: "not-useful"` (calibration signal round-trips to the product) |

Not mapped, deliberately: Work-start Policies, continuity owners, typed
receipts' internals, stance vocabularies — upstream product machinery
(§Division of labor); stance policies compile down to plain clamps/watches
(§7). A receipt *summary* enters as an ordinary candidate.

## References

- `docs/specs/shared-profile-rosters.md`, `docs/specs/shared-profile-space.md`,
  `docs/common/conventions/HOME_SPACE.md` — multi-user substrate; the
  contribute-your-own idiom; `writeAuthorizedBy` in production.
- `docs/specs/server-side-execution/README.md` — standing registrations,
  wake-on-commit, `onBehalfOf` attribution (ranker execution home; §6.3
  names this spec's dependencies on it).
- `docs/specs/memory-v2/` — `01-data-model.md` (seq, heads),
  `03-commit-model.md` (optimistic concurrency; commit-log `sessionId` /
  reserved `invocationRef`), `04-protocol.md` + `05-queries.md`
  (`SessionSync` catch-up, `FactEntry.seq` — the shipped machinery behind
  §10.1), `07-op-views-and-annotations.md` (the projection-family framing
  §10.1 borrows; the annotations plane it deliberately does not build on),
  `08-conflict-granularity.md` (mergeable ops).
- `docs/specs/sqlite-builtin/` (esp. `05-reactivity.md`, `06-cfc.md`) —
  seen-store backing; why trust-bearing tables wait on §10.3; `reactOn`
  coarseness; the rev-serialized write path; the `tryClaimMutex` shape §10.4
  borrows.
- `docs/specs/space-model/4-cells.md` — stream-cell ephemerality.
- `docs/specs/pull-based-scheduler/README.md` — demand-driven evaluation
  (and its limits for observed queries, §4.4).
- `docs/specs/webhook-ingress/README.md` — external candidate ingress
  (durable persistence at the handler required, §6.1).
- `packages/home-schemas/` (`journal.ts`, `favorites.ts`, `learned.ts`,
  `home.ts`) — the durable-array + stream-append precedent; stable-key
  discipline; the system-inferred-but-user-owned precedent for learned
  policies (§7).
- `packages/runner/src/cfc/prepare.ts`, `packages/runner/src/cfc/ui-contract.ts`
  — `writeAuthorizedBy` enforcement (cell-write path); trusted surfaces.
- `packages/runner/src/builtins/navigate-to.ts`,
  `docs/common/conventions/wish.md` — navigation from stored cell links;
  well-known targets.
- `packages/ui/src/v2/components/cf-toast/`, `cf-alert`, `cf-badge` —
  existing presentation components.
- `packages/background-piece-service/README.md` — why the ranker does not
  run there.
- PR #4132 (annotation-primitive prototype, draft) — the documented
  anti-precedent for storage-side reverse indexes invisible to the reactive
  graph; §10.1's design constraint.
