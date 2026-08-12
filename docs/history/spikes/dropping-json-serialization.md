---
status: historical
created: 2026-08-01
archived: 2026-08-04
reason: "Research spike: findings from removing `toJSON()` and load-bearing `JSON.stringify` from the runtime."
---

# Spike: dropping `toJSON()` and `JSON.stringify` from the runtime

> Historical note: this records what a research branch found, not a design and
> not the current system. The branch deliberately breaks things; the breakage
> is the deliverable. Nothing here describes shipped behavior.

`FabricValue` began as "`JSONValue` regularly manipulated with
`JSON.stringify()`". Residue of that origin: the data model honors `toJSON()`
methods when converting a value, and the runtime leans on `JSON.stringify` for
value semantics. This spike removes both to find out what holds them in place,
so the real work can be staged with the surprises already known.

Facts below were measured on the branch unless marked as reasoning.

## Finding 1 — the runner has no single storage boundary

This is the finding that most changes how the work should be staged.

The premise going in was that values reach the data model through one place,
so a "preflight" that serializes builder artifacts just upstream of it would
cover everything. That premise is false. Artifacts reach conversion through at
least four independent entry points, and they arrive in **different shapes**:

| entry point | shape seen |
|---|---|
| `Runner.instantiateRawNode` → `getImmutableCell` | module (object) |
| `Runner.updateResultProjection` → `fabricFromNativeValue` | module (object) |
| `CellImpl.set` → `normalizeAndDiff` (`data-updating.ts:1095`) | factory (function) |
| action/derive result → sandbox result normalization | pattern returned by an action |
| `Runner.updateArgument` → `Cell.set` AND a second `diffAndUpdate` | pattern as a sub-pattern's ARGUMENT |
| `Runner.instantiateJavaScriptActionNode` → `getImmutableCell` | artifact in a JS action's inputs |

Found in that order, each only after the previous was covered. Covering them
one at a time is whack-a-mole, and the resolution was to stop doing it: the
replacement now happens inside `Runtime.getImmutableCell` -- the intake whose
own documentation already called itself "the designed intake" -- which covers
every one of its callers at once, plus `updateArgument`, which does not go
through it.

Note `updateArgument` wrote TWICE from the same value, and flattening only the
first write left the second storing the raw artifact. A boundary with two
writes has to agree with itself about what was stored.

Measured: with the preflight covering the first two AND extended to handle
function-shaped artifacts, the runner suite failure set was **byte-identical**
— same 14 tests, same causes. Extending the preflight's *shape* coverage
changed nothing, because the shapes it newly covers do not arrive at the sites
where it is installed.

Measured three times over: after adding function-shape coverage, after making
module serialization reach nested graphs, and after correcting how the walk
reads members, the failing set stayed byte-identical at 14. Each of those was a
real correction; none was observable from the sites where the preflight is
installed.

Consequence for staging: "serialize upstream, then delete the data model's
`toJSON` support" is not one change at one seam. It is a change at every entry
point, and each sees a different artifact shape. That is the cost that has to
be weighed against a conversion-side hook, which was rejected early on the
grounds that landing solid replacer functionality in the data model is harder
than transforming upstream. That trade should be re-decided against this
measurement rather than against the original assumption.

## Finding 2 — the pattern graph was only half-serialized

`patternToJSON` emitted `pattern.nodes` verbatim, and those nodes hold **live**
modules: `toJSONWithAliasBindings` builds a node by copying its module member
by member, function members included. The emitted "serialized" graph was
therefore not serialized — it relied on a later `JSON.stringify` to finish the
job by calling methods on live objects.

That single fact is what kept `toJSON` alive on modules: it was not the data
model that needed the name, it was `JSON.stringify` of a graph. Making the
boundary emit serialized modules (`nodesWithSerializedModules`) removes the
reader outright, at which point the name is free.

Boundary only. Internal serialization must keep modules live, because that is
what the runner executes.

## Finding 3 — the four `api` factory types must move together

Changing the shared serializer member on three of `NodeFactory`,
`ModuleFactory`, `HandlerFactory`, `PatternFactory` — but not the fourth —
breaks `PatternFactory`'s assignability to `NodeFactory`. `Runtime.run`
overloads on exactly that (`runtime.ts:2107` takes `NodeFactory<T, R>` and
infers `R` from the factory; `runtime.ts:2114` takes `Pattern | Module` with
`R = any`, inferring from the **result cell**). So every `runtime.run` silently
drops to the second overload and takes its result type from whatever the
caller annotated its cell as.

It presents as patterns "losing" a key at distant call sites
(`Readonly<{action: any}>`), with no diagnostic anywhere naming assignability.
Measured: 22 errors across three unrelated test files; changing all four types
made it zero.

Worth recording because the first diagnosis was wrong: this is not "widening an
intersection perturbs inference". Cardinality is not the trigger. Broken mutual
assignability is.

## Flag-day inventory

Two flag days are measured, and they differ in the way that matters most for
sequencing: one is silent and one is loud.

### FD1 — `JSON.stringify(SomePattern)` answers `undefined`. SILENT.

`JSON.stringify` of a function with no `toJSON` is not an error; it is
`undefined`. A caller storing the result gets a hole, with no throw and no type
error.

Live pattern-source sites, all feeding wiki-link resolution:

- `packages/patterns/record.tsx:882`
- `packages/patterns/record-backup.tsx:456`
- `packages/patterns/experimental/chat-note.tsx:418`

Needs a named migration and sits in `packages/patterns`, where the
compat/vintage baselines live — so it is also the flag day most likely to move
a stored form.

TRACED END TO END, and it is bigger than three call sites. The stringified
pattern is a cross-package WIRE FORMAT:

    record.tsx / chat-note.tsx   JSON.stringify(Record) -> a string
      -> note.tsx:348            carried as `linkPattern`
      -> note.tsx:396            `$pattern={patternJson}` -- a UI prop
      -> cf-code-editor.ts:631   JSON.parse(program)
      -> cf-code-editor.ts:642   rt.createPage(pattern, space, inputs)

A pattern is serialized in pattern source, handed through a string-typed prop
into a Lit component in `packages/ui`, parsed back, and instantiated as a page.

That settles what `toJSON` means on a FACTORY, and it is not the same thing it
meant on a module. A module's was internal plumbing with no consumer. A
factory's is the format an actual consumer in another package parses. Removing
it is an API migration with `packages/ui` on the far end, not a rename -- which
is the argument for the factory/module split being a real distinction rather
than a convenient one.

Latent, not addressed: the emitted graph carries `argumentSchema` and
`resultSchema`, so if an interned schema ever holds a `FabricPrimitive`, the
`JSON.stringify` -> `JSON.parse` round trip loses it silently. Same family as
the `Fabric*` TODOs already marked in `builtins/llm.ts`.

In-repo, it surfaced loudly as 7 runner tests failing with
`SyntaxError: "undefined" is not valid JSON`. Those are the shadow of the
silent failure, not the failure itself.

### FD2 — an artifact reaching an uncovered entry point. LOUD WHERE IT HAPPENS; A SECOND MODE IS UNEXPLAINED.

A pattern factory is a function; the data model's function arm looks for
`toJSON`. Where that rejection happens it is loud: "not representable as a
`FabricValue`: function per se".

But most of the failures attributed to this cause show no rejection at all.
Of them, one reports the error; five report nothing and merely read `undefined`
downstream; one drops an event with a warning. The tempting inference -- that
the rejection is being thrown and swallowed -- was tested and REFUTED for the
case examined: nothing is thrown there at all. See "A second failure mode,
mechanism unidentified" below.

So this flag day has two modes, and only the first is understood. That is a
more useful thing to know than a tidy story about swallowing would have been.

Live idiom:

```tsx
const tools: Record<string, BuiltInLLMTool> = {
  search_web: { pattern: searchWeb },   // a PatternFactory: a function
};
```

`packages/patterns/system/common-fabric.tsx:329`,
`packages/patterns/system/omnibox-fab.tsx:171`.

## A second failure mode, mechanism unidentified

One failure is security-adjacent and does not fit the rejection story. With the
member gone, an event is dropped -- "no handler registered for ... and its
piece could not be started" -- and the handler never runs.

Traced against a baseline worktree at the merge base, and the tempting
explanations are all wrong:

- Nothing is thrown. No rejection occurs anywhere on the path.
- The content-addressed entry ref is IDENTICAL on both trees, so no identity
  hash moved.
- The ROOT result cell carries its `patternIdentity` metadata on both trees.

What actually happens is an early return in `ensure-piece-running.ts:122-128`:
walking the result-cell chain from the event link reaches a cell that carries
no `patternIdentity` on the branch. So a metadata write that the piece-start
path depends on did not happen. Whether that is downstream of some earlier
silent conversion failure is not established.

Recorded as unexplained rather than folded into FD2. The five
`patterns-derive-return-pattern` failures log nothing either, which is exactly
what this one looked like before it was traced, so they should not be
attributed to a rejection without the same treatment.

### Not a flag day, verified

`Cell.toJSON()` is untouched, so `packages/html/src/worker/keying.ts:23` and
the two `packages/ui` `JSON.stringify(cell)` consumers keep working. Only
modules and pattern factories lost the member.

## Finding 5 — `Cell.toJSON()` is far less load-bearing than it reads

`runtime.ts:2001` describes the mechanism accurately -- "`Cell`s become sigil
links (their `toJSON()`)" -- and that phrasing invites the conclusion that the
member is on the hot path of every write referencing a cell. Measured, it is
not.

Renaming `CellImpl.toJSON` with no compensating change in the data model, so
that every `Cell` reaching the conversion fails outright: the runner goes from
14 failures to **23**. Nine additional tests, fifteen "not a recognized fabric
type" rejections.

The prediction before running it was "hundreds". The reason it is small: a cell
reference is normally already a link by the time a value reaches the
conversion -- `unwrapOneLevelAndBindToDoc` and the sigil-link helpers do that
work upstream -- so the `toJSON` route serves only the cases where a raw `Cell`
lands in a value that gets converted.

Consequence for staging: `Cell` is a far more tractable target than its
reputation, and the ordering intuition "do the deepest thing last" was wrong
here. It is not deep; it is merely wide and greppable
(`JSON.stringify(cell)` in `packages/html` and `packages/ui`).

## Consumers of `toJSON` found late

Both were missed by the initial survey and are recorded so a staged plan
includes them:

- **The CTS transformer blesses `toJSON`.**
  `packages/ts-transformers/src/transformers/pattern-context-validation.ts:133`
  special-cases a `toJSON()` member on a pattern object literal as storable,
  explicitly because "the data model converts a toJSON-bearing" value. When the
  data model stops, that rule blesses something that throws.
- **`JSON.stringify` of a pattern graph**, via nested node modules — Finding 2.

## An ambient flag that answers one question was made to answer two

`internalGraphSerialization` exists to decide whether a graph gets a
`$patternRef`. A sub-pattern's graph is reached through
`serializePatternGraph`, which sets that flag, so a nested graph on its way to
the boundary was also skipping module serialization -- a ref-less graph
containing a sub-pattern still carried live modules one level down, and nothing
finished the job.

The fix descends into a `type: "pattern"` module's emitted sub-graph from the
boundary path, rather than teaching the internal serializer a second job. The
shape is worth recording: an ambient boolean naming one condition gets reached
for by anything that correlates with it, and the second question it is asked is
answered wrong exactly where the correlation breaks.

Note the near-miss in ordering: the preflight's walk finds a nested module by
its own serializer, so landing the preflight's function branch first would have
MASKED this defect -- absent wherever the preflight runs, live everywhere else
-- rather than removing it.

## Finding 4 — the encoded form does not move

Measured as a true before/after, in a throwaway worktree at the branch's merge
base, running the same probe source in both trees over a ref-less
three-deep pattern (`Top` → `Mid` → `Leaf` → `lift`) plus a sibling lift node:

- `dataUriFromValue(fabricFromNativeValue(patternToJSON(Top)))` — byte-identical
- the same for the factory `Top` (baseline raw vs branch through the preflight)
  — byte-identical
- `patternToJSON(Leaf)` at depth 1 — byte-identical

Where a value reaches storage at all, it reaches it as exactly the same bytes.
The only difference is the expected one: converting a raw factory throws on the
branch (FD2) where it succeeded on the baseline.

Re-verified at the branch's final state, after the replacement moved from the
individual call sites into `Runtime.getImmutableCell`: still byte-identical.
That move was the kind of change -- same bytes, different moment -- this branch
has shown can shift behavior while every byte comparison reports identical, so
it was re-run rather than assumed.

Scope not yet covered by that probe: handler modules carrying
`$implRef`/`wrapper`, and `FabricPrimitive`-carrying schemas. The compiled
pattern's `$patternRef` branch IS covered.

Separately verified at the same time: module serialization now reaches every
depth. The baseline emitted live modules at depths 1, 2 and 3 of a ref-less
graph; the branch emits none, and the graph converts without the preflight.

## Known latent throw, not fixed here

`nodesWithSerializedModules` serializes a node's module by calling the method
the node's module copy carries, which closes over the **original** module. For
`type: "javascript"` modules the two are content-identical (the copy differs
only in interned-schema object identity, not content). For `type: "pattern"`
modules both routes re-derive the sub-graph from the same live sub-pattern and
defer-increment identically, with one asymmetry: the build-time copy passes the
enclosing pattern's alias resolver (`builder/pattern.ts:558`) and the boundary
path does not (`builder/json-utils.ts:388`, the CT-1230 workaround). So a live
`Cell` still in the sub-graph at boundary time throws "Cell not found in pattern
aliases" rather than becoming an alias.

Alias resolution is therefore not silently lost — the divergence is a throw.
Recorded rather than fixed.

## Independent defect found along the way

`ensure-piece-running.ts:171-174` catches every error on the piece-start path
and returns `false`, and its logger is constructed disabled
(`getLogger("ensure-piece-running", { enabled: false, ... })` at `:26-29`). So
an **error**-level report on that path prints nothing, and any throw becomes a
silent `false` that the caller renders as "its piece could not be started".

This did NOT cause the failure above -- that was traced to an early return, not
the catch. It is recorded because it is real, it sits on a security-relevant
path, and it is precisely the mechanism that would hide this class of problem
next time.

## Finding 6 — a hand-built fixture cannot exhibit the bug it is meant to catch

Two claims in this document were "verified" against synthetic fixtures and were
wrong, and the same mistake was made independently by both people working on
it, which suggests it is a property of the method rather than of either.

The graph serializer walks a HAND-ENUMERATED set of positions: a node's
`module`, then that module's `implementation.nodes`. Verified to depth 3
against a hand-built `Top → Mid → Leaf` pattern, it reported no live modules
remaining. Run against a real repo pattern
(`packages/patterns/factory-outputs/parking-coordinator/main.test.tsx`) the same
probe reports **2768 function-valued members** still in the emitted form, at a
path neither fixture could produce:

    $.nodes[1].module.implementation.nodes[40].inputs.op.nodes[0].module

A sub-graph reached through a node's INPUTS -- the op path -- is not covered.
The synthetic fixtures had no op-carrying inputs, so they could not fail.

The standard that should have been applied from the start, and was articulated
about someone else's probe before being violated in one's own: **a probe that
has only ever passed is not yet a probe.** Every claim here resting on a
synthetic fixture should be re-run against a real pattern before it is relied
on, the encoded-form neutrality claim first.

## Finding 7 — the same removal made a failure quieter

Replacing `JSON.stringify` with a content hash at the change-detection site
fixed the silent-skip bug and introduced a different one on the same line.

`JSON.stringify` drops a function member and returns a string. `hashStringOf`
refuses: `hashOf: unsupported type: function`. So for a ref-less pattern
carrying artifacts under `inputs.op`, the key computation now THROWS where it
previously returned a usable string -- and an unguarded throw on that path
reaches the `ensure-piece-running` catch whose logger is disabled, becoming a
silently unstarted piece.

Loud replaced by silent, through a swallow already documented elsewhere in this
file. Recorded because the shape generalises: replacing a lenient mechanism
with a strict one moves failures earlier, which is usually right, but only if
every consumer of the strict one is prepared to fail. Here one was not, and the
system's own error handling converted the improvement into a regression.

Fixed at the CONSUMER first, by routing the key through the preflight walk;
the producer was fixed afterwards by Finding 8's redesign. Before that, the
producer was wrong: `patternToJSON`'s own output on a real pattern still
carries 2768 function-valued members across 8 path shapes, all under
`inputs.op`, at two levels of nesting (`op` inside `op`). So the emitted graph
is not a representable value, and the next caller who converts it without
flattening gets `hashOf: unsupported type: function` or "function per se".
Recorded as an OPEN DEFECT rather than closed by the consumer fix -- it is a
trap laid for the next person.

## Finding 8 — a positional traversal over a graph is the wrong design

`nodesWithSerializedModules` enumerates the positions an artifact may occupy:
a node's `module`, then that module's `implementation.nodes`. That enumeration
has now been wrong twice, both times found by measurement rather than reading,
and both times failing as a silent live object at the boundary.

The general walk already in the branch -- the preflight's -- gets the same
input right: 2768 artifacts found, 0 remaining, without knowing anything about
graph shape. It looks for THE ARTIFACT rather than for THE POSITION, which is
the entire difference, and `inputs.op` nesting inside itself makes the
positional version strictly harder to get right than the general one.

Two implementations of one job (replace every artifact with its encodable
form) in the serialization domain is also the duplication this repo treats as
a footgun; the divergence stays invisible until something converts the output.

The cost to weigh: the two differ in WHEN, not only in what. The positional
one lives inside the graph serializer where the internal-vs-boundary
distinction is known; the general one runs at a storage boundary on a finished
value. Merging them naively means `builder/json-utils.ts` importing a
runner-level module, and new import edges into the runner's cyclic core have
broken CI before. The shape that avoids it: put the general walk in a LEAF
module both import, parameterised by what to do at each copy (the derivation
note differs by caller), and delete the positional traversal rather than
extend it.

RESOLVED on that shape. `replaceArtifacts(value, onCopy)` now lives in the
leaf that already knew what an artifact is; the storage boundary is that walk
with the derivation note as its hook, and `patternToJSON`'s ref-less branch
is the same walk with the same hook. Measured on a real pattern: the emitted
graph goes from 2768 live functions across 8 path shapes to ZERO at any path,
both `inputs.op` depths included, and the encoded form does not move a byte
even though the walk now runs inside the serializer rather than outside it.

## Finding 9 — bookkeeping written per branch gets left off a branch

The derivation note that carries trust onto a copy was got wrong three times,
each in a new shape:

1. absent -- the new copy sites simply did not call it;
2. present but on the wrong side of the copy that followed, so it registered
   an object the next statement discarded;
3. present, parameterised, and wired at one of three copy sites -- the
   function branch, but neither the object-artifact branch nor the container
   rebuild.

Each was found by the A/B harness, none by the test suite, and each looked
correct at the call site. The fix that ends the series is structural: every
branch returns through a single `copied()` that announces the copy and records
the answer, so a copy site cannot be added without the bookkeeping. Three
occurrences of one mistake is a property of the design, not of the person.

## Finding 10 — the cost of looking everywhere, and what not to do about it

The walk costs **7-9% of the whole intake**. `getImmutableCell` is four steps
-- walk, convert, encode to a data URI, mint the cell -- and the walk is the
first of four:

| | heavy real graph | typical binding |
|---|---|---|
| walk | 12.7 ms | 0.0024 ms |
| convert | 67.9 ms | 0.0121 ms |
| encode | 68.3 ms | 0.0040 ms |
| WHOLE `getImmutableCell` | 181.0 ms | 0.0266 ms |
| walk's share | **7.0%** | **9.0%** |

An earlier version of this finding said "18% of the conversion", which is the
same walk measured against the wrong denominator: encoding costs about as much
again as conversion, and cell minting more still. Quoting a cost against one
step of a four-step procedure overstates it roughly twofold, and the number
that decides anything is the share of what a caller actually pays.

Three things worth keeping with it:

- Still not the full storage procedure. A cell that is WRITTEN also pays
  diffing, transaction bookkeeping, commit and persistence, none of which is in
  the 181 ms. The share of a real write is smaller again.
- It is a fixed fraction, not a cliff: 7% and 9% across a ~7000x size
  difference means it scales with the same traversal the conversion already
  does. On typical values the absolute cost is 2.4 microseconds.
- The positional version was cheaper because it visited less, and it visited
  less because it was wrong. Slower than something that did not do the job is
  not a regression.

Recommendation: no speculative fast path. Note also that NOTHING in this repo
gates on performance -- the `perf-check` job was removed for being too noisy,
and `benchmarks.yml` collects trend data for a dashboard rather than a verdict.
So this is a judgement call, not something a check adjudicates. If a signal
ever appears, NOT a "no artifacts under here" cache -- that needs the walk to have run in order to know, and
memoising it means another identity-keyed side table, the exact mechanism
behind Finding 9's four bugs. Key off a fact the pipeline already tracks
instead: a value that is already a deep-frozen `FabricValue` cannot contain a
live artifact, which is O(1) at the root and adds no bookkeeping.

## Method note that outranks the rest

Every defect in the trust/derivation family, and the producer defect, was found
by A/B against a baseline worktree. NONE was found by the test suite, which
returned the same 1106 passed / 6 failed across four consecutive substantive
changes without moving once.

A suite that does not move is not evidence that nothing moved.

## Method notes

- The honest oracle for "who depends on this?" is to REMOVE the behavior and
  run the whole workspace. Stack-trace instrumentation under-reports: samples
  taken inside SES-locked-down test processes come back with an empty
  `Error.stack`, and on this work the two unattributable samples out of fifteen
  were the ones that mattered.
- The root `deno task test` fail-fasts, so a deliberately-broken experiment
  measures only the first failing package. Use `TEST_DISABLED_PACKAGES`.
- A test fixture built by hand drifts from the shape the builder produces. A
  fixture omitting `toJSON` made a preflight test assert a property the
  production artifact did not have, which is how a false claim about the
  preflight being load-bearing reached a commit message. The same mistake, in a
  probe rather than a test, produced two false "verified" claims -- see
  Finding 6.
- Bytes-identical is not behavior-identical. Trust and the content-addressed
  entry ref live in identity-keyed `WeakMap`s, so they do not travel with the
  encoded form. A copy that skips `noteDerivedCopy` is a trust dead end that no
  byte comparison can see; two were introduced here and neither showed up in
  any encoded-form A/B. Any future version of this work wants a provenance
  check alongside the encoded-form check.
- Note the object that is RETURNED, not one built along the way. The first
  attempt at that fix registered a value the following statement discarded, so
  it read as fixed and changed nothing.
- Bytes-identical failed **three separate times** on this work, which makes it
  a category rather than an anecdote. A byte comparison agreed while: a copy
  skipped its derivation note; serialization moved to a different actor
  (data-model's duck-typed arm answers `toJSON` too, so the same bytes come
  out whether or not the walk did the work); and an internal graph lost every
  module's body, because that branch was never the one the encoded-form probe
  measured. Each time the bytes were RIGHT and the question was wrong.
- The instrument that answers those is a **survivor hunt**: apply the
  transformation, then search the result for anything that should no longer be
  there -- a serializer member, a live function, an unregistered copy. It asks
  about the output's structure rather than its encoding, which is what a byte
  comparison structurally cannot do. Run it against the baseline too: a
  survivor hunt that finds nothing in both trees is measuring nothing.
- Prose that names a function's output without naming WHICH BRANCH produced it
  is how a true measurement licenses a false conclusion. `patternToJSON` has a
  storage-boundary branch that the walk flattens and an internal branch that it
  deliberately does not; "live functions in an emitted graph: 7691 -> none" is
  true of the first and says nothing about the second. The claim was accurate
  and the sentence was not.
- A guard belongs where the shape it guards actually occurs. Two obvious homes
  for the internal-graph assertion could not host it: both fixtures' modules
  carry a STRING implementation, so serializing and dropping-functions coincide
  on them and the test passes either way. Check that a proposed guard can fail
  before believing it guards anything.
