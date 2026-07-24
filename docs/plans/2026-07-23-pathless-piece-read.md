# Implementation plan: path-less piece read returns `undefined` while every child path resolves

Status: IMPLEMENTED on this branch (see "Implementation outcome" at the bottom —
the fix landed at the piece read boundary, NOT in traverse; Phase 1 as
originally drafted was overruled by the #4746 precedent found during
implementation). Worktree: `~/Code/worktrees/labs/pathless-piece-read` (branch
`fix/pathless-piece-read` off `f723939df`).

## Why

`cf piece get -c <id>` (no path) returned the literal `undefined` for a healthy,
fully-readable lunch-poll piece, while `$NAME`, `$UI`, and `question` all
returned real data through the same CLI. Loom's deploy gate hard-failed on that
`undefined`, killing every lunch-poll deploy through "New pattern" (since worked
around by gating on `piece inspect`). Any consumer doing a path-less read has
the same landmine: "piece published nothing" and "projection failed" are
indistinguishable.

## Confirmed mechanism (measured at head `f723939df`, not inferred)

The hand-off's framing — "schema-less whole-object resolution" — is
**inverted**. The path-less read is the _most_ schema-laden read in the CLI:

1. `PiecesController.get` → `PieceManager.get` returns
   `getResultCellWithSourceSchema(piece)`
   ([manager.ts:364](packages/piece/src/manager.ts),
   [piece-helpers.ts:82-95](packages/runner/src/piece-helpers.ts)) — the durable
   result schema from `getMetaRaw("schema")` is attached via `asSchema`. So
   `piece.result.get([])` runs the full `SchemaObjectTraverser` with the
   pattern's generated result schema.
2. The schema-generator marks **all 29 lunch-poll result properties `required`**
   — including `myName`, `isJoined`, `isAdmin`, `$NAME`, `$UI` (verified via
   `deno task cf check --show-transformed`).
3. `myName`/`isJoined`/`isAdmin` are computeds over `Writable.perSession` cells.
   A computed's result cell is created at the **narrowest scope of its inputs**
   ([runner.ts:4137](packages/runner/src/runner.ts) `narrowestScope`), so those
   docs are **session-scoped**. A fresh CLI process is a different session (each
   storage manager mints its own `sessionId`,
   [v2.ts:782](packages/runner/src/storage/v2.ts)) → the docs are absent for it.
4. The collapse cascade, all in [traverse.ts](packages/runner/src/traverse.ts):
   - ~3455: followed link's target value is `undefined`; the prop schema
     (`{type:"string"}`, no default) rejects it → `fail(invalidType)`;
   - ~4256 `traverseObjectWithSchema`: the errored property is silently omitted
     from `filteredObj`;
   - ~4313: the `required` check finds it missing → **`return undefined` — the
     whole object voids** (object analog of `traverseArrayWithSchema`'s
     every→undefined);
   - ~3563: propagates up as `fail(invalidObject)`; `validateAndTransform`
     returns `undefined`.

Why child paths work: `key('question')` narrows the schema to the child
subschema — the parent's `required` list never runs. Why `inspect` works: it
reads through the narrow `nameSchema`. Any schema that doesn't `require` an
unreachable property is safe.

Two hypotheses from the hand-off are **ruled out**:

- `canFollowScopedLink` is NOT the trigger: `canFollowScopedLink(undefined, *)`
  is permissive ([scope.ts:134-142](packages/runner/src/scope.ts)) and the prop
  schemas carry no scope cap. The scoped link IS followed; the target doc is
  simply absent in the reader's session. (The CT-1642 scope-block produces the
  identical `notFound`, so a traverse-level fix covers both.)
- "Schema-less whole-object resolution is broken" — a genuinely schema-less
  whole-object read of the same doc **works** (proven by unit test, below).

### Reproduction state at head — important nuance

- **Runner level: the bug is alive at head.** A minimal unit test (container
  with a `required` property whose value links to a session-scoped doc, read
  from a fresh session) reproduces the whole-object void at `f723939df`. Draft
  test: `packages/runner/test/scoped-link-whole-object-read.test.ts` (committed
  on this branch; 5 cases: writer-session control ok, child-path ok, required
  whole-object read FAILS, non-required variant ok, schema-less read ok).
- **End-to-end: the lunch-poll repro no longer fires at head.** A live check
  (local toolshed at head, fresh deploy, fresh-session path-less read) returns
  the full ~21KB result JSON, exit 0 — with and without `--step`. The end-to-end
  symptom was fixed _somewhere_ in `0654af4b4..f723939df` (75 commits). Bisect
  result: see "Bisect verdict" below.

## Prior art and in-flight work (do not re-invent; do not collide)

- **[#4874](https://github.com/commontoolsinc/labs/pull/4874) (merged
  2026-07-21, mathpirate)** — same bug class at the CLI layer: added
  `cf piece get --step` (atomic start/pull/read/stop so session scope matches)
  and `PieceResultProjectionError` ("stored data is present, but its schema
  could not resolve all required values", exit 1) when a read comes back
  `undefined` while raw data exists. Gap: the heuristic
  (`resultProjectionFailedAtPath`,
  [piece.ts:121-141](packages/cli/lib/piece.ts)) returns false when the result
  cell has **no schema** — a schema-less result still prints silent `undefined`.
- **[#4532](https://github.com/commontoolsinc/labs/pull/4532) (merged, B2
  "reader blackout")** — the array-side twin: an unresolvable required link in
  an array **element** voided the whole array. Fixed with a grace gated to
  array-element objects only. Its history is the load-bearing constraint: the
  first (blanket) version relaxed `required` on all objects and **CI rejected
  it** — the scheduler depends on strict-required invalidation to defer
  lifts/handlers until arguments materialize ("run now with holes" crashed
  auth-manager patterns). Any root-object fix must respect that contract.
- **[#4677](https://github.com/commontoolsinc/labs/pull/4677) (open, seefeldb)**
  — explicit `DataUnavailable@1` flow (`pending`/`error`/`syncing`/
  `schema-mismatch`). The principled long-term home for "cannot materialize ≠
  absent". Does not touch traverse.ts; no code conflict, strong conceptual
  overlap — coordinate the signal taxonomy rather than minting a parallel one.
- **[#4787](https://github.com/commontoolsinc/labs/pull/4787) (open,
  ubik2/CT-1880)** — rewrites the absent-pointer-target return path in
  `SchemaObjectTraverser` (surfaces schema `default`s before failing). Direct
  overlap with the same functions a fix would touch. Rebase/coordinate.
- **[#4882](https://github.com/commontoolsinc/labs/pull/4882) (merged)** —
  logging-only (sync failures that read as silent absence); its "follow-ups"
  section explicitly defers typed absent-vs-denied classification for callers.
- **CT-1642** (closed: logging), **CT-1863** (open: one bad element blanks a
  space — same voiding family, shell-side), **CT-1880** (open: scoped `.of()`
  initials invisible cross-session), **CT-1390** (closed precedent: bad-path
  `piece get` exits 1 with "Available keys" — the CLI already chose "error
  loudly" over "silent undefined" once).

## The API decision the hand-off asked for

**Answer: both, layered — and neither is "return `undefined`".**

1. For a doc whose every child path resolves, the path-less read voiding to
   `undefined` is a **bug** (the B2 blackout, object edition). The read should
   return the object with the unreachable session-scoped members degraded, not
   void the world. But per B2's history, this must NOT be a blanket
   required-relaxation — it must be gated so scheduler-facing reads keep strict
   invalidation semantics.
2. Where the projection genuinely cannot produce a coherent object, `undefined`
   is the **wrong signal** — #4874 already established the precedent (typed
   error + `--step` hint). The remaining gap is the schema-less-result case and
   the runner-level signal (#4677's territory).

## Plan

### Phase 0 — pin the current truth (cheap, do first)

1. Commit the draft runner test
   `packages/runner/test/scoped-link-whole-object-read.test.ts` with the
   currently-failing case marked as the bug pin (either `it.skip` with a
   tracking comment, or inverted as a characterization until Phase 1 flips it).
   This is the hand-off's acceptance criterion 1, at exactly the right level
   (below the CLI, above e2e).
2. Depending on the bisect verdict (below): if the e2e fix was incidental (e.g.
   a lunch-poll pattern change moved the repro out of the trigger zone), add a
   CLI integration test that deploys a _minimal fixture_ with a session-scoped
   computed marked required (the `#4874` fixture `session-derived-result.tsx`
   may already be it — verify why it now passes without `--step`) so the e2e
   behavior is pinned independent of lunch-poll's evolution.

### Phase 1 — the runner fix (the real one)

In [traverse.ts](packages/runner/src/traverse.ts):

1. At the absent-link-target site (~3455, where a followed pointer's
   `doc.value === undefined`), record a **distinct failure kind** (e.g.
   `TRAVERSE_FAILURES.absentLinkTarget`) instead of the generic `invalidType`.
   Set it both when the target doc is absent (this bug) and when `followPointer`
   scope-blocks the follow (CT-1642) — the two produce identical downstream
   behavior today and should carry the same marker.
2. In `traverseObjectWithSchema` (~4313), when the `required` check is about to
   void the object, tolerate properties that were dropped **specifically for
   `absentLinkTarget`** — return the partial object without them. Everything
   else (genuinely invalid data, wrong types, missing plain properties) keeps
   strict semantics.
3. **Gating decision — resolve during implementation, in this order of
   preference:** a. If failure-kind gating alone passes the full suite
   (including the auth-manager/scheduler tests that killed B2's blanket
   version), prefer it: it is principled (absence-of-another-scope's-doc is not
   "data invalid") and covers every consumer, not just the CLI. b. If the
   scheduler genuinely depends on absent-link-target voids to defer actions
   (plausible: "invalid until dependencies materialize"), add a **read-mode
   flag** (traversal option, e.g. `projection: "lenient"`) threaded from
   `Cell.get()` variants, and have _terminal_ readers — `PiecePropIo.get`
   ([piece-controller.ts:2210](packages/piece/src/ops/piece-controller.ts)),
   `resolveCellPath` consumers — opt in. Scheduler reads keep strict mode. This
   mirrors how B2 gated by traversal position; we gate by caller intent instead,
   which is more honest about _why_ the relaxation is safe.
4. Run the B2 regression suite explicitly: `convergence-storm.test.ts`, the
   auth-manager pattern tests, goldens (expect read-set-only deltas if any).
   B2's PR body documents these as the canary set.

Deliverable: the Phase 0 runner test flips to green; lunch-poll-shaped path-less
reads return the object minus unmaterializable session members.

### Phase 2 — the signal (close #4874's gap; coordinate, don't parallel-build)

1. In `resultProjectionFailedAtPath`, distinguish outcomes for the
   still-`undefined` cases (schema-less result cell, raw genuinely absent) so
   the CLI never prints bare `undefined` for "projection failed" — after Phase 1
   this should be rare (partial objects come back instead), but the
   scope-blocked and total-failure cases remain.
2. Do NOT invent a new runner-level unavailability marker: #4677 is building
   `DataUnavailable`. File the traverse-level "absent because scoped-doc
   unreachable" case as a candidate variant on that PR (comment linking this
   plan), and keep Phase 1's failure kind internal to traverse until #4677 lands
   a public taxonomy.

### Phase 3 — upstream prevention (schema-generator; separate PR, optional)

The generated result schema claiming `required` for members that are
by-construction per-session is the root lie. Change ts-transformers /
schema-generator to emit session/user-scoped derived outputs as non-`required`
(or `default`-carrying). Doesn't heal persisted schemas — Phase 1 is still
needed — but stops minting new ones. Coordinate with #4787 (defaults-at-read)
and CT-1880 (scoped initials), which are adjacent. Ship as its own PR with its
own review; do not block Phases 0-2 on it.

### Explicitly out of scope

- Loom changes — Loom already gates on `piece inspect`; vendor bump picks this
  up via the normal `loom vendor sync labs` flow.
- The internals leak found during live verification (path-less dump of a
  handler-rich pattern serializes raw Cells:
  `"runtime": "<circular
  reference>"`, `_link`/`_causeContainer` noise). Real
  wart, separate concern — file a ticket, don't fold into this fix.
- CT-1863 (shell space-list blanking) — same family, different container and
  consumer; Phase 1's failure kind may help it, note on the ticket.

## Bisect verdict

Bisect of `0654af4b4..f723939df` with the live lunch-poll repro (fresh space per
commit, local toolshed, path-less read). **Two transitions in the range, not
one:**

1. `3779114df` ([#4874](https://github.com/commontoolsinc/labs/pull/4874),
   mathpirate) — silent `undefined` (exit 0) becomes the explicit exit-1
   diagnostic ("stored data is present, but its schema could not resolve all
   required values. Use --step…"). Intentional for this symptom's CLI half;
   pinned by `piece.test.ts` + a `piece-integration.test.ts` shard.
2. `3e3754b7f` ([#4959](https://github.com/commontoolsinc/labs/pull/4959),
   mathpirate, merged 2026-07-23) — the plain path-less read starts returning
   the full 21.5KB JSON. **Pattern-side and incidental**: the PR's motivation is
   the frozen poll clock; it swaps the bare one-shot `#now` wish (a
   session-linked value the CLI's fresh session could not materialize) for the
   shared per-space `#now/300` tick and removes the per-session `today` cell.
   `cf piece get` is never mentioned. Every other suspect commit (`b447793fc`,
   `2bfe0ff24`, `daa877a2e`, `639d989a7`) left the outcome unchanged.

Consequences for the plan:

- **Nothing pins the e2e success.** If any pattern reintroduces a bare
  `#now`/session-scoped required output, the plain read regresses to the #4874
  error (loud, at least — not silent). Phase 0 step 2 is therefore required.
  Open puzzle to resolve there: the live check found the #4874 fixture
  (`session-derived-result.tsx`) also reads fine without `--step` at head, yet
  #4874's integration test ("reports present result data that cannot project in
  a fresh session") expects exit 1 — reconcile these (test-harness vs
  manual-deploy difference? fixture shape not actually session-scoped?) before
  choosing the new fixture; the e2e pin needs a fixture with a genuinely
  session-scoped required output.
- The bug's original severity stands confirmed: at the tag, the CLI printed
  literal `undefined` with exit 0 — the exact landmine Loom stepped on.
- The runner-level collapse (Phase 1's target) is untouched by both transitions
  — our committed runner test still fails at head, and CT-1642 / CT-1863-family
  consumers still hit it.

## Acceptance criteria (from the hand-off, mapped)

1. Labs test failing-before/passing-after at the right level →
   `scoped-link-whole-object-read.test.ts` (Phase 0/1), below the CLI.
2. Lunch-poll repro returns something coherent path-less → already true at head
   e2e; Phase 1 makes it true _by design_ (partial object) rather than by
   whatever the bisect finds; pinned by the Phase 0 tests.
3. `address`/`cheeseboard`/`birthday` unchanged → they have no session-scoped
   required members; the failure-kind gate cannot alter them. Add them to the
   integration assertion set anyway (cheap).
4. If the "signal" answer is chosen anywhere, say so in the PR → Phase 2
   inherits #4874's already-public contract (exit 1 + "stored data is
   present…"); the PR must state that a path-less read can now return a partial
   object, and note it in `skills/cf/SKILL.md` (which #4874 already touches for
   `--step`).

## Risks

- **Scheduler contract** (B2's blanket-version failure) — mitigated by the
  gating ladder in Phase 1.3 and running the named canary suites early.
- **#4787 collision** — same traverse functions in flight; rebase against it
  before finalizing, or land after it.
- **Semantic surprise for consumers**: a partial object where code expected
  all-or-nothing. Mitigation: the only consumers of the voided read today see
  `undefined` — every observed caller (CLI, Loom gate) treats that as failure,
  so partial-object is strictly more informative. State it loudly in the PR body
  regardless.

## Implementation outcome (what actually landed on this branch)

The plan's Phase 1 (a traverse-level `absentLinkTarget` failure kind + gated
`required` tolerance) was **abandoned before writing it**, on new evidence:
[#4746](https://github.com/commontoolsinc/labs/pull/4746) (ubik2, merged
2026-07-15) deliberately REMOVED the B2 element-level grace and litigated
exactly that distinction — "for a required property, [absent target and failed
schema] both mean the property does not match. Callers that want partial
visibility should express that in the schema." Re-introducing an absent-target
tolerance in the traverser would revert an intentional, recent design decision.

What landed instead — partial visibility expressed in the schema, at the piece
read boundary:

- `schemaWithScopedLinkRequiredsRelaxed(schema, rawValue, base)` in
  [piece-helpers.ts](packages/runner/src/piece-helpers.ts): derives a projection
  schema whose `required` no longer claims properties whose STORED value is a
  link into a narrower-than-space scope (user/session). Recurses through inline
  records only; links are boundaries; arrays are deliberately untouched (#4746
  territory); identity-preserving when there is nothing to relax.
- `cellWithScopedLinkRequiredsRelaxed(cell)`: applies it to a cell carrying a
  schema, re-schema'ing via `asSchema` only when something changed.
- `PiecePropIo.get`
  ([piece-controller.ts](packages/piece/src/ops/piece-controller.ts)) reads
  through the relaxed projection before `resolveCellPath` — healing
  `cf piece get` (path-less and pathed), `inspect`, and every consumer of
  `piece.result.get()` / `piece.input.get()`, for already-persisted schemas too.
  Traverse, scheduler, and reactive reads are untouched.

Tests:

- [scoped-link-whole-object-read.test.ts](packages/runner/test/scoped-link-whole-object-read.test.ts):
  9 steps — controls, the strict void as an explicit #4746 characterization, the
  fix (fresh session gets the partial object; owner session still sees
  everything), schema-derivation unit checks (only scoped-link requireds drop;
  identity preserved), and strictness preservation (a genuinely missing plain
  required property still voids).
- New CLI fixture `session-scoped-result.tsx` + integration case: a STARTED
  deploy with a required perSession-derived output; a fresh CLI session's
  path-less get exits 0 with the stable member present (the lunch-poll
  deploy-gate shape, pinned e2e — closes the "nothing pins the e2e success" gap
  the bisect exposed).

Phase 2 (CLI signal gap for schema-less results) and Phase 3 (schema-generator
emitting honest optionality) remain follow-ups; Phase 2's urgency is reduced
because the projection now returns partial objects instead of `undefined` for
this class.

## Adversarial review outcome (post-implementation)

A devil's-advocate review of the first implementation found no blockers but
four should-fixes, all addressed in the follow-up commit:

1. **Hand-rolled hop-walk duplicated `resolveLink`** (with cell-minting side
   effects and a latent wrong-parse-base bug) → replaced with
   `resolveLink(runtime, runtime.readTx(), link, "value")`: real cycle
   detection, no side effects, and the standard fresh-replica pull kick.
2. **Bare catches swallowed diagnostics** → `logger.debug` on both fallback
   paths (fallback remains the strict pre-existing behavior).
3. **The walk loop had no unit coverage past hop 0** → added multi-hop,
   user-scope, nested-inline-record, and stored-cycle tests (14 steps
   total in `scoped-link-whole-object-read.test.ts`).
4. **Two structural limits were undocumented** → now documented in the
   helper's doc comment and pinned by a characterization test: (a) a
   space-scoped link to a doc whose own schema requires a scoped member
   still voids that doc's read (schema combine keeps `required` from either
   side across link hops — unreachable from a boundary derivation); (b) a
   result root that is itself a link is left unrelaxed for the same reason.
   Both degrade to the pre-existing strict void and both are properly fixed
   by Phase 3 (schema-generator emitting honest optionality).

Reviewer also verified: writes untouched (`PiecePropIo.set` re-derives its
target; `getCell()` hands out the un-relaxed cell), schema interning absorbs
the per-read schema mint (content-keyed dedupe), no reactive/scheduler path
is affected, and the input-side application makes `cf piece link` target
verification strictly better. FUSE (`cell-bridge.ts`) is the one non-CLI
consumer of `PiecePropIo.get` — its suite runs in the final gate; profile
there first if mounted-space listings ever slow down.
