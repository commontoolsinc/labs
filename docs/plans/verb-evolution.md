# Designing verbs so they can change

This document records how verbs are designed so that changing them later is
possible: what a verb promises, what an author may change about one, what a
holder of a piece has to write down, and what the tooling does about it.

Two audiences share it. Pattern authors need the rules. Everybody else needs
the argument to be checkable, so it starts from first principles and avoids
shorthand.

## The vocabulary, briefly

A **pattern** is a program someone writes. A **piece** is a running copy of
that pattern that holds real data — a specific notebook, a specific board.

A **verb** is a named action a pattern offers to the outside world: `addItem`,
`setLabel`, `archive`. Verbs are not the only way in: a caller with write
permission can also set a piece's fields directly — the UI's editing controls
do exactly that, and so do `cf piece set` and the filesystem mount. A piece's
interface is its fields and its verbs together, the same way an object's
interface is its public fields and its methods.

This document is about the verb half, because that is where the design
questions are. The field half is governed by the same update gate — its
accept-more/provide-more rules below are field rules — and a writable field is
the tightest contract of the lot, because it is promised in both directions at
once: writers rely on what it accepts, readers on what it holds.

The runtime writes down the **shape** of every pattern automatically, from the
TypeScript types the author wrote. The shape records what a pattern accepts,
what it provides, and which of its fields are verbs.

Patterns are **updated in place**. You push new code onto pieces that already
exist and already hold data. That is the whole source of the problem: the new
code has to keep working for everything that was already talking to the old
code.

## Two kinds of pattern

Two populations share this runtime, and the rules have to serve both without
charging both the same price.

Most patterns are **one-offs**. Somebody wanted a thing, worked with a model
for an afternoon, and now has it. That author will not read a compatibility
rule, and will not be around to debug a refused update six months later. For
these, the right rule is the one nobody has to learn — applied by the
transformer and the authoring tools, so the ordinary way to write a pattern is
already the compatible way.

Some patterns are **long-lived and shared**: made deliberately, depended on by
people the author has never met, expected to keep working for years. Their
authors are motivated to get it right and will spend time on it. For these,
the right rule is the complete one — named interfaces, declared versions,
explicit compatibility boundaries — and those tools have to exist even though
most patterns never reach for them.

The two are served by one substrate, not two systems. The default path is the
simple one; the deliberate path adds machinery on top of it and never
contradicts it.

That ordering carries a constraint worth stating plainly: **prefer the simple
rule to the precise one.** Most of the code around these patterns is written
by models, including inexpensive ones, and an elaborate rule is one more thing
to get subtly wrong at a moment when nobody is watching. A rule that is
slightly less precise and considerably easier to follow is the better rule
here.

## The problem this answers

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
This one is a straightforward defect, filed with its fix decided
([#5663](https://github.com/commontoolsinc/labs/issues/5663)); it is listed
here because it shapes how much the gate can be trusted while it is open.

So the gate refuses changes that are safe, and permits at least one that is
not. Pattern authors will learn to work around it either way. The design below
settles what they should be working around.

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
that is not going to change — it is the one rule genuinely protecting callers.

**A verb's output is completely unprotected.** The shape the runtime writes
down records a verb's input and discards its output. Renaming a field of what
a verb hands back passes every check and breaks callers silently. This is a
deliberate deferral — recording outputs would commit us to a format that the
planned Fabric-types work is expected to replace — and it means output changes
are governed by convention alone.

The same gate governs what a *holder* may change about what it demands, and
there the rules are considerably tighter than they look:

| Change a holder makes to its own demand | Result |
| --- | --- |
| Demand a new optional field or verb | allowed |
| Demand a new required field that carries a default | allowed |
| Demand a new **required verb** | **refused** |
| Stop demanding a field or verb it no longer uses | **refused** |

Both refusals come from `packages/piece/src/schema-compatibility.ts`. Dropping
a named field is rejected outright as `existing argument field was removed` —
the gate has no notion of narrowing, so giving up a demand looks exactly like
breaking one. Raising a demand hits `newly required argument field has no
default`, and a verb is a stream, which cannot carry a default; that message is
the very refusal this document opens with, arriving from the other direction.

The consequence is worth stating plainly, because most of the design rests on
it: **a deployed holder's required demands are write-once.** They cannot be
added to and cannot be given up. Only optional demands can evolve at all, and
only by growing.

Note the asymmetry with the provider side, which is deliberate and correct: a
pattern may add a newly required field to its own *result*, because the new
graph materializes it when it runs. Nobody is left holding a gap. A demand has
no such escape, because the piece it points at already exists.

## What a piece promises

In ordinary object-oriented programming, an object promises an interface:
these fields, these methods. Code that holds the object leans on that promise
without checking. Take the promise away and every caller turns defensive — if
this method exists use it, otherwise try that one, otherwise fall back. Agents
can cope with code like that. People maintaining it are miserable.

The promise is worth keeping. What makes keeping it hard here is that pieces
are persistent: each one carries the interface it was created with, and keeps
it while the code around it moves on. Sooner or later some caller holds a
piece older than the interface it wants, and no declaration style makes that
impossible.

So the uncertainty cannot be removed — but it can be **placed**. The livable
designs concentrate it at one moment: when a caller first takes hold of a
piece, it establishes what it is holding, and relies on a guaranteed interface
from then on. The miserable designs spread it across every call. That standard
decides most of what follows.

Who is doing the calling matters too, because the callers are not alike:

- **Probing callers** — the CLI, the UI, an agent — ask a piece what it has
  before acting. They bind late, so a missing verb costs them a listing
  lookup, not a crash. Flexibility is cheap here.
- **Compiled callers** — TypeScript in one pattern calling a verb on another
  piece — bind when the code is written. They are exactly what the interface
  promise exists for.
- **Stored references** — a board holding a list of notes — are bindings
  that persist. What a pattern demands of the pieces it stores is written into
  its own shape and outlives everyone's code. These are the hardest case, and
  they are where today's refusal comes from.

## The design

### Verbs are promises, and names are permanent

A verb is declared as something a piece definitely has, not something it may
have. Code that holds a piece and calls a verb holds a guarantee, and does not
check first.

Names never change. A verb is never removed and never renamed. Retiring one
means adding its replacement and marking the old one `@deprecated`, which
hides it from listings while keeping it callable. A verb whose contract must
change incompatibly gets a new name, spelled `append_v2`, introduced when the
second generation actually appears rather than reserved on day one.

This is the floor. Everything below stands on it.

### A holder demands only what it uses

When one pattern stores another, it writes down what it *uses*, not what the
other pattern *is*: the fields it reads or writes, the verbs it calls, and the
reference itself. A board that keeps notes but never appends to them does not
mention `append`.

The refusal that motivated this document then disappears at its root. Adding
`append` to notes no longer changes the board's shape, because the board never
demanded `append`. Nobody's promise weakens: a holder that *does* call a verb
declares it, and holds a guarantee for exactly what it declared.

The principle is old — declare what you need, not what they are. It is how Go
interfaces work: declared by the consumer, satisfied by shape, and best kept
tiny ("the bigger the interface, the weaker the abstraction"). Pattern code
already lives this way at compile time, because TypeScript types structurally;
this extends the same discipline to the stored contract. The difference from
Go is that a demand here is durable — written into the holder's shape and
proved again at link time, against a provider that evolves independently.

Most of the machinery already exists: the runtime already proves that a stored
link satisfies the shape its holder demands, and shared narrow projections — a
board-facing view of a topic — are already in use across patterns. What is new
is that holder-side types are *demands*, written that way on purpose, and that
the tooling says so.

The cost is that an author writes two kinds of type: a pattern's own full
truth, and its demands on others. A demand is a real contract and has to stay
as small as it claims.

One limit to know about: shape carries no meaning. A demand can say "has a
verb named `append` taking text"; it cannot say "and `append` means what I
think it does". Small demands keep that gap harmless, the same way small Go
interfaces do. Closing it properly is what names and versions are for.

### Named, versioned interfaces are where this goes

An interface gets a name and a version of its own, separate from any one
pattern: "Notes, version 2" is a first-class thing, patterns declare which
interfaces they provide, and consumers declare the minimum version they
accept. Binding checks once; after that the caller holds a guarantee.

This is the mechanism that survives contact with **patterns owned by different
people**, and that is why it is scheduled rather than left in the distance.
Holder-side demands answer the shape question, and shape carries no meaning; a
name and a version are what let one author rely on another author's contract
and know when it has moved. Without it, the honest advice to somebody building
on a pattern they do not own is to fork it, which forfeits the substrate.

It is also the most machinery of anything here: an interface needs an
identity, a registry, a compatibility rule of its own, and a place to live in
the shape. The planned Fabric-types work is the natural vehicle. This is a
design stream of its own — see [the longer arc](#the-longer-arc) — and it is
open, with everything else in this document standing as the interim until it
lands.

### A maybe is resolved once, at binding

A published interface may carry optional members, because a piece deployed
under an earlier generation genuinely does not have the later generation's
verbs. Absence there is a fact about the piece, not a hedge — and an interface
that is handed to consumers has to cover every generation still running,
including where the pattern's own declaration marks the member required.

What an optional member does not license is a maybe at every call site. A
caller resolves it **once, when it takes hold of the piece**, into a real
fallback or a real failure, and holds a promise from then on:

```tsx
// Shown at module scope.
declare const activityLog: { logEvent?: Stream<{ text: string }> };

// Resolve once. Every later call site holds a guarantee.
const logEvent = activityLog.logEvent;
if (logEvent !== undefined) logEvent.send({ text: "started" });

// Never this. When the verb is absent, nothing happens and nothing says so.
activityLog.logEvent?.send({ text: "started" });
```

The second form is the tempting rewrite and the one to refuse. It is not the
resolution of a maybe, it is the deferral of one, and it fails silently: no
error, no log, no signal. In a test, a real failure becomes a pass.

And when a caller cannot proceed without the member at all, an optional is the
wrong tool. The answer is a new interface version, and a caller that declares
it requires that version. "This needs Notes v2, and the piece provides v1" is
a failure someone can act on; a skipped `send` is not.

### A verb's output changes by getting a new name

Nothing checks outputs, so the convention has to do the work: **a change to
what a verb hands back is treated exactly like a rename, and gets a new verb
name.** Adding to an output is safe; changing or removing anything in one is
not, and there is no gate to catch it.

This costs nothing to adopt and is the only protection available until outputs
are recorded in the shape. Recording them is Fabric-types' job, and when it
lands the convention is replaced by a check rather than supplemented by one.

### A true break is a redeploy

Some changes are genuinely incompatible, and no declaration discipline makes
them compatible. Those are handled by deploying a new pattern and migrating
the data, rather than by updating in place.

Migration is a good bet to get cheaper: migrating data from an old shape to a
new one is work a model can do, and the useful form of that is generated
migration logic rather than per-piece hand-holding. It is still the exception,
not the path. The default is to stay compatible, because most patterns are
updated by models that will cheerfully jump through hoops to avoid a break,
and because a compatible update keeps the piece's identity.

That last part is the gap to know about. A redeploy mints a **new piece with a
new identity**, and other pieces hold references to the old one — boards hold
notes, topics hold cross-references. Those stored references keep pointing at
the old piece, and nothing re-points them; migrating the data does not move
the references. Anyone redeploying a pattern whose pieces are referenced
elsewhere has to re-point those references themselves. There is no general
forwarding mechanism — no way for an old identity to hand its callers on to
its successor — and building one has not been scheduled.

## How the design holds up

The way to evaluate any of this is to cross what a provider might do to its
interface against what a holder wrote down, and read the cells. Five kinds of
demand are reachable: embedding the provider's whole **Output** type (today's
default), a narrow demand naming **fields only**, a narrow demand naming a
**required verb**, one naming an **optional verb**, and a **versioned**
interface demand. Probing callers are omitted because they bind late and
survive every row.

| Provider evolution | Full Output | Fields only | Req. verb | Opt. verb | Versioned |
| --- | --- | --- | --- | --- | --- |
| Add a verb | **holder refused** | ok | ok | ok | ok |
| Add an optional field | ok | ok | ok | ok | ok |
| Add a required field carrying a default | ok | ok | ok | ok | ok |
| Widen a verb's input with an optional field | ok | ok | ok | ok | ok |
| Require more of a verb's input | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** |
| Change a verb's output | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** | **breaks at call** |
| Rename or remove a verb | provider refused | provider refused | provider refused | provider refused | provider refused |
| Retire: add the replacement, deprecate the old | **holder refused** | ok | ok | ok | ok |

"Holder refused" means the gate stops the *holder's* next update, so nothing
breaks at runtime but the holder is stuck. "Breaks at call" means every gate
passes and the failure arrives when someone calls the verb.

Four things fall out of it.

**Every refusal lives in one column.** The whole cost of today's default is the
Full Output column, and both of its refusals are the same event — a provider
adding an action. That is the argument for holder-side demands in one column,
and it is why the mechanical check belongs where embedding happens.

**Two rows are red everywhere.** Requiring more of a verb's input and changing
a verb's output break every demand shape equally, because neither is recorded
where a gate can see it. No declaration discipline helps: the first is a filed
defect ([#5663](https://github.com/commontoolsinc/labs/issues/5663)) and the
second is the naming convention above, and until they are closed a holder's
care buys nothing on those two rows. Versioning does not rescue them either
until outputs are in the shape and a provider actually bumps.

**The optional-verb and versioned columns are identical.** Every cell agrees,
which says the choice between them is not about what can evolve — it is about
what a reader can tell. `BackwardsCompatibleProfile` in
`packages/patterns/system/profile-home.tsx` is the exhibit: a `PartialBy` over
the full Output that records its vintages in a comment ("setBio/addPiece
2026-06-17, toggleEditing 2026-06-16") because the type cannot say them, and
carries a hand-maintained instruction to add every future stream to the list.
The optionality *is* a version boundary with its name erased. Versioning names
the vintage, and moves the maybe from every seam to bind time.

**The columns are not reachable from one another.** This is the finding that
changes what happens next. A deployed holder cannot move rightward: it cannot
add a required verb demand, because that is a newly required field with no
default, and it cannot drop what it no longer needs, because removal reads as a
break. Escalating a versioned demand from v1 to v2 hits the identical wall. So
the design is complete for holders that do not exist yet, and inert for every
holder already deployed — which puts scoped acknowledgment and migration on
the critical path for adoption rather than in the nice-to-have pile.

## What the tooling does

The rules above are only as good as the number of authors who never have to
learn them. These are the mechanisms that carry them.

### The rule is about embedding, not exporting

A pattern's output type has to be **exported**: TypeScript cannot otherwise
name the factory's return type, which
[composition](../common/patterns/composition.md) requires and most shipped
patterns do. Export is not the vector either — the refusal reproduces inside a
single file with no import anywhere in it, when a board stores `NoteOutput[]`
declared in the same module.

The enforceable joint is **embedding**: a holder does not put another pattern's
Output type into its own schema. It declares the fields and verbs it uses,
which is usually a title and a single verb. The transformer already has the
resolved type at every `pattern<I, O>` call, so it can check this where it
happens — including the aliases that sound narrow and are not, where a name
like `EventPiece` turns out to be a whole Output.

Embedding the provider's type stays right in one legitimate case: the holder
genuinely means "that interface, with those required verbs". The other reason
it happens — the type is large and restating it is redundant — is practical
rather than principled, and it is the case worth designing away.

`skills/pattern-critic/SKILL.md` already asks for this direction under
"oversized cross-pattern contracts" (critique-guide category 17): prefer a
consumer-owned minimal structural type over the full pattern schema and over
`Pick`/`Omit` coupling. What a critique cannot do is enforce the rule or record
which demands exist, which is what everything below needs.

### Demands are recorded as demands

Today a holder's demand is indistinguishable from its own state: the refusal
path `argument.notes[].append` *is* the demand subtree, unmarked. That single
gap is why the impact report below cannot count anything, why the gate treats
giving up a demand as a break rather than the safe narrowing it is, and why a
deliberate break can only be acknowledged by turning the whole gate off.

Marking demands is therefore the substrate the rest of the tooling stands on,
not a nicety.
[#5746](https://github.com/commontoolsinc/labs/pull/5746) prototypes both
halves — a `Demand<T>` marker whose stamp rides the referencing node so a
shared definition stays neutral and each use site declares its own
demand-ness, and an advisory warning when a contract embeds a foreign Output
type, with self-reference still legal and `@sharedContract` opting a genuine
protocol type out.

Adopting narrow demands across already-deployed patterns is itself a break,
and on both sides: a deployed holder cannot drop the fields it stopped needing
(see the holder table above), so the migration needs the scoped acknowledgment
below rather than a quiet edit.

### Authoring time shows the blast radius

Compatibility is discovered today by having an update refused. The same
comparison the gate runs can run before anything deploys, over two versions of
a pattern — and, because holders record what they demand, it can go further
than pass or fail and report what a change would actually hit:

```
This update breaks 14 recorded consumer contracts across 6 patterns:
- 9 are owned by you
- 3 appear automatically adaptable
- 2 belong to other authors

Choose: revise the change, generate migrations or adapters, or proceed and
mark affected consumers incompatible.
```

This is the shape that lets nobody classify a pattern's permanence up front.
An author does not declare whether a pattern is a one-off or a long-lived
contract; its dependencies say so, and the report is where they say it.
Compatibility stays the default, and an intentional break stays possible with
its impact and its recourse both visible. Generated migrations and adapters —
applied eagerly, or lazily when a piece is next touched — are the recourse
this grows into.

### A break is acknowledged one at a time

The only override today turns the entire gate off at once, which makes
accepting one deliberate break silence every other protection. A break should
be acknowledgeable by name — this field, this verb — which is also what
"proceed and mark affected consumers incompatible" needs underneath it.

### Verb calls are counted

Retirement policy is guesswork without usage data; deprecation windows work in
other systems because usage is observable. The planned invocation-record work
is the natural place for this to ride, and the blast-radius report is a good
deal more useful when it can say which of those contracts is live.

## The longer arc

The pressure behind this document does not go away: pieces live a long time,
they carry their interface with them, and the code around them keeps changing.
Other systems have faced exactly this — long-lived stateful things, evolving
interfaces, no way to update everything at once — and they converged on the
same small set of mechanisms. None of them solved it by making the interface
uncertain. They kept the promise, versioned it, and built machinery for old
and new to live side by side.

This is an open design stream, and four mechanisms recur in it:

**1. Interfaces carry versions, and consumers name the minimum they accept.**
COM froze every published interface permanently: you never changed `IFoo`, you
published `IFoo2`, and an object implemented both. A caller asked once — "do
you support `IFoo2`?" — and held a guaranteed interface from then on. OSGi
modules import each other at "version 1.2 or newer". Kubernetes serves the
same API at several versions at the same time. The planned Fabric-types shape
for verbs is the natural place a declared version would ride.

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
each piece when next touched); systems with many small stateful things mostly
chose lazy.

Two of the rules recorded above were derived by measurement against our own
runtime and then turned out to be classical results — which suggests the rest
of this map is worth reading before we draw more of it ourselves. "A published
interface only grows" is COM's frozen interfaces and protobuf's permanent
field numbers. "A newly required input breaks callers" is so well established
that proto3 removed the `required` keyword from the language entirely.

## Considered and set aside

**All verbs optional, as the default.** Declaring every verb as something a
piece may have buys the most evolution for the least machinery: adding a verb
is then always allowed, anywhere, including on types other patterns store. It
is set aside because it moves the maybe into every call site, permanently. An
interface whose every member is optional is not a contract, it is a
suggestion, and code consuming a suggestion turns defensive. Every system in
the longer arc bought the same evolution while keeping the promise.

The measurements are kept because they locate who depends on verb
declarations:

- **8 call sites** in shipped pattern code read a verb off another piece,
  across four files.
- **396 call sites across 50 test files** do the same, every one of the form
  `instance.verb.send(...)` — the documented way to test a pattern.

Making verbs optional turns each of those into a possibly-absent value, and
the obvious rewrite, `instance.verb?.send(...)`, does nothing at all when the
verb is absent. Whether the compiler would even catch a missed rewrite is
unestablished: pattern `*.test.tsx` files are excluded from `deno task test`
in `packages/patterns` and run through the `cf` binary instead. This is the
measurement behind the call-site rule above.

Optional members survive where absence is a real state — a generation that
lacks a verb, or a capability present by configuration — resolved once at
binding. What they are not is an evolution device applied across the board.

**Versioning every verb from day one.** Spelling the first generation
`append_v1` is uniform, and it taxes every verb forever to serve the few that
ever need a second generation. A version suffix appears when the second
generation does.

## What is not settled here

One question is open by design, and it is the one the cross product exposes:
**how a deployed holder moves.** Narrow demands, required-verb demands and
versioned demands are all reachable when a holder is written and none of them
are reachable afterwards, so every adoption path runs through either a scoped
acknowledgment or a migration that rewrites holders. Which of those carries it
— and whether the gate should learn that removal beneath a demand marker is
narrowing rather than breakage — decides how much of this design applies to
what is already running.

Three smaller calls belong to whoever does the work:

- Whether the embedding rule warns, lints, or fails, and in what order those
  arrive; [#5746](https://github.com/commontoolsinc/labs/pull/5746) starts at
  advisory on purpose.
- How wide the baseline reset has to be once narrow demands land, and how it
  is sequenced against the append-only baselines gate.
- Whether an interim output check is possible before Fabric-types, given that
  the shape discards verb outputs today.
