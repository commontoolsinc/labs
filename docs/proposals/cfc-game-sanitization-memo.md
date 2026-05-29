# Modeling hidden-information games with CFC — a forcing function for graded, per-reader declassification

**Status:** Design exploration / motivating sketch (non-normative)
**For:** CFC designers (`../specs/cfc`) and anyone weighing what belongs on the CFC roadmap
**Companion:** working demo pattern at `packages/patterns/poker-sanitization-demo/main.tsx` (type-checks; click-through)

---

## What this is, and the decision it informs

This memo uses a board game as a **forcing function** to surface a capability CFC does not yet
have and probably wants: **declassification that produces a *reduced shape* of a value,
different for each reader, evaluated when the value is read.**

It is **not** a proposal to ship a poker game. The game is the crispest, most self-contained way
to exhibit the missing primitive; the same primitive underwrites a class of real product
features (below). The decision this memo informs is:

> Should *graded, per-reader projection* (and its sibling, *policy-controlled unlinkability*) be
> on the CFC roadmap as first-class primitives — or is the intended answer always "partition into
> scopes"?

**Central claim, in one sentence.** CFC's group/role model, opaque references, and collection
constraints already cover most of a hidden-information game; the two things genuinely missing are
(1) a small *ordered* reveal dimension with a read-time projecting declassifier, and (2) a way to
make a reference's *linkability* a policy-controlled, declassifiable fact. Everything else maps
onto machinery that already exists.

---

## Why this matters beyond games

A hidden-information game is the purest instance of a pattern that recurs across collaboration
and privacy features: **the same stored value must appear in different, *partially* redacted forms
to different people, and the redaction is graded, not all-or-nothing.**

The "reveal only the count / only that it exists / only the order" moves a card game needs are
exactly:

- a shared document where a collaborator may see **that a field exists** but not its value;
- a per-recipient **summary** that reveals aggregate facts (how many items, what categories)
  without the items;
- a roster where teammates see **names** and outsiders see only a **headcount**;
- an audit view that proves **a record was touched** without disclosing the record.

CFC today reaches for **scopes** (`PerUser` / `PerSpace`) for all of these — which forces a
binary partition (you're in the scope or you're not) and turns every change in visibility into a
data migration. The game makes vivid what scopes can't express: a *graded* reveal that *changes
over time* (deal → hidden, showdown → visible, fold → "existed") on a *single* canonical value.

If CFC can express the game cleanly, it can express all of the above with one mechanism.

---

## The model we're emulating: `github.com/jkomoros/boardgame`

`boardgame` is a mature Go framework for turn-based board/card games. Among its subsystems is a
small, unusually sharp **state-sanitization model**, and that subsystem — not the game engine —
is what we want to learn from.

### The core idea in one screen

The server holds **one** true game state. When it sends state to a particular client, it emits a
**redacted projection tailored to that viewer**. The true state is never mutated; each player
simply receives a different lossy view of the same thing.

Consider a hand of two cards that Alice holds. One declaration governs every viewer:

```go
// In Alice's player-state struct. "len" applies to the "other" group by default.
Hand boardgame.Stack `sanitize:"len"`
```

From that single tag, the framework computes, *per recipient*:

| Viewer | What they receive for `Alice.Hand` |
|---|---|
| **Alice herself** (`self`) | `[A♠, K♥]` — the real cards |
| **Bob / any other player** (`other`) | two face-down placeholders — *"Alice holds 2 cards"*, no faces |
| **A spectator** (`other`) | same as Bob — count only |
| **Admin / game log** | full true state |

That is the whole "aha": **one policy declaration → a correct, per-viewer, partially-redacted
projection, for free.** No hand-written "build Bob's view" code; no separate count cell to keep in
sync. (Source: `state.SanitizedForPlayer` at `sanitization.go:170`; tag parsing in
`struct_inflater.go`; `Game.JSONForPlayer` is the egress boundary, `game.go:212`.)

### The reveal lattice

The redaction is **graded**. Each field is assigned one policy from an ordered lattice (for
collections; scalars collapse to visible-or-hidden):

| Policy | A non-privileged viewer learns… | Rank |
|---|---|---|
| `PolicyVisible` | everything | 0 (most revealing) |
| `PolicyOrder` | positions/order, **values replaced** by placeholders | 1 |
| `PolicyLen` | **count only**, order destroyed | 2 |
| `PolicyNonEmpty` | **one bit**: empty or not | 3 |
| `PolicyHidden` | nothing; field looks absent | 4 (most restrictive) |

### Groups and resolution

A policy binds to a *(field, group)* pair. Built-in groups are `self` (the viewer owns this
substate), `other` (everyone else), and `all`; games can define custom enum groups and computed
`same-TEAM` / `different-TEAM` groups. When a viewer is in several groups, the
**least-restrictive matching policy wins** (`base/game_delegate.go:325`).

### The clever part: identity that survives moves but not shuffles

Each card carries an unguessable id, `sha1(gameID + secretSalt + deck + index + secretMoveCount)`
(`component.go:319`); the salt is never sent to clients, so an unobserved id is uncomputable. Two
properties make this powerful:

- **Stable across public moves**: a card keeps its id as it slides between visible piles, so a UI
  can animate "the *same* card" moving — without anyone needing to know its face.
- **Scrambled on shuffles and secret moves**: `Shuffle()` bumps `secretMoveCount`, changing every
  id, and records old↔new ids in `IDsLastSeen` (`stack.go:1272`). A viewer learns "these N cards
  became those N cards" (so the shuffle still animates) but **cannot recover which became which**
  — exactly the unlinkability a shuffle should create. A *public* shuffle reorders *without*
  scrambling, so cards remain trackable; the framework distinguishes the two on purpose.

So a card's identity carries two policy-relevant facts: a **stable animation token** and a
**linkability relation that can be deliberately severed.**

---

## What CFC already expresses

Reading `../specs/cfc`, the *group/labeling* half of this maps onto existing machinery with no
new mechanism:

| Boardgame | CFC today | Reference |
|---|---|---|
| Groups `self`/`other`/`all`/`team` | **Spaces + roles**; "any reader can view" emerges from role membership, not DNF labels | `03-core-concepts.md` §3.6 |
| "least-restrictive policy wins" | CNF access check: satisfy ≥1 alternative per clause | §3.1.4 |
| Faceless placeholder + opaque id | **Opaque inputs / opaque handles** — a reference you can pass but not read | `08-13-opaque-inputs.md`; `14.2.2.7` |
| `PolicyOrder` / `PolicyLen` as *structural facts* | **Collection constraints** `permutationOf` / `lengthPreserved`, and the **membership-vs-member confidentiality split** | `08-05-collection-transitions.md` §8.5.3–8.5.6 |
| "order/selection leaks info" | **Selection-decision integrity** | §8.5.7 |

The most encouraging single find: **§8.5.6.1 already separates *membership confidentiality*
(which / how-many items) from *member confidentiality* (each item's value).** That is precisely
the axis `len`/`order` live on. CFC has the right *seam*; it lacks a graded, reader-relative
*projection* across it.

### Being precise about what CFC *does* have (and why it's not enough)

CFC is not purely all-or-nothing — it has three adjacent partial-declassification mechanisms, and
it's worth saying exactly why each falls short, because the gap is narrower and sharper than
"CFC is binary":

- **`maxConfidentiality` ceilings** (`08-08`, render-boundary): bound how sensitive a value may
  be to pass a boundary. This is a *threshold on a whole value*, not a transform that emits a
  reduced shape.
- **Error declassification** (`05-policy-architecture.md` §5.4): reduces an error to
  `sanitizedFields` at a target confidentiality. This *is* a value-reducing declassifier — but it
  is **not reader-relative** (same sanitized error for everyone) and **not an ordered lattice**
  (it's a hand-written field list per rule).
- **`cf-cfc-render-boundary`** (`packages/patterns/cfc-render-policy-demo/main.tsx`): shows/hides a
  subtree in a *trusted host*. It is a **UI gate**, not a transform of the data, and it does not
  stop a reader's runtime from reading the underlying bytes.

So the precise gaps are three, and all three must hold simultaneously for the game:

1. **Graded** — a value reduces to one of several *ordered* shapes, not just pass/block.
2. **Reader-relative** — the shape is a function of *who is reading*, evaluated per reader.
3. **Read-time projection of one stored cell** — the same canonical cell yields many shapes;
   notably, the spec has **no** mention of per-reader / per-viewer / per-recipient projection, and
   the runner deliberately dropped its legacy query-time redaction. Boardgame's
   `SanitizedForPlayer` is exactly this, and CFC has no analogue.

### The obvious objection: "why not just scopes?"

Anyone who knows the runtime will say: put each player's hand in a `PerUser` scope, the table in
`PerSpace`, done. That works for *binary* hidden-vs-visible, and the skeleton pattern uses it. But
it cannot express what the game actually needs:

- **No graded reveal.** Scopes give "in or out." "Bob sees the *count* of Alice's hand" requires a
  separate, manually-maintained count cell — the exact hand-sync code boardgame's one tag avoids.
- **Reveal transitions become data migrations.** Deal (→ hidden), showdown (→ visible), muck
  (→ "existed") are, with scopes, *moves of data between scopes* triggered by handlers. As policy,
  they're a label change on a value that never moves. The latter is auditable and reversible; the
  former scatters the same logical card across scopes over its lifetime.
- **No unlinkability / animation identity.** Scopes have no story for "you may animate the shuffle
  but not trace a card through it," nor for a stable token that survives public moves.
- **Structure leaks.** The *existence* of a per-user cell is itself observable; `existence`-level
  reveal ("a hand was folded, contents never knowable") isn't naturally expressible.

Scopes are the right tool for *coarse* sharing boundaries. The game needs *fine, graded,
time-varying* reveal on values that stay put. That's the new capability.

---

## Proposed primitives (prioritized)

Four primitives. If only one is built, build **#2** (graded per-reader projection) — it is the
core capability and #1 is its data model. #3 (unlinkability) is the novel, higher-risk research
piece. #4 is an enforcement-architecture question more than a label-model one.

Signatures are illustrative, in the style of the existing CFC chapters.

### Priority 1 — #1 Facet labels (the data model)

Generalize §8.5.6.1's two-way (membership vs member) split into a small fixed set of **facets**,
each independently gated, ordered as a reveal lattice that mirrors boardgame exactly:

```ts
type RevealLevel = "hidden" | "existence" | "cardinality" | "order" | "values";
//   hidden      → field appears absent                         (≈ PolicyHidden)
//   existence   → one bit: present / non-empty                 (≈ PolicyNonEmpty)
//   cardinality → count, no order, no values                   (≈ PolicyLen)
//   order       → positions / identity slots, no values        (≈ PolicyOrder)
//   values      → full contents                                (≈ PolicyVisible)
// Scalars collapse to {hidden, values}.

type FacetPolicy = {
  audiences: Array<{ audience: AudienceRef; level: RevealLevel }>;
  default: RevealLevel; // recommend "hidden" as the safe default
};
```

Carried in schema `ifc` under a new `reveal` key, parallel to `confidentiality`:

```jsonc
{
  "type": "array",
  "items": { "$ref": "#/$defs/Card" },
  "ifc": {
    "reveal": {
      "default": "hidden",
      "audiences": [
        { "audience": { "role": "self" },         "level": "values"      },
        { "audience": { "role": "table-reader" }, "level": "cardinality" }
      ]
    }
  }
}
```

`AudienceRef` resolves through **existing space roles** (§3.6) — `self`, `table-reader`, a team
role, etc. The reveal lattice reuses CFC's disjunctive-authorization-via-roles wholesale; only the
*graded ordered level* is new.

**Design question for spec authors:** the levels are *ordered* and resolved *least-restrictive-
wins per reader*, which the conjunctive CNF lattice cannot express. So this looks like a small
*third* label dimension (ordered), beside confidentiality (CNF) and integrity (meet) — analogous
to how integrity already sits beside confidentiality. Is that the right shape, or should it be
sugar over confidentiality caveats? (CNF can't do ordered resolution, which is why I lean toward a
separate dimension.)

### Priority 1 — #2 Reveal projection (the core operation)

A **projecting declassifier**: instead of allow/deny, emit a *reduced value* plus a *residual
label* protecting what was not revealed. This is the capability CFC lacks.

```ts
function revealLevelFor(policy: FacetPolicy, reader: Principal): RevealLevel {
  const matches = policy.audiences.filter(a => reader.satisfies(a.audience));
  return matches.length ? maxLevel(matches.map(m => m.level)) : policy.default; // least-restrictive-wins
}

type RevealedView<T> = {
  level: RevealLevel;
  value: ProjectedShape<T>; // full T at "values"; placeholders at "order"; {count} at
                            // "cardinality"; bool at "existence"; absent at "hidden"
  residualLabel: Label;     // still protects everything NOT revealed at this level
};

function project<T>(value: T, facets: FacetPolicy, reader: Principal): RevealedView<T>;
```

Projecting a 2-card hand:

| level | `value` shape |
|---|---|
| `values` | `[{suit:"♠",rank:"A"}, {suit:"♥",rank:"K"}]` |
| `order` | `[Blinded#a1, Blinded#a2]` (positions kept, faces gone — see #3) |
| `cardinality` | `{ count: 2 }` |
| `existence` | `true` |
| `hidden` | `undefined` |

This is the read-time dual of §8.5's write-time collection constraints, and it subsumes #1 (each
lower level reveals strictly fewer facets).

**Soundness obligation (flag for spec authors):** the residual label must dominate exactly the
un-revealed facets, and the overlapping-declassifier hazard (`14.3.2`) is *sharper* here — a
reader simultaneously in two audiences must get the join, and must never be able to combine an
`order` projection from one render with a `cardinality` projection from another to learn more than
`order` alone. Mitigation (boardgame's): make `project` **deterministic in `(value, reader,
epoch)`** so repeated projections are stable and non-leaky (boardgame salts its order/len
permutation, `randPermForStack`, for exactly this reason).

### Priority 2 — #3 Blinded references with policy-controlled re-linkability (the novel one)

No current analogue. Extend the opaque handle (§8.13) with a **linkage epoch**, and make
*linkability itself a labeled, declassifiable fact.*

```ts
type Blinded<T> = {
  opaqueId: string;     // unguessable; STABLE while linkage is preserved (animation token)
  epoch: number;        // bumped on re-blinding (≈ secretMoveCount)
  // content readable only by a reader whose reveal level for this value is "values"
};

// Public move: identity preserved → a UI can animate "the same token" between containers.
function publicMove<T>(b: Blinded<T>, from: Container, to: Container): Blinded<T>; // SAME id+epoch

// Re-blind (shuffle / secret move): severs linkability.
function reblind<T>(items: Blinded<T>[]): { next: Blinded<T>[]; bridge: LinkageBridge };

type LinkageBridge = {
  type: "https://commonfabric.org/cfc/atom/LinkageBridge";
  before: string[];  // old opaqueIds (multiset)
  after: string[];   // new opaqueIds (multiset)
  // asserts "these became those" but NOT which→which   (≈ IDsLastSeen)
};
```

The new policy idea: **unlinkability is a confidentiality property.** After `reblind`, the
relation *old-id ↦ new-id* carries a clause declassifiable only to a reader whose reveal level
over the container is `order` or higher. A `cardinality`/`existence` viewer gets the
`LinkageBridge` (animation resolves) but not the relation — matching boardgame's
`Shuffle` (scrambles) vs `PublicShuffle` (doesn't). This expresses things confidentiality +
integrity alone cannot: *"you may see a card moved from deck to discard, but not that it is the
same card you saw earlier."*

### Priority 3 — #4 Trusted per-reader materialization boundary (the architecture question)

Boardgame's secrecy is real because `SanitizedForPlayer` runs **server-side before egress.** CFC
enforces at commit-time and at render-time-in-a-trusted-host (UI-only). For real (not UI-only)
secrecy, define a **materialization sink** — the read-time dual of the sink gate (§5.2):

```ts
function materializeForReader(cell: CellRef, reader: Principal): RevealedView<unknown>;
// applies #1 facets via #2 projection and #3 re-blinding before bytes leave the authoritative space
```

This is the heaviest lift and the right place to be explicit about trust: in a peer-to-peer space
where every participant's runtime can read the raw bytes, true secrecy needs either (a) a trusted
materializer participants delegate to, or (b) keeping each player's secret facet in a scope peers
can't read (today's `PerUser` answer). The skeleton uses (b) and marks where (a) would replace it.
**This is genuinely a fork in the road, and #2/#3 only deliver real secrecy if it's resolved** —
worth Berni's explicit call.

---

## Worked example: Texas Hold'em

| Field | Lives in | `reveal` policy | Primitive(s) |
|---|---|---|---|
| `deck` (pre-deal) | table | `{ default: hidden }`, members `Blinded` | #1, #3 |
| `holeCards[p]` | player scope | `{ self: values, table: cardinality }` | #1, #2 |
| `board` (flop/turn/river) | table | `{ default: values }` | #2 (declassify-on-reveal) |
| `pot`, `bets`, `toAct` | table | `{ default: values }` | — (public) |
| `muck` (folded cards) | table | `{ default: existence }`, members `Blinded` | #1, #3 |

1. **Shuffle** → `reblind(deck)`: fresh ids + `LinkageBridge`. UIs animate; no one below `order`
   traces a card through it. (#3)
2. **Deal** → cards `publicMove` deck→hand, then a *secret* deal `reblind`s the destination so the
   hand can't be correlated with deck positions. `holeCards[p]` projects `values` to `self`,
   `cardinality` to the table: Alice sees `A♠ K♥`; Bob sees `{count: 2}`. (#2, #3)
3. **Flop** → three cards `publicMove` deck→board; `board` is `values` to all — a graded
   declassification *up* the lattice, gated by a trusted "reveal community card" intent. Cards keep
   their `opaqueId`, so deal→flip animates continuously. (#2)
4. **Betting** → `pot`/`bets` are public scalars. No new machinery.
5. **Showdown** → surviving hands transition the table's level `cardinality → values`, gated by a
   `Showdown` intent (trusted UI action, §3.8/§6). A graded declassification *event*. (#2)
6. **Muck (fold without showing)** → hand `publicMove`s to `muck` (`existence` to the table) and is
   reblinded in. Everyone learns *a* hand folded; no one ever learns its contents, and no one can
   later prove *which* cards were folded even once the deck is revealed. (#1, #3)

Every mechanic — graded reveal, group resolution, stable-id animation, scramble unlinkability,
declassify-on-reveal — lands on one of the four primitives.

---

## Expressible today vs needs adding

| Capability | Today | With proposal |
|---|---|---|
| Per-player hidden vs visible hands | ✅ scopes (`PerUser` + `PerSpace`) | same, as policy not data partition |
| "Any table member sees the board" | ✅ spaces + roles | same |
| "Opponent has N cards" (count, not values) | ⚠️ only via a hand-maintained separate count cell | ✅ `reveal: cardinality` (#1/#2) |
| "Tile positions visible, faces hidden" (order) | ❌ | ✅ `reveal: order` (#2) |
| Animate a card across public moves | ⚠️ only if its id is public (no secrecy) | ✅ stable `Blinded.opaqueId` (#3) |
| Can't trace a card through a shuffle | ❌ no unlinkability concept | ✅ `reblind` + `LinkageBridge` (#3) |
| One canonical cell, many reader projections | ❌ (render-time, UI-only) | ✅ `materializeForReader` (#4) |
| Reveal that *changes over time* (deal→hidden→showdown) | ⚠️ as data migration between scopes | ✅ a label change on a value that never moves (#2) |

---

## Open questions for CFC designers

1. **Third label dimension, or sugar over confidentiality?** The ordered, least-restrictive-wins
   reveal lattice is not expressible in the conjunctive CNF lattice. A small separate ordered
   dimension (like integrity) seems cleaner — agree?
2. **Where is the materialization boundary?** Is the intended answer always "partition into
   scopes," with `reveal` being a *render-time* convenience over a scope partition the policy
   compiler derives — or is a trusted server-side materializer in scope? (#4 is the fork.)
3. **Re-linkability vs the recombination attack (`14.3.2`).** `reblind` is a *sanctioned*
   unlinkability op. Does it interact with the open recombination hazard, or is it separable
   because it withholds a *relation* rather than declassifying a *value*?
4. **Determinism of projections.** Should `project` be required deterministic in `(value, reader,
   epoch)`, as boardgame's salted permutation effectively is?
5. **Authoring surface.** Does a graded `reveal` belong in `cfc_authoring_contract.md` as e.g.
   `Reveal<T, { self: "values"; table: "cardinality" }>`, lowering to `ifc.reveal`, parallel to
   the existing `Confidential<T, X>`?

---

## The companion pattern

`packages/patterns/poker-sanitization-demo/main.tsx` makes the memo concrete, and is deliberately
split into **what CFC enforces today** vs **what this memo proposes** — so it demonstrates real CFC
idiomatically rather than faking the extension.

**Enforced (idiomatic, real CFC):**

- Each hand is a real `Confidential<Card[], readonly [PokerHoleCards]>` cell, created the idiomatic
  way (`lift` → `Cell.for(id).set(...)`), so it carries a genuine `ifc.confidentiality` label.
- A `cf-cfc-render-boundary` with `maxConfidentiality={[]}` **actually blocks every hand from
  rendering** — this is the one CFC mechanism the runtime enforces today.
- The **showdown is a real integrity-gated declassification**: a trusted-action surface
  (`data-ui-surface` / `data-ui-event-integrity` / `data-ui-action` + a `TrustedActionWrite` output)
  flips the cell that drives `declassifyConfidentiality`. Only that trusted gesture reveals the
  hands; **folded hands are never declassified.**
- `cf-cfc-label` shows a hand's live label (the real `ifc.confidentiality`).

**Proposed (clearly labelled "simulated — not enforced"):** the graded reveal lattice
(`existence`/`cardinality`/`order`) and per-reader projection — shown only as an illustration of the
target shapes, with an explicit note that CFC today is binary (blocked or fully declassified).

The pattern also carries an **honest-limitation panel**: the render boundary hides labelled content
in a *trusted host*; it does not encrypt the cell, so real secrecy between mutually-distrusting
players still needs the per-reader materialization of §4.4.

It **type-checks, deploys, and runs** (`deno task cf check … --no-run`, exit 0; deployed to a local
toolshed and driven in-browser, 0 console errors).

### Live demo (screenshots)

The same hands, before and after the trusted showdown (`docs/proposals/images/`):

- **Blocked** (`poker-v3-01-blocked.png`): every hand shows *"Content hidden by policy"* — the
  render boundary refusing to render the labelled cell — plus a `🔒 blocked by render boundary`
  note. Status: *"Hands are confidential — the render boundary is blocking them."*
- **Revealed** (`poker-v3-02-revealed.png`): after the **trusted Showdown** action declassifies the
  `PokerHoleCards` atom, the same boundaries now permit the cards (`Alice A♠A♥`, `Bob K♦K♣`,
  `Charlie 7♥2♦`). Nothing else in the pattern can flip that cell.

![Hands blocked by the CFC render boundary](./images/poker-v3-01-blocked.png)
![Hands revealed after the trusted showdown declassification](./images/poker-v3-02-revealed.png)
