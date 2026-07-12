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
today (§3 inventories what exists). The Loom product's in-flight attention
framework and Pond's spatial shell are the first intended consumers; this
spec defines the runtime primitives their product surfaces should compile
onto, so each stops hand-rolling its own attention state. Derived from the
2026-05-21 multi-user/notifications design sessions and the 2026-07 attention
reframe.

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
   versions every entity (memory-v2 `seq`). Seen-state is one small relation
   — last observed `seq` per (user, entity) — and "unseen change", "while you
   were away", and the artifact lifecycle all fall out as queries (§5). For
   in-fabric sources, an attention item is a *view over* "an artifact you
   care about changed", which dissolves the "every pattern must remember to
   emit notifications" problem.
4. **Policies are user-owned cells**, not ranker code. The core ships a
   good-enough default fold; the bespoke last 20% ("library book due"
   escalations, quiet hours, per-thread mutes) is data the user — or a
   pattern, on proposal — writes (§7).
5. **Multi-user needs almost nothing new.** Attention is a per-(user, item)
   relation: a shared space emits one candidate and each member's ranker
   lanes it independently. "Who has seen this" is the same seen-state
   contributed into shared space, read the other direction (§8).

## Goals

- A single canonical attention envelope and ledger that shell, product
  surfaces (Loom, Pond), patterns, and OS adapters all read.
- Make autonomous/agent work *legible* without interruption — the user can
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
  occurrence rather than duplicating it.

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
attention-posture ladder, stance-bearing attention policies, a
capacity-bounded Today block, and a default-weekly digest — materialized in
product-local storage; its current "unseen" affordance is a localStorage
last-seen timestamp per browser. Pond's donut prototype ranks pieces
spatially by an attention score. Both need the same substrate: durable
per-user seen-state, a trustworthy canonical ledger, and per-user policy.
This spec is that substrate.

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
  dismiss-without-open or mute feeds back as posture caps. An emitter cannot
  buy `interrupt` with enthusiasm.
- **Attention ≠ confidence.** How sure the system is about an item and how
  loudly it surfaces are separate axes. Uncertain-but-urgent goes to
  `heads-up` with its uncertainty stated; certain-but-routine stays in
  `review`. The envelope carries them separately.

The ladder deliberately matches the posture vocabulary the Loom product
already uses (silent memory → daily review → timely heads-up → interrupt), so
product surfaces map 1:1 onto runtime postures.

### 4.3 The pipeline

```text
Sources                         emit candidates (requested posture = advisory)
  agents/pieces running as me     │
  pieces I joined, running        │  per-source prefilter: "important within
    as others (group chat)        │   my world?" — cannot judge cross-source
  sharing directed at me          │
  artifact changes (derived, §5)  │
  external ingress (webhooks)     ▼
Ranker (per-user, trusted single writer)         §6
  folds candidates × policy cells (§7)
  assigns posture; coalesces; writes the ledger
  ── writeAuthorizedBy gate: only the ranker's verified
     module identity may write the canonical ledger ──
Ledger (per-user, durable, queryable)            §4.4
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
type AttentionItem = {
  // Identity — THE load-bearing field. Every surface adapter targets it for
  // replace/retract (iOS UNNotificationRequest.identifier + apns-collapse-id,
  // Android notify(id), Web Push options.tag). Deterministic:
  // "<source-system>:<source-key>[:<event-key>]", set by the ranker on first
  // emission and reused for every replacement.
  id: string;

  // Pointer to the source of truth (a stored cell link, not a query string).
  // The item is the invitation; the source is the truth. Used to evaluate
  // active(), to navigate, and as the key for source-scoped policies.
  source: unknown;            // asCell: ["cell"]
  // The source entity's memory-v2 seq at emission. Monotone per entity
  // (space-global Lamport clock — an opaque, comparable token, not a dense
  // counter). Drives replace, retract, and re-emerge semantics.
  sourceSeq: number;
  // Optional grouping key for presentation (one conversation, one task).
  threadKey?: string;

  // Content. Snapshot at emission (title/body) plus the live destination.
  title: string;
  body: string;
  // Focused destination: a stored cell link navigated with navigateTo().
  target: unknown;            // asCell: ["cell"]
  // Optional link to prepared material (draft, diff, packet) when it is a
  // different artifact than target.
  prepared?: unknown;         // asCell: ["cell"]

  // Routing. requestedPosture is advisory input from the source; posture is
  // assigned by the ranker and is the only one surfaces read.
  requestedPosture: "silent" | "review" | "heads-up" | "interrupt";
  posture: "silent" | "review" | "heads-up" | "interrupt";
  // Confidence is orthogonal to posture (§4.2); surfaces may render it.
  confidence?: number;        // 0..1

  emittedAt: number;
  expiresAt?: number;         // time-bound claims retract themselves
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
                              // system-on-behalf actions (auto-expiry)
  // The sourceSeq the action was taken against. A dismissal tombstones that
  // seq; if the source advances past it, the item re-emerges and the old
  // dismissal no longer applies.
  againstSeq: number;
  payload?: unknown;          // snoozeUntil, acted result, mute scope, ...
};
```

Nothing stores `active`, `dismissed`, or `unread` flags. They are **derived,
pull-evaluated queries** — computed when a surface demands them, per the
pull-based scheduler's grain (a claim nobody is looking at costs nothing):

```ts
// Shown for illustration only.
const active = (n: AttentionItem) =>
  currentSeq(n.source) <= n.sourceSeq || stillCurrent(n); // source's call
const terminal = (n: AttentionItem, log: AttentionAction[]) =>
  log.some((a) =>
    (a.type === "dismissed" || a.type === "archived" || a.type === "acted") &&
    a.againstSeq >= n.sourceSeq
  );
const visible = (n: AttentionItem, log: AttentionAction[], now: number) =>
  !terminal(n, log) && active(n) && !snoozedUntil(log, now) &&
  (n.expiresAt === undefined || now < n.expiresAt);
```

### 4.5 Storage

The ledger lives in the **user's home space** (home space DID = user identity
DID; the established home for durable per-user state, alongside favorites and
journal — see `docs/common/conventions/HOME_SPACE.md`).

Recommended storage is a **`sqlite-builtin` database with two tables**
(`items`, `actions`) declared by the attention pattern
(`docs/specs/sqlite-builtin/`):

- The ledger is append-heavy, queryable, and long-lived — SQL gives
  filtering, ranking, pagination, and retention sweeps that an array cell
  makes awkward at volume; `.query<Row>()` reads are reactive.
- `db.exec` commits atomically with surrounding cell writes, and concurrent
  writers serialize on the handle cell's `rev` — which *matches* the
  single-trusted-writer model instead of fighting it.
- Cell links in rows (`cfLink<T>()` columns) keep `source`/`target`/`prepared`
  live and navigable.
- Per-column CFC labels extend the same `ifc` gating to the table.
- Deterministic ids (already required by §4.4) fit `exec`'s
  no-`lastInsertRowid` constraint.

A phase-0 implementation may instead start with a **durable array cell plus
stream append handlers**, exactly following the favorites/journal precedent
in `packages/home-schemas/` (`journal.ts`: durable array; `home.ts`:
`addJournalEntry: { asCell: ["stream"] }` as the append endpoint). Two rules
carry over regardless of backing:

- **Never model the ledger itself as `asCell: ["stream"]`** — stream cells
  are ephemeral (only the marker persists; payloads do not — see
  `docs/specs/space-model/4-cells.md`). Streams are append *endpoints*, not
  logs.
- **Never `set()` the whole array.** Concurrent device writes must use the
  mergeable ops (`push`, `addUnique`, `removeByValue`) so user actions from
  two devices merge against durable state instead of clobbering. Memory is
  optimistic-concurrency with path-aware validation, not CRDT — this design
  needs no CRDT because the ranker is a single canonical writer and user
  actions are mergeable appends.

Retention: `expiresAt` handles time-bound claims; a periodic sweep reaps
rows that are terminal with `sourceSeq` below a watermark. Sweeping is a
ranker duty (it owns the ledger), bounded and boring by design.

## 5. Seen-state and attention over artifacts

The most common attention event in practice is not "interrupt me" — it is
"an agent (or another member) did work while I wasn't looking, and I need to
be able to *see that it happened*". That is not a notification; it is
seen-state, and the runtime already has almost everything needed.

**The seen ledger** is one small relation per user: the last `seq` the user
actually observed, per entity.

```ts
// Shown for illustration only.
type SeenMark = {
  entity: unknown;            // asCell: ["cell"] — the artifact/piece
  seenSeq: number;            // last observed memory-v2 seq
  at: number;
};
```

Everything else is a query over marks joined against current heads:

- `unseen(entity) = head(entity).seq > seenSeq` → change dots on artifacts
  and their containers (space lists, home). The shell writes a `seen` mark
  when the artifact is actually viewed.
- **"While you were away"** = all cared-about entities with unseen changes,
  grouped by space, agent-authored changes flagged (commit attribution says
  who wrote), ordered by the ranker. Renders as a pattern on the home
  context. This is the first-run view and the every-return view — the same
  query.
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

**The care-relation** answers "which entities produce dots at all":
approximately *touched-recently ∪ agent-did-it-for-you ∪ explicitly-watched*,
itself tunable by policy. Getting this right is an open question (§11.2);
getting it wrong in the "too broad" direction is the failure mode to avoid
(dots everywhere = dots nowhere).

## 6. The ranker

**One logical ranker per user.** It folds candidates and policies into the
ledger, assigns postures, coalesces (same `id` when the same source object
advances; same `threadKey` when distinct events share a conversation),
computes re-emergence, and sweeps retention.

**Trust.** The ledger's `items` schema carries a CFC `writeAuthorizedBy`
claim (the same mechanism that already protects profile links in production —
see `docs/common/conventions/HOME_SPACE.md` and
`packages/runner/src/cfc/prepare.ts`). Two viable bindings:

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

**Execution.** Where does the ranker run?

- **Target: the server-primary execution model**
  (`docs/specs/server-side-execution/`). The ranker is exactly the shape that
  model's *standing registrations* exist for — work whose value is its
  effects rather than client-read output — and *wake-on-commit* is its
  trigger: a commit touching a cared-about entity or candidate stream wakes
  the worker, the ranker folds, the ledger updates, connected clients see it
  through the ordinary feed. Execution is attributed `onBehalfOf` the user.
- **Interim: client-side.** Until standing registrations land, the ranker
  runs as an ordinary piece while the user has a client open. This degrades
  gracefully: seen-state and lanes still work (computed on arrival);
  what's lost is delivery to a *closed* client — which is only needed from
  phase 2 (§10) anyway.
- **Not: `background-piece-service` as-is.** It is per-space (the ranker is
  per-user), ~60s polling (the ranker is wake-on-commit shaped), and its own
  README documents async-completion unreliability. If bps is pressed into
  interim service, treat that as scaffolding, not the design.

**Laziness.** The ranker materializes *rows*; it does not keep derived
predicates hot. `active()`/`visible()` evaluate on surface demand
(pull-based). The one push-shaped duty is OS delivery (§9.3), which is
explicitly an edge adapter fed by wake-on-commit, not a hot loop.

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
    postureFloor?: "review" | "heads-up" | "interrupt";
    coalesceWindowMs?: number;
    quietHours?: { start: string; end: string };
  };
  reason?: string;            // human-legible: why this policy exists
  createdBy: string;          // user DID, or module identity for proposals
};
```

- Policies live in the user's home space (`PerUser` scope). The core ships a
  handful of defaults: messages-from-humans → `heads-up`;
  agent-completions → `silent` (visible as seen-state, never buzzing);
  anything with `expiresAt` sooner than ~1h → eligible for `interrupt`.
- **Mute is a policy, not a special relation.** "Mute this thread" writes
  `{match: {threadKey}, effect: {postureCap: "suppress"}}`. The ledger item
  that carried the mute action just records that it happened.
- **Patterns propose, the user disposes.** A pattern can ship a suggested
  policy with its artifacts ("library book due → heads-up 3 days before");
  adoption goes through a trusted surface, exactly like other user-consented
  writes. This is where the bespoke 20% lives, and why the ranker doesn't
  have to be perfect: when it mis-lanes something, the fix is a legible
  one-line policy, written by the user or by their agent on request.
- **Policies are confidential.** "Mute everything from person X" is itself
  sensitive. Policy cells carry confidentiality labels like any other data;
  ranker output must not let an observer reconstruct another user's policies
  (a shared-space member must not be able to detect they've been muted).
  Rich product-level policy dimensions (e.g. stance vocabularies) layer on
  top as additional fields the runtime treats as opaque.

## 8. Multi-user

Three properties, all falling out of "attention is a per-(user, item)
relation" plus existing constraints:

- **One candidate, N ledgers.** A shared space emits one candidate per event;
  each member's own ranker lanes it under their own policies. A new message
  can be `interrupt` for the on-call member and `silent` for the member who
  muted the thread. The emitter cannot know or decide this — correctly so.
- **"Who has seen this" is contributed, not enumerated.** There is no
  runtime primitive for listing a space's members or reaching into their
  home spaces (`docs/specs/shared-profile-rosters.md`), and this design does
  not add one. Shared seen-state follows the roster idiom: members'
  runtimes write their own seen marks into `PerSpace` state in the shared
  space — *if* the space's disclosure policy says to. Read receipts,
  "3 people haven't seen the new plan", presence-of-attention are queries
  over that contributed state. Disclosure is a per-space policy cell
  (some spaces want receipts, some don't); a member who discloses nothing
  simply doesn't appear.
- **Escalation across people is a policy.** "If nobody attends to this
  within 2h, raise it to `heads-up` for the space owner" is a policy cell on
  the shared space, evaluated by the owner's ranker against contributed
  seen-state. No siloed notification system can express this; here it is
  one record.

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
- every render of an item is also the write-path for `seen` actions.

Presentation components exist (`cf-toast`/`cf-toast-provider`, `cf-alert`,
badge conventions); the net-new work is mounting them against ledger
queries.

### 9.2 Digests

A digest is **bounded history, not a feed**: a periodic artifact-shaped
summary over the ledger and seen-state — quiet dispositions, artifact
updates, prepared material, grouped by class — rendered by a pattern. The
runtime contribution is only that the queries behind it (terminal items
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
  `notify(id)`, Web Push `options.tag`. When `visible()` flips false, the
  dispatcher retracts on every delivered surface. iOS replaces but does not
  tick (text refreshes when the shade reopens); genuinely-live claims are a
  Live Activities track, explicitly out of V1.
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

## 10. Phasing

Each phase is independently shippable and none re-shapes the data model.

- **Phase 0 — seen-state.** The seen ledger (§5), unseen dots in the shell,
  and a "while you were away" home pattern. No ranker, no candidates, no
  push. This alone makes agent work legible — the single most-requested
  product gap — and exercises the exact relation everything else builds on.
- **Phase 1 — ledger + lanes.** Envelope, home-space ledger, a minimal
  client-executed ranker (defaults + mute + posture caps), shell bell/lanes,
  candidate emission for non-artifact sources. Policies v0.
- **Phase 2 — server ranker + first transport.** Ranker as a standing
  registration under server-primary execution (wake-on-commit); Web Push
  with device registration and retraction; digest queries.
- **Phase 3 — breadth.** Wrapped-app APNs/FCM; full action vocabulary
  (snooze/archive surfaced); shared seen-state + escalation policies;
  coalescing refinements. Live Activities remain a separate track.

## 11. Open questions

1. **Ranker trust binding.** Verified module identity is recommended (§6),
   but the "wholly-system service" alternative keeps resurfacing; if the
   server executor itself writes the ledger, is that a builtin identity, and
   does that preempt user-forkable rankers? Resolve before phase 1.
2. **The care-relation.** Which entities produce seen-state dots (§5)?
   Touched ∪ agent-authored ∪ watched is the working answer; validate
   against real spaces before hardening, and decide whether "touched" decays.
3. **Ledger backing for phase 1.** sqlite tables (recommended) vs array
   cells (journal precedent). If array cells ship first, define the
   migration to sqlite before volume forces it.
4. **Seen-mark write amplification.** Naive per-view marks write on every
   artifact open, from every device. Batch/debounce policy, and whether
   marks for low-value views are worth persisting at all.
5. **Disclosure defaults** for shared seen-state (§8): receipts on or off by
   default, and what the non-disclosing member's absence reveals.
6. **Policy expressiveness boundary.** V1 is plain predicates. Content
   regexes and LLM-judged predicates ("only interrupt if actually urgent")
   are clearly coming — as ranker inputs they inherit the ranker's authority,
   so they need their own integrity story before admission.
7. **Coalescing.** Same `id` vs same `threadKey` heuristics; sub-object
   edge cases (a thread whose items have their own lifecycles).
8. **`seq` across spaces.** `sourceSeq` is per-space; items whose source
   lives in a different space than the ledger need the pair (space, seq).
   Confirm the envelope treats `sourceSeq` as opaque-with-provenance rather
   than globally comparable.
9. **Digest self-promotion.** May a digest claim `heads-up` on a schedule
   (§9.2)? Leaning policy-gated, default off.
10. **Convergence with product stores.** Loom currently materializes
    attention candidates in product-local storage with localStorage
    seen-timestamps. Define the migration: product candidates become
    candidates into this pipeline; localStorage dots become seen-ledger
    reads.

## References

- `docs/specs/shared-profile-rosters.md`, `docs/specs/shared-profile-space.md`,
  `docs/common/conventions/HOME_SPACE.md` — multi-user substrate; the
  contribute-your-own idiom; `writeAuthorizedBy` in production.
- `docs/specs/server-side-execution/README.md` — standing registrations,
  wake-on-commit, `onBehalfOf` attribution (ranker execution home).
- `docs/specs/memory-v2/` (esp. `01-data-model.md`, `03-commit-model.md`,
  `08-conflict-granularity.md`) — `seq`, optimistic concurrency, mergeable
  ops.
- `docs/specs/sqlite-builtin/` — recommended ledger backing.
- `docs/specs/space-model/4-cells.md` — stream-cell ephemerality.
- `docs/specs/pull-based-scheduler/README.md` — demand-driven evaluation.
- `docs/specs/webhook-ingress/README.md` — external candidate ingress.
- `packages/home-schemas/` (`journal.ts`, `favorites.ts`, `home.ts`) — the
  durable-array + stream-append precedent and stable-key discipline.
- `packages/runner/src/cfc/prepare.ts`, `packages/runner/src/cfc/ui-contract.ts`
  — `writeAuthorizedBy` enforcement; trusted surfaces.
- `packages/runner/src/builtins/navigate-to.ts`,
  `docs/common/conventions/wish.md` — navigation from stored cell links;
  well-known targets.
- `packages/ui/src/v2/components/cf-toast/`, `cf-alert`, `cf-badge` —
  existing presentation components.
- `packages/background-piece-service/README.md` — why the ranker does not
  run there.
