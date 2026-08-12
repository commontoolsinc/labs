# Designing verbs so they can change

This document exists so the team can make one decision together: **how should
verbs be designed, so that changing them later is possible?**

The decision belongs to the pattern owners. The argument should be followable
by anyone on the team, so this starts from first principles and avoids
shorthand. It frames the problem, names the dimensions the answer has to
settle, weighs the candidate designs — including one considered and set
aside — and records the longer arc of versioned interfaces and managed
upgrades that any near-term choice is an interim for.

## The vocabulary, briefly

A **pattern** is a program someone writes. A **piece** is a running copy of
that pattern that holds real data — a specific notebook, a specific board.

A **verb** is a named action a pattern offers to the outside world: `addItem`,
`setLabel`, `archive`. Verbs are not the only way in: a caller with write
permission can also set a piece's fields directly — the UI's editing controls
do exactly that, and so do `cf piece set` and the filesystem mount. A piece's
interface is its fields and its verbs together, the same way an object's
interface is its public fields and its methods.

This document is about the verb half, because that is where the open design
questions are. The field half is already governed by the same update gate —
its accept-more/provide-more rules below are field rules — and a writable
field is the tightest contract of the lot, because it is promised in both
directions at once: writers rely on what it accepts, readers on what it
holds.

The runtime writes down the **shape** of every pattern automatically, from the
TypeScript types the author wrote. The shape records what a pattern accepts,
what it provides, and which of its fields are verbs.

Patterns are **updated in place**. You push new code onto pieces that already
exist and already hold data. That is the whole source of the problem: the new
code has to keep working for everything that was already talking to the old
code.

## The problem

When a pattern is updated, the runtime compares the old shape to the new one
and **refuses the update** if the new shape would break something relying on
the old one. Two rules drive that comparison, and they run in opposite
directions:

- For things a pattern **accepts**, it may accept more than before, never
  less. Accepting less breaks whoever was sending the thing you dropped.
- For things a pattern **provides**, it may provide more than before, never
  less. Providing less breaks whoever was reading the thing you dropped.

That is sound in principle. In practice it produces two bad outcomes today,
pulling in opposite directions.

**Ordinary changes are refused.** Adding a new verb to a type that another
pattern stores fails the check. If a board keeps a list of notes, and you add
one new action to notes, updating the board is refused outright:

```
argument.notes[].append: newly required argument field has no default
```

Nothing is wrong with that change. It adds an action; it takes nothing away.
It is refused because of how verbs are declared, not because of what the
change does.

**And some genuinely breaking changes pass.** Adding a newly required field to
a verb's input passes the check and then fails every existing caller at the
moment they call it. The check treats a verb's input as though it were an
output — the one place the two rules above get applied the wrong way round.
This one is a straightforward defect and is being fixed
([#5663](https://github.com/commontoolsinc/labs/issues/5663)); it is listed
here because it shapes how much the gate can be trusted while it is open.

So the gate refuses changes that are safe, and permits at least one that is
not. Pattern authors will learn to work around it either way. The question is
what we want them working around.

## What is true today

Measured against the current runtime, not inferred:

| Change to a verb | Result |
| --- | --- |
| Add a verb | allowed |
| Add a verb to a type another pattern stores | **refused** |
| Remove or rename a verb | refused |
| Mark a verb `@deprecated` | allowed, and it disappears from listings |
| Turn a verb into data, or data into a verb | refused |
| Add an optional field to a verb's input | allowed |
| Add a required field to a verb's input | allowed, **and breaks callers** |
| Remove or retype a field of a verb's input | refused |
| Change anything about a verb's **output** | allowed, and nothing checks it |

Two entries deserve emphasis.

**A verb's name is permanent.** Removal and renaming are both refused, and
that is unlikely to change — it is the one rule genuinely protecting callers.
Retiring a verb therefore means adding its replacement and marking the old one
`@deprecated`, which hides it from listings while keeping it callable.

**A verb's output is completely unprotected.** The shape the runtime writes
down records a verb's input and discards its output. Renaming a field of what
a verb hands back passes every check and breaks callers silently. This is a
known, deliberate deferral — recording outputs would commit us to a format
that the planned Fabric-types work is expected to replace — but it means
output changes are governed by care alone.

## What a piece promises

In ordinary object-oriented programming, an object promises an interface:
these fields, these methods. Code that holds the object leans on that promise
without checking. Take the promise away and every caller turns defensive —
if this method exists use it, otherwise try that one, otherwise fall back.
Agents can cope with code like that. People maintaining it are miserable.

The promise is worth keeping. What makes keeping it hard here is that pieces
are persistent: each one carries the interface it was created with, and keeps
it while the code around it moves on. Sooner or later some caller holds a
piece older than the interface it wants, and no declaration style makes that
impossible.

So the uncertainty cannot be removed — but it can be **placed**. The livable
designs concentrate it at one moment: when a caller first takes hold of a
piece, it establishes what it is holding, and relies on a guaranteed
interface from then on. The miserable designs spread it across every call.
That is the standard to hold each option below against: after the first
check, does the caller hold a promise or a maybe?

Who is doing the calling matters too, because the callers are not alike:

- **Probing callers** — the CLI, the UI, an agent — ask a piece what it has
  before acting. They bind late, so a missing verb costs them a listing
  lookup, not a crash. Flexibility is cheap here.
- **Compiled callers** — TypeScript in one pattern calling a verb on another
  piece — bind when the code is written. They are exactly what the interface
  promise exists for.
- **Stored references** — a board holding a list of notes — are bindings
  that persist. What a pattern demands of the pieces it stores is written
  into its own shape and outlives everyone's code. These are the hardest
  case, and they are where today's refusal comes from.

## The dimensions

Any answer has to settle five things. They are listed in order of leverage:
the first one changes how much the others matter.

### 1. How much do we want to depend on updating in place?

This is the real question, and the others are downstream of it.

If updating a running piece is the normal way patterns change, then the shape
rules are a permanent design constraint and type design has to bend around
them. If deploying a new pattern and migrating the data is normal, the gate is
a safety net for small changes and stops driving design at all.

This is a product-stage question more than a technical one. Today nothing
outside the team holds a piece running our patterns, and migrating data
between shapes is something we control end to end. That will not always be
true.

### 2. Should a verb promise that it exists?

A verb can be declared as something a piece definitely has, or as something it
may have. That single choice decides the refusal above: a verb declared as
"definitely has" must be present everywhere the type is used, including inside
patterns that merely store it — which is why adding one is refused. A verb
declared as "may have" can be added anywhere, at any time.

In the source this is one character. The verb an author writes today:

```tsx
// Shown as interface or class members.
/** Append a line to the body. */
append: Stream<{ text: string }>;
```

and the same verb declared as "may have":

```tsx
// Shown as interface or class members.
/** Append a line to the body. */
append?: Stream<{ text: string }>;
```

The cost is what a caller can assume. If verbs may be absent, every piece of
TypeScript that reads one off another piece has to cope with it not being
there — and most of that code is our own tests. Option B below carries the
measurement.

### 3. How does a changed contract get a name?

Since names are permanent, a verb whose contract must change incompatibly
needs a new name. Two spellings are available: a name that describes the
difference (`appendFormatted`), or a version suffix (`append_v2`).

A related question is whether to version from the start — `append_v1` on day
one — or only when a second generation appears. Versioning from the start is
uniform but taxes every verb forever to serve the few that ever change.

### 4. What should the gate protect?

Today it protects names and inputs, and ignores outputs. It could protect
outputs too, at the cost of committing to a format now rather than after the
Fabric-types work. Or output safety could stay a matter of convention and
review.

### 5. What does a holder of a piece have to declare about it?

When one pattern stores another — the board holding notes — today it embeds
the note's whole shape, verbs included, into its own. That is why adding a
verb to notes is refused as an update to the *board*: the board's shape
changed, even though the board never calls the new verb.

The alternative is for a holder to declare only what it actually uses: the
fields it reads or writes, the verbs it calls, and the reference itself.
Then a provider growing a new verb never touches its holders. Option D below is
this choice taken deliberately.

## The options

These are coherent packages, not a menu — each settles the dimensions
together.

### Option A — Verbs are permanent public contracts

Declare every verb as something a piece definitely has. Never remove or
rename. Version by new name when a contract must change. Accept that adding a
verb to a stored type requires a redeploy rather than an update.

**Good when** things outside our control call our verbs, and stability matters
more than iteration speed.

**Costs** the most common evolution step — adding an action — becomes a
migration event whenever the type is stored elsewhere. Option D removes
exactly this cost, and composes with A.

### Option B — All verbs optional (considered, and set aside)

Declare every verb as something a piece may have. Adding a verb is then
always allowed, anywhere, including on types other patterns store. Names
stay permanent and retirement still goes through `@deprecated`.

This buys the most evolution for the least machinery, and it is set aside
anyway, for the reason the promise section gives: it moves the maybe into
every call site, permanently. An interface whose every member is optional is
not a contract, it is a suggestion — and code consuming a suggestion turns
defensive. It is convenient for probing callers and for data upgrades, and
wrong for everything the promise exists to serve. Every system in the longer
arc bought the same evolution while keeping the promise.

The measurements are recorded because they locate who actually depends on
verb declarations:

- **8 call sites** in shipped pattern code read a verb off another piece,
  across four files.
- **396 call sites across 50 test files** do the same, every one of the form
  `instance.verb.send(...)` — the documented way to test a pattern.

Making verbs optional turns each of those into a possibly-absent value, and
the obvious rewrite, `instance.verb?.send(...)`, **does nothing at all when
the verb is absent** — in a test, a real failure becomes a pass. Whether the
compiler would even catch a missed rewrite is unestablished: pattern
`*.test.tsx` files are excluded from `deno task test` in `packages/patterns`
and run through the `cf` binary instead.

Optional declaration stays legitimate where absence is a real state of the
piece — a capability present by configuration, not by version. Even then,
the right shape for it is a separate small contract a caller probes for once
at binding (Go spells this `if f, ok := w.(http.Flusher)`), not optional
members scattered through the primary interface. What it must not become is
an evolution device.

### Option C — Redeploy first

Treat a significant pattern change as a new deployment plus a data migration,
rather than an in-place update. Do not bend type design around the gate at
all; let it catch what it catches.

**Good when** we are still learning what these patterns should be, and the
data we would migrate is ours.

**Costs** it needs migration to be genuinely easy, and it stops being
available the moment someone outside the team holds a piece we cannot
redeploy for them.

It also has a hole. A redeploy mints a
**new piece with a new identity**, and other pieces hold references to the
old one — boards hold notes, topics hold cross-references. Those stored
references keep pointing at the old piece; nothing re-points them. In-place
update exists precisely because identity persists through it. A
redeploy-first posture is therefore incomplete without a re-pointing or
forwarding story — a way for an old identity to hand its callers on to its
successor — and that is a mechanism someone has to design, not a workflow
note.

### Option D — Holders demand only what they use

Keep every verb a promise, and change what a *holder* writes down. Today a
board storing notes embeds the note's whole shape in its own; under this
option it declares only its demand: the fields it reads or writes, the verbs
it actually calls, and the reference itself. A note is still everything its own
pattern says it is — this changes the consumer's declaration, not the
provider's.

The measured refusal disappears at the root: adding `append` to notes never
changes the board's shape, because the board never demanded `append`. And
the promise survives, because a holder that *does* call a verb declares it —
and then holds a guarantee for exactly what it declared.

The principle is old — declare what you need, not what they are. It is how
Go interfaces work: declared by the consumer, satisfied by shape, and best
kept tiny ("the bigger the interface, the weaker the abstraction"). Our
pattern code already lives this way at compile time, because TypeScript
types structurally; this option extends the same discipline to the stored
contract. The difference from Go is that a demand here is durable — it is
written into the holder's shape and proved again at link time, against a
provider that evolves independently.

Most of the machinery already exists: the runtime already proves that a
stored link satisfies the shape its holder demands, and shared narrow
projections (a board-facing view of a topic) are already in use across
patterns. What is missing is the decision that holder-side types are
*demands*, written that way on purpose, and the authoring guidance to match.

One limit to know about: shape carries no meaning. A demand can say "has a
verb named `append` taking text"; it cannot say "and `append` means what I
think it does". Small demands keep that gap harmless, the same way small Go
interfaces do — and closing it properly is what Option E's names and
versions are for.

**Costs** an author writes two kinds of type — a pattern's own full truth,
and its demands on others — and a demand is a real contract that must stay
as small as it claims. It does nothing for the other evolution problems:
changing an existing verb still means a new name, and outputs are still
unprotected.

### Option E — Named, versioned interfaces

Give interfaces names and versions of their own, separate from any one
pattern: a "Notes, version 2" interface exists as a first-class thing,
patterns declare which interfaces they provide, and consumers declare the
minimum version they accept. Binding checks once; after that the caller
holds a guarantee.

This is the full form of the longer arc's first mechanism, and the only
option here that still works when pieces and callers are owned by different
people. It is also the most machinery: an interface needs an identity, a
registry, a compatibility rule of its own, and a place to live in the shape
— the planned Fabric-types work is the natural vehicle. A nominal interface
mechanism was considered once before and deliberately deferred; this option
is the argument for scheduling that work rather than rediscovering it.

### How they compose

A is the floor everything else stands on: names permanent, contracts kept.
D removes the one measured refusal without weakening anyone's promise, and
can be adopted pattern by pattern. C handles the true breaks D cannot — but
it is incomplete until redeploy has a re-pointing story. E is the
destination the longer arc describes, and the only complete answer once
outside callers exist. B is set aside as a posture; optional declaration
remains a scalpel for verbs whose absence is a real state.

Sequencing matters more than the labels: D and the three items under "Worth
doing under any posture" are compatible with every posture, so they need not
wait on the larger decision.

## The longer arc: versioned interfaces and managed upgrades

Whichever posture wins now, the pressure behind this document does not go
away: pieces live a long time, they carry their interface with them, and the
code around them keeps changing. Other systems have faced exactly this —
long-lived stateful things, evolving interfaces, no way to update everything
at once — and they converged on the same small set of mechanisms. None of
them solved it by making the interface uncertain. They kept the promise,
versioned it, and built machinery for old and new to live side by side.

Four mechanisms recur, and ours will likely need a form of each:

**1. Interfaces carry versions, and consumers name the minimum they accept.**
COM froze every published interface permanently: you never changed `IFoo`,
you published `IFoo2`, and an object implemented both. A caller asked once —
"do you support `IFoo2`?" — and held a guaranteed interface from then on.
OSGi modules import each other at "version 1.2 or newer". Kubernetes serves
the same API at several versions at the same time. The planned Fabric-types
shape for verbs is the natural place a declared version would ride.

**2. Compatibility has declared boundaries, and breaking one is a decision.**
Semantic versioning is the everyday form: additions are minor, breaks are
major, and a major is a choice someone makes on purpose, never a side effect
of an edit. Avro checks compatibility pairwise — the shape data was written
with against the shape the reader expects — which is structurally what our
update gate already does. The difference is that Avro's rules are a published
contract authors design against, while ours are discovered at refusal time.

**3. Upgrades are per-piece, and every piece has an upgrade policy.**
Erlang, the canonical hot-upgrade system, runs at most two versions of a
module at once and migrates each process individually. Orleans upgrades
long-lived actors during rolling deployments by routing each call to a host
compatible with that actor's version. Upgradeable smart contracts make the
policy explicit: who may upgrade a given contract is itself recorded state.
We have already run the unmanaged version of this experiment: a prior board
update left old and new pattern versions writing to the same space, and the
resulting write storm was measured at 96% of all commits in that space.
Coexistence without management is a failure mode we have met, not a
hypothesis.

**4. Upgrades can run code.**
Sooner or later a new shape needs data the old shape did not store, and the
upgrade has to compute it. Erlang gives every process a state-transform
callback that runs during upgrade. Common Lisp's object system migrates each
instance lazily — the first time it is touched after its class changes —
through a hook the author writes. Rails migrations and event-sourcing
upcasters are the same idea for databases and event logs. Kubernetes converts
stored objects between API versions through registered conversion code. The
recurring design fork is eager (upgrade everything now) against lazy (upgrade
each piece when next touched); systems with many small stateful things
mostly chose lazy.

Two of the rules recorded above were derived by measurement against our own
runtime and then turned out to be classical results — which suggests the
rest of this map is worth reading before we draw more of it ourselves. "A published interface only grows" is COM's frozen
interfaces and protobuf's permanent field numbers. "A newly required input
breaks callers" is so well established that proto3 removed the `required`
keyword from the language entirely.

None of this machinery is designed here. It is recorded so the near-term
choice is made knowing where the road leads, and so the owners can decide
whether to open it as its own design stream.

## Worth doing under any posture

Three items fall out of this analysis that no option contradicts:

- **Move compatibility discovery to authoring time.** Today an author learns
  the rules when an update is refused. The same comparison the gate runs can
  run as a `cf` command over two versions of a pattern before anything
  deploys — the difference between a published contract and a wall you find
  by walking into it.
- **Make deliberate breaks scoped.** The only override today turns off the
  entire gate at once. A deliberate break should be acknowledgeable by name
  — this field, this verb — so accepting one break does not silence every
  other protection.
- **Count verb calls.** Retirement policy is guesswork without usage data:
  deprecation windows work in other systems because usage is observable. The
  planned invocation-record work is the natural place for this to ride.

## What this document asks the owners to decide

1. **The posture**: A alone, A+D, or A+D with C for true breaks — and
   whether to schedule E now or leave it in the longer arc.
2. **Whether optional verbs remain permitted as a targeted tool** — for
   absence that is a real state of the piece — now that they are set aside
   as a default.
3. **Whether output shape protection waits for Fabric-types** or gets an
   interim, given that nothing checks outputs at all right now.
4. **Whether to open the longer arc as its own design stream** — versioned
   interfaces, declared compatibility boundaries, per-piece upgrade policy
   and ownership, and upgrades that run code — with today's choice named
   explicitly as the interim until that stream lands.

Two questions are already settled and are recorded here so they do not get
reopened: verb names are permanent and retirement runs through `@deprecated`;
and a version suffix is spelled `append_v2`, introduced only when a second
generation is needed.

## The one thing that is not optional

Whatever posture we take, **a verb's output needs a convention**, because
nothing enforces one. The cheapest version: treat a change to what a verb
hands back exactly like a rename, and give it a new verb name. That costs
nothing to adopt and is the only protection available until outputs are
recorded in the shape.
