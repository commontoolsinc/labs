# Attention System

A canonical runtime substrate for managing user attention: a per-user
ledger of **notices** written by a single trusted **steward** under the user's
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
cross-principal append gate for the notice inbox (§10.2). The Loom product's
in-flight attention framework and Pond's spatial shell are the first intended
consumers; this spec defines the runtime primitives their product surfaces
should compile onto, so each stops hand-rolling its own attention state
(Appendix A maps Loom's candidate shape onto the envelope; Appendix B walks
fourteen stress-case user stories). Derived from the 2026-05-21
multi-user/notifications design sessions and the 2026-07 attention reframe;
revised 2026-07-12 across four adversarial review rounds (runtime + product;
Android-as-gold-standard + primitive-shape + parsimony; user-story grading +
naming ergonomics; a second story round that re-verified fixes and added
first-contact, catch-up, profile, and cold-start coverage).

## Last Updated

2026-07-12

## Summary

Every existing notification system is biased toward interruption because the
*emitter* chooses how loudly to surface, and emitters' incentives favor
loudness. This design inverts that: **sources only post notices with a
posture hint; the user's steward — running with the user's policies,
structurally on the user's side — decides**. The runtime's job is to make
that inversion enforceable (CFC write-gating on the canonical ledger), cheap
(derived queries over stores the user already holds, no second event
journal), and portable across surfaces (one envelope, per-platform
adapters).

Five load-bearing moves:

1. **One ledger, one posture scale.** Notices land on exactly one rung of an
   ordered scale — `silent` → `review` → `heads-up` → `interrupt` — and the
   rung is the promise made to the user (§4.2). The system is biased
   downward: a source earns its way up through **learned policies** the user
   can read and edit (§7), and every dismiss-without-open pushes its future
   notices back down.
2. **The steward is the only writer.** The canonical ledger carries a
   `writeAuthorizedBy` claim; untrusted patterns can post candidates and
   render their own local views, but cannot spam the ledger (§6).
3. **Attention over artifacts is derived, not posted.** The runtime already
   versions every entity (memory-v2 `seq`), and the version already crosses
   the wire on every query result; exposing it is one small read-only
   primitive, the changes projection (§10.1). Seen-state is one small
   relation — last observed version per (user, entity) — and "unseen
   change", "while you were away", notice currency, and the artifact
   lifecycle all fall out as joins against it (§5). For in-fabric sources, a
   notice is a *view over* "an artifact you care about changed", which
   dissolves the "every pattern must remember to send notifications"
   problem.
4. **Policies are user-owned cells**, not steward code. The core ships a
   good-enough default fold; the bespoke last 20% ("library book due"
   escalations, quiet hours, per-thread mutes, nag-until-done) is data the
   user — or a pattern, on proposal, or the steward itself, legibly (§7) —
   writes.
5. **Multi-user needs almost nothing new.** A notice is a per-(user, notice)
   relation: a shared space posts one candidate and each member's steward
   lanes it independently. "Who has seen this" — and, per disclosure policy,
   "who has handled this" — is the same state contributed into shared space,
   read the other direction (§8).

### Division of labor

This spec owns **routing, terminal state, seen-state, and delivery**.
Everything upstream of a posted notice — deciding whether an agent may
*start* work, preparing material, continuity ownership, receipts, onboarding
interviews that seed policy — is product-side and stays there. A product
framework (e.g. Loom's attention framework) enters this pipeline as a
*trusted source* posting well-prepared candidates with a posture hint; the
runtime steward's job for such a source is cross-source arbitration and
enforcement of the user's posture clamps, not re-litigating the product's
preparation decisions.

### Vocabulary

*Notice* — the unit: a posted announcement with a destination, that waits to
be noticed. A **candidate** is a notice as posted, before the steward admits
it (assigning `id`, `posture`, `weight`) — the same envelope at an earlier
stage, exactly as `wish()` resolves `candidates` into a `result`.
*Disposition* — what the user (or the steward on their behalf) did with a
notice; the append-only log. *Steward* — the per-user trusted fold that admits
candidates, assigns postures, and guards the user's quiet; called a steward,
not a "ranker", because ranking is its most minor duty and it works for the
user, not the feed. (No relation to Loom's retired "Attention Steward"
auto-surfacing system — this is a routing fold, not a suggestion engine.) *Ledger* — the notices store specifically. *Attention
state* — the triple of stores (notices, dispositions, seen — §4.5). *Lane* —
a shell projection over attention state (most lanes correspond to a posture
rung; some, like the snoozed lane, are lifecycle views). *Watch set* — the
entity set whose changes the user's attention system observes (§5).

## Goals

- A single canonical notice envelope and ledger that shell, product surfaces
  (Loom, Pond), patterns, and OS adapters all read.
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
  ledger, honoring per-platform replace/retract semantics and the notice's
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
  write, and proposed-but-unadopted policies never enter the steward's fold.
  (One product obligation this spec *names* because safety depends on it:
  ship an emergency-sources policy pack through this same propose/adopt
  flow — §7, Appendix B.1.)
- **Coverage/miss measurement** ("earn the right to say all caught up") —
  product-layer analytics over the ledger; the ledger just has to be
  complete enough to measure.
- **V1 delivery breadth.** No SMS/email channels, no iOS Live Activities, no
  wearables. `time-sensitive`/`critical` OS interruption levels are not
  *implemented* in V1 (both need platform entitlements) but their adapter
  mapping is **reserved** (§9.3) so user-adopted break-glass policies have
  somewhere to compile when entitlements land.
- **A "list all members of a space" primitive.** The runtime deliberately
  lacks one (see `docs/specs/shared-profile-rosters.md`); multi-user features
  here are designed within that constraint, not around it.
- **Replacing source UIs.** A notice opens its focused destination (the
  artifact, the draft, the conversation); within a thread, the newest live
  notice displaces older ones (§6.4) rather than piling on.

## 3. Background

### 3.1 What exists in labs today

Effectively nothing:

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

### 3.2 Prior art: how the OS notification stacks work

This design borrows deliberately from the OS notification systems — and its
strongest claims are about what their architecture *cannot* express — so
reviewers need the minimum shape of those APIs to judge the comparison.
(Deeper per-field mappings live in the adapter sections, §9.3.)

**The shared architecture.** On every platform, an app granted a one-time
binary permission constructs a notification payload — title, body, media,
optional buttons — hands it to the OS, and **chooses its own loudness**.
Delivery to a device where the app isn't running rides a vendor relay
(Apple's APNs, Google's FCM, a browser's push service) to an OS daemon. The
notification is a **snapshot copy**: once posted, it has no live tie to the
data it describes beyond an app-chosen identifier the app can use to replace
or cancel it. Seen/dismissed state is **per-device tray state** — dismissing
on the phone does nothing on the laptop unless the app hand-builds
push-to-cancel sync. The only cross-app arbitration the user gets is a
chronological pile in a tray.

**Android — the most capable, and this spec's behavioral reference:**

- **Channels**: an app declares named notification categories; after
  creation, the *user* controls each channel's importance, sound, and
  lockscreen visibility, and the app can never raise them — only lower.
  This is the germ of this spec's inversion, but only the germ: the app
  still picks every channel's *initial* importance, can mint fresh channels
  freely (resetting defaults), and the user discovers channels reactively,
  buried in settings, usually after being annoyed.
- **Replace/retract**: `notify(id, …)` with the same id replaces the
  delivered notification in place; `cancel(id)` retracts it.
  `setOnlyAlertOnce(true)` — *optionally* — makes re-posts update silently.
  `setTimeoutAfter(ms)` auto-cancels. Groups get a summary notification.
- **Actions + RemoteInput**: buttons and inline text reply on the
  notification itself — act without opening the app; the input is delivered
  back to the app via a broadcast.
- **Lockscreen visibility tiers**: per notification, public / private /
  secret, with an app-supplied redacted `publicVersion` for untrusted
  displays.
- **Ongoing + progress** notifications; full-screen intents for calls and
  alarms; per-channel do-not-disturb bypass flags.
- **Delivery**: FCM wakes the app process; notifications post with the app
  dead and survive reboot.

**iOS:**

- **Interruption levels** — `passive` (no wake), `active` (default),
  `time-sensitive` (breaks through Focus; requires an entitlement),
  `critical` (breaks mute; Apple-granted entitlement, effectively
  medical/safety only). An OS-enforced ceiling on loudness classes — but
  the *app* picks the level per notification, subject only to those gates.
- **Replace** via `UNNotificationRequest.identifier` (local) and
  `apns-collapse-id` (push). Content freezes at delivery — it refreshes
  when the user reopens the shade but never ticks live; genuinely live UI
  is a separate API surface (Live Activities).
- **Notification Service Extension**: a slice of app code runs on receipt
  and may mutate content before display — the platform's hook for
  decrypt-on-device and fetch-on-receive (the shape §9.3's redaction rule
  compiles to).
- **Focus modes**: user-side routing — which apps and which *people* may
  break through — but coarse: app-grain and contact-grain, with no
  conditions, and each app self-reports what a "person" is.

**Web Push**: VAPID-authenticated push to a service worker;
`showNotification` with `tag` for replace and `actions` for buttons;
payloads are encrypted to the subscription, so the browser vendor's relay
cannot read content (alone among the three). The most constrained surface —
which is exactly why it is this spec's envelope floor (§9.3).

**What the architecture structurally cannot do.** These are not missing
features; they are consequences of "emitter-priced snapshot copies delivered
to per-device trays," and they are the holes this design exists to fill:

1. **The emitter prices its own loudness.** Android's channel initial
   importance and iOS's interruption level are chosen by the party with the
   incentive to interrupt. The user's recourse is reactive and blunt:
   per-app or per-channel toggles, discovered after the annoyance.
2. **Permission is binary and app-grain.** Allow-or-deny at first run.
   There is no "this thread, quietly", no "this source, only until I've
   handled one", no conditional grant — unless the app builds its own
   settings screen, which the OS cannot verify it honors.
3. **The notification is a dead copy.** Nothing retracts it when the
   underlying thing is handled elsewhere; read-state doesn't cross devices;
   the email you answered on your laptop still sits on your phone's
   lockscreen. Well-engineered apps simulate liveness with push-to-cancel;
   most don't.
4. **No cross-source arbitration.** The tray is a chronological pile.
   Nothing sees "forty things are competing for this person right now" —
   notification fatigue is unaddressable at the system level because no
   system-level party holds the queue.
5. **No cross-person semantics.** "Someone on the team handled it" and
   "escalate if nobody does" are unexpressible; every paging product is a
   SaaS control plane bolted on top to compensate.
6. **The relay reads the payload** (APNs and FCM; Web Push excepted).
   Confidentiality requires per-app heroics — end-to-end encryption plus
   on-device decrypt in an extension — rather than being a property of the
   flow.
7. **User policy is not data.** The user cannot write, inspect, or port a
   routing rule. What the OS learned about their preferences (if anything)
   is invisible and vendor-locked.

### 3.3 What this design adopts, inverts, and adds

**Adopted — the mechanics that earned their keep** (this spec's ledger stays
"Android-shaped" so adapters compile 1:1):

- Stable-identity replace/retract → `id`, steward-derived (§4.4).
- Only-alert-once → made *unconditional*: alerting rides posture
  transitions, and the emitter cannot opt back into re-buzzing (§9.3).
- Lockscreen visibility tiers → `redacted`, generalized from an app choice
  to CFC label enforcement at the push boundary (§9.3).
- Actions + inline reply → `actions`/`replyTo`, with the broadcast-back
  replaced by an append to a source-space cell under the user's ordinary
  session authority (§4.6) — same UX, radically simpler trust story.
- iOS's interruption-level vocabulary → the posture scale's rungs map onto
  it (and Android channel importance) so OS compilation is a table lookup,
  and the reserved break-glass mapping (§9.3) targets `time-sensitive` /
  `critical` when entitlements land.
- Channels-as-classification → `kind`, but bound to verified source
  identity instead of self-declared (§4.4).

**Inverted — the same levers, moved to the user's side:**

- Android lets the user *lower* a channel after the app priced it; here the
  emitter never prices at all — `postureHint` is advisory, the steward
  assigns, and raising is exclusively user-authored (§4.2). The one lever
  Android proved users understand (per-channel importance) becomes the
  *whole* model rather than the escape hatch.
- Binary app permission becomes per-source, condition-bearing policy data:
  clamps, quiet hours with named exceptions, watches — proposable by
  patterns at the moment of intent, adopted by the user, editable forever
  (§7). Focus modes' "which people break through" becomes a verified-actor
  policy rather than app-self-reported metadata.
- The OS's invisible ML ranking (Android's notification assistant) becomes
  **learned policies**: the same adaptive demotion, materialized as
  records the user can read, edit, and delete (§7).

**Added — expressible here, structurally impossible there:**

- A notice is live-tied to its `subject`: handle the thing *anywhere* and
  the notice retracts *everywhere* — the seen-join (§4.4) gives every
  source the auto-retract behavior only the best-engineered apps simulate,
  cross-device, for free.
- Derived notices: in-fabric changes need no posting at all (§5) — there is
  no "the app forgot to notify" failure mode, and quiet agent work is
  visible at zero notification cost.
- Cross-person semantics as single policy records: collective quiet
  ("acted-by-any demotes for all") and escalation ("nobody in 2h → raise
  for the owner") (§8).
- One canonical, queryable ledger with the OS trays as degraded
  projections — digests, audit, and coverage measurement read the ledger,
  not N device states.

**Inherited, honestly:** dead-device delivery still rides APNs/FCM/Web Push
and their gates — the break-glass ceilings (`time-sensitive`, `critical`,
DND-bypass) are the platforms' to grant, not ours to declare (§9.3), and
push timing is theirs. This design compiles down to the OS stacks; it does
not pretend to replace them.

## 4. Model

### 4.1 The unit: a notice

A notice is a **posted announcement with a focused destination** — it waits
to be noticed; it does not get to decide how loudly. Borrowing the product
framing: a raw source occurrence, or the bare fact that an agent ran, does
not deserve a notice. The envelope therefore always carries *where to go*
(`subject`, and optionally a distinct `target`) and *what is ready there*
(title/body describing the prepared result or the change), never just
"something happened".

The runtime does not — cannot — enforce that notices are well-prepared; it
enforces the things preparation depends on: who may write the ledger, which
posture a notice actually gets, and that handled notices retract everywhere.

### 4.2 The posture scale

One ordered scale:

```text
suppress < silent < review < heads-up < interrupt
```

`suppress` is rank zero: never materialized for this user (distinct from
`silent`, which is recorded and findable). Every materialized notice
occupies exactly one rung, and the rung is a promise:

| Posture | Promise to the user | Typical projection |
|---|---|---|
| `silent` | "Recorded; you'll find it if you look." | seen-state dots on artifacts, history views |
| `review` | "Batched for your next review; no urgency." | digest, review queue — bounded history, not a feed |
| `heads-up` | "Look when you next check in; we'll hold it." | shell bell/badge count, quiet OS delivery |
| `interrupt` | "Worth breaking your flow for." | OS banner/sound, in-shell takeover |

Two invariants:

- **Downward bias.** Defaults sit low (`silent`/`review`). Sources post a
  *hint*; the steward assigns the real posture via the policy clamp (§7), and
  repeated dismiss-without-open feeds back as learned clamps. Crucially,
  **no emitter-controlled field may raise posture**: reaching `interrupt`
  (or `heads-up` above a source's learned baseline) requires a user-adopted
  policy floor — never urgency claims, expiry times, or any other field the
  emitter writes. An emitter cannot buy `interrupt` with enthusiasm. The
  same discipline binds the *shipped defaults*: any default above `review`
  must match on **steward-verified facts** (e.g. `actor` is a human DID with
  an established relationship to the user), never on self-declared fields
  like `kind` — otherwise declaring a kind *is* choosing a baseline, which
  re-opens the loophole this invariant closes.
- **Attention ≠ confidence.** How sure the system is about a notice and how
  loudly it surfaces are separate axes. Uncertain-but-urgent goes to
  `heads-up` with its uncertainty stated (product copy; `ext` if
  structured); certain-but-routine stays in `review`.

The rung names deliberately match the posture vocabulary the Loom product
already uses (silent memory → daily review → timely heads-up → interrupt), so
product surfaces map 1:1 onto runtime postures. Within a rung, ordering is
the steward-assigned `weight` (§4.4) — an opaque scalar that never crosses
rungs and never gates delivery; it exists so continuous surfaces (Pond's
radial layout, "ordered by the steward" lists) don't have to invent one.

### 4.3 The pipeline

```text
Sources                          post candidates (postureHint = advisory)
  agents/pieces running as me      │
  pieces I joined, running         │  per-source prefilter: "important within
    as others (group chat)         │   my world?" — cannot judge cross-source
  sharing directed at me           │
  artifact changes (derived, §5)   │
  external ingress (webhooks)      ▼
Notice inbox (durable; quota-gated append)       §6.1, §10.2
  ▼
Steward (per-user, trusted single writer)          §6
  folds candidates × policy cells (§7)
  assigns posture + weight; coalesces; writes the ledger
  ── writeAuthorizedBy gate: only the steward's verified
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

A source **posts a candidate**; the steward **admits it as a notice**. Same
envelope, two stages — and the stage split is structural: a candidate
*cannot carry* an assigned posture, because `posture`, `weight`, and `id`
exist only on the admitted type.

```ts
// Shown for illustration only.
// A subject-entity version: memory-v2 seq is per-space (a space-global
// Lamport clock, monotone per entity), so versions are only comparable
// within the same space. Read via the changes projection (§10.1).
type EntityVersion = { space: string; seq: number };

// What a source posts (into the notice inbox, §6.1). Everything on the
// candidate is descriptive or advisory — no field a source writes can
// raise loudness (§4.2).
type NoticeCandidate = {
  // THE entity this notice is about (a stored cell link, not a query
  // string). The notice is the invitation; the subject is the truth.
  // Satisfaction, coalescing, and re-emergence all key on it: once your
  // seen mark on subject reaches subjectVersion, the notice retracts
  // everywhere (alreadySeen, below).
  subject: unknown;           // asCell: ["cell"]
  // The subject's version at posting. Drives coalescing (same id,
  // advancing version) and re-emergence tombstones (§4.7).
  subjectVersion: EntityVersion;
  // Source classification ("group-chat", "importer", "agent-run", ...).
  // BOUND BY THE STEWARD to the source's verified identity: the first-seen
  // kind for a given source sticks; a source changing its declared kind
  // is itself a reputation signal (and does not escape kind-matched
  // clamps, which follow the source identity). Policy matching (§7) and
  // digest grouping (§9.2) key on it. Self-declared, therefore never a
  // basis for above-review shipped defaults (§4.2).
  kind: string;
  // Grouping key for presentation AND displacement: within a threadKey,
  // only the newest live notice is visible (§6.4). One conversation, one
  // task, one agent run (threadKey = run id).
  threadKey?: string;
  // Who this notice is from/about (a DID when known): "Ana: running late"
  // vs "New message". Serves OS payloads, digest grouping, and §5's
  // "by whom" in one field.
  actor?: string;

  // Content. Snapshot at posting (title/body) plus the live destinations.
  title: string;
  body: string;
  // Variant for untrusted displays: lockscreens and push relays (§9.3).
  // When absent and labels forbid egress, adapters send a generic
  // envelope and fetch full content on unlock/open.
  redacted?: { title: string; body: string };
  // Where opening the notice goes, when that differs from subject
  // (default: subject). Navigated with navigateTo().
  target?: unknown;           // asCell: ["cell"]
  // Prepared material (draft, diff, packet) when it is a different
  // artifact than the destination.
  attachment?: unknown;       // asCell: ["cell"]
  // Close-the-loop affordances rendered on the surface itself (§4.6):
  // approve/deny, done/later, inline reply — act without opening the app.
  actions?: NoticeAction[];
  // Live progress for ongoing work ("agent is 60% through your
  // refactor"). Progress updates are same-rung coalesces and therefore
  // silent (§9.3). Absent total = indeterminate. Rich live chrome (Live
  // Activities) is a later adapter track; this field is the floor every
  // surface can render.
  progress?: { done: number; total?: number };

  // Advisory only — the "requested" loudness. The steward assigns the real
  // posture; surfaces never read the hint.
  postureHint: "silent" | "review" | "heads-up" | "interrupt";

  postedAt: number;
  notBefore?: number;         // embargo: hold materialization until then
  expiresAt?: number;         // evaluate-on-read; swept terminally by the
                              // steward (§4.7, §9.3)

  // Opaque product round-trip channel. Disciplined by invariant: NO
  // runtime-derived predicate, NO steward fold step, and NO policy match
  // may read ext — it carries product fields (Loom's why_now, channel,
  // authorization_state — Appendix A), not routing inputs. An ext key
  // consumed by two independent products is a candidate for promotion to
  // the envelope (or a sign the envelope is wrong).
  ext?: Record<string, unknown>;
};

// An admitted notice IS a candidate plus the three fields only the steward
// may write. Two stages, one envelope, enforced by the type.
type Notice = NoticeCandidate & {
  // Identity — THE load-bearing field. Every surface adapter targets it
  // for replace/retract (iOS UNNotificationRequest.identifier +
  // apns-collapse-id, Android notify(id), Web Push options.tag). Derived
  // by the STEWARD from verified provenance (source space DID + entity id
  // [+ event key]) — never from candidate-supplied strings, so a hostile
  // source cannot collide another source's id to hijack coalescing or OS
  // replace/retract.
  id: string;
  // The promise made to the user (§4.2) — the only loudness surfaces read.
  posture: "silent" | "review" | "heads-up" | "interrupt";
  // Intra-rung ordering. Opaque; never crosses rungs; never gates
  // delivery (§4.2).
  weight?: number;
};

// One button on a notice: approve/deny, done/later, inline reply (§4.6).
type NoticeAction = {
  key: string;                // semantic key, recorded in the disposition
  label: string;
  input?: "text";             // direct reply / free-text input
  // Durable endpoint in the source space — a durable array cell, NEVER a
  // Stream (stream payloads don't persist, §4.5). Acting appends
  // {key, input?, noticeId, at} under the user's ordinary session
  // authority — the same authority the user would have acting in-app.
  // No new trust surface.
  replyTo?: unknown;          // asCell: ["cell"]
};

// Append-only per-notice disposition log — what the user (or the steward,
// on the user's behalf) did with the notice. Deliberately small: "seen"
// is NOT a disposition (it lives in the seen store, §4.5/§5, and
// notice-seen is a join); "muted" is NOT a disposition (mute IS a policy
// write, §7). Cause-preservation across the three terminal types is the
// point: undo, history, and calibration all key on it.
type NoticeDisposition = {
  noticeId: string;
  at: number;
  // Which surface the disposition came from (shell, os-tray, digest,
  // ...). Lets policy decide e.g. "os-tray dismiss clears that device
  // only" (§9.3).
  surface: string;
  // Who did it: the user's DID, or the steward's module identity for
  // system dispositions (expiry sweep, thread displacement — §4.7).
  actor: string;
  // The subjectVersion this disposition was taken against. A dismissal
  // tombstones that version; if the subject advances past it, the notice
  // re-emerges (the steward's coalesce advances subjectVersion past the
  // tombstone — one operation, not a separate mechanism) and the old
  // dismissal no longer applies. Comparable only within
  // subjectVersion.space.
  againstVersion: EntityVersion;
  ext?: Record<string, unknown>; // product extension (e.g. calibration
                              // feedback like "not-useful"); same
                              // discipline as NoticeCandidate.ext
} & (
  | { type: "dismissed" }
  | { type: "archived" }
  | { type: "snoozed"; until: number }
  | { type: "acted"; key: string; input?: string }
);
```

Nothing stores `active`, `dismissed`, or `unread` flags — dispositions are
derived. And critically, **currency is a local join, not a cross-space
read**: a notice is satisfied once the user's own seen mark on its *subject*
reaches the notice's version. This is the Android behavioral gold standard —
view the source anywhere, the notification retracts everywhere — computed
entirely from the user's own stores:

```ts
// Shown for illustration only.
const sameSpaceGte = (a: EntityVersion, b: EntityVersion) =>
  a.space === b.space && a.seq >= b.seq;
const terminal = (n: Notice, log: NoticeDisposition[]) =>
  log.some((d) =>
    (d.type === "dismissed" || d.type === "archived" || d.type === "acted") &&
    sameSpaceGte(d.againstVersion, n.subjectVersion)
  );
const alreadySeen = (n: Notice, seen: SeenStore) =>
  sameSpaceGte(seen.versionOf(n.subject), n.subjectVersion);
const visible = (
  n: Notice, log: NoticeDisposition[], seen: SeenStore, now: number,
) =>
  !terminal(n, log) && !alreadySeen(n, seen) && !snoozed(log, now) &&
  (n.notBefore === undefined || now >= n.notBefore) &&
  (n.expiresAt === undefined || now < n.expiresAt);
```

Notices that should outlive observation (a todo is not done because you
looked at it; a medication reminder must nag) are handled deliberately, not
by the runtime guessing which glances "count": a user-adopted `realert`
policy (§7) **exempts matched notices from seen-satisfaction entirely** —
they clear only on a terminal disposition, never because the user glanced
at the subject — and the source re-posts at a newer version when it is
meaningfully newsworthy again (content escalation, not liveness).
Satisfaction that doesn't involve the user looking (someone else handled it;
the trip ended) is the steward's job: its fold observes the subject change and
terminally retracts the notice (system disposition by module identity).

A caveat on "cheap": pull-based scheduling makes *unobserved* queries free
(`docs/specs/pull-based-scheduler/README.md`), not observed ones. A mounted
lane is a live subscription over the user's own three stores — no per-notice
cross-space reads (cross-space reading happens once, in the steward's fold) —
and §4.5's write discipline bounds how often those stores change.

### 4.5 Storage

Attention state lives in the **user's home space** (home space DID = user
identity DID; the established home for durable per-user state, alongside
favorites and journal — see `docs/common/conventions/HOME_SPACE.md`). It is
three stores, and the three backings are not ad-hoc — they derive from a
2×2 of **writer authority × reactivity coupling**:

| | wakes lane queries | must never wake lane queries |
|---|---|---|
| **steward-only writes** | `notices` | *(learned policies live with §7 policies, not here — they are user-visible data)* |
| **any-surface writes** | `dispositions` | `seen` |

1. **`notices`** (the ledger) — written *only* by the steward. Backing for
   phase 1: a **durable array cell carrying the `writeAuthorizedBy`
   claim**, the mechanism already protecting profile links in production
   (`docs/common/conventions/HOME_SPACE.md`,
   `packages/runner/src/cfc/prepare.ts`). Coalescing (same `id`, subject
   advanced) is an in-place element update by the single leased steward
   instance (§6.2); coalescing **refreshes** content, `expiresAt`, and
   `progress` — a re-emerged notice carries the new posting's lifetime, not
   a stale one. This is deliberately *not* sqlite yet: `writeAuthorizedBy`
   is enforced on the cell-write prepare path and **does not gate
   `db.exec`** today — sqlite's implemented CFC covers confidentiality
   ceilings and row-label rules, not write authorization
   (`docs/specs/sqlite-builtin/06-cfc.md`). Migrating `notices` to a sqlite
   table (better ranking/pagination/retention at volume) is gated on the
   net-new work item in §10.3, and on giving it **its own database**: every
   `db.exec` serializes on the database handle cell's `rev`, so one shared
   db cannot hold both a steward-only table and an everyone-writes table
   without gating both or neither.
2. **`dispositions`** — written by every surface on every device. Backing: a
   durable array cell appended with **mergeable ops only** (`push`,
   `addUnique`), so concurrent dispositions from two devices merge against
   durable state instead of clobbering (memory is optimistic-concurrency
   with path-aware validation, not CRDT — and this design needs no CRDT:
   the canonical writer is singular per store, and dispositions are
   mergeable appends). The steward periodically compacts dispositions for
   terminal, swept notices.
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
   focused open). A focused open writes *only* the seen mark — notice-seen
   is a join (`alreadySeen`, §4.4), not a second record.

Two rules regardless of backing:

- **Never model a store as `asCell: ["stream"]`** — stream cells are
  ephemeral (only the marker persists; payloads do not — see
  `docs/specs/space-model/4-cells.md`). Streams are append *endpoints*, not
  logs. This matters doubly for ingress: webhook payloads ride an ephemeral
  stream, so a **receiving handler must persist candidates durably at
  ingress** — otherwise external candidates arriving while no steward is
  live are lost permanently, not delayed (§6.1). The same rule is why
  `NoticeAction.replyTo` must be a durable cell, never a stream.
- **Never `set()` a whole array** that has more than one writer.

Retention: the steward's sweep terminally retracts expired notices (system
disposition — this is the *one* expiry mechanism; `visible()`'s expiry check
is the read-side shadow of it, so an expired notice is hidden immediately
and reaped eventually), **ages the bell** — unhandled `heads-up` notices
older than N days (default 7; realert-matched notices exempt) demote to
`review` as a posture transition, so a long absence returns to a digest,
not a wall of stale urgency — and reaps notices that are terminal with
`subjectVersion` below a watermark, plus their dispositions. Sweeping is an
steward duty (it owns the ledger), bounded and boring by design. Because
sweeping only reaps terminal rows, per-source intake quotas (§6.1) are what
bound a flooding source, not retention.

### 4.6 Actions on the notice

The most attention-respecting affordance in existing systems (Android
actions + direct reply) is closing the loop *without opening the app* —
approve/deny, done/later, reply, from the shade or the bell. The envelope's
`actions` field carries it:

- Rendering: shell lanes and OS adapters render `actions` as buttons (plus
  an inline input when `input: "text"`). Android compiles to
  `Notification.Action`/`RemoteInput`; Web Push to `showNotification`
  actions (buttons; inline text where supported); the shell renders
  natively. The PWA floor holds — Web Push supports action buttons.
- Acting: writes the ordinary `acted` disposition (`{key, input?}`), which
  is terminal; and, when `replyTo` is present, appends
  `{key, input?, noticeId, at}` to the reply cell in the source space
  **under the user's ordinary session authority** — exactly the authority
  the user would exercise replying in-app. No new trust surface: the
  source granted itself read on its own cell, and the user could always
  write there through the source's own UI.
- The "needs your approval" genre (Loom's `authorization_state:
  proposal-required`) compiles to `actions: [approve, deny]` — the approval
  affordance travels with the notice instead of forcing navigation.

### 4.7 Lifecycle

For review clarity, the full per-(user, notice) state machine, every
transition named once:

```text
(candidate) --steward fold: clamp > suppress--> ADMITTED
ADMITTED --now < notBefore--> EMBARGOED --time--> VISIBLE
EMBARGOED --steward: subject satisfied / superseded--> TERMINAL
         (a pre-scheduled reminder is retracted when its reason ends)
VISIBLE --user: dismissed|archived|acted--> TERMINAL
VISIBLE --steward: subject satisfied / thread displaced / expiry sweep
         (system disposition)--> TERMINAL
VISIBLE --user: snoozed--> SNOOZED --until--> VISIBLE
VISIBLE --seen mark on subject reaches subjectVersion--> SATISFIED
         (hidden; no disposition row — pure join; does NOT apply to
         realert-matched notices, which clear only terminally, §7)
VISIBLE --now ≥ expiresAt--> hidden immediately (read-side),
         TERMINAL at next sweep (write-side)
TERMINAL --steward coalesce advances subjectVersion past tombstone-->
         VISIBLE (re-emergence: a consequence of coalescing, not a
         separate mechanism; silent unless a realert policy applies, §9.3)
TERMINAL + below watermark --sweep--> reaped
```

Posture may change after admission (escalation raises it, collective
handling demotes it — §8); §9.3 defines alerting and retraction in terms of
these posture transitions. **Policy changes re-fold**: policy cells are fold
inputs, so a policy commit wakes the steward and admitted notices re-lane —
muting a thread demotes its existing notices, not just future ones.

## 5. Seen-state and attention over artifacts

The most common attention event in practice is not "interrupt me" — it is
"an agent (or another member) did work while I wasn't looking, and I need to
be able to *see that it happened*". That is not a notification; it is
seen-state.

**The seen store** is one small relation per user: the last version of an
entity the user actually observed. "Observed" is defined strictly:
**seen = focused open** — the user navigated to the entity (or a notice
whose subject is the entity) and it was the focus of their attention.
Scrolling past a row in a list is *not* seen; rendering a lane is *not*
seen. This single definition is load-bearing three ways: it keeps unseen
dots honest, it keeps disclosed read-receipts meaningful (§8), and it keeps
seen writes rare (§4.5.3).

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
- **"While you were away"** = one `changes(watchSet, basis: seenWatermark,
  attribution: true)` call, grouped by run/thread then space, ordered by
  the steward. Renders as a pattern on the home context. This is the
  first-run view and the every-return view — the same query. The affordance
  must answer *what changed, by whom, since you looked* — the projection's
  `author` field gives session-grain attribution from day one (§10.1) — and
  a jump-in that emphasizes the changed region (memory-v2 holds both
  versions; the diff is derivable). A bare dot that says "something
  happened" does not meet the bar (§4.1).
- **Artifact lifecycle** falls out of the same two numbers plus a timestamp:
  *fresh* (unseen changes) → *seen* → *stale* (untouched for N) →
  *archived*. No new subsystem.

**Derivation beats posting.** For in-fabric sources, a candidate is *derived
from* artifact-change + watch set — the attention system watches; patterns
just write their artifacts. Explicit posting remains for sources with no
artifact (external ingress, transient events), but it is the minority path.
This is the platform's grain: derived state over stored state, and no
parallel event journal duplicating what memory-v2's commit log already
records.

**Run-level grouping.** One agent run touching twelve artifacts must not be
twelve scattered dots. From phase 1, agent-shaped sources post one
receipt-shaped notice per run (`threadKey` = run id), and the
while-you-were-away view folds entity changes under the run's receipt by
**attribution**: changes whose `author` is the run's session group beneath
the receipt rather than appearing as free-floating dots.
(Attribution-based folding, not an envelope field — the changes projection
already carries the join key.) Phase 0 — dots only — does not have this,
which is a stated limitation, not an oversight: phase 0 makes agent work
*visible*; run-level legibility is phase 1's tracked follow-through (§11).

**The watch set** is not a fourth kind of policy — it is the entity set
handed to the changes projection, seeded by derived defaults
(*touched-recently ∪ agent-did-it-for-you*) and extended by explicit
watch/unwatch policies (§7). Getting the defaults right is an open question
(§12.2); getting them wrong in the "too broad" direction is the failure
mode to avoid (dots everywhere = dots nowhere).

## 6. The steward

**One logical steward per user.** It admits candidates, folds policies,
assigns postures and weights, coalesces (same `id` when the same subject
advances — re-emergence is this same operation crossing a tombstone),
applies thread displacement (§6.4), retracts satisfied notices, and sweeps
retention (§4.5).

### 6.1 The notice inbox

Candidates must be **durable before admission**: the steward may be asleep or
absent (interim mode, closed clients), and ephemeral candidates would be
silently lost, not delayed. Intake shape:

- In-fabric artifact changes need no *posting* — they are derived (§5).
  (They do need *reach*: until server-side cross-space wake exists, changes
  in other spaces reach a server-side steward via the same forwarding path as
  posted candidates below; a client-side steward reads them directly through
  the user's ordinary sessions.)
- Posted candidates land in the **notice inbox in the user's home space** —
  a cross-principal, quota-gated append surface, named net-new work
  (§10.2), because it is the one place untrusted-ish writers meet the
  user's home space: the write gate enforces per-source quotas against the
  *verified writer identity*, not against self-reported fields. Until
  §10.2 lands, candidates rest in a durable per-source cell in the space
  where they arise and the steward reads them there (client-side interim),
  with quotas enforced at fold time — weaker (a flood bloats the
  source-space cell, not the home space) but sound.
- Webhook ingress: the receiving handler persists the payload durably at
  ingress (§4.5); the ephemeral stream is transport, not storage.
- Quota pressure and dismiss-without-open feed the same **learned-policy**
  signal (§7): the source's baseline clamps down, legibly.

### 6.2 Trust and instance discipline

The ledger carries a CFC `writeAuthorizedBy` claim. Two viable bindings:

1. **Verified module identity** (recommended): the steward ships as a pattern
   with a content-addressed module identity; `writeAuthorizedBy` binds to it.
   The steward stays in pattern-space — inspectable, forkable in principle,
   updated like any pattern — and "trusted" means *this exact code*, not
   "runs on a server".
2. **Trusted builtin**: a runtime builtin id in the claim. Stronger, but
   moves the fold out of pattern-space and makes policy-fold evolution a
   runtime release.

Recommendation: (1), with the fold's *inputs* (policies) as data so the code
rarely needs to change. Note the identity subtlety: *acting as the user*
(session `as` / `actingPrincipal` = the user's DID) and *being authorized to
write the ledger* (module identity matching the claim) are two separate
checks, and the design uses both — every steward write is attributable
`onBehalfOf` the user and provably from the steward's code.

`writeAuthorizedBy` authorizes *code*, not an *instance*: two devices running
the steward both pass the claim. The single-writer premise therefore needs
instance discipline, not just CFC: **the interim client-side steward takes a
lease** (a mutex cell claimed with an expiry; the sqlite spec's
`tryClaimMutex` shape) and only the leaseholder folds. Independent of the
lease, the fold is specified **idempotent and commutative over the notice
inbox** (deterministic ids; coalescing recomputes from subject state rather
than incrementally mutating), so a lease handoff or a brief double-writer
window degrades to wasted work, not divergence.

### 6.3 Execution

- **Target: the server-primary execution model**
  (`docs/specs/server-side-execution/`). With intake home-space-local
  (§6.1), the steward is a *standing registration on the user's home space* —
  work whose value is its effects rather than client-read output — woken by
  commits to the notice inbox, the policy cells, or forwarded watch-set
  events. Execution is attributed `onBehalfOf` the user. Named
  dependencies, since that spec's workers, registrations, and wake-on-commit
  are all **per-space**: standing registrations are its own later phase;
  scoped (`PerUser`) state claims are gated (its G16); server-side
  *cross-space* reads/wake are explicitly deferred there — which is exactly
  why intake forwards into the home space instead of the steward reading N
  spaces.
- **Interim: client-side, under lease** (§6.2). Until standing registrations
  land, the leaseholder client runs the steward as an ordinary piece. This
  degrades gracefully for in-fabric state (candidates are durable; folding
  happens on next lease) — what's lost is only *timeliness* while no client
  is open, which matters from phase 2 (OS delivery) onward and not before.
- **Not: `background-piece-service` as-is.** It is per-space (the steward is
  per-user), ~60s polling (the steward is wake-on-commit shaped), and its own
  README documents async-completion unreliability. If bps is pressed into
  interim service, treat that as scaffolding, not the design.

**Laziness.** The steward materializes *rows*; it does not keep derived
predicates hot. `visible()` evaluates on surface demand over the user's own
stores (§4.4). The one push-shaped duty is OS delivery (§9.3), which is
explicitly an edge adapter fed by wake-on-commit, not a hot loop.

### 6.4 Coalescing and thread displacement

Two mechanisms at two altitudes:

- **`id` is identity**: the same notice at a newer subject version.
  Coalescing updates the notice in place (refreshing content, expiry,
  progress); crossing a dismissal tombstone is re-emergence. Identity is
  steward-derived from verified provenance (§4.4), so it cannot be forged.
- **`threadKey` is the thread**, and displacement is a *derived rule over
  it*: **within a threadKey, only the newest live notice is visible**;
  older live notices in the thread are terminally retracted by the steward
  (system disposition) when a newer one is admitted. A prepared result
  therefore displaces the raw occurrence by *sharing its thread*, not by
  naming notice ids — no displacement chains, no tombstone bookkeeping for
  the emitter, and "the displaced notice's subject advances again" needs no
  special case (it is simply the thread's newest notice again).
  Cross-thread or multi-target displacement is deliberately not
  expressible; a consumer who needs it should make the case with a concrete
  scenario (§12.7).

## 7. Policies

A policy is a small declarative record the steward folds over — **data, not
steward code**:

```ts
// Shown for illustration only.
type AttentionPolicy = {
  match: {
    subject?: unknown;        // asCell: ["cell"] — a specific source/thread
    // Verified actor identity (DID). THE dimension for interrupt-bearing
    // floors: "messages from this person/number → heads-up". Steward-
    // verified, unlike kind.
    actor?: string;
    kind?: string;            // as bound by the steward, §4.4 — but note:
                              // self-declared at first posting, so an
                              // interrupt-bearing min matched on kind is
                              // first-declaration-spoofable by a NEW
                              // source; bind alert floors to actor,
                              // subject, or spaceDid instead
    spaceDid?: string;
    threadKey?: string;
  };
  effect: {
    // One clamp on the one ordered scale (§4.2):
    // suppress < silent < review < heads-up < interrupt.
    clamp?: { min?: "review" | "heads-up" | "interrupt";
              max?: "suppress" | "silent" | "review" | "heads-up" };
    // Exempts this policy's min from quiet-hours clamping (the babysitter
    // thread breaks through). User-authored only.
    bypassQuietHours?: boolean;
    // Nag-until-done: a matched notice is EXEMPT from seen-satisfaction —
    // it clears only on a terminal disposition (acted/dismissed/archived),
    // never because the user glanced at the subject — and re-alerts on
    // this cadence while live. One of the two consented exceptions to
    // §9.3's alert-once rule. User-authored only; the cadence needs timer
    // wake (§10.5) to fire between commits.
    realert?: { everyMs: number };
    coalesceWindowMs?: number;
    // Time-conditional clamp sugar: during these hours/days, apply
    // `max` (default "review"). days omitted = every day.
    quietHours?: { start: string; end: string; days?: string[];
                   max?: "suppress" | "silent" | "review" };
    watch?: boolean;          // extend/prune the watch set (§5)
  };
  reason?: string;            // human-legible: why this policy exists
  author: string;             // user DID; a pattern's module identity for
                              // proposals; the STEWARD's module identity for
                              // learned policies (see below)
};
```

**Composition is one formula, with a hard ceiling.** Effective posture =
`clampScale(baseline, max(matching mins), min(matching maxes))` where
**`baseline = min(postureHint, "review")`**, further bounded by the
source's learned baseline. The ceiling is load-bearing: absent it, a
brand-new source with no learned history and no matching max would get
whatever it hinted — the exact cold-start hole §4.2 forbids. As written,
no notice exceeds `review` unless a *policy min* raises it, and mins above
`review` are user-authored only (shipped defaults and learned policies
never set them). **Maxes dominate mins** on conflict, with one exception —
a user-authored min marked `bypassQuietHours` survives the quiet-hours
max. `quietHours` is defined as nothing more than a time-conditional max
(default `"review"`; `days` scopes it — "work sources suppressed on
weekends" is `{quietHours: {start: "00:00", end: "24:00", days:
["sat","sun"], max: "suppress"}}`). The canonical case — "quiet hours
22:00–07:00, but the babysitter thread always breaks through" — is two
records and zero ambiguity.

- Policies live in the user's home space (`PerUser` scope). The core ships a
  handful of defaults: messages from **verified human actors with an
  established relationship** (rosters, prior threads — and rosters are
  seeded by contact import at onboarding, so this default works on day
  one, not after weeks of thread history) → `heads-up`; **first contact
  from a verified human actor with no established relationship** →
  `review`, grouped in a distinguished **requests** shelf (the
  message-requests idiom), quota-bounded per source, where the notice
  carries a one-tap promote affordance that writes `{match: {actor},
  clamp: {min: "heads-up"}}` through the trusted surface — legitimate
  strangers (the marketplace buyer, the new-school-year parent) are
  distinguishable from importer noise without being handed loudness;
  agent-completions → `silent` (visible as seen-state, never buzzing). Per
  §4.2, shipped defaults above `silent` key on steward-verified facts only
  — never on self-declared `kind` (declaring `kind: "group-chat"` must not
  buy the human-messages baseline; "first contact from a verified human"
  is verifiable — DID checked, roster/thread absence checked). There is
  deliberately **no default that maps any emitter-supplied field to
  `interrupt`**.
- **Mute is a policy, not a special relation** (and not a disposition).
  "Mute this thread" writes `{match: {threadKey}, effect: {clamp: {max:
  "suppress"}}}`; the re-fold rule (§4.7) demotes existing notices too.
- **Patterns propose, the user disposes.** A pattern can ship a suggested
  policy with its artifacts ("library book due → heads-up 3 days before");
  adoption goes through a trusted surface, exactly like other user-consented
  writes — adoption *is* the write, and unadopted proposals never enter the
  fold. Two idioms this primitive must carry, because users won't write
  these policies unaided:
  - **The emergency pack.** Nobody writes an interrupt floor for their
    kid's school until the day it's too late. Products should propose a
    small break-glass set at onboarding — school/daycare numbers and
    alarm/fraud *sources* — as `{match: {actor | subject | spaceDid},
    clamp: {min: "interrupt"}, bypassQuietHours: true}` through this same
    adopt flow. Bind these floors to **verified identities** (`actor`,
    `subject`, `spaceDid`), never to `kind`: a kind-matched interrupt
    floor is first-declaration-spoofable by any new source that declares
    the magic kind. The runtime's part: those adopted policies compile to
    the OS's highest available interruption level (§9.3's reserved
    mapping). Honest residual: an emergency from a source the user never
    adopted and doesn't know lands at `review` (first-contact shelf at
    best) — the price of the inversion, which the pack exists to shrink,
    not erase.
  - **The deadline ladder.** Long-lived obligations post their whole
    escalation ladder ahead of time: three candidates with `notBefore` =
    T-90/T-30/T-7, same `threadKey` (each new admission displaces the
    prior rung), ascending posture hints, plus a proposed min the user
    adopts once. Obligation met → subject advances → the steward retracts
    the pending rungs (§4.7's EMBARGOED retraction).
- **Learned policies: the reputation loop, made legible.** The downward
  feedback the spec promises (dismiss-without-open, quota pressure ⇒ the
  source's notices sink) has to live *somewhere*, and hidden steward state
  would break the inspectability goal. It lives here: the steward — which is
  already the trusted fold, not a third party petitioning for adoption —
  writes ordinary policy records (`author` = its module identity, `reason`
  = the evidence, e.g. "7 of 8 notices dismissed without open over 30d")
  into a designated **learned** section of the policy store. They are
  visible, editable, and deletable exactly like hand-written policies; a
  user deleting one is itself a signal. Learned policies may only *lower*
  (set maxes / lower the baseline) — raising posture remains exclusively
  user-authored (§4.2). This follows the platform's existing precedent for
  system-inferred-but-user-owned data (`packages/home-schemas/learned.ts`).
- **Product policy dimensions compile down.** Stance-like vocabularies
  (Loom's `attention-policy-v1`) do not ride an opaque field on runtime
  policies — there is deliberately no `AttentionPolicy.ext`, because an
  opaque blob on the user's routing rules would imply a second, shadow
  interpreter of the same cells. Product policy systems keep their own
  records and *compile* to plain runtime clamps/watches, exactly as a
  trusted source compiles its channel semantics to posture hints.
- **Policy privacy, honestly stated.** Policy cells are never directly
  readable by other principals — they are ordinary confidential home-space
  data. But *behavioral* inference cannot be fully prevented: in a space
  that discloses read receipts, a muted member's persistent silence is
  statistically visible to a patient observer. The runtime's guarantee is
  scoped: no direct exposure, and inference surface bounded by the space's
  own disclosure policy (§8, §12.5). Steward *output* ordering/timing is not
  considered a protected channel in v1.

## 8. Multi-user

Three properties, all falling out of "a notice is a per-(user, notice)
relation" plus existing constraints:

- **One candidate, N ledgers.** A shared space posts one candidate per
  event; each member's own steward lanes it under their own policies. A new
  message can be `interrupt` for the on-call member and `silent` for the
  member who muted the thread. The emitter cannot know or decide this —
  correctly so.
- **"Who has seen this" — and "who handled this" — is contributed, not
  enumerated.** There is no runtime primitive for listing a space's members
  or reaching into their home spaces
  (`docs/specs/shared-profile-rosters.md`), and this design does not add
  one. Shared attention state follows the roster idiom: members' runtimes
  write their own **seen marks and, per disclosure policy, terminal
  dispositions** into `PerSpace` state in the shared space — *if* the
  space's disclosure policy says to. Read receipts, "3 people haven't seen
  the new plan", and *"Bea already handled this"* are queries over that
  contributed state. Disclosing terminal dispositions matters because
  handling often doesn't touch the source artifact (triaged verbally,
  replied off-fabric): when the subject *is* mutated, everyone's notices
  coalesce or satisfy for free; when it isn't, a disclosed `acted` is the
  only retraction signal others can get. A per-space opt-in policy —
  *"acted-by-any-member demotes to `silent` for all"* — turns that signal
  into collective quiet. Disclosure is a per-space policy cell (some spaces
  want receipts, some don't); a member who discloses nothing simply doesn't
  appear — and, corollary, silently opts out of collective quiet, which the
  space's members should understand when choosing the policy.
- **Escalation across people is a policy.** "If nobody attends to this
  within 2h, raise it to `heads-up` for the space owner" is a policy cell on
  the shared space, evaluated by the owner's steward against contributed
  state. No siloed notification system can express this; here it is one
  record. (Escalation is a posture *raise* after admission; §9.3's
  transition rule makes it alert exactly once. Deadline-shaped escalation —
  "nobody acted" produces no commits — needs timer wake, §10.5.)

**Profiles.** A user with multiple profiles (work, personal) has one
attention system *per profile*: profile ≡ its own space graph ≡ its own
home space, so attention state, policies, steward, and learned baselines
are independent per profile by construction — nothing new to build, and no
cross-profile leakage to prevent (a work source cannot learn it's quiet on
the personal profile because it never met the personal profile). Merging
the two into one device's shell — one bell over N profiles' lanes — is a
shell/product presentation concern over N independent ledgers, not a
runtime concept. Context separation *within* one profile ("work spaces
quiet on weekends") is ordinary policy: `spaceDid`-matched `quietHours`
with `days` and a `max` of choice (§7).

## 9. Surfaces

### 9.1 Shell

The shell renders attention state; it does not own attention logic. Per the
"pattern on the context" resolution: the home/shell context declares how the
attention surface renders, so it is replaceable like the rest of the home
experience. Concretely:

- lanes: `interrupt` (modal-adjacent), `heads-up` (bell + badge count),
  `review` (digest entry point), `silent` (dots via seen-state, §5);
- unseen-change dots on artifacts and containers;
- a snoozed lane (snoozed notices must stay discoverable);
- notice `actions` rendered in place (§4.6);
- **focused opens** — never renders — write the seen mark, under §4.5's
  advance-only + debounced discipline. Rendering a lane writes nothing.

Presentation components exist (`cf-toast`/`cf-toast-provider`, `cf-alert`,
badge conventions); the net-new work is mounting them against ledger
queries. One CFC note for badge counts: aggregates over a rule-bearing
store refuse unless every row is readable by the counting principal —
for a home-space ledger this holds as long as notice rows' clauses always
include the owner; state that invariant in the schema rather than
discovering it when someone adds a per-row rule.

### 9.2 Digests

A digest is **bounded history, not a feed**: a periodic artifact-shaped
summary over the ledger and seen-state — quiet dispositions, artifact
updates, prepared material, grouped by `kind` — rendered by a pattern. The
runtime contribution is only that the queries behind it (terminal notices
since T, unseen changes since T, dispositions by surface) are cheap and
complete. Whether a digest's *summary* may itself claim `heads-up` is a
policy decision, default no.

### 9.3 OS delivery

Only `interrupt` (and optionally `heads-up`, quietly) ever reaches the OS.
Adapters compile the envelope down; the ledger stays canonical and
"Android-shaped" (live update + auto-retract), and platforms degrade from
there:

- **Alerting rides posture transitions, not writes.** A delivered notice
  alerts when it first materializes at an alert-bearing rung and again only
  when the steward *raises* its posture (escalation, §8); every same-rung
  coalesce — new message in the thread, progress tick, content refresh —
  **replaces silently** on every surface (Android `setOnlyAlertOnce`
  semantics, made unconditional: the emitter cannot choose to re-buzz).
  The invariant bends in exactly **two consented ways**, both bounded by
  user grants: a user-authored `realert` policy (§7) re-alerts a live
  matched notice on its cadence and exempts it from seen-satisfaction —
  nag-until-done for medication-grade obligations, grantable only by the
  user; and a *fresh* notice (new event key, new `id`) first materializing
  at an alert-bearing rung alerts — which means a source holding a
  user-granted floor can alert once per genuinely new event, bounded by
  intake quotas (§6.1) and revocable by editing the floor. Name that
  honestly: alert-once is per-*notice*; per-*source* alert frequency is
  governed by quotas plus the user's grant, not by the coalesce rule.
  Posture *demotion* and visibility flips are retraction triggers: the
  dispatcher retracts or downgrades the delivered surface when either
  occurs. And on device (re)registration after an offline gap, the
  dispatcher **damps the backlog**: it alerts only for notices newer than
  the gap start (newest per thread); older live notices land silently in
  lanes — the delivery log already records what was never delivered, so
  "returning from vacation" is a quiet catch-up, not a buzz storm.
  Without the base rule a coalescing thread would legally buzz on every
  advance — louder than Android, inverting the spec's promise.
- **Break-glass compiles to the platform's ceiling.** A user-adopted
  `{clamp: {min: "interrupt"}, bypassQuietHours: true}` policy (the
  emergency pack, §7) maps to the highest interruption level the platform
  grants us: today a maximally-prominent standard alert; when
  `time-sensitive` / `critical` (iOS) and DND-bypass channels (Android)
  entitlements land, *this same policy* compiles to them with no policy
  migration — the mapping is reserved now precisely so the novel emergency
  isn't re-designed later. (Implementing those entitlements stays a
  non-goal for V1; reserving their compile target is not.)
- **Replace/retract rides `id`** everywhere: iOS
  `UNNotificationRequest.identifier` / `apns-collapse-id`, Android
  `notify(id)`, Web Push `options.tag`. Two honesty notes. First,
  transitions are evaluated on commit-driven wakes and on read — **nothing
  wakes anything at `expiresAt`**: server-side timers don't exist yet (they
  are "(Future)" in `docs/specs/server-side-execution/`), so an expired
  notice may linger on an OS tray until the next wake re-evaluates it.
  Timer registrations that feed the dispatcher are named net-new work
  (§10.5); until they land, expiry is evaluate-on-read with explicitly
  stale OS surfaces (the steward's sweep is the terminal write-side, §4.5).
  Second, iOS replaces but does not tick (text refreshes when the shade
  reopens); genuinely-live notices (`progress`) render best-effort per
  platform, and rich live chrome (Live Activities) is a separate later
  track.
- **Confidentiality crosses the push boundary explicitly.** Push payloads
  and lockscreens are untrusted displays: they carry `redacted` when
  present, otherwise a generic envelope ("Update from <kind>"), with full
  content fetched on unlock/app-open (the conventional
  mutable-content/fetch-on-receive shape). Notices whose confidentiality
  labels forbid egress to the push relay get the generic envelope
  unconditionally — the same CFC labels that govern every other flow govern
  this one; a system that gates reading a version number (§10.1) does not
  get to mail full message bodies through third-party relays unexamined.
- **Two transports, not one.** Browser/PWA: Web Push (VAPID + service
  worker). Wrapped mobile apps: native APNs/FCM via the wrapper's plugin —
  embedded webviews do not get Web Push. The server side (toolshed) needs a
  device-registration table `{userDid, deviceId, transport, token}` and a
  delivery log `{noticeId, deviceId, platformIdentifier, deliveredAt,
  retractedAt}` so retraction can target what was actually delivered.
  Ship Web Push first; the envelope is transport-agnostic.
- **The PWA is the floor.** The canonical shape includes nothing that cannot
  be expressed on the most-constrained surface (action buttons included —
  Web Push has them); richer platforms are adapter opt-ins, not envelope
  fields.
- **Tray-dismiss is per-device by default.** An OS-tray dismissal writes a
  disposition with `surface: "os-tray"`; whether it terminates the notice
  globally is policy (default: clears that device only; the shell is
  canonical).

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
   the watch set as roots and the seen watermark as basis it is the
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
2. **Notice inbox append gate** *(phase 1; hardened by phase 2)*. A
   home-space inbox cell with **restricted cross-principal append**: other
   principals' patterns may append candidates (the rosters
   contribute-your-own idiom, reversed) but the write gate enforces
   per-source quotas against the verified writer identity. This is what
   makes dead-device delivery an authority question with an answer instead
   of an open question — the full chain "someone messages me while all my
   devices are closed → my phone buzzes" is inbox append → home-space
   wake → steward fold → dispatcher push.
3. **Write-authorization for sqlite** *(pre-migration of the ledger to
   sqlite; not needed for phase 1's array-cell backing)*.
   `writeAuthorizedBy` is enforced on the cell-write prepare path only;
   `db.exec` today checks confidentiality ceilings and row-label rules but
   not write authorization. Gating `db.exec` per database handle (the `rev`
   bump is a cell write, so the prepare path sees it) needs specification
   and a security review of its own, including whether any sqlite write
   path bypasses the rev write.
4. **Steward lease** *(phase 1)*. A small mutex-cell convention (claim with
   expiry, renew, steal-on-expiry) for single-instance election of the
   interim client-side steward (§6.2). Generalizes beyond attention.
5. **Timer wake** *(phase 2+)*. Executor-pool timer registrations
   (`notBefore`, `expiresAt`, snooze expiry, `realert` cadences, escalation
   deadlines, digest cadence) feeding wake-on-commit's machinery, so
   time-driven transitions don't depend on coincidental commits. Until
   then: evaluate-on-read, stale OS surfaces acknowledged (§9.3). Note this
   is the single load-bearing dependency for every deadline-shaped story
   (2FA expiry, medication, on-call escalation, visa ladder — Appendix B);
   it is small, but it is not optional for phase 2.
6. **Push transports** *(phase 2/3)*. Web Push then APNs/FCM: device
   registration, delivery log, retraction dispatch (§9.3). Net-new but
   conventional. The break-glass entitlements (`time-sensitive`/`critical`,
   DND-bypass channels) are a named later extension with their compile
   target reserved now (§9.3).

## 11. Phasing

Each phase is independently shippable and none re-shapes the data model.

- **Phase 0 — seen-state.** The changes projection (§10.1), the seen store
  with its write discipline (§4.5.3), unseen dots in the shell, and a
  "while you were away" home pattern. No steward, no candidates, no push.
  Acceptance bar: the user can see *what changed, by whom (session-grain),
  and since when*, and jump in with the changed region emphasized — not
  merely that a dot exists. This makes agent work **visible** — the single
  most-requested product gap — while run-level *legibility* (one notice per
  agent run, not twelve dots) is explicitly phase 1's follow-through.
- **Phase 1 — ledger + lanes.** Envelope, home-space `notices` (array cell
  + `writeAuthorizedBy`) and `dispositions` stores, notice intake (inbox
  gate §10.2, or interim source-space cells), a minimal client-executed
  steward under lease (verified-fact defaults + clamp composition + learned
  policies + thread displacement), shell bell/lanes with notice actions
  (§4.6), receipt-shaped notices for agent runs with attribution folding
  (§5). Policies v0 (including the emergency-pack and deadline-ladder
  propose/adopt idioms, §7).
- **Phase 2 — server steward + first transport.** Steward as a standing
  registration on the home space under server-primary execution
  (dependencies named in §6.3); Web Push with device registration,
  redaction rules, and retraction; digest queries; timer wake (§10.5),
  which activates `realert`, escalation deadlines, and timely `notBefore`
  materialization.
- **Phase 3 — breadth.** Wrapped-app APNs/FCM; shared seen-state +
  disclosed terminal dispositions + escalation policies (§8); the ledger
  on sqlite once §10.3 lands; snooze/archive surfaced fully; `progress`
  rich chrome (Live Activities) and the break-glass OS entitlements as
  their own tracks.

## 12. Open questions

1. **Steward trust binding.** Verified module identity is recommended (§6.2),
   but the "wholly-system service" alternative keeps resurfacing; if the
   server executor itself writes the ledger, is that a builtin identity, and
   does that preempt user-forkable stewards? Resolve before phase 1.
2. **Watch-set defaults.** Touched ∪ agent-authored ∪ watched is the
   working answer (§5); validate against real spaces before hardening, and
   decide whether "touched" decays.
3. **Forwarder contract.** Cross-space reach for a server-side steward
   (§6.1, §6.3): who runs the forwarding (the emitting pattern? the user's
   runtime on visit?), and what happens for spaces the user hasn't opened
   in weeks? Partially subsumed by §10.2's inbox gate; the residue is
   *derived* watch-set events from spaces with no cooperating emitter.
4. **Seen-mark granularity.** Per-entity marks are the floor. Do container
   views (a space list showing N dots) warrant container-level marks, and
   does "seen the container" imply anything about members?
5. **Disclosure defaults** for shared seen-state and terminal dispositions
   (§8): receipts on or off by default, what the non-disclosing member's
   absence reveals, and how much of §7's policy-privacy bound this sets.
6. **Policy expressiveness boundary.** V1 is plain predicates. Content
   regexes and LLM-judged predicates ("only interrupt if actually urgent")
   are clearly coming — as steward inputs they inherit the steward's authority,
   so they need their own integrity story before admission.
7. **Displacement scope.** Thread displacement (§6.4) deliberately cannot
   express cross-thread or multi-target displacement. If a real consumer
   produces a scenario that needs it, revisit with that scenario on the
   table; until then the simpler rule stands.
8. **Learned-policy dynamics.** Decay (does a learned clamp relax after N
   weeks of the user opening that source's notices?), evidence thresholds,
   and whether a user deleting a learned policy suppresses re-learning for
   a period.
9. **Digest self-promotion.** May a digest claim `heads-up` on a schedule
   (§9.2)? Leaning policy-gated, default off.
10. **Convergence with product stores.** Loom currently materializes
    attention candidates in product-local storage with localStorage
    seen-timestamps. Appendix A is the field mapping; the remaining
    question is sequencing — which loom surface adopts the runtime ledger
    first, and whether loom's materializer becomes the trusted source or a
    second steward (§Division of labor says: trusted source).
11. **`realert` bounds.** Minimum cadence, maximum duration, and whether a
    realert policy requires re-confirmation after N fires — the exception
    to alert-once must not become a resharpened nag machine (§7, §9.3).
12. **Ingress-actor verification.** The first-contact default and the
    emergency pack both bind to verified `actor` identities — but an actor
    arriving via external ingress (an SMS number, an email address) is not
    a fabric DID. What vouches an ingress identity into "verified human"
    (importer attestation? user confirmation on first sight?) decides how
    much of B.1 and B.11 external sources can actually reach.

## Appendix A — mapping Loom's `attention-candidate-v1`

For the first consumer's adoption review. Loom fields → envelope. (Naming
flag: Loom's `claim_kind` vocabulary includes a value `notice`; product-side
that value should be renamed — e.g. `fyi` — before the runtime noun lands.)

| Loom candidate field | Envelope home |
|---|---|
| `id` / source identity | `id` (re-derived by steward from verified provenance) |
| subject / focused target | `subject` (cell link); distinct destination → `target`; `focused_view_fallback` → `ext` |
| prepared material | `attachment` |
| `title`, body copy | `title`, `body` (+ `redacted` where the product wants lockscreen-safe copy) |
| `why_now` | `ext.why_now` (product copy, runtime-opaque) |
| `claim_kind` (act-now / review / notice→fyi / …) | `kind` + `postureHint` (kind is classification; the hint is the loudness request derived from it) |
| `channel` (important-and-urgent / yours-in-progress / might-interest-you) | `ext.channel` — audience/genre, orthogonal to posture; product lanes render it |
| `relation_to_trigger` (augments / supersedes / resolves / …) | `ext.relation_to_trigger`, whole; *supersedes* additionally = share the trigger's `threadKey` (thread displacement, §6.4, does the retraction) |
| `authorization_state: proposal-required` | `actions: [{key:"approve"…},{key:"deny"…}]` (§4.6) + `ext.authorization_state` — the approval affordance travels with the notice |
| `authority_class` | `ext` (work-start domain, product-side per §Division of labor) |
| `not_before` | `notBefore` |
| sender / subject person | `actor` |
| delivery/interrupt eligibility | `postureHint`, clamped by user policy (§7) |
| feedback: done / later | dispositions `acted` / `snoozed` |
| feedback: never-for-this-class | a policy write (`clamp.max`) via the trusted surface |
| feedback: not-useful | disposition `dismissed` + `ext.feedback: "not-useful"` (calibration signal round-trips to the product) |

Not mapped, deliberately: Work-start Policies, continuity owners, typed
receipts' internals, stance vocabularies — upstream product machinery
(§Division of labor); stance policies compile down to plain clamps/watches
(§7). A receipt *summary* enters as an ordinary candidate.

## Appendix B — fourteen worked stories

Fourteen deliberately diverse stress cases from two rounds of user-story
review, each walking the mechanism end to end, with honest grades: **fully
built** (phase 3) and **phase 1 reality**. Grades were adversarially
re-verified against the spec *as revised* — where a fix earned a grade, the
fix is in the spec, and where a story still fails, the failure is stated.
The pattern in the grades is itself a finding: stories whose essence is
*time* or *other people* are phase-gated on timer wake (§10.5) and push
(§10.6); stories derivable from state the user already holds are strong
almost immediately.

| # | Story | Axis | Fully built | Phase 1 |
|---|---|---|---|---|
| B.1 | School emergency | must-interrupt, novel source | B− (actor-bound pack + reserved mapping; honest residual = `review`) | F (no push) |
| B.2 | Medication | seeing must not satisfy | A− (`realert` = terminal-only satisfaction) | D (no timer wake) |
| B.3 | On-call triage | multi-user coordination | A− | D (shared state is phase 3) |
| B.4 | Overnight agent run | quiet agent work | A | A− |
| B.5 | 2FA code | time-critical, brief | B | B− |
| B.6 | Social stream | high-volume, low-value | A | A |
| B.7 | Medical privacy | lockscreen leakage | A | A− (trivially — no push yet) |
| B.8 | Approve rebooking | act from the surface | A− | B (shell only) |
| B.9 | Visa renewal | long-lived deadline ladder | B | C+ (evaluate-on-read only) |
| B.10 | Adversarial source | spam defense | A− | A− |
| B.11 | Marketplace stranger | first contact, unknown human | B+ (requests shelf + promote) | B− (shell only) |
| B.12 | Return from vacation | bulk catch-up boundedness | B (aging + reconnect damping) | B− |
| B.13 | Work/personal split | context separation | B (per-profile state + day-scoped quietHours) | B− |
| B.14 | Day-one cold start | defaults before any learning | B− (ceiling + roster seeding) | C+ |

### B.1 The school emergency (must-interrupt, novel source)

Priya's kid has an allergic reaction at school; the office texts "come now."
Quiet is the failure mode — and the *novel* emergency is downward bias's
structural blind spot, because interrupt requires a pre-adopted floor that
by definition doesn't exist for a first-time source. The design's answer is
two-part, and honest about its limits: (1) the **emergency pack** (§7) —
onboarding proposes break-glass floors for school/daycare/alarm/fraud
sources at the moment the user is thinking about setup, via the ordinary
propose/adopt flow, **bound to verified identities** (`match.actor` /
`subject` / `spaceDid` — never spoofable `kind`); (2) the **reserved
break-glass mapping** (§9.3) — that adopted policy compiles to the OS's
highest granted interruption level, upgrading to
`time-sensitive`/`critical` when entitlements land, with no policy
migration. What the design will *not* do is let the message's own urgency
raise its posture — that lever, once granted to emergencies, is granted to
everyone claiming to be one. The residual, stated without varnish: an
emergency from a source the user never adopted and has no relationship
with lands at **`review`** (the first-contact requests shelf if it's a
verified human; §7) — a full miss until the next check-in. That is the
price of the inversion; the pack exists to shrink it, and how an
SMS-ingress phone number gets verified as a known actor at all is open
question §12.12.

### B.2 The medication reminder (seeing must not satisfy)

Elena must take tacrolimus by 9pm; a glance must not silence the reminder.
Her one-time adopted policy carries `{clamp: {min: "interrupt"},
bypassQuietHours: true, realert: {everyMs: 600_000}}`, and `realert` does
the whole job on its own: a matched notice is **exempt from
seen-satisfaction** — glancing at the reminder does not clear it; only a
terminal disposition (logging the dose → `acted`, or an explicit dismiss)
does — and it re-alerts on the cadence while live (§7, §9.3). The med
pattern may still re-post as the deadline nears (fresh event key, same
`threadKey`, each rung displacing the last), but that is *content
escalation* ("30 minutes left"), not liveness — the nag no longer depends
on the source's own timer discipline. Logging the dose advances the
subject artifact and the steward terminally retracts every pending rung,
including embargoed ones (§4.7). Phase gating is real: the cadence firing
between commits needs timer wake (§10.5) — before phase 2 this story is
not safely servable and products should not pretend otherwise.

### B.3 On-call triage (exactly one person must act)

A pager event lands in a three-person ops space at 11pm. Each on-call
member's rotation adopted `{match: {spaceDid: ops-space, kind: "pager"},
clamp: {min: "interrupt"}, bypassQuietHours: true}` — the `spaceDid` bound
matters: a bare kind-matched interrupt floor would be claimable by any new
source declaring `kind: "pager"` (§7). Bea acks from her lockscreen via
`actions` (§4.6): terminal `acted`, appended to the pattern's `replyTo`
cell under her session authority. Her runtime discloses the disposition
into `PerSpace` state; the space's opt-in policy "acted-by-any demotes to
silent for all" re-lanes Dana's and Sam's notices; posture demotion
retracts their banners (§9.3). If nobody acts in 15 minutes, the space's
escalation policy raises the owner's notice — a deadline evaluation that
needs timer wake (§10.5). One pager event, three independent ledgers,
collective quiet from one policy record — the part no siloed platform can
express.

### B.4 The overnight agent run (quiet work, visible)

Tomás's filing agent renames 200 documents at 3am. It posts *one*
receipt-shaped notice (`threadKey` = run id, `progress` ticking silently),
laned `silent` by the agent-completions default. The 200 changes are never
posted at all — they are derived: the while-you-were-away view runs one
`changes(watchSet, basis, attribution: true)` call and folds every entity
whose change `author` is the run's session under the receipt. Tomás sees
one line, expands it, jumps into anything suspicious with the changed
region emphasized. Zero buzz, full visibility, and the trust that makes
overnight agents acceptable — the design's home turf, strong from phase 1
(phase 0 gives the dots without the run grouping).

### B.5 The 2FA code (time-critical, worthless in minutes)

Marcus is mid-login on his laptop; the code arrives via his SMS forwarder.
Webhook ingress persists durably at the handler (§6.1); the candidate
carries `expiresAt: +5min` and a `postureHint: "heads-up"` (or `interrupt`
via a one-time adopted policy the OTP pattern proposed at setup — a
realistic single config). A second code coalesces silently over the first
(`id`-keyed replace, §9.3). Expiry hides the notice immediately on read;
the OS tray copy goes stale until timer wake lands — the spec's own §9.3
honesty note, and tolerable here because the user is at a client by
construction (they're logging in). One friction worth product attention: a
cautious confidentiality label pushes the code behind the generic envelope
— the rare notice whose whole value is lockscreen visibility; the OTP
pattern should set `redacted` to carry the code deliberately.

### B.6 The social stream (high-volume, low-value; downward bias earns its keep)

Nina's social importer posts ~80 like/follow events daily; she never opens
them. Intake quotas bound the flood at the write gate against verified
writer identity (§10.2). Her dismiss-without-open pattern becomes a
**learned policy** she can read — `{match: {kind: "social"}, clamp: {max:
"silent"}, author: steward, reason: "37 of 40 dismissed without open over
30d"}` — and the source can never buy its way back up (learned policies
only lower; §7). The review lane stays bounded; the weekly digest groups
the residue by `kind`. This is the reputation loop as a legible artifact
rather than a black-box feed model — strong from phase 1.

### B.7 Medical results on a shared-visibility lockscreen (privacy)

Ray's clinic portal posts test results; his partner sometimes sees his
lockscreen. The notice's confidentiality labels forbid egress to the push
relay, so the adapter sends the generic envelope unconditionally — full
content fetched on unlock/app-open (§9.3) — and `redacted` lets the product
choose neutral copy. Tray-dismiss on the shared-visibility device is
per-device (§9.3), so dismissing there doesn't clear his laptop. Muting the
thread is a policy write in his home space — never readable by the clinic
or anyone else, with the behavioral-inference bound §7 states honestly.

### B.8 Approving the agent's rebooking (act from the surface)

Grace's travel agent drafted a rebooking; the fare hold expires soon. The
notice carries `attachment` (the itinerary diff), `expiresAt` (the hold),
and `actions: [approve, deny]` with a `replyTo` cell (§4.6). Approve from
the lockscreen: terminal `acted` disposition + `{key: "approve", noticeId,
at}` appended to the pattern's reply cell under her ordinary session
authority; the acted terminal retracts the notice on every device. Two
honest caveats: acting from a locked device presumes an authenticated
session on-device, and a stale tray (§9.3) means she could approve a
just-expired fare between wakes — the reply cell's consumer must treat
replies as requests, not facts.

### B.9 The visa renewal (long-lived deadline ladder)

Hana's visa expires in October; she wants `review` at T−90, `heads-up` at
T−30, `interrupt` at T−7. The **deadline ladder** idiom (§7): the pattern
posts all three candidates ahead of time with ascending `notBefore` dates,
the same `threadKey` (each admission displaces the prior rung), ascending
hints, plus a proposed min she adopts once — at setup, when she's thinking
about it. Renewal filed → subject advances → the steward retracts every
pending rung including embargoed ones (§4.7). The gate is timeliness:
`notBefore` materialization is evaluate-on-read until timer wake (§10.5) —
nearly harmless at 90-day horizons for a daily shell user, unacceptable for
B.2's same-day cadence, which is why both stories hang on the same §10.5
line item.

### B.10 The adversarial source (spam defense)

"DealBlaster," installed for price tracking, turns hostile: floods
candidates, hints `interrupt` with `ext.urgency: "CRITICAL"`, tries to
collide the banking source's notification id, re-declares its kind as
"group-chat" to catch the human-messages default. Every defense is
structural, not heuristic: hints can't raise (§4.2); `ext` is quarantined
from routing (§4.4); `id` is steward-derived from verified provenance, so the
collision is impossible by construction; quotas bind to verified writer
identity (§10.2); dismiss-without-open writes a legible learned max (§7);
unconditional alert-once means even fresh-event-key spam can't re-buzz past
its clamped rung; and the kind-lie fails because above-`review` defaults
key on verified facts, never self-declared `kind` (§4.2) — declaring
yourself "group-chat" buys nothing without a verified human `actor` the
user actually knows.

### B.11 The marketplace stranger (first contact from an unknown human)

Maya lists a couch; a legitimate buyer — verified human DID, zero prior
relationship — messages her, and the first responder wins the sale. Before
the first-contact default existed, this story graded C: the buyer failed
the established-relationship test and sank indistinguishably into `review`
alongside importer noise, and Maya couldn't even hand-write a fix because
`match` had no `actor` dimension. As specced now: the message lands in the
**requests shelf** (`review`, distinguished grouping, quota-bounded — §7),
where it reads as a person, not noise; one tap on the promote affordance
writes `{match: {actor}, clamp: {min: "heads-up"}}` and the conversation is
loud thereafter. For time-critical listings, the sanctioned louder path is
the pattern proposing a listing-scoped min at listing time (the
moment-of-intent idiom). Downward bias holds: minting DIDs buys a stranger
nothing above the requests shelf. Note `threadKey` must be per-buyer, not
per-listing — thread displacement (§6.4) would otherwise let buyer #2's
inquiry retract buyer #1's.

### B.12 Return from vacation (bulk catch-up must be bounded)

Jonas is offline 16 days: ~300 notices, ~80 unseen artifact changes across
12 spaces. The joins do most of the collapsing for free — 16 days of one
chat is *one* notice (coalescing + thread displacement), everything he
handled from his phone abroad is already satisfied everywhere (seen-join),
expired 2FA/fare-holds are hidden and swept, matured ladder rungs displaced
each other. Two rules close the rest: the sweep's **aging** demotes
unhandled `heads-up` older than 7 days to `review` (§4.5), so the bell
shows this week, not a 16-day wall; and the dispatcher's **reconnect
damping** (§9.3) alerts only for notices newer than the gap — the return is
a quiet shelf plus one "while you were away" view (which is *specified* as
the every-return view, §5), not a buzz storm. Residual: whether
"touched-recently" survives 16 days in the watch set is open question
§12.2 — the vacation is the case that forces that answer.

### B.13 Work and personal (context separation)

Sofia keeps work and personal profiles and wants work quiet on evenings
and weekends, family always through, one device. Profiles are the coarse
cut: profile ≡ own home space ≡ own attention state (§8) — her work
steward and personal steward are independent by construction, and one
shell merging two ledgers is presentation, not runtime. Within the work
profile, context is ordinary policy: `{match: {spaceDid: work-space},
effect: {quietHours: {start: "18:00", end: "09:00"}}}` for evenings plus
`{quietHours: {start: "00:00", end: "24:00", days: ["sat","sun"], max:
"suppress"}}` for weekends (§7's day-scoped, max-bearing quietHours), and
`{match: {threadKey: family}, clamp: {min: "heads-up"}, bypassQuietHours:
true}` for the always-through exception. Every piece is a legible record
she can read back.

### B.14 Day one (defaults before any learning)

Riley is brand new: no learned policies, no adopted packs, defaults only.
The load-bearing line is §7's composition ceiling — `baseline =
min(postureHint, "review")` — without which a day-one source hinting
`interrupt` would simply get it (no learned history, no matching max: the
formula's original cold-start hole, now closed). The week then looks like:
messages from imported contacts → `heads-up` from day one (rosters are
seeded by contact import, §7 — without that, the established-relationship
default fires for nobody and the app reads as broken silence exactly when
it's being judged); strangers → the requests shelf; importers and agents →
`review`/`silent`, bounded by intake quotas until learned clamps
accumulate evidence. Honest weakness: the review lane is at its noisiest
in week one, before any learning — the propose/adopt idiom (patterns
proposing their own sensible clamps at install) is the mitigation, and
§12.8's evidence thresholds decide how fast learning kicks in.

## References

- `docs/specs/shared-profile-rosters.md`, `docs/specs/shared-profile-space.md`,
  `docs/common/conventions/HOME_SPACE.md` — multi-user substrate; the
  contribute-your-own idiom; `writeAuthorizedBy` in production.
- `docs/specs/server-side-execution/README.md` — standing registrations,
  wake-on-commit, `onBehalfOf` attribution (steward execution home; §6.3
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
  discipline; the `subject` field-naming precedent; the
  system-inferred-but-user-owned precedent for learned policies (§7).
- `packages/runner/src/cfc/prepare.ts`, `packages/runner/src/cfc/ui-contract.ts`
  — `writeAuthorizedBy` enforcement (cell-write path); trusted surfaces.
- `packages/runner/src/builtins/navigate-to.ts`,
  `docs/common/conventions/wish.md` — navigation from stored cell links;
  the `candidates` → `result` lifecycle precedent for candidate → notice.
- `packages/ui/src/v2/components/cf-toast/`, `cf-alert`, `cf-badge` —
  existing presentation components.
- `packages/background-piece-service/README.md` — why the steward does not
  run there.
- PR #4132 (annotation-primitive prototype, draft) — the documented
  anti-precedent for storage-side reverse indexes invisible to the reactive
  graph; §10.1's design constraint.
