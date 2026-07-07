# Reactive Interpreter v2 — Decision Log

Append-only. Date + evidence. Divergences from the design docs land here
first, then the design doc is amended.

## D-V2-BRANCH — build on `claude/priceless-rubin-89ad5e` (2026-07-02)

The branch is `origin/main` + the v2 spec — i.e. it already *is* "a new
branch from main". #4298 is harvest-only (files ported and adapted, never
merged). Rationale: #4298 is +30k lines against a main that has moved, and
its architecture (runtime extraction) is what v2 rejects.

## D-V2-SEQ — builder-first, transformer-second (2026-07-02)

06-migration-plan's V0/V1 put "transformer emits the ROG artifact + ROG →
legacy expander" first. Refined: **the builder is the first (and unifying)
IR front-end.** Compiled patterns *execute builder calls* at construction
time (the transformer emits `__cfHelpers.lift(...)`/`ifElse(...)`/`h(...)`
calls), so making the builder record IR ops during `pattern()` construction
covers compiled AND hand-built patterns with:

- **zero recognition** (the builder has the live semantic call — `ifElse`
  knows its branches, `str` knows its template — v1's extract.ts existed
  only because it started from serialized JSON);
- **zero transformer change** at first (native expr/str ops are W5
  increments on a working pipeline);
- **no expander needed** until legacy-node retirement (the builder keeps
  building legacy nodes as today; the ROG rides alongside, inert flag-off).

Consequences: the pattern JSON gains a versioned optional `rog` field so
*loaded* patterns interpret without re-derivation; the field MUST be
identity-neutral (pattern hashing/content-addressing unchanged — old and new
serializations of the same pattern keep the same identity). 01-decisions
D-V2-ARTIFACT §1–2 remain the end-state; the expander moves to the
legacy-retirement stage.

Risk accepted: builder-recorded ROG must stay consistent with the legacy
nodes it parallels (one source of calls builds both, so divergence = a
builder bug, caught by the differential oracle).

## D-V2-HARVEST-BASE — port-and-adapt, never blind-copy (2026-07-02)

#4298 is based on a main a few days older (its HEAD `99c8b1eca`,
2026-06-30); every harvested file is compiled + tested against current main
before commit. Harvest order: rog.ts (W1), interpret.ts + partition.ts +
measurement harness (W3), collection-interpreter mechanics (W4), test
oracles per work order.

## D-V2-ROG-SIDETABLE — ROG lives in a WeakMap side-table, never in the pattern JSON (2026-07-02)

Recon (builder pipeline, cited to main): pattern identity is content-addressed
from serialized bytes, so ANY new serialized field breaks identity stability
for every existing pattern. Also: compiled patterns are constructed by
EXECUTING the factory once at module load (`pattern(fn)` pushes a frame, runs
fn, collects nodes — builder/pattern.ts:122-168), and `$patternRef`-loaded
patterns resolve through the artifact index back to that factory. So:

- The ROG is built at `pattern()` FINALIZATION from live objects (NodeRefs
  with live modules, live input/output cells) — direct Map lookups, zero
  shape recognition. `str` emits `interpolate` (the builder holds the static
  template), `ifElse`/`when`/`unless` emit tagged `control`, builtin refs
  classify by NAME into effect ops — v1's recognizers become emissions.
- Attached via WeakMap (pattern-metadata idiom): identity-neutral by
  construction, no serialization change at all.
- A pattern that arrives as PLAIN JSON with no live factory has no ROG →
  legacy instantiation (exactly D-V2-ARTIFACT's "old artifacts on the legacy
  loader"). Coverage census tracks how often this occurs.
- ROG construction is ALWAYS-ON (cheap, inert data); the flag gates dispatch
  only. An unsupported builder shape marks the ROG incomplete with a reason
  (fail-closed → legacy dispatch) rather than failing construction.

Amends 02-ir.md §3 (serialization) and D-V2-SEQ's "versioned optional `rog`
field" — superseded by the side-table.

## D-V2-INTERNALS-TABLE — internals are table-indexed, not string-keyed (2026-07-02)

v1 keyed internal cells by `JSON.stringify`ed partialCause strings. v2: each
Rog carries `internals: InternalDecl[]` ({partialCause, schema?}) and
`internal` ValueRefs point by INDEX. Nested Rogs have their own table (frames
fall out structurally; no FrameId needed).

## D-V2-F4-DEFER — no write-back cut edges in the first partition (2026-07-02)

The v2 partition ships WITHOUT F4 (boundary write-back) cut edges, despite
the IR carrying `effect.writeTargets`. Three reasons: (1) v1 reached CI-ON
green without them (F4 stayed an open finding); (2) naive edges create a
false cycle — a handler's input CONSTRUCT references the very cell the
handler writes (a binding, not a read-after-write), so every handler pattern
would fail-closed; (3) under pull scheduling the hazard is re-run churn /
conflict surface, not value correctness. Plan: measure lunch-poll conflicts
once dispatch lands (the user's watch-carefully directive), then add edges
that EXCLUDE each boundary's own binding constructs if the ratchet appears.

## D-V2-PURE-PATTERN-INLINE — pure nested patterns are segment-resident (2026-07-02)

A nested `pattern` op whose child BuiltRog is complete and recursively pure
is NOT a boundary: it stays inside its segment and evalRog inlines the child
(v1's W5a win, now by construction at partition time). Only effectful /
incomplete / plain-JSON children remain `pattern` boundaries.

## D-V2-PURE-PATTERN-INLINE — AMENDED: dispatch-off by default (2026-07-02)

Flag-ON triage found the hole: a handler-built child pattern pushed into a
list must be a real, ADDRESSABLE piece (its result cell IS the observable —
the launched-child contract); inlining collapsed it to a value (undefined
list entries in patterns-ifelse push test). Inlining is safe only for
consumed-as-value children, which the dispatch cannot yet distinguish. The
partition keeps the capability behind `inlinePurePatterns` (default false);
evalRog's pattern case stays for that future. Engagement cost recorded by
census as `boundaries_pending:pattern`.

## D-V2-STR-DIRECT — interpolation is a transformer concern, not the str pseudo-builtin (user, 2026-07-02)

`str` is transformer-emitted for regular backtick interpolation. The
interpreter should support backtick interpolation DIRECTLY (the transformer
emits the native interpolate form) rather than recognizing the `str`
pseudo-builtin's lift. The current WeakSet closure-marking of
`interpolatedString` is an acceptable INTERIM (green, zero serialization
risk) for builder-authored `str` calls, but the track is: W5's transformer
emission lowers template literals straight to the interpolate op (a
dedicated builder call), and the str-pseudo-builtin recognition path stops
being load-bearing.

## D-V2-CONTROL-MODERNIZE — explicit ifElse/when/unless are outdated style (user, 2026-07-02)

Explicit `ifElse`/`when`/`unless` builtin calls were once REQUIRED; that
constraint is gone and plain JS ternaries/logical operators are the modern
form (the transformer lowers them). Consequences: (a) where tests/examples
assert explicit-builtin quirks that feel spurious, patterns may be
modernized to the JS form instead of chasing perfect builtin fidelity;
(b) the control_reference_semantics work should not over-invest in
reproducing the explicit-builtin write-shape — in multi-segment emission
control ops stay preserved legacy boundary nodes, and the native-control
path targets the transformer-lowered ternary form.

## D-V2-NEXT — multi-segment emission confirmed as the next work order (user, 2026-07-02)

Segments coalescing around preserved legacy boundary nodes (handlers,
effects, control) — the engagement unlock and the architecturally deep win.

## D-V2-FLATMAP-LEGACY — flatMap stays a verbatim legacy boundary (2026-07-06)

map and filter run on the inline-coordinator chassis; flatMap does not.
Rationale: (a) marginal share of reactive collection usage in the corpus
census (`op_pending` class); (b) its aggregate is a CONCAT over per-element
ARRAYS — element output length is data-dependent, so slot identity in the
container is not a per-element key the inline chassis can subscribe on
(splicing on any one element's length change re-keys every downstream
slot); (c) the payoff per implementation risk is far below map/filter,
both of which keep per-element outputs slot-stable. Revisit only if census
data shows flatMap contributing a non-marginal doc/node share.

## D-V2-FILTER-BATCH-FIRST-PASS — inline filter's first predicate eval is coordinator-inline (2026-07-06)

CFC §8.5.6.1 membership taint requires the container's first write to join
every considered element's content label (the shape IS the secret — even
`[]`), and later membership diffs never touch the container root again
(slot-path writtenPaths; value no-ops skip prepare entirely). Legacy gets
this from batch first-instantiation inside the pattern-run tx. The inline
filter therefore evaluates an element's FIRST predicate inline in the
coordinator's tx (content read deliberately journaled — it IS the taint),
handing subsequent changes to the pointwise per-element effects. Coarse
first stamp, pointwise refinement — exactly legacy's labeling contract,
plus one-pass first settle.

## D-V2-TRANSIENT-COLLECTIONS — segment-resident map/filter/flatMap for value-consumed outputs (user, 2026-07-06)

A collection op whose output is TRANSIENT — consumed only by interpreted
ops, never retained (result tree, boundary refs, effect writeTargets,
transitively-retained constructs) — evaluates IN-MEMORY inside its
segment: no container doc, no per-element docs, no coordinator. Only
retained outputs keep the materialized inline coordinators (they are the
incremental-update path). This is the collection analogue of
D-V2-PURE-PATTERN-INLINE's consumed-as-value analysis, and the common
chained case (`items.filter(..).map(..)` where only the final result is
kept) collapses every intermediate stage to zero documents.

Mechanics:
- Eligibility: element ROG fully inlinable (same test as the inline
  coordinators); `usesArray` initially refused (follow-up: in-memory has
  the whole list, so it becomes supportable later).
- Retention fixpoint: extend the value-consumed walk to collection
  candidates; an ADMITTED candidate stops retaining its list input, so
  chains cascade (recompute until stable — monotone, terminates).
- evalRog gains the `collection` case (today `NotInterpretedHere`):
  map = element-ROG result per item; filter = keep ORIGINAL item on
  truthy predicate; flatMap = concat (UNLOCKED here — the materialized
  blocker was slot re-keying under data-dependent element lengths; in
  memory there are no slots).
- Semantics pinned by differentials, not assumption: undefined list,
  sparse holes, empty results — the in-memory view must match what a
  legacy downstream leaf READS from the container doc (doc-normalized),
  same discipline as non_fixed_point_const.
- CFC: sound by construction — the segment's journaled deep list read
  joins element labels into the per-tx J; there is no container shape to
  stamp (the membership-taint obligation attaches only to MATERIALIZED
  filter output, which keeps the batch-first-pass coordinator).
- Reactivity: the segment's deep list read re-runs it wholesale on any
  element change — the deliberate trade for transient outputs (in-memory
  recompute, no doc round-trips) vs the materialized path's per-element
  incrementality for kept outputs.

## D-V2-SCOPES-PER-OP — scope flow-tracking at per-op granularity (user, 2026-07-06)

Berni's design brief, realized: "track the scopes through the flow of
data, so we know what the final scope is when writing something (even if
the output scope is declared as space, if derived from session-scoped
data it becomes session-scoped and we add that redirect from the space
scope doc to the session scoped one)". Legacy already IS this — per node
action, via narrowest-read-scope + sendValueToBinding's scoped-instance +
redirect write. The interpreter's obligation is GRANULARITY: a segment
collapses N legacy actions, so one tx-ambient scope would smear a scoped
read across sibling ops (proven by the sibling differential before the
fix). Per-op = exactly legacy.

Three load-bearing findings:
1. LAZY DEREFS: leaf inputs are query-result proxies — the scoped link's
   deref happens inside the leaf BODY, not the seed read. Seed-time
   capture alone observes nothing (session reads landed after every
   capture had closed); the per-op RUN BRACKET is what attributes them.
2. JOURNAL INVARIANCE: the first implementation switched the bulk inputs
   read to per-key reads for attribution and broke a scoped-map resume
   test — the segment's journaled read set drives re-run reactivity and
   must stay byte-identical. Scope attribution therefore uses bare
   resolveLink (self-exempt probes) + run brackets, never extra reads.
3. CACHE BLINDNESS: the per-tx Cell.get() cache elides the reads scope
   tracking observes — entries now record the fill's narrowest scope and
   replay it on hits (also closes a latent legacy under-narrowing hazard
   in warm batch transactions; under-narrowing is the leak direction).

Static markers stay legacy-owned: raw-builtin outputBinding folds,
pattern-node child scoping, and frame-result schema folds are all
boundary territory (verbatim instantiation); legacy's simple javascript
path IGNORES static scope for plain-value lifts (pinned by differential).
Value-consumed inlining refuses scope-declaring children.

## D-V2-RESOLVED-COPY — derived copies dispatch via the validated canonical ROG (2026-07-07)

The STRICT `getBuiltRog` lookup (direct WeakMap key) misses for a DERIVED
COPY of a pattern (reload rehydration, embedded/serialized sub-pattern),
even though its canonical ROG resolves via the derivation chain. Measured
on the multi-user chat sim: 16/16 `no_rog` misses were resolvable AND
positionally faithful — a FALSE REJECTION, not a genuine plain-JSON tail.

Dispatch now recovers them: on a strict miss it tries
`getBuiltRogResolved` and binds the canonical ROG (structure + live
side-car by op id) against the COPY's `pattern.nodes` (this-instantiation
boundary modules + alias bindings), gated by a POSITIONAL-CORRESPONDENCE
validation.

**Why validation is load-bearing (not optional):** the canonical ROG's op
ids are POSITIONAL against the canonical's nodes. The dispatch seeds
cross-op reads from `pattern.nodes[i].outputs` and writes a segment op's
value through `pattern.nodes[i].outputs`, trusting copy node `i` == op `i`.
A copy that reordered same-kind siblings or retargeted an alias would
silently mis-wire. A 6-lens adversarial soundness workflow found ZERO
holes against the four current copy sites (all provably order-preserving)
but flagged this REORDER-OF-EQUALS as a latent hole for future copy sites.

**The validation predicate** (each check fails closed with a distinct
census reason):
1. LENGTH — copy node count == canonical node-op count (non-construct ops;
   constructs are the appended id suffix).
2. KIND — per-position module class matches the canonical op kind.
3. ALIAS TARGET (the hardening) — per-position, the copy's node inputs AND
   outputs carry the same alias TARGETS (cell/partialCause/path) as the
   canonical's serialized node, CANONICALIZING AWAY the only two lossless
   copy transforms: `defer`-count bumps (nesting, not target) and `scope`
   folded into `schema` (annotation, not target). Kind+length alone is a
   PROXY safe today; the alias digest makes it a PROOF against future copy
   sites.

`BuiltRog.canonicalNodes` carries the canonical's serialized input/output
alias skeletons (from the `serializedNodes` already built at construction)
so the resolved path can compare without the canonical Pattern. Census
gains `interpretedViaResolved` (resolved-path engagement, counted distinct
from strict hits — proxy-metric-decoupling). NOTE: recovered chat-sim
patterns are boundary-heavy group-chat sub-patterns that stop at the
`nothing_to_collapse` cost gate — the win is correctness/honesty of the
metric + engagement for any reload/embedded pattern that DOES carry
collapsible compute.
