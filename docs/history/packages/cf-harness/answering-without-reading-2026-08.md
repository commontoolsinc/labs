---
status: historical
created: 2026-08-17
archived: 2026-08-17
reason: "Record of the CT-2003 arc: what shipped in #5736, #5747, #5748 and #5781 to let a cf-harness agent compute over a space it cannot read, why each decision went the way it did, what six live runs demonstrated and what they did not, and the bugs and open threads left behind."
---

# Answering a question about private data without reading it

The goal was one sentence long: a `cf-harness` agent should answer a question
about private data held in a Common Fabric space without that data entering its
context. The route is to stop handing the model values at all. It receives
opaque references, it writes a pattern, and it runs that pattern inside the
space; the pattern touches the data, the model touches only a token and the
answer.

Specified in Linear CT-2003, building on CT-2001's session-local opaque
handles. Four pull requests carried it: #5736, #5747, #5748 and #5781. All four
are on `main`; the last is commit `75dae635f`. Everything below was checked
against the tree at that commit, and where a claim could not be checked it says
so.

The state of the package as it stands is documented live, and this record does
not restate it: `packages/cf-harness/docs/CURRENT_STATE.md` says what the
harness does, `packages/cf-harness/README.md` says how to drive it, and
`packages/cf-harness/docs/ROADMAP.md` says what is left. What follows is the
part that does not belong in any of those — why the shape is the shape, and
what was learned building it.

## What shipped

**#5736 — session address handles.** A per-run table maps short opaque tokens
to cell addresses, and the prompt loop swaps at the model boundary in both
directions: an address in model-bound tool output becomes a token, and a token
in a model-authored tool argument resolves to the real address before policy
evaluation, summarization and dispatch. The token grammar and the entry shape
live in `packages/cf-harness/src/contracts/handle-table.ts` (prefix `cfh:a:`,
a five-character minimum suffix over a thirty-character alphabet); minting and
both swap directions live in `packages/cf-harness/src/handle-table.ts`; the two
boundary sites are `#swapModelBoundValue` and `#resolveHandleTokensInToolInput`
in `packages/cf-harness/src/prompt-loop.ts`. Tokens derive from a per-run salt,
so they are stable within a run and disjoint across runs. The table is run
state (`packages/cf-harness/src/run-state.ts`), validated on adoption in
`packages/cf-harness/src/engine.ts`, and rehydrates through `--resume-run`.
Artifacts keep the raw bytes; only the model-bound rendering carries tokens.

**#5747 — one reference syntax.** The runner's LLM-friendly link form is the
fabric's canonical textual reference. Every piece-reference intake seam in the
`cf` CLI now normalizes through `normalizeLLMFriendlyRef` in
`packages/cli/lib/llm-friendly-ref.ts`, so a canonical reference works wherever
the CLI's older bare grammar does — an embedded path prefixes the positional
path, an embedded space DID is checked against the space the command resolves
to, and an id-only command refuses an embedded path rather than truncating it
silently. The reference-text rules were consolidated into the runner rather
than duplicated: `linkPathSegmentToCellPathSegment` and `CELL_SCOPE_VALUES`
join `matchLLMFriendlyLink` in `packages/runner/src/link-types.ts` and are
re-exported from the light client/runtime surface,
`packages/runner/src/shared.ts`; `parseCellPath` in
`packages/runner/src/piece-helpers.ts` delegates to the first of them. One
intake is deliberately outside the helper: `parseUrl` in
`packages/cli/commands/piece.ts` still uses the bare grammar, because a URL is
not a piece reference.

**#5748 — `run_pattern`.** The model supplies pattern source; the harness
compiles and deploys it into a configured space and waits on the runtime's real
barriers (`runtime.settled()` then `pieces.synced()`), then returns the result
cell's canonical reference plus, when a `resultSchema` was given, a
schema-sanitized value. The tool is in
`packages/cf-harness/src/tools/run-pattern.ts` and the session it runs against
is in `packages/cf-harness/src/fabric-session.ts`, whose first line of
documentation is the load-bearing one: nothing in that module ever enters the
docker sandbox. String inputs that are whole LLM-friendly links become live
cells, so data is wired in by reference rather than copied. Compile diagnostics
come back raw so the model can iterate, with bare fabric identifiers replaced
by a placeholder in the model-facing copy. The tool exists only when
`--fabric-api-url`, `--fabric-identity` and `--fabric-space` are configured
together.

**#5781 — composition.** A delegating parent seeds a child's handle table
(`seedSubagentHandleTable`, `packages/cf-harness/src/prompt-loop.ts`); a
`pattern-author` child profile moves authoring out of the orchestrator
(`packages/cf-harness/src/contracts/subagent.ts`), with its own turn budget of
24 against the default subagent cap of 8 and a discriminated-union return
contract that a failure cannot pass as a success; `describe_handle`
(`packages/cf-harness/src/tools/describe-handle.ts`) answers for a reference's
shape without its value; and a tool call the model wrote wrong costs a turn
instead of the run
(`packages/cf-harness/src/contracts/invalid-tool-call.ts`). The same change
published a CLI address as the one string that names it, and fixed three bugs
in the runner's CFC machinery — see [Bugs found in shared
machinery](#bugs-found-in-shared-machinery).

## The decisions, and why

### Handles are unconditional

An earlier revision of #5736 put the swap behind `--handle-mode`, defaulting
off. It was taken out before merge and the reasons are worth keeping, because
they recur.

A default-off path rots: nothing exercises it in the ordinary case, so it is
the branch that breaks quietly. Two behaviors mean a compatibility matrix — a
run recorded under one mode, resumed under another — and every cell in that
matrix is a question someone has to answer. And the mode generated a class of
findings that existed only because the mode existed: resume silently
downgrading a run, an explicit flag conflicting with a recorded session mode, a
tool allowlist interacting with mode gating. Once there is one behavior, none
of those is representable.

Removal was a net 318 lines across eleven files (361 deleted, 43 added). No
test assertion that predates the feature changed meaning: the only pre-existing
test files touched lost `handleMode` lines that the feature commit had itself
added to them, and the seven deleted CLI tests were all tests of the mode. The
flag never reached `main`; it lives only on the unmerged branch
`ct-2001-p0a-address-handles`.

### One canonical reference syntax

The CLI's bare grammar predates the runner's LLM-friendly form and is
convenient to type. It is now an alias, and the rule stated in the module
documentation of `packages/cli/lib/llm-friendly-ref.ts` is that new
reference-syntax capability lands in the canonical form first: the alias must
never grow a capability the canonical form lacks. The reason is the handle
table. A handle is a token standing for a canonical reference, and if two
syntaxes can name addresses the canonical one cannot, then some address has no
token, and the model has to see it raw. Divergence in the grammar is a leak in
the boundary.

### Unlisted, and detached

`run_pattern` deploys a piece that is durable in the space and absent from the
space's piece list. There is no `unlisted` flag: the tool calls
`pieces.runPersistent(...)` and never calls `pieces.add()`, which is the only
seam that puts a piece in the registry (`PiecesController.add` in
`packages/piece/src/ops/pieces-controller.ts`).

The distinction the registry draws is "a piece a person might want to visit".
`cf piece new` registers, because it makes artifacts people open. Just-in-time
computation on the way to answering a question is not that, and putting it in
the list would bury the things a person actually browses under the exhaust of
every intermediate calculation.

Detachment is likewise an omission: no `origin` is recorded.
`docs/specs/piece-source-lifecycle.md` states that manually authored and
LLM-generated code start detached, and a model-authored pattern is exactly the
second. Provenance is not lost, it moves: the run's persisted artifacts and run
state carry the `pieceId`, so run-to-piece attribution is an operator question
answered from the run rather than a claim the piece makes about itself.

### The configured space is the authority boundary

An input reference naming a space other than the session's is refused, before
anything is compiled and before any piece exists, in
`packages/cf-harness/src/tools/run-pattern.ts`. Session construction separately
verifies the configured space's authorization.

This is not a hypothetical. A review of the work demonstrated a pattern
deployed in space A reading a live cell from space B; the gate exists because
the absence of it was shown to be exploitable, not because it seemed prudent.
The rule that results is narrow and easy to state: a session's authority ends
at its own space. Anything wider needs a multi-space authority model that
nobody has designed, and until someone does, cross-space work is refused rather
than quietly permitted.

### Shape is disclosed only when the harness derived it

`describe_handle` reports a reference's schema and the path segments of its
referent, never its value, and never dereferences the cell. The guard that
matters is one line in `packages/cf-harness/src/tools/describe-handle.ts`:
disclosure requires `entry.schemaSource === "harness"`.

The reasoning is that property names are a channel. A schema arriving attached
to a reference is data — something put it there — and a child that can attach a
schema to a reference it returns can encode arbitrary information in property
names for the parent to read back through `describe_handle`. So the
channel is closed at both ends: no mint takes a schema off the reference it is
handed, and the only write site is the one that records a compiled pattern's
own result schema, which the harness knows because it did the compiling. An
entry without a schema means the shape was never free to capture, and reads as
shapeless.

### Minimum-privilege seeding

When a parent delegates, the child's handle table is initialized with exactly
the entries whose tokens appear in the delegation's `goal` or `context`, copied
verbatim so the token is stable across the hierarchy, and nothing else. A
reference the child discovers on its own comes back through the child's table
and out through the parent's boundary as a token the parent can resolve; a
token-shaped string that resolves in neither is scrubbed to fixed inert text so
it cannot resolve later in the parent's table.

The property this buys is that the decomposition structure *is* the opacity
structure. What a subagent can reach by reference is precisely what the parent
chose to write into the delegation — not a policy layered on top of
delegation, but a consequence of how delegation already works. There is no
separate question of what a child may see, and so no separate place for that
question to be answered wrongly.

## What was demonstrated live

Six harness runs against a local server, on `gpt-5.5`, against a seeded
`summary-demo` space holding 36 invented expense records. Each record had a
private free-text description and inert `category`, `amount` and `date` fields,
matching the `Expense` shape in `packages/patterns/budget-tracker/schemas.tsx`.

These runs were live and interactive. Nothing in the repository records them —
no fixture, no captured transcript, no integration test — so the account below
is a record of what was observed, not something a reader can re-run from the
tree. It is included because it is the evidence that the mechanism composes,
which no unit test demonstrates.

An agent discovered a piece address, saw only a token where the address was,
wrote a pattern, ran it by reference, and read back a computed result. Its
transcript contained zero raw fabric identifiers, which was confirmed
independently from the host side rather than taken from the agent's own report.

A chain-of-custody check made the point sharper: asked to echo "the id it saw",
the model echoed a token, because a token is the only thing it ever held, while
the raw artifact for the same step contained the full canonical reference.

A third run computed correct per-category totals against budgets. Those numbers
were stated aloud in the transcript, which is correct and is the point of the
sanitizer's pin rules: `category` and `amount` are inert, so the computed
answer may be spoken, while the descriptions the pattern read to produce it
never entered the transcript at all.

The last run built something a person can open: a registered, browser-visitable
spending overview at `/summary-demo/spending-overview`, wired to the tracker's
arrays by reference. Adding a row to the tracker moved it from 36 to 37
expenses and from $6,328 to $7,327 with no refresh — the ordinary reactive
behavior, reached entirely through references. The `Expense` type the agent
wrote for that piece has no `description` field: the privacy property
expressed in the agent's own code, because a field it cannot read is a field it
has no reason to declare.

## What was not demonstrated

Every one of those runs used `--cfc-enforcement-mode observe`, over data
carrying no labels.

What the runs demonstrate is the harness's reference discipline: that an agent
can be given tokens instead of addresses, compose them, compute through them,
and produce a correct answer without a raw identifier or a private string
reaching its context. That is a property of the harness.

They do not demonstrate that the runtime would refuse a leak. Enforcement
against labeled data is untested, and nothing here should be read as evidence
about it. The two properties are independent, and only the first has been
shown.

## Bugs found in shared machinery

Four defects surfaced in the runner's CFC validation and sanitization, all
fixed in #5781, all in `packages/runner/src/cfc/schema-sanitization.ts` and
`packages/runner/src/cfc/structured-result.ts`. They are recorded here because
this work is where they were found, not where they lived: the first, third and
fourth were reachable by any caller of that machinery, cf-harness among them
but not only it.

**A typed union was validated as a closed object with no properties.** The
object branch of `validateAgainstSchemaInternal` computed its permitted key set
from `schema.properties` alone and never consulted `anyOf`, `oneOf` or
`allOf`. A discriminated union written the ordinary way has no own properties,
so every value failed on its first key. Reachable through the exported
`validateAgainstSchema` and therefore through LLM structured-output validation
(`packages/runner/src/builtins/llm.ts`) and `fetch`
(`packages/runner/src/builtins/fetch.ts`). The fix reads the branch surface and
skips the check when a branch is open, while still taking an explicit
`additionalProperties: false` at its word over its branches.

**Every UI-bearing pattern result failed entirely, so no structured value came
back.** A pattern result always carries framework keys — `$UI` and its
rendering variants, `$NAME`, `$TYPE` and the rest — and a `resultSchema`
describing only the computed fields declares none of them. Validation rejected
the whole result on the first such key, so the caller got an error and no value
at all; had it passed, the sanitizer would have sealed the entire object
instead. This one was narrower than the others: it was a `run_pattern` call
site missing an argument that did not yet exist, in the window between #5748
and #5781. The fix is the `reservedKeys` option, with `FRAMEWORK_RESULT_KEYS`
(`packages/runner/src/builder/types.ts`) passed at the call site. Reserved only
excuses a key from the unmodeled-key rules — a reserved key the schema does
model is measured against what the schema says.

**The sanitizer's `knownPropertyNames` walk had no cycle guard and no depth
bound.** It was a plain recursion over combinator branches. A self-recursive
union recursed forever, and a deep combinator chain overflowed the stack —
inside the sanitization of schema input that, in this design, the model wrote.
It is now one worklist with two guards, a path-scoped `$ref` set and a
walk-wide visited set, and cut branches contribute nothing, including no
openness, so the failure mode is closed rather than open.

**The reserved-key exemption applied at eight descent sites.** The exemption
belongs to the root value and no deeper; `nestedValueValidationOptions` now
strips it at all eight places the validator descends into a child value, while
correctly leaving it in place for the recursions that describe the same value
by another schema — combinator branches, a resolved `$ref`, `not`/`if`/`then`/
`else`. This one never shipped: the option was introduced and corrected within
#5781, so it is a note on how the exemption is meant to work rather than a
regression that reached anyone.

Underneath all four sits one structural fault, which is the finding worth
carrying forward. **The validator and the sanitizer were running two drifted
copies of one walk.** The sanitizer walked combinator branches; the validator
did not walk them at all. Two implementations of "which property names does
this schema know about" will disagree, and each fix to one widens the gap. They
now read one answer from `cfcCombinatorObjectSurface`, which returns both the
known names and whether anything is open, because the two consumers
legitimately use those differently — the validator reads the names only when
nothing is open, the sanitizer reads them regardless.

A related fix in the same commit: `schemaForValue` took only the first matching
`anyOf` branch and now takes all of them. Taking the first hid later branches'
constraints, so a string a later branch pinned as a `const` went over the
boundary as an opaque link, and a property only a later branch declared was
governed by nothing.

## Filed, and not fixed

Three issues came out of this work and are not addressed by it.

**CT-2005** — `parseCellPath` converted non-canonical numeric path tokens, so
the JSON-pointer segment `01` addressed array index 1, a different cell than
the pointer names. Found in review of #5747, which had deliberately diverged
with a canonical-index-only rule. This one was fixed in flight; `parseCellPath`
in `packages/runner/src/piece-helpers.ts` now delegates to
`linkPathSegmentToCellPathSegment`.

**CT-2012** — a pattern calling `llm()` with no model fails against a standard
local toolshed. `DEFAULT_MODEL_NAME` is the literal string `"default"`, and a
locally started toolshed registers no model or alias by that name. Authored
patterns name a model and are fine; generated ones fall into it, because the
default is documented and reachable and simply does not resolve. Open.

**CT-2014** — `cf piece call` cannot reach a stream handler owned by a
sub-pattern and re-exported by its parent; the same handler works from the
browser. Registration belongs to the sub-pattern instance while `piece call`
addresses the parent, and it fails as an aborted transaction rather than as a
diagnosis. It matters beyond one pattern because composing sub-patterns and
re-exporting their streams is a common idiom, and calling a handler through
`cf` is a primary way an agent acts on a space. Open.

## Open threads

**In-pattern language-model synthesis** is parked. The demo had a narrative
half — have the pattern write the prose summary inside the space, so even the
summary is composed where the data lives — and it never completed. CT-2012 is
the immediate obstacle; whether anything else stands behind it is unknown,
because the run never got past it.

**Cross-space joins** are refused by design, per the authority-boundary
decision above. Lifting the refusal is not a matter of removing the check: it
needs an explicit model of what authority a session holds over more than one
space, and who grants it.

**A child's turn budget appears capped by the parent's remaining turns.** This
was observed and not explained. The code assigns a child its own budget from
the delegation or the profile — `DEFAULT_SUBAGENT_MAX_MODEL_TURNS` is 8,
`PATTERN_AUTHOR_SUBAGENT_MAX_MODEL_TURNS` is 24, both in
`packages/cf-harness/src/contracts/subagent.ts` — with no arithmetic against
what the parent has left, so whatever produces the symptom is somewhere the
reading of the delegation path did not find. Treat this as an unreproduced
observation, not a diagnosed bug.

**`run_pattern` has no per-invocation deadline.** The run-level abort signal is
the only cancellation source, stated as such in the documentation of
`raceWithAbort`. A pattern that never settles wedges the settle barrier for as
long as the run lasts, and with no signal at all, indefinitely. Note the
asymmetry with the analogous CLI path, which has a 60-second
`PIECE_START_TIMEOUT_MS`. The roadmap wants a resource ceiling here rather than
a bare timeout.

**Denial-path tool messages are not swapped.** A denial summary keeps the
tokens the model wrote, which is a gap in coverage rather than a leak in the
direction that matters, and it is the first item in the roadmap's delegation
section.

**Value handles are reserved and unimplemented.** `cfh:v:` exists in the token
grammar only as a reserved prefix; `HarnessHandleKind` has exactly one member,
`"address"`. CT-2001 now carries the position that they may be unnecessary
altogether: with `run_pattern` merged, a capability that acquires external data
can write it to the fabric itself and return an *address* handle to it. That
covers every in-fabric result, and covers external data too if the browser and
`web_fetch` capabilities are given the same route. Taking it means no
session-scratch region, no second handle kind and no new labeling decision —
labeling happens where the machinery already is, in an ordinary fabric write by
a pattern in a space with CFC in play. Several of CT-2001's open questions
dissolve rather than get answered.

## A hazard for the next rebase

In #5781 a CLI address stopped being a four-field object — `id`, `path`,
`scope`, `space` — and became a single string in canonical reference form:
`InvocationResultLink` in `packages/cli/lib/callable.ts` went from an interface
to `string`, and `packages/cli/lib/cell-selection.ts` emits the same one string
under the `$link` key.

The hazard is what that does to a merge. Code reading `.receipt.id` or
`["$link"].id` off an address is now reading a property of a string, and those
values almost always sit inside `unknown` or `any` payloads — a `jq` filter, a
test that destructures a tool result. So the breakage arrives through a *clean
merge that still type-checks*, and shows up as `null` or `undefined` at
runtime. The one place it does fail the compile is where a signature changed
outright: `collectInvocationResultLinks` gained a required `contextSpace`
parameter.

Three separate instances surfaced across two rebases. The shell scripts —
`packages/cli/integration/verb-session-demo.sh`, `verb-session-gaps.sh`,
`verbs-over-the-cli.sh` — were found by grepping for the field accesses, and
note that the fix is not only dropping `.id`: the canonical form leads with
`/`, so prefix checks for `of:` had to become `/of:` and a `sed` stripping the
prefix had to go. The TypeScript instances were found only by running the
suite. If you are rebasing anything across this change, grep for `.receipt`,
`$link`, and `of:` — and then run the tests anyway, because grep does not find
the ones that compile.
