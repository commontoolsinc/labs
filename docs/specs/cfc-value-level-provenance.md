# CFC value-level dataflow — the end-state past the D4 prefix

_Companion to [`cfc-write-prefix-provenance.md`](./cfc-write-prefix-provenance.md)
(Epic D4, shipped). That doc proved the last-overlapping-write **prefix** is the
tightest per-write bound available from journal order alone. This doc designs
what lies past it: **span-attributed provenance** — per-write dataflow recorded
by the runtime where an executor structurally isolates operation spans, composed
with the shipped prefix everywhere else. Deliberately unscheduled; §8 gives the
entry criteria. Written 2026-07-09 at owner request._

## 1. What the prefix still over-taints

The shipped gate (`verifyInputRequirements`, `cfc/prepare.ts`) quantifies each
protected write over the reads before its last overlapping write attempt. That
is sound and strictly tighter than transaction-global — but within the prefix
every labeled read still gates the write, fed or not. The residual inventory,
from code and tests:

- **Within-prefix unrelated reads.** The S7 exemption
  (`isProvenanceOnlyConsumedLabel`) is still needed for provenance reads
  *inside* the prefix; a confidential or endorsement-bearing read that merely
  precedes an unrelated protected write in one handler body still gates it.
  Multi-concern handlers (read A, decide B) pay this constantly.
- **Trigger reads at `−∞`** join *every* protected write's prefix
  (`prepare.ts`, gatedReads assembly) — deliberately conservative; a trigger
  that provably fed only one write gates them all.
- **`+Infinity` fallbacks.** No logged overlapping attempt (entry made
  applicable by an attempted-but-unapplied write), or a backend without the
  activity clock, degrades that path to transaction-global
  (`WritePrefixBounds.boundFor`).
- **Three surfaces are deliberately transaction-global** — recorded as
  [SC-23](./cfc-spec-changes.md) boundaries (a)/(b):
  1. the confidentiality **egress ceiling** (`collectConsumedLabel` — "a sink
     request … does not record its own read provenance");
  2. the **flow-label join `J(tx)`** — one per-tx join stamped at every written
     path (`deriveFlowJoin`), which smears unrelated taint across everything a
     routing transaction shuffles (the in-code shell-stamp comment) and makes
     the hereditary integrity **meet** "usually empty" — any unlabeled co-read
     destroys integrity credit for every write;
  3. the **D3 flow-meet credit** in `verifyWriteFloor`, same join.
- **Recursive-read descendant union** (`collectConsumedLabel`): a recursive
  read consumes ancestor *and* descendant entries — read-granularity
  over-approximation, orthogonal to write-side provenance but part of the same
  precision budget.

None of these are bugs. Each is the sound over-approximation available from
what the journal records today. The question is what *new recorded structure*
buys precision, and under what trust.

## 2. The ceiling argument, and the only two ways past it

The prefix doc's §4 soundness argument is exhaustive for journal order: a read
before the last overlapping write "could have fed" the value **as far as the
journal knows**. Excluding any such read is no longer a structural fact *of the
journal* — so, per §8.9.1's dichotomy (`08-09-runtime-label-propagation.md`),
anything tighter must be one of:

1. **New structural facts** — the runtime records *more* than order, such that
   exclusion is again a property of what the record "simply does not contain"
   (the decomposition rationale). §8.5.4.3 already sanctions the limit case:
   one transaction per element op. The cost axis is real — the reactive
   interpreter exists precisely to collapse per-node docs/actions — so the
   design below records finer structure *within* one transaction instead of
   splitting transactions.
2. **Trusted flow-precision claims** — §8.9.1's `flow-taint-precision` concept
   gate on the executing implementation identity. Claims that cannot be
   structurally checked live here, and only here.

Everything in this doc is classified against that line. The classification is
the design.

## 3. Span-attributed provenance

### 3.1 The record

Extend the shipped activity clock (`v2-transaction.ts` — the shared
`journalIndex` stamp on read activities and the write-attempt log) with an
optional **span tag**:

```ts
// storage/interface.ts additions (sketch)
interface IReadActivity  { /* … */ journalIndex?: number; span?: SpanId }
interface IWriteAttempt  { /* … */ journalIndex:  number; span?: SpanId }
// SpanId: opaque per-transaction identifier minted by the runtime bracket
```

A span is a runtime-bracketed execution interval: "these reads and these write
attempts were issued while operation S was executing." The bracket already
exists in the interpreter (`EvalContext.runScoped`, built for per-op scope
attribution, with the invariant that bracketing must not change the journal);
span stamping is the same bracket writing one more field. Nothing else in the
transaction changes; unbracketed activity simply has `span` absent.

Span stamping is **journal-class recording** — the runtime observing *where*
activity occurred, exactly as `journalIndex` records *when*. It is not a claim
by the executed code; the executed code cannot set it.

### 3.2 The per-write provenance closure

For a write attempt `w` with span `S`, define `feeds(w)` as the least set
containing:

- every read in span `S` (its **direct reads** — including lazy in-body derefs,
  which the interpreter bracket already attributes per-op);
- for every direct read of address `A`: the reads of `feeds(w')` for the last
  span-tagged write attempt `w'` overlapping `A` with
  `journalIndex < read.journalIndex` (intra-transaction producer edges,
  resolved from **observed** attempts — never from IR edges);
- if any read in the closure has no resolvable span-tagged producer but a
  producing write exists in the journal (an **unspanned** producer): the entire
  prefix of that producer, per the shipped bound — the closure degrades to the
  prefix exactly where structure runs out;
- trigger reads: joined into `feeds(w)` for every `w`, as today (`−∞`), unless
  a future scheduler records which invalidated address scheduled which span —
  out of scope here.

For an **unspanned** write, `feeds(w)` = the shipped prefix. Mixed granularity
inside one transaction is therefore well-defined and monotone: spans only ever
*remove* reads that the prefix would have kept, and only where a bracket
attests the removal structurally.

The gate change is mechanical: `verifyInputRequirements` and `verifyWriteFloor`
quantify over `feeds(w)` instead of the prefix set. The S7 exemption shrinks
again (a provenance read outside `feeds(w)` needs no exemption); the #14
empty-case delegation to the D3 floor is unchanged (an empty `feeds(w)` is a
strictly better-grounded "no labeled input" fact than an empty prefix).

### 3.3 What makes the closure sound — and where it stops being structural

The closure embeds one assumption the journal cannot check: **span
non-interference** — an operation's write depends only on reads in its own
span plus values it read from other spans' outputs. A JS closure that stashes
state across spans in lexical scope violates it invisibly.

So the soundness class of `feeds(w)` is decided by the **executor**, not the
record:

- Where the executor **structurally enforces read isolation** per span — the
  reactive interpreter's obligations in the proposed §18.7.3
  (`specs#11`): explicit inputs, no hidden lexical capture, per-op bracketed
  derefs, fail-closed on unresolved references — non-interference is enforced,
  and the closure is precision of the same character as decomposition. Per
  §18.7's own framing, the *package* still rides a flow-precision claim
  asserted by the **interpreter's implementation identity** (trusted for
  `flow-taint-precision`), with the structural obligations making the claim
  auditable. This doc adopts that framing verbatim rather than re-arguing the
  prefix doc's "no trust gate" conclusion for spans: the prefix needs no gate
  because journal order alone carries it; spans need the §18.7-class gate
  because non-interference does not come from the journal.
- Where the executor is **opaque user JS** (handlers via `events.ts`, legacy
  per-node actions, RI `leaf` ops beyond their declared structured input),
  non-interference is unattested. Span tags from such code MUST NOT narrow
  labels; the gate ignores them (falls back to prefix). If a deployment wants
  precision there anyway, §8.9.1 already prices it: trust the specific
  implementation identity for `flow-taint-precision` — per identity, per
  user, never ambient.
- A **trusted compiler/transformer** (§14.4.4) that verifies element-locality
  of code it compiled may stamp spans on that code's behalf; the claim rides
  the *compiler's* identity. This is the ts-transformers seam, future work.

### 3.4 Tier table

| Tier | Executor | Mechanism | Trust surface |
|---|---|---|---|
| T0 (shipped) | any | last-overlapping-write prefix | none — journal order |
| T1 | reactive interpreter | span closure §3.2 | interpreter identity trusted for `flow-taint-precision`, under §18.7 structural obligations |
| T2 | opaque JS granted precision | span closure, unverified isolation | per-implementation `flow-taint-precision` grant (§8.9.1), explicit and rare |
| T2′ | compiled patterns | compiler-asserted spans | compiler identity (§14.4.4) |
| — | any, when affordable | true per-element transactions | none — §8.5.4.3 decomposition (preferred where the tx tax is acceptable) |

T1 is the payoff tier: the interpreter is where execution is consolidating,
`runScoped` exists, and the IR's explicit `inputs`/`writeTargets` edges make
the *predicted* dataflow checkable against the *observed* spans (a divergence
is a fail-closed diagnostic, never a narrowing).

## 4. Digest binding

Same discipline as the prefix (its §6, "load-bearing for soundness"):

1. Span tags join `PreparedDigestInput` — on both the consumed reads and the
   write-attempt log. Canonicalization: span ids are per-transaction ordinals
   rank-normalized over the decision-relevant set, exactly like the shipped
   activity-clock ranks (raw ids would encode internal bracket count; ranks
   preserve every containment/producer relation the closure consumes).
2. The closure itself is **recomputed at commit** from the re-derived digest
   input, never carried as data (audit S2 shape: bind the verification event,
   not a caller-supplied summary — §8.10.1).
3. A post-prepare change to any span boundary, producer order, or read
   membership flips the digest and invalidates the preparation.

## 5. Consequences for the three transaction-global surfaces

Span provenance changes the premise SC-23's boundaries rest on. Each surface
upgrades independently, behind its own staging:

1. **Egress ceiling per sink request.** A sink-request document is produced by
   some span; `feeds(sink-request write)` *is* the request's read provenance —
   the thing whose absence forced transaction-global. The ceiling check moves
   to `feeds(w)` for the request-producing write, T1-gated, dialed like
   `cfcPolicyEvaluation` (off → observe-divergence → enforce).
2. **Pointwise flow labels.** `J(tx)` becomes `J(feeds(w))` per written path —
   the §8.9.3 default transition turns pointwise, the shell-stamp smear
   disappears for spanned producers, and the hereditary integrity meet stops
   being destroyed by unrelated co-reads (the meet over `feeds(w)` is the
   per-value meet). This is SC-23(b)'s "needs per-path derived components
   first" — the derived component exists (S16); it is the join that coarsens,
   and spans fix exactly that.
3. **D3 flow-meet credit** follows (2) — credit computed over `feeds(w)`.

Ordering: (2) is the highest-leverage (it compounds into every downstream
read) but touches persisted labels — ship behind `cfcFlowLabels` staging with
SC-11 idempotence intact. (1) is self-contained. (3) rides (2).

## 6. Stage 0 — measure before building

There is today **no counter measuring prefix precision** (nothing records
`boundFor` `+Infinity` rates, reads excluded per write, or would-flip
decisions). Before any span machinery:

- Extend `CfcInstrumentationHooks` with per-prepare precision counters:
  gated-read count per protected write (prefix vs transaction-global), bound
  source (real / `+Infinity` / clock-less), S7-exemption fire count.
- In the interpreter branch, a shadow mode: compute `feeds(w)` from the
  existing `runScoped` brackets **without enforcement**, and log
  `would-flip` — decisions (rejections *and* label joins) that differ between
  prefix and closure. This is the metric that must be red before T1 is worth
  building, per the proxy-metric lesson: measure the real mechanism's
  engagement, not a stand-in.

## 7. Non-goals

- **No IR-derived narrowing.** ROG edges predict; only bracket observations
  narrow (R-CFC-1/R-CFC-2). A predicted-vs-observed divergence fails closed.
- **No cross-transaction provenance.** `feeds(w)` is intra-transaction;
  cross-tx flow stays with persisted labels (§8.12.8 components).
- **No confidentiality *read*-side change.** The recursive-descendant union
  (§1) is read-granularity and separately addressable (schema-scoped reads);
  this design does not touch it.
- **No new declassification.** §8.9.1's closing line governs: precision only,
  never release. `feeds(w)` never drops a clause that fed the value — it drops
  reads that provably did not.

## 8. Entry criteria (deliberately unscheduled)

Build T1 when **all** hold:

1. The reactive interpreter is merged and default-on for the pattern classes
   whose precision matters (it is branch-only today; its flag-default is
   gated on the cross-space pull-amplification fix).
2. Stage-0 diagnostics show material over-taint: would-flip counts on
   realistic workloads (group-chat, notes, sqlite row flows), not synthetic.
3. specs#11 (§18.7) or its successor has landed, so T1's trust framing has a
   normative home to cite.

Until then the shipped prefix is the enforced bound everywhere, and this doc
is the recorded design intent.

## 9. Spec-change queue

- Give SC-23 its owed spec home: §8.9.1 gains the journal-order structural
  precision paragraph (the prefix, its last-overlapping-write bound, trigger
  reads at `−∞`) — the labs-side interpretation becomes normative text.
- New §8.9.1 subsection (or §18.7 extension once specs#11 lands):
  span-attributed provenance — the record (§3.1), the closure (§3.2), the
  non-interference condition and its executor-class trust table (§3.3–3.4),
  digest binding (§4).
- §8.10 note: the egress ceiling MAY be evaluated per sink-request provenance
  where spans are enforced, transaction-global otherwise (upgrades SC-23(a)
  from "deliberate boundary" to "staged upgrade path").

## Provenance

Runner seams: `WritePrefixBounds`/`buildWritePrefixBounds`/
`verifyInputRequirements` gating and the S7/#14 comments (`cfc/prepare.ts`),
the activity clock + write-attempt log (`storage/v2-transaction.ts`,
`storage/interface.ts`), rank normalization in `buildPreparedDigestInput`
(`storage/extended-storage-transaction.ts`), order-preserving
`writeAttemptLog` canonicalization (`cfc/canonical.ts`), transaction-global
egress/flow-join/floor-credit seams (`collectConsumedLabel`,
`deriveFlowJoin`, `verifyWriteFloor`, `cfc/prepare.ts`), interpreter bracket
`EvalContext.runScoped` + `inputsOf`/`writesOf`
(`reactive-interpreter/{interpret,rog}.ts`, branch
`claude/priceless-rubin-89ad5e`). Spec: `08-09-runtime-label-propagation.md`
§8.9.1 (decomposition before claims; the `flow-taint-precision` profile),
§8.9.2 (transaction-global `O`, trigger reads), `08-05-collection-transitions.md`
§8.5.4.3 (decomposition preferred), `08-10-validation-at-boundaries.md` §8.10.1
(digest binds the verification event) and §8.10.2.2 (ordered attempted-write
views), `14-open-problems-and-proposals.md` §14.4.4 (static analysis),
§14.1.3.5 (trusted extraction to a supported operation graph), and open PR
specs#11 (§18.7 non-decomposing reactive interpreter profile, whose trust
framing §3.3 adopts). Labs-side: [SC-23](./cfc-spec-changes.md) records the
shipped interpretation this doc extends.
