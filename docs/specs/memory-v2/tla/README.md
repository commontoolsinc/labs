# TLA+ model: pending-stack commit protocol

`PendingStacks.tla` is a bounded, model-checked specification of the Memory v2
pending-stack commit protocol (`03-commit-model.md` §3.3–3.6), built to check
the invariant catalog (`09-invariants.md`) over **all** interleavings within
its bounds — including the interleavings nobody thought to hand-write a unit
test for. It reproduces the CT-1910 bug class as a machine-found
counterexample and certifies the repaired shapes. (The pre-#4606 scalar wire
shape — the legacy old-client/old-server dependency recording whose
under-recording produced the CT-1872 "1c" phantom — is deliberately not
modeled; only the shipped full-stack shape and the proposed overlap-filtered
refinement are.)

## Results

Checked with TLC 2.19 (all four small configs finish in under a minute; the
deep config in a few minutes):

| Config | DepMode | BasisMode | DeliveryMode | Result |
| --- | --- | --- | --- | --- |
| `PendingStacks_Current.cfg` | `fullstack` (shipped #4606) | `maxdep` (legacy: pending reads without `basisSeq`) | `atomic` | **ReadCoherence violated** — CT-1910: the pending-read staleness scan starts at the highest dependency's resolution seq, missing a foreign overlapping write that landed between the reader's confirmed basis and that seq. Kept as the regression witness for the legacy shape, which servers still serve. |
| `PendingStacks_Repaired.cfg` | `fullstack` | `confirmed` (CT-1910 repair — shipped: pending reads declaring `basisSeq`, scanned with own-session exclusion) | `atomic` | **All invariants hold** (14,504,005 distinct states, exhaustive at `MaxTotal = 4`). |
| `PendingStacks_Filtered.cfg` | `filtered` (proposed CT-1872 refinement) | `confirmed` | `atomic` | **All invariants hold** (same bound and state count). |
| `PendingStacks_Filtered5.cfg` | `filtered` | `confirmed` | `atomic` | **All invariants hold** at `MaxTotal = 5` with single-path writes (110.7M distinct states, ~5 min) — deep enough for a foreign write to reject a *middle* pending layer beneath a reader, the case where overlap-filtering actually drops a dependency. |
| `PendingStacks_Channel.cfg` | `fullstack` | `confirmed` | `channel` (delayed verdict delivery) | **All invariants hold**, including `AcceptedVersusDropped` (INV-6), at 39,966,805 distinct states, `MaxTotal = 4`, ~90s. Certifies the decided-but-unprocessed window: commits built there name decided-dead layers and are refused by the dead-dependency admission rule; commits built after the processed rejection's drop record sparse arrays (§3.5's view-relative completeness). Negative control: deleting `HasDeadDep` from `Process` violates `CascadeTotality` within a second — the rule is load-bearing, not decorative. |

Read the violation together with the catalog: the maxdep counterexample is an
INV-1 failure through the staleness basis, orthogonal to dependency
recording — no choice of DepMode fixes it, which is why the repaired configs
change the basis dial. Conversely, dependency under-recording is the other
failure axis (INV-3(a): a recording shape that drops a layer overlapping the
read path re-creates the CT-1872 phantom); the filtered configs certify that
the proposed narrowing keeps every overlapping layer and stays sound.

**Scope of the certification.** The model checks the ADMISSION CORE under
two structural assumptions the runtime does not automatically share, so the
Repaired result certifies the rule, not the whole pipeline:

- **Canonical reads.** `Build` constructs one read per path directly from
  session state (`cbasis = csn`). The runner's raw-activity → wire
  compaction layer (`compactCommitReads`) is outside the model; losing a
  divergent basis there is guarded by a runner unit test (divergent basis
  overrides survive compaction), not by TLC.
- **FIFO by construction.** `Process` admits `Min(Unresolved(s))`, so a
  later same-session commit can never overtake an earlier one in any
  reachable state. The runner's hold-mode admission CAN reorder sends,
  which is why the shipped exclusion is predecessor-restricted (own commits
  with `local_seq` below the reader's) rather than session-wide — a rule
  that coincides with the model's same-session exclusion in every
  model-reachable state and stays sound under overtaking. Modeling issued
  versus admitted commits separately, with FIFO as a checked invariant
  rather than a structural given, is the natural refinement if this area
  churns.

## Running

TLC needs Java and `tla2tools.jar`
(<https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar>);
neither is vendored.

```bash
java -cp tla2tools.jar tlc2.TLC -config PendingStacks_Current.cfg \
  -workers auto PendingStacks.tla
```

A violated invariant prints the full state trace — each `State N` is one
atomic action (`Build`, `Process`, `Integrate`); the last state's `log` entry
is the incoherently accepted commit, and comparing its read's `obsC`/`obsP`
(mapped through `res`) against the writes below it in `log` shows the phantom
or missed contributor directly.

## What the model is

- **State**: an accepted-commit `log` (index = canonical seq); per session, a
  pending stack `pend`, verdicts `res` (localSeq → accepted-at-seq /
  rejected), a confirmed integration point `csn`, and a localSeq counter.
- **Actions**: `Build` (client constructs a commit against one snapshot —
  confirmed prefix plus pending stack — recording observations and the
  dependency set the active `DepMode` prescribes), `Process` (server FIFO
  admission: dead-dependency check, then staleness scan per `BasisMode`,
  then accept-and-append or reject — with the client's mirrored drop fused
  in under `atomic` delivery, server-side only under `channel`), `Deliver`
  (channel mode: the client processes the next verdict in submission
  order — for a rejection, the drop and transitive cascade), and
  `Integrate` (client advances its confirmed view one log entry; own
  accepted entries promote here, gated on the processed verdict).
- **The master invariant** `ReadCoherence` is observational, not mechanical:
  every accepted commit's recorded observation of a path — its confirmed
  contributors plus its pending-layer contributors mapped through resolution
  — must equal the exact set of accepted writes to that path below the
  commit's own seq. Phantom contributors (observed ⊃ durable) and missed
  concurrent writes (observed ⊂ durable) both break the set equality. This is
  INV-1 of `09-invariants.md`; `CascadeTotality` and `MonotonicResolution`
  cover INV-4 and INV-5.

## Abstractions, and why each is safe to make

- **One document, overlap = path equality.** Real overlap is
  ancestor/descendant path structure plus the Tier-1 path-blind set/delete
  check; both only *widen* conflict detection relative to equality, i.e. move
  in INV-2's safe direction (more rejections, never more acceptances). A bug
  reachable under equality-overlap is reachable under the real matcher; the
  converse widenings can't introduce coherence violations, only retries. The
  model therefore under-approximates the matcher and is a sound bug-finder
  for admission logic, but it does NOT check the matcher's own
  refinements — that is the differential harness's job
  (`packages/memory/test/v2-differential-consistency.test.ts`).
- **Appends-only values.** The value of a path is the set of accepted writes
  to it. This makes observations mergeable (a reader through a stack observes
  base + every contributing layer, exactly the mergeable-collection-writes
  situation CT-1872 arose from) and makes coherence a set equality instead of
  a value comparison. Last-writer-wins replace semantics would only coarsen
  observations, hiding contributor differences the set form exposes.
- **Verdict delivery is a mode.** `atomic` fuses the server's verdict with
  the client's mirrored cascade in one action — the original abstraction,
  kept so the historical configs certify the same state graphs (the
  Repaired/Filtered counts are unchanged to the digit). `channel` is the
  in-flight-verdict refinement: the server decides, and the client
  PROCESSES each verdict by an explicit `Deliver` step in submission order
  — for a rejection, the drop-and-cascade. `Deliver` is the processing
  point, not the transact response's arrival: the implementation holds a
  rejection's drop for the covering fan-out frame (the read-repair gate),
  so the revert and the winning data land as one visible transition and
  re-run actions read repaired state. That brings into
  scope the decided-but-not-yet-applied window of CT-1927 verdict parking
  (promotion still waits for `Integrate`, now guarded so a covering frame
  cannot precede its verdict — the §4.11 server obligation), INV-6 as the
  checked `AcceptedVersusDropped` invariant, and the sparse dependency
  arrays of §3.5 (a build after a processed rejection's drop records only
  survivors).
  Two collapses keep it tractable, argued in the module header: the
  response-to-processing window adds no observably distinct dependency
  arrays (so verdict-time and frame-time drop policies are covered alike),
  and a locally cascade-dropped commit models
  as never-decided (pre-send refusal) — the server-decides-first ordering
  is a separate reachable interleaving. Still outside scope: connection
  loss and replay (INV-11), which remain covered by reconnect unit tests
  only.
- **FIFO per-session admission.** INV-5 holds by construction, matching the
  current implementation (which rejects rather than holds). If admission is
  ever parallelized or holds are introduced, that assumption must become an
  explicit checked property, not a structural given — model that change here
  first.
- **No branches, scopes, preconditions, or schema sync.** Orthogonal to the
  pending-stack machinery under study.

## Changing the model

Per the change discipline in `09-invariants.md`: if a change introduces a new
dependency-recording shape or staleness basis, add it as a `DepMode` /
`BasisMode` variant plus a config, and record the expected/observed result in
the table above. Keep the existing modes — the violated configs are
regression witnesses (they document *why* the current shape is what it is),
not dead code. If TLC finds a violation in a mode expected to pass, the trace
is the ticket: minimal, complete, and replayable against the real engine as a
unit test (compare `packages/memory/test/v2-engine.test.ts` harness).
