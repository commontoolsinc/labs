# Reactive Interpreter — design history & lessons

The [spec](./README.md) describes the interpreter as it is. This document
records *why* it is that way: the decisions that shaped it, the ones that were
made and later reversed, and the cross-cutting lessons that recur. Reading it is
optional — the spec stands alone. It exists so that a future change doesn't
re-litigate a settled question or re-learn a paid-for lesson.

Entries are roughly chronological. Each is a decision (`D-`) or a lesson (`L-`),
with what was decided, why, and — where it applies — how it later changed.

---

## Part I — The shape of the thing

### D-BUILDER-BORN — record the ROG in the builder, not the transformer

The original plan was to make the transformer emit the ROG as the compiled
artifact (opaque leaves as content-addressed module exports; legacy nodes
*generated from* the same IR). That was rejected in favour of building the ROG
in the **builder**, at `pattern()` finalization.

Why the builder wins: compiled patterns are constructed by *executing* the
factory once at module load, and the transformer already emits ordinary builder
calls. So at finalization the builder holds the live semantic call — `ifElse`
knows its branches, `str` its template, a builtin ref its name. There is nothing
to recognize. This covers compiled *and* hand-built patterns with one front-end,
**zero transformer change** to start, and **no ROG→legacy expander** (the legacy
nodes keep being built as always; the ROG rides alongside, inert flag-off).

The transformer-emission end-state isn't wrong — it's just a later increment
(native `expr`/`interpolate` ops), reachable on a working pipeline instead of a
prerequisite for one.

### D-ROG-SIDETABLE — the ROG is a WeakMap side-table, never a serialized field

Pattern identity is content-addressed from serialized bytes. *Any* new
serialized field breaks identity stability for every existing pattern. So the
ROG cannot live in the pattern JSON. It lives in a WeakMap keyed on the
factory/pattern objects (the `pattern-metadata` idiom) — identity-neutral by
construction, no serialization change at all. A pattern that arrives as plain
JSON with no live factory simply has no entry → legacy. Construction is always
on (cheap, inert); the flag gates dispatch only; an unrepresentable shape marks
the ROG `incomplete` rather than throwing.

### D-INTERNALS-TABLE — index internals, don't stringify causes

An earlier interpreter keyed internal cells by `JSON.stringify`-ed partial-cause
strings in a flat namespace (collision risk papered over by per-graph maps, and
result-self-references simply unmodeled). Here each ROG carries an
`internals: InternalDecl[]` table and `internal` refs point by index; nested
ROGs carry their own table, so frames fall out structurally with no FrameId.
Result self-references are a modeled ref kind (`result`), which removed a whole
`unrecognized_alias` fallback class.

### L-GRAPH-COMPRESSION — the interpreter is a compression pass, not an engine

The deepest framing, and the one that keeps paying off: the scheduler stays the
reactive engine. Segments and boundaries are ordinary nodes; they inherit
invalidation, CFC, and materialization for free because they read and write the
*same aliases* the legacy nodes did. Every time a design question looked like it
needed a new mechanism (a fan-out primitive, a read-through channel, a second
propagation path), the answer was instead "write the original alias" — the
alias topology *is* the wiring. Boundaries preserved verbatim is the other half:
the interpreter only ever replaces pure regions, never re-implements a boundary.

---

## Part II — What an earlier meta-node design got wrong (and this one avoids)

A prior effort ran a single trusted meta-node per pattern. Three of its
load-bearing claims were refuted by measurement; the refutations are baked into
this design:

- **"One meta-node per pattern; all-or-nothing eligibility."** Refuted: the win
  is **pure-region coalescing** — cut at effect/handler/collection/control
  boundaries, collapse maximal pure regions into segment nodes, hand the coarser
  DAG to the *unchanged* scheduler. Partial engagement per pattern, not
  all-or-nothing.
- **"O(1) documents via inline containers, with pointwise CFC."** Refuted under
  the current CFC machinery: a container write clears child `derived` labels, so
  pointwise requires per-element documents (the materialized coordinator path,
  §11.2) — *or* a new trusted per-path content-label emit that was never built.
- **"Leaves stay opaque sandboxed JS."** Partially refuted: native `expr`/
  `interpolate` ops remove the SES round-trip for operators and `str`. (Live
  leaf capture also removed SES from the *trusted* leaf path, which is why the
  remaining `expr` work is hygiene, not a correctness unlock — see spec §14.)

Two pathologies from that effort gate any default-on decision and are why the
flag stays default-off until measured clean:

- **Cross-space pull amplification** (~226–270× timeouts on the multi-user /
  cross-space tests): a schema-less whole-state sink deep-traversing the
  coalesced result graph, combined with a reader-isolated cross-space doc that
  never loads, forms a re-sync/re-dirty loop. This interpreter's multi-user chat
  simulation runs clean (~5s, ~3% faster than legacy) — the pathology is absent,
  but the gate remains.
- **The write-back (F4) I/O ratchet** — see D-F4-DEFER.

### D-F4-DEFER — no write-back cut edges in the first partition

The IR carries `effect.writeTargets`, but the partition ships *without* F4
(boundary write-back) cut edges. Three reasons: (1) the prior effort reached
flag-on green without them; (2) naive edges create a **false cycle** — a
handler's input construct references the very cell it writes (a binding, not a
read-after-write), so every handler pattern would fail closed; (3) under pull
scheduling the hazard is re-run churn / conflict surface, not value correctness.
Plan: measure conflicts once dispatch is stable, then add edges that *exclude*
each boundary's own binding constructs only if a ratchet actually appears.

---

## Part III — Collections

### D-PURE-PATTERN-INLINE → consumed-as-value analysis

First decision: a nested `pattern` op with a complete, recursively-pure child is
not a boundary — it evaluates in-segment (inline the child ROG). Flag-on triage
then found the hole: a handler-built child pattern *pushed into a list* must be a
real, addressable piece (its result cell IS the observable — the launched-child
contract); inlining collapsed it to a value and broke a push test. The capability
was gated off by default until it could tell consumed-as-value children from
retained-as-piece ones. That discriminator became `findValueConsumedOps` (spec
§6.3) — a retention walk that admits a candidate only if its output is never
referenced from the result tree, an effect, or another boundary. The same walk
generalized to collections (below).

### D-FLATMAP-LEGACY — flatMap stays a verbatim boundary when materialized

`map` and `filter` run on the inline-coordinator chassis; materialized `flatMap`
does not. Its aggregate is a **concat over per-element arrays** — element output
length is data-dependent, so slot identity is not a per-element key the inline
chassis can subscribe on (a length change on any element re-keys every
downstream slot). The payoff-per-risk is far below map/filter, whose per-element
outputs stay slot-stable. (`flatMap` *is* handled by the transient path, where
there are no slots — see below.) Revisit only if the census shows flatMap
contributing a non-marginal doc/node share.

### D-FILTER-BATCH-FIRST-PASS — the membership-taint lesson

The subtlest CFC bug in the whole effort, and worth remembering because a
byte-equality differential *cannot* catch it. Which elements a `filter` keeps is
a secret; the container's *shape* must carry the join of every considered
element's label — **even when the result is `[]`**, and even though later
membership diffs only touch slot paths, never the container root (so a value
no-op skips label emission entirely). Only the *first* root write can stamp the
membership secret. Legacy gets this from batch first-instantiation inside the
pattern-run tx. The inline filter mirrors it exactly: an element's **first**
predicate evaluation runs inline in the coordinator's own tx (the content read
is deliberately journaled — it *is* the taint), then hands off to the pointwise
per-element effects. The bug was found only by the pointwise CFC suite; the
differential was green throughout. **Lesson: for label correctness, a value
differential is necessary but nowhere near sufficient.**

### D-TRANSIENT-COLLECTIONS — segment-resident collections (the big doc win)

A collection whose output is *transient* — consumed only by interpreted ops,
never retained — evaluates in memory inside its segment: zero container docs,
zero per-element docs, zero coordinator. The retention fixpoint makes chains
cascade: `items.filter(..).map(..)` feeding a lift collapses every intermediate
stage to nothing. `flatMap` unlocks here (no slots in memory). The semantics are
pinned by differentials, not assumed — the first `flatMap` draft guessed "skip
non-array element results," and the differential immediately caught that legacy
*pushes* a defined non-array value. **Lesson: match legacy's document-normalized
read semantics op by op; guessing loses.** The reactive trade is explicit: a
transient collection re-runs its whole segment on any element change (in-memory
recompute) versus the materialized path's per-element incrementality — which is
exactly why *retained* outputs keep the materialized coordinator.

---

## Part IV — Scopes

### D-SCOPES-PER-OP — track scope per op, because a segment collapses N actions

Cell-scope narrowing (a value derived from session data becomes session-scoped,
with a redirect from the space doc) is something legacy already does — per node
action, via narrowest-read-scope + the scoped-instance-plus-redirect write. The
interpreter's only obligation is **granularity**: a segment collapses N actions,
so one tx-ambient scope would smear a scoped read across sibling ops. Per-op
tracking = exactly legacy. Three findings were load-bearing:

1. **Lazy derefs.** Leaf inputs are query-result proxies; the scoped link
   dereferences inside the leaf *body*, not at seed read. Seed-time capture
   observes nothing — the per-op **run bracket** is what attributes the scope.
2. **Journal invariance.** The first cut switched the bulk input read to per-key
   reads for attribution and broke a scoped-map resume test: the segment's
   journaled read set drives its re-run reactivity and must stay byte-identical.
   Attribution therefore uses bare `resolveLink` (self-exempt probes) + run
   brackets, never extra reads.
3. **Cache blindness.** The per-tx `Cell.get()` cache elides the reads scope
   tracking needs; entries now record the fill's narrowest scope and replay it
   on a hit — which also closed a latent legacy under-narrowing hazard in warm
   batch transactions (under-narrowing is the unsafe direction).

Lifting the old pattern-wide `scope_narrowing` fallback (which had refused these
patterns outright) let ~39 scope-oracle cases interpret while matching legacy's
full `{value, internal scope, redirect scope}` triple per output. Static scope
markers stay legacy-owned (boundary territory); value-consumed inlining refuses
scope-declaring children.

---

## Part V — The `$patternRef` reversal (a two-act story)

This is the clearest example of the design improving by *deleting* code, and it's
worth the full telling because the same mistake is easy to repeat.

### Act 1 — D-RESOLVED-COPY: recover derived copies via a validated canonical ROG

Dispatch uses the *strict* `getBuiltRog` (op ids are positional against the exact
object's nodes). It was missing for **derived copies** of a pattern — the chat
sim showed 16 patterns hitting `no_rog` that were actually resolvable via the
derivation chain and positionally faithful. A false rejection, not a genuine
plain-JSON tail. So a recovery path was built: on a strict miss, resolve the
canonical ROG and bind it against the copy's nodes, gated by a
**positional-correspondence validation** (length + per-position module-kind +
per-position alias-target digest, canonicalizing the two lossless copy
transforms — `defer` bumps and scope-folded-into-schema). A six-lens adversarial
soundness review found zero holes against the four copy sites but flagged a
"reorder-of-equals" hole for future sites, which the alias digest closed.

### Act 2 — remove it, because the copies were killed at the source

A follow-up made the *binding machinery* (`unwrapOneLevelAndBindtoDoc`) represent
a referenced pattern as a compact `{ $patternRef }` sentinel resolved back to the
live canonical, instead of structurally copying it. That eliminated the **only**
source of derived-copy pattern objects reaching the interpreter — measured 16/16
in the chat sim, all traced (via a per-site `noteDerivedCopy` probe) to the
binding copy, *not* reload or serialization. With copies gone at the source, the
entire recovery path became unreachable by any real pattern (authored patterns
hoist to `$patternRef` → strict hit; a reload re-runs the factory → strict hit).
A disable-and-run experiment confirmed only the path's own synthetic tests
depended on it (817/820 flag-on with it stubbed to `no_rog`), so it was removed —
net −548 lines, including the whole positional-correspondence + alias-digest
machinery. A ref-less hand-built / bare-Engine pattern that misses the strict
lookup now just runs legacy (fail-safe).

**Lesson (L-KILL-THE-COPY): don't build a recovery path for a bad input class —
eliminate the class at its source.** The recovery path was correct, hardened,
and tested, and it was still the wrong move; the right fix was one level up, in
how patterns bind. The tell was that the copies all traced to *one* site.

A cross-boundary footnote: the `$patternRef` change regressed the notes pattern
(a stream handler's argument went undefined) because the sentinel initially
dropped `argumentSchema`/`resultSchema` — bisected to the chip, flag-independent,
and fixed by carrying the schemas on the sentinel. **Lesson: a compact reference
must carry everything a consumer validates against, not just identity.**

---

## Part VI — Cross-cutting lessons

### L-PROXY-METRIC — pick a metric that is RED until the real mechanism runs

The single most repeated lesson. "It didn't error" is not "it engaged." The
census (attempted / interpreted / fallbackByReason / nodeOpsCollapsed /
boundariesByKind / transientCollections) exists so engagement is *measured*.
Twice, an earlier effort drove a suite green via fallback and mistook it for
engagement. Corollaries applied throughout: keep a separate counter for any
second engagement path (the resolved-copy path had its own
`interpretedViaResolved` so it could never be confused with strict hits); run
the realistic test early; and never build "expected-site" lists from
head-truncated greps.

### L-DIFFERENTIAL-IS-NECESSARY-NOT-SUFFICIENT

The differential oracle (byte-equal results + byte-equal reactive updates,
flag-on vs flag-off) is the backbone of correctness — but it is blind to two
classes: **CFC labels** (the membership-taint bug was green on the differential;
only the pointwise CFC suite caught it) and **document/scope structure** (a value
can be right while its scope redirect or its per-element doc set is wrong). Every
such property needs its own oracle: the pointwise CFC suite, the scope
`{value, internal-scope, redirect-scope}` triple, the doc/node footprint harness.

### L-LEGACY-DOC-NORMALIZATION — match what legacy *reads*, not what it *computes*

The interpreter feeds values to leaves directly; legacy reads them after a
document round-trip. This gap is why constants are gated to fixed points (spec
§5.3), why transient-collection edge cases (undefined lists, sparse holes) are
pinned to legacy's container-read view, and why the `flatMap` contribute rule was
copied verbatim rather than reinvented. Any time the interpreter produces a value
a downstream *legacy* node will read, the value must survive the doc model.

### L-RESUME-IS-THE-HARD-PART — cold paths degrade to legacy

Resume/recovery (reload from synced state) is the least-tested, most-timing-
sensitive path. Policy: resumed instantiation refuses inline collection
substitution and uses the battle-tested legacy coordinator; the inline
coordinators degrade monotonically to the real legacy builtin (identical
signature + cause) on any scoped/runtime-swap/resume trigger. The one residual
flag-on exit-leak lives exactly here (an inline-filter build interacting with a
legacy resume), and is a storage-layer follow-up rather than an interpreter
correctness bug.

### L-TEST-PLUMBING-COUNTS

Two infrastructure bugs cost real coverage/CI signal and are worth flagging as a
class: (1) the runner's test task globbed `test/*.test.ts`, which does not match
`test/reactive-interpreter/` — so the interpreter's dedicated suites never ran in
CI, and the module tree read as ~4% covered while its tests passed locally
(fixed by discovering `test/` recursively; coverage 24.6% → 86%). (2) Fabric
values serialized via `JSON.parse(JSON.stringify(...))` collapse to `{}`; the
test snapshot idiom was hardened to a canonical `nativeFromFabricValue` helper —
but *one* test legitimately depended on `JSON.stringify` dropping `undefined`
slots, so it kept the raw idiom with a comment. **Lesson: when hardening a
suite-wide idiom, the one site that resists is often telling you something
true — don't force it green.**

---

## Appendix — commit trail

Milestones, for archaeology (branch `claude/priceless-rubin-89ad5e`, PR #4514):

- Builder-born ROG + side-table; strict/resolved lookup split.
- Multi-segment emission around preserved boundaries; the ~15-line runner seam.
- Inline `map`/`filter` coordinators; batch-first-pass membership taint.
- Consumed-as-value nested-pattern inlining.
- Const doc-fixed-point gate (`edb624ab9`).
- Transient collections + `flatMap` unlock (`cb32e2e10`).
- Per-op scope flow-tracking (`da01f15ee`).
- Derived-copy resolved-ROG path (`87c1a1648`) — later removed (`12c89bbd5`)
  after `$patternRef` binding eliminated the copies at the source.
- Coverage/test-glob fix; fabric-safe snapshot helper.
- Watch-drain on replica close (#4590) — fixed the map/list resume exit-leak; the
  filter variant is a tracked follow-up.
