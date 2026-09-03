# Scheduled Work in the Server

*A pattern declares the cadence it wants to wake on, the space's own serving
runtime honours it, and the background piece service is deleted rather than
carried forward.*

**Status:** the replacement capability is proposed and exploratory; the
deletion it enables is already an owner ruling ·
**Updated:** 2026-09-02

The same day D12 ruled the background piece service sunset, the owner also
ruled that its work should *not* be migrated, on the grounds that "bgUpdater is
not in practical use today and will come back in a simpler form". This is a
shape for that simpler form: a way for a pattern to declare that it wants
waking on an interval, honoured by the serving runtime the executor already
hosts. One step of it needs a further ruling before it could be built.

The document is in three parts and they are separable. Part 1 is the
replacement. Part 2 is the deletion. Part 3 is compute accounting, which is a
different problem that neither of the others depends on.

---

## What is already decided

The [D12 ruling](../history/specs/server-side-execution/passivity-arc-orchestration.md)
sunsets the background piece service, and describes it in terms worth quoting
because they explain why the deletion is a goal rather than a chore. The
service is "a runtime that runs pieces on the server by pretending to be a
client". The ruling calls it a pre-existing workaround for the serving gap, and
says that closing that gap is what makes it redundant. It is recorded as the
first deletion of a whole component the arc has earned.

The live spec carries this forward in its own statement of what is being built:
toolshed routes its own pattern needs through the executor, and the background
piece service stays sunset.

The sequencing was ruled in the same place:

> close the serving gap → migrate the service's work onto the executor →
> sunset the service → flip the flag

Events have since overtaken two of those four steps, and §2.2 records what
that leaves. The flip has landed: `SERVER_EXECUTION_DEFAULT_ENABLED` is now
`true`, so the executor serves by default and the soak is running. It landed
with the background piece service still in the tree, which is the opposite of
the ruled order.

The middle step reads as though the replacement gates the deletion. It does
not, because a second ruling the same day removed it:

> bgUpdater is not in practical use today and will come back in a simpler
> form, so rather than migrating this service, disable it

So the deletion does not wait for anything in Part 1. The owner's premise is
that the capability can lapse, because nothing depends on it in practice, and
that it returns later in a simpler form. There is no production deployment for
that premise to have stopped being true of, so it holds without qualification:
no registrations have accrued, and nothing is relying on a background poll.

Two further clauses constrain this document directly. The service must keep
working until it is retired, and silencing it early does not count as the
sunset. And it must not be given executor authority as a stopgap, because that
would re-authorise a component already decided for deletion.

The two parts are therefore genuinely independent. Everything the background
service does is redundant once the executor serves spaces, with one exception:
waking a piece on a timer when nobody is watching. The ruling's position is
that this exception may simply go away for a while. Part 1 is a proposal for
what it should look like when it comes back, and Part 2 can proceed without
it.

Nothing is broken today and no user is waiting on this. Part 1 is about what
the product should be able to do rather than a repair, so it can be held to
whatever bar seems right, including waiting for Part 3, at no cost to anyone.
Part 2 is cheap for the same reason: there is nothing to preserve.

## Why the executor does not already cover it

The executor now serves by default, so this is a question about the shipped
system rather than about an arm behind a flag. The serving loop is lazy by
design, and the laziness is precisely what leaves this gap.

A space is active when it has at least one live client session or undelivered
events. Otherwise it may be parked, with its runtime disposed and its lease
released. Within an active space, derivations that nobody demands stay dirty
and unmaterialised indefinitely. The loop computes what a client session is
tracking, and nothing else.

A scheduled wake is, in those terms, demand with no demander. Nobody is
watching. Closing the serving gap does not close this one, because this one is
not a gap in the design — it is the design.

## What a pattern would declare

A new reserved key on the pattern result:

```tsx
// Shown for illustration only.
export default pattern("Feed reader", ({ url, items }) => ({
  [UI]: <FeedView items={items} />,
  [SCHEDULE]: [
    { intervalMinutes: 120, callback: refresh({ url, items }) },
  ],
}));
```

`[SCHEDULE]` would join the reserved keys in
[`framework-result-keys.ts`](../../packages/utils/src/framework-result-keys.ts).
That file already states the contract these keys live under: the spellings
belong to the framework, the runner reads them back off the result, and the
transformer decides what a pattern may declare about them.

`[TESTS]` is the closest precedent, and the reason to prefer a reserved key
here. Its consumer is an out-of-process test runner rather than the rendering
path, which is the relationship a scheduler would have to a pattern.

The alternative would be a new builtin. That carries an obligation a reserved
key does not: any new builtin under server-execution v2 has to be classified
into one of five placement classes and given a contract row in
[`builtins.md`](../specs/server-side-execution/builtins.md). A reserved key is
static data sitting on the result, readable by a schema probe without running
anything, which is what a scheduler needs.

The value is a list so that one pattern can declare more than one cadence.
`intervalMinutes` says how often. `callback` is the stream the wake sends to.

### Validation

The transformer would enforce three rules, since it is already the place that
decides what a pattern may say about a reserved key.

`intervalMinutes` must be a literal. A computed interval could not be read
without running the pattern, which defeats the point of a declaration a
scheduler can index.

`intervalMinutes` must be at least 60. Out-of-range values are rejected rather
than clamped, following the convention the `#now/N` bounds already set.

The list has a small maximum length. A pattern declaring dozens of cadences is
more likely to be a mistake than an intention.

## Part 1 — The replacement

### 1.1 The step that needs a ruling

The loop already has one exception to its own laziness, and it is close to the
right shape. The explicit warm request activates a parked space with no live
session and no events, and injects what
[`serving-loop.md` §1](../specs/server-side-execution/serving-loop.md) calls
identity-less warm demand — a demand key with no demanding pair, unioned into
that tenure's demand pass. Today the serving-side provisioning path is the only
thing that issues one.

The spec is explicit that this is the single deliberate extension of demand
beyond client sessions, and that the issuer is a scoped signal rather than a
blanket write-trigger. A scheduled waker would be the second issuer. The count
is currently pinned at one, and moving it to two is the owner's call rather
than an implementation detail.

Everything else in Part 1 rests on that answer.

### 1.2 Where the schedule would live

The declaration is already durable, because it sits on the piece's result. What
is missing is an index the host can consult without loading every piece in
every space.

The proposal is a row on the direct-engine plane, alongside the existing
`execution_lease` table: for each space, when its next scheduled wake is due.
That plane already carries exactly this kind of bookkeeping, under the rule
that nothing on it is ever a commit.

The row would be maintained by the SpaceServer, which already sees every
accepted commit for its space. When a wave commits a piece result carrying
`[SCHEDULE]`, the schedule row is updated inside the same store transaction —
the pattern the basis index already follows, where index rows travel in the
transaction without becoming part of the commit representation.

Host boot discovery gains a third arm. Today it asks per space whether the
event stream head is past the watermark. It would also ask whether a schedule
is due.

### 1.3 Firing

On activation for a scheduled wake, the host would issue warm demand scoped to
the declared callbacks, deliver an event to each due callback, and write the
next due time before firing rather than after.

Writing first is deliberate. If the next due time were written on completion, a
crash partway through would leave the entry due again immediately, and the
space would activate into the same crash on a tight loop.

The next due time would be the current time plus the declared interval plus a
jitter of up to twenty minutes either way. The jitter has to be computed by the
server. Patterns cannot produce it, because the capability gate denies both the
ambient clock and `Math.random()` in reactive context — see
[`TIMING_SIDE_CHANNELS.md`](../specs/sandboxing/TIMING_SIDE_CHANNELS.md).

A two-hour cadence with twenty minutes of jitter can fire as little as one
hundred minutes apart. Combined with the sixty-minute floor, the shortest
possible real gap is forty minutes.

For how the jitter is drawn, the proposal leans towards deriving it by hashing
the piece's identity into the window rather than drawing fresh randomness each
period. The reason is testability: the test suites here run under a frozen
clock preload, and a scheduler that consumes real entropy is hostile to that.
A hash-derived phase is reproducible, is stable across restarts, and still
spreads pieces evenly across the window.

That preference assumes the point of the jitter is spreading load, so that ten
thousand hourly pieces do not all fire at the top of the hour against the same
third-party service. If the point is instead to be unpredictable to an outside
observer, a hash-derived phase is the wrong answer and a fresh draw each period
is right. The two choices are not compatible, so this wants settling before
building.

### 1.4 Scoping the demand

A scheduled wake should demand the subgraph its callbacks need and nothing
else. It should not materialise the piece's whole display-facing derivation for
an audience of nobody.

The cheapest way to avoid paying for unwanted computation is not to perform it,
and the loop's demand model already supports being that precise. The
provisioning warm request is already scoped this way, capturing the staged
instances rather than requesting the space at large.

This is the author's inference rather than anything the spec settles: the
declaration should be read as naming what it demands, not merely when.

### 1.5 This puts background compute in the toolshed process

The background service runs in its own process under its own identity. A piece
that wedges it takes down background execution and nothing else. Part 1 gives
that property up, and it gives it up at the moment Part 1 ships rather than at
the moment the old service is deleted.

The existing per-space budgets pace outbound network effects, and the
consequence-flush deadline bounds how long a wave may hold a commit open.
Neither bounds compute. The cooperative yield hands the process back between
action runs, and its own header states the bound honestly: an action runs to
its end. A piece that loops synchronously inside a single action is not
preempted.

So a scheduled wake is a way for a pattern author to schedule unbounded
synchronous work inside the process that also serves the storage WebSocket.
That is a property of Part 1, not a cost of the migration, and it does not
become safer by keeping the old service around. Part 3 is what would bound it.
Whether Part 1 should ship before that bound exists is an open question below.

### 1.6 What Part 1 does not do

It does not run anything when the server is down. The proposal moves the
requirement from "the user runs a background service" to "the server the user
already depends on is running". That is a smaller ask, and it is not the same
as working while everything is off.

It does not bound how much work a wake performs. That is Part 3.

## Part 2 — Deleting the background piece service

The inventory and the ordering constraints, so that the deletion can be scoped
as its own change.

### 2.1 This has been done once already

The v1 arc executed this deletion. The service was disabled under the flag in
`f945d1ed0` and deleted in `9c9513317`, a change of −6754 and +282 lines,
reachable locally on `upstream/codex/server-execution-flags-on`.

That branch is a v1 archive and is marked "do not merge", so the commit is not
a patch to apply. It is a worked inventory, and reading it saves rediscovering
the parts of the deletion that are not obvious. Two of its decisions are
recorded below because they were arrived at by finding out the hard way.

### 2.2 The ordering, and the premise to re-check

The ruling put the sunset before the flip. The flip landed first, with the
service still present, so the deletion is now a cleanup behind a shipped change
rather than a step ahead of one. What survives of the ruling is the half that
was never about ordering: the sunset does not wait for a replacement, because
the owner ruled the capability may lapse.

That makes one question live rather than hypothetical. A runtime under the flag
that is not the serving runtime — which is what the background service's worker
is — defaults to the speculation overlay and "thereby loses the
derivation-commit path by construction"
([`runtime.ts:529`](../../packages/runner/src/runtime.ts:529)). The service
depends on that path when it starts a piece. It now resolves the default ON in
any ordinary deployment, so whatever that costs it, it costs it today.

The flip PR discharged the review finding that no gate exercised these binaries
in the ON arm. There is now a deployed-topology posture gate that runs the real
`bg-piece-service` binary against a serving toolshed
([`posture-gate.test.ts`](../../packages/background-piece-service/integration/posture-gate.test.ts)),
and the service logs the posture it resolved. Read what that gate claims,
though: the binary starts, opens a session, reads and watches the registry,
reports ON, and shuts down cleanly on SIGTERM. It does not run a piece. Whether
a poll can still drive a `bgUpdater` handler to a durable commit under the
default arm is not covered by it, and is the open question above.

v1 did not rely on that structural loss. It added an explicit bail gated on the
flag, and the reason was specific to v1: a live background registration made
the memory engine refuse to acquire or renew an execution lease, so the service
structurally locked the executor out of every space it served. That machinery
does not exist in v2 — there are no references to it on main — so the v2
deletion does not inherit that reason, only the ordering.

**The premise holds, and nothing needs re-checking to confirm it.** The ruling
rests on "bgUpdater is not in practical use today", and there is no production
deployment for that to have stopped being true of. The v1 commit worried that
the registered set "is not derivable from this repo (it accrues as users
connect accounts)". Nothing has accrued, so the set is empty and the concern is
moot.

What remains is source-level. Six patterns on main declare a `bgUpdater`
stream: the Gmail importer, the Google calendar importer, Google auth, Airtable
auth, and a test pattern. They are code referring to a mechanism being removed,
not users depending on it.

Note also that a `bgUpdater` stream is not only a polling target. The Gmail
extractor wires the importer's `bgUpdater` to a button's `onClick`, so the same
stream serves as the manual refresh path. Deleting the service does not require
deleting the streams, and v1 did not delete them.

### 2.3 The servability oracle is empty

The ruling names a use for the service that expires when it does. Every piece
it runs today is a piece the executor must be able to run tomorrow, so its
workload would be a ready-made coverage list for the serving gap.

That instruction assumes a running deployment with a workload. There is none,
so the oracle has nothing in it and this step cannot be performed as written.

The six patterns in §2.2 are the repository's own statement of what wanted
background execution, so they are the coverage list by default, and a weaker
one. What they cannot tell you is which of them anyone
actually ran, or which ran successfully — a question the service could not have
answered reliably either, since its README records that an updater doing
asynchronous work returns while that work is still in flight, so failures go
unobserved. The oracle was going to over-report even when it had something in
it.

### 2.4 Inventory

The `packages/background-piece-service` package, including its worker,
worker-controller, and space-manager machinery, and the `bg-piece-service`
binary target in `tasks/build-binaries.ts`.

The `--bg-updater` arm of the local development scripts, the corresponding
sections of the local development documentation, and the package's entry in
`tasks/check.sh`.

The `gideon-tests/test-background-manual-trigger.tsx` pattern, which exists to
exercise the service.

Docstrings in the Google and Airtable auth patterns claiming that tokens
auto-refresh in the background. v1 corrected rather than removed these, since
the manual refresh button becomes the effective path.

**v1 kept two things this deletion can take.** Both were kept for reasons that
depended on a running deployment, and neither reason survives without one.

v1 kept the registry write side, moving `setBGPiece` out of the deleted package
into a new `packages/toolshed/routes/integrations/bg-registry.ts`, because
`POST /api/integrations/bg` had a live caller in the `cf-updater` element and
no-oping the write would have left that button reporting success while
registering nothing. With nothing calling it, the honest move is to delete the
route and the element together rather than to relocate a writer for a reader
that is also going.

v1 kept the registry data, because "the set of pieces that asked for background
execution is not derivable from this repo" and "a replacement
standing-registration mechanism will want it". Nothing accrued, so there is no
data to preserve and Part 1 inherits no registrations. It starts from the
declarations in the patterns themselves, which is where it should start anyway.

### 2.5 What the deletion buys

The deletion now retires machinery the flip had to build. The deployed-topology
posture gate exists to prove this binary resolves the right arm; a binary that
no longer ships needs no such proof, so the gate, the integration test, and the
startup posture log line go with it.

It also settles the §2.2 question by removing its subject. Deciding whether the
service can still commit under the default arm is only worth the investigation
if the service has a future, and it does not.

## Part 3 — Compute accounting

Separate from both. Part 1 does not depend on it to function, Part 2 does not
depend on it at all, and it would be worth doing even if scheduled wakes never
existed.

The concern is a piece that wakes on a schedule, computes something expensive,
and produces data that nothing ever reads.

### 3.1 What already exists

Per-action wall clock is measured unconditionally, and the telemetry bridge
exports it as `ct.scheduler.action.duration_ms` along with settle duration and
a busy ratio. The serving loop keeps a per-space counter block including the
demand pass's wall time and per-wave counts, exposed on the health-stats route.

Per-space budgets exist and are enforced, as knobs on `SpaceServerPolicy`
threaded from the environment: a cap on dispatched but unsettled network
effects, and a token bucket pacing egress. Holds are counted rather than
silent.

### 3.2 What is missing

Attribution is by pattern name and module name. Two instances of one pattern in
one space are indistinguishable, and rate-limiting a user needs the instance
and the owner.

The measurements are telemetry, leaving through the metrics exporter. A quota
has to be read back and enforced by the server, which means durable state
rather than a metrics pipeline. A quota that resets when the process restarts
is not a quota.

The existing budgets pace egress. Nothing bounds compute.

Wall clock is not CPU time. On a single-threaded process with cooperative
yielding, an action's measured duration can straddle work done for other
spaces. This is the measurement trap most worth resolving early, because
getting it wrong produces numbers that look authoritative and bill the wrong
tenant.

### 3.3 A possible shape

Meter the wave rather than the action. The wave is already the unit that
commits, is already counted, and already carries a deadline. Attribute within
it by action for diagnosis rather than for billing.

Keep a durable per-space ledger on the direct-engine plane, next to the lease
and the schedule index, so the existing rule holds: bookkeeping never rides the
commit stream.

Enforce at activation rather than mid-wave. Declining to activate a space whose
scheduled budget is spent is cheap, fails cleanly as a skipped and counted
wake, and cannot corrupt anything in flight. Interrupting a wave partway
interacts badly with the outbox's at-least-once delivery.

Keep scheduled work in a separate bucket from session-driven work. Somebody
sitting in front of their piece should not be throttled because their overnight
jobs are expensive. The distinction is available at the point of measurement,
because warm demand carries no demanding pair while session demand does.

### 3.4 A signal that may be better than cost

The loop knows something a CPU meter does not: whether anything ever demanded
the result. A piece whose scheduled waves produce derived commits that never
enter any session's tracked set is measurably useless rather than merely
expensive.

Backing that piece's schedule off, by doubling its interval until something
reads its output, would degrade the right thing and cost almost nothing to
compute. This is the author's proposal rather than something the spec
contemplates, so it would need its own design work. It is recorded because it
may make a large part of the rest of Part 3 unnecessary.

## Open questions

1. Does the owner accept a second issuer of warm demand? The spec pins the
   count at one. Everything in Part 1 rests on this.
2. Is the jitter for spreading load or for unpredictability? The answer decides
   whether the offset is hash-derived or freshly drawn, and the two are not
   compatible.
3. Should Part 1 ship before a compute bound exists? Since the deletion does
   not wait for Part 1, Part 1 is free to wait for Part 3, and the argument in
   §1.5 says it probably should: without a bound, a scheduled wake is a way for
   a pattern author to run unbounded synchronous work inside the process
   serving the storage WebSocket. The cost of waiting is that the capability
   stays absent for longer, which the ruling has already accepted.
4. What happens to a piece created while its space is parked? An authored
   admission alone does not activate a space, so a piece created by another
   space's provisioning write could carry a schedule that nothing indexes until
   the space next activates for some other reason.
5. Should `[SCHEDULE]` name what it demands, or should the scheduler infer the
   demand from the callback's own reads? Inference is less to write down and
   less precise.
6. Is the sixty-minute floor a policy or a limitation? If shorter cadences are
   wanted later, the floor is what has to move, and the jitter window would
   have to become proportional rather than fixed.

## Acceptance

Part 1 would need: a pattern declaring `[SCHEDULE]` firing its callback with no
browser open and no background service running; the next due time surviving a
toolshed restart; a wake demanding only the callback's subgraph, shown by the
demand counters; and the transformer rejecting a sub-sixty-minute interval, a
computed interval, and an over-long list.

Part 2 would need the six declaring patterns shown to run under the executor,
which is the whole of the coverage list now that the oracle is empty. It does
not need Part 1, and it does not need the `bgUpdater` streams removed — v1 kept
them, and one of them is a manual refresh button.

Part 3 would need a ledger that survives restart, a demonstration that a space
over its budget is not activated for a scheduled wake, and evidence that
session-driven work is unaffected by a scheduled budget being spent.

Every one of these should be asserted on counters rather than on logs, which is
what the serving loop's own testing rules already require.

## Alternatives considered

**Keep the background service and give it per-piece intervals.** Foreclosed by
D12 and by the ruling against migrating it, and independently by the flip that
has now landed: a non-serving runtime under the flag loses the
derivation-commit path, so the service has no future in the served world
regardless of what features it grows.

**Make `#now/N` durable instead of adding a declaration.** Attractive, because
the declaration already exists in a form patterns use. It fails on discovery:
nothing can read a wish target without running the pattern, so no scheduler can
index it. It also conflates "give me the current time" with "wake me up", which
are different requests sharing a mechanism today.

**Run scheduled work in a separate process that talks to the executor.** This
keeps the process isolation §1.5 gives up, which is the one real advantage the
background service has. It is not the background service resurrected, because
such a process would hold no runtime and pretend to be no client — it would
only tell the executor when to wake a space. If open question 3 resolves
against shipping Part 1 unbounded, this is where to look next.

## Out of scope

Sub-hour cadences. Cron-style calendar expressions, as opposed to intervals.
Any guarantee that a wake fires while the server is down. Cross-space scheduled
work. Per-user quota policy, as opposed to the accounting that would make such
a policy expressible.
