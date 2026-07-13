# Egress materialization — monolithic rendered output (design)

> **Status**: Design for a **second** flag layered on the reactive
> interpreter ([README.md](./README.md)); **not built**. Requires the base
> `experimentalInterpreter` flag. Motivated by the document-count ceiling
> documented in the interpreter spec §16 and the gating list §18. This
> document proposes the mechanism, the scope, the correctness envelope, and a
> minimal prototype whose only job is to *measure* the win before any
> production commitment.

---

## 1. The problem it targets

The interpreter's document-count win is **flat for real apps** (§16). A
rendered list cascades to per-element documents: retention treats the
rendered output as observable, so the map materializes as an inline
coordinator with one doc + one effect per element, and that materialization
propagates up a `filter → map → map` chain (a retained tail forces the whole
chain materialized — see the partition notes). A real app's persisted store
is therefore mostly boundary documents (rendered VNodes, result-tree, handler
docs) that the interpreter preserves by design.

**Incrementality is paid by default.** Every rendered element is its own
document precisely so that changing one element rewrites one document. Many
UIs never exercise that — small lists, infrequent updates, single-audience
display — and pay the per-element overhead for nothing.

## 2. The proposal

Add a second flag under which the **rendered egress** — the vdom tree
including its mapped collection elements — materializes into **one document**
instead of fragmenting per element. Incremental per-element materialization
becomes an **opt-in** (and an automatic fallback for the cases that need it),
rather than the unconditional default.

Proposed flag: **`experimentalMonolithicEgress`**
(`CF_EXPERIMENTAL_INTERPRETER_MONOLITHIC_EGRESS=1`), a no-op unless
`experimentalInterpreter` is also on. When built it registers in the central
experimental-flags registry (`docs/development/EXPERIMENTAL_OPTIONS.md`) with
its default (off), planned end state, and removal path, per the flag rules.

## 3. Mechanism — reuse the transient path; flip one retention decision

**No new evaluation machinery is required.** The interpreter already has the
transient / value-consumed path: a `map`/`filter` whose output is consumed by
a pure op evaluates **in memory inside its segment** and inlines its array
value, with zero per-element documents (README §11.1). It fires today only
when the output feeds another interpreted op. What stops it from firing for a
*rendered* list is a single decision in the retention walk
(`findValueConsumedOps` / `computeRetained` in `dispatch.ts`): a retained
`construct` (the vdom `h(...)`) recurses through its refs and marks the map as
retained → materialized.

The flag's core change is a **retention-policy flip**: under the flag, a
retained `construct` does **not** force its collection refs to materialize —
it lets them stay transient and inline. Then:

- the map runs in memory (transient) → an array of VNode values;
- the enclosing `construct` (the `h("ul", …)`) wraps that array;
- the whole subtree writes to **one** result document.

That is ~10–20 lines in the retention walk, plus flag plumbing. The transient
+ construct + segment machinery — already built, tested, green — does the
rest.

## 4. Scope: presentation only, not state

Collapse the **vdom presentation**, never the state. The vdom is a pure,
re-derivable projection that **links out** to the real documents:

- **Pieces stay addressable.** A list where each item is a navigable piece
  keeps the piece as its own document; the monolithic vdom holds a *link* to
  it. The consumed-as-value analysis already separates "retained-as-piece"
  from "consumed-as-value" (README §6.3); piece elements keep their docs, only
  their VNode presentation inlines.
- **Bidirectional binding still lands.** A two-way-bound field writes through
  the *state cell* the vnode links to, not the vnode node. Those cells remain
  real documents. Monolithic presentation is compatible — writes flow through
  the links.
- **Events still fire.** Handlers are referenced by the vnodes and live in
  their own streams; navigation goes through handler-driven `navigateTo`, not
  the vdom tree.

So the two "obvious" blockers (navigation, write-back) **compose**, because
the collapse is confined to the display projection.

## 5. CFC — inherits B3, does not add a new problem

An earlier draft of this design claimed monolithic materialization would
force a single coarse label and thereby sacrifice pointwise CFC. **That was
wrong**, and the correction matters:

- **Labels are per-path within a document** (`cfc/types.ts` label entries are
  path-keyed). A single document can carry per-path labels; collapsing docs
  does not inherently coarsen.
- **But** the per-path *distinction* for independent outputs comes from
  per-node / per-element **transaction isolation**, not from per-path
  attribution within one write. A single write (one tx) stamps the tx flow-
  join. So a monolithic collection evaluated in one segment tx gets the
  **join of all elements** — the same coarsening a segment already performs
  on independent scalar outputs (README §13, gating item **B3**).

Therefore this flag does **not** introduce a new CFC problem — it is a larger
instance of B3. Consequences:

- It is **fail-safe** (over-taint, never under-taint — no leak), but under
  render-ceiling enforcement an over-tainted public element **over-blocks**.
- The B3 fix (per-op / per-path label attribution: the eval records which
  element's reads produced which output path, and `prepare` stamps each path
  with *its* read-join) **also** makes the monolithic doc per-element-path
  precise. The two are the same fix.
- **Gate accordingly** (see §6): until B3 lands, refuse the collapse for
  lists whose elements carry *varying* labels (fall back to per-element,
  which keeps pointwise precision); collapse only uniform-label / display-only
  lists. After B3, the collapse is precise and the gate lifts.

## 6. The one real cost — incremental re-render — and the opt-in

The cost that does **not** dissolve: a monolithic vdom re-renders **wholesale
on any element change** — O(N) per edit, versus O(1) per-element incremental.
Typing in one row of a large list re-derives the whole list. This is the
actual trade, and it is why incremental must stay reachable.

**Default monolithic; fall back to per-element automatically when:**

1. an element is **retained-as-piece** or **bound-editable** (already detected
   by the consumed-as-value analysis — these must keep addressable docs);
2. elements carry **varying CFC labels** (pre-B3 pointwise-precision guard,
   §5);
3. the author marks the list **incremental** — a `.incremental()` / `.keyed()`
   marker for large, frequently-mutated, or multi-user-mergeable lists (a
   monolithic doc conflicts on every element edit; per-element docs merge).

(1) and (2) are automatic from analysis already present or from B3's label
data; (3) is the explicit escape hatch. A first prototype ships (1) + a
conservative (2) and defers (3) to a follow-up.

## 7. Resume and reactivity

- **Resume/reload.** The monolithic egress re-derives on reload (it is a pure
  projection of state that persists independently), so a fresh runtime
  reconstructs it. But the transient path deliberately refuses inline
  collection substitution on resume (README §9,
  L-RESUME-IS-THE-HARD-PART) — the prototype must verify the monolithic egress
  degrades to a real materialized coordinator on resume rather than assuming
  it re-derives cleanly.
- **Reactivity.** The monolithic segment reads all element inputs, so it
  re-runs on any of them — correct, and the O(N) cost of §6 made concrete. Its
  read-set must cover every element input (no under-subscription); the
  differential + a trigger-count check pin this.

## 8. Prototype plan (measure first)

The prototype exists to produce a real doc/commit number on the corpus, not
to ship. Minimal footprint:

1. `experimentalMonolithicEgress` flag (requires base; off by default).
2. The `computeRetained` construct-collection flip (§3).
3. The safety gate (§6): refuse collapse when an element is
   retained-as-piece / bound-editable, or carries a non-uniform label.
4. Tests: the differential oracle (byte-equal results both flags), a
   trigger-count check (monolithic re-runs on any element change; per-element
   fallback unaffected), a doc-count assertion (monolithic < per-element on a
   pure-display list), and a CFC characterization (uniform-label list collapses
   soundly; mixed-label list falls back).
5. Run the 87-pattern corpus + full integration A/B; report the doc/commit
   delta **and** the single-element-edit re-render cost, judged per §16
   (action/commit reduction and re-render granularity — not doc count in
   isolation).

## 9. Open questions

- **Piece / bound-element detection completeness.** Does the consumed-as-value
  analysis catch every addressable/write-back case a real vnode can create, or
  are there vnode shapes (embedded links minted at render time, handler-bound
  inputs) that need explicit detection before collapse is safe?
- **Collapse scope.** Only the vdom presentation, or also non-rendered
  *retained* collections (e.g. a list retained into the result tree but not
  rendered)? The presentation-only cut is the safe first step; broadening is a
  later decision.
- **Ordering vs B3.** Ship gated (uniform-label only) before B3, or wait for
  B3 and ship precise? The prototype can run either way; the production
  decision depends on how many corpus lists are mixed-label.
- **Interaction with the launched-child contract.** A handler that pushes a
  child pattern into a rendered list needs the child to be a real piece; the
  gate must treat those as incremental even inside an otherwise-collapsible
  list.

## 10. Relationship to the base spec

- **Requires** `experimentalInterpreter`; it is a materialization *mode* of
  the interpreter, not a standalone path.
- **CFC precision is gated on B3** (README §18); the flag inherits and shares
  that fix.
- **Directly targets** the document-count ceiling (README §16): this is the
  lever that would move it for rendered UIs, if real-app list sizes make the
  re-render cost acceptable — which the prototype measures rather than assumes.
