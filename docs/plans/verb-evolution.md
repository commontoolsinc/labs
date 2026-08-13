# Designing verbs so they can change

This document records how verbs are designed so that changing them later is
possible: what a verb promises, what an author may change about one, what a
holder of a piece writes down, and what the tooling does about it. It is
written for the whole team, not only pattern authors — the argument avoids
shorthand so a reader outside this part of the system can still check it.

## The vocabulary, briefly

A **pattern** is a program someone writes. A **piece** is a running copy of
that pattern that holds real data — a specific notebook, a specific board.

A **verb** is a named action a pattern offers to the outside world: `addItem`,
`setLabel`, `archive`. Verbs are not the only way in — a caller with write
permission can also set a piece's fields directly, as the UI's editing
controls, `cf piece set`, and the filesystem mount all do. A piece's
interface is its fields and its verbs together, the way an object's interface
is its public fields and its methods. This document is about the verb half,
where the design questions are; fields go through the same update gate, and
the accept-more and provide-more rules below are field rules.

The **shape** of a pattern is the runtime's record of what it accepts, what
it provides, and which of its fields are verbs. A build step — the
**transformer** — derives it automatically from the TypeScript types the
author wrote.

Patterns are **updated in place**: new code is pushed onto pieces that
already exist and already hold data, and it has to keep working for
everything that was already talking to the old code.

## The problem

When a pattern is updated, the runtime compares the old shape to the new one
and **refuses the update** if the new shape would break something relying on
the old one. Two rules drive that comparison, in opposite directions:

- What a pattern **accepts**, it may accept more of, never less. Accepting
  less breaks whoever was sending the thing you dropped.
- What a pattern **provides**, it may provide more of, never less. Providing
  less breaks whoever was reading the thing you dropped.

Sound in principle. Measured against the current runtime — not inferred —
here is what it does to a verb's author:

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

Three rows are bad outcomes, and they pull in different directions.

**Ordinary changes are refused.** If a board keeps a list of notes and you
add one new action to notes, updating the board is refused outright:

```
argument.notes[].append: newly required argument field has no default
```

Nothing is wrong with that change — it adds an action and takes nothing
away. It is refused because of how verbs are declared, not because of what
the change does.

**Some genuinely breaking changes pass.** Adding a newly required field to a
verb's input passes the check, then fails every existing caller the moment
they call. A straightforward defect — the one place the two rules above get
applied the wrong way round — filed with its fix decided ([#5663]), and
listed here because it shapes how much the gate can be trusted while open.

**A verb's output is not checked at all.** The shape records a verb's input
and discards its output, so renaming a field of what a verb hands back
passes every check and breaks callers silently. This is a deliberate
deferral: recording outputs now would commit to a format that
**Fabric-types** — the planned design stream that gives verbs declared,
checkable result types in the shape — is expected to replace. Until it
lands, output changes are governed by convention alone.

The same gate also governs the *holder* — what a pattern may change about
what it demands from the pieces it stores — and there is the fourth bad
outcome:

| Change a holder makes to its own demand | Result |
| --- | --- |
| Demand a new optional field or verb | allowed |
| Demand a new required field that carries a default | allowed |
| Demand a new **required verb** | **refused** |
| Stop demanding a field or verb it no longer uses | **refused** |

Both refusals come from `packages/piece/src/schema-compatibility.ts`.
Dropping a named field is rejected as `existing argument field was removed`
— the gate has no notion of narrowing, so giving up a demand looks exactly
like breaking one. Raising one hits `newly required argument field has no
default`, and a verb is a stream, which cannot carry a default: the refusal
above, arriving from the other direction.

Stated plainly, because much of the design rests on it: **a deployed
holder's required demands are write-once.** They cannot be added to and
cannot be given up; only optional demands can evolve, and only by growing.
(The provider side is looser on purpose: a pattern may add a newly required
field to its own *result*, because the new code materializes it when it
runs. A demand has no such escape — the piece it points at already exists.)

Behind all four outcomes is the fact that makes this hard: **pieces
persist.** Each carries the interface it was created with while the code
around it moves on. Sooner or later some caller holds a piece older than the
interface it wants, and no declaration style makes that impossible.

The callers are not alike, and the difference matters throughout:

- **Probing callers** — the CLI, the UI, an agent — ask a piece what it has
  before acting. They bind late; a missing verb costs a listing lookup, not
  a crash. (True only while listings tell the truth: [#5662], open, has the
  CLI listing data fields as callable and dropping calls on them silently.)
- **Compiled callers** — TypeScript in one pattern calling a verb on another
  piece — bind when the code is written. They are what an interface promise
  exists for.
- **Stored references** — a board holding a list of notes — are bindings
  that persist: what a pattern demands of the pieces it stores is written
  into its own shape and outlives everyone's code. The hardest case, and
  where the refusal above comes from.

## What a solution must satisfy

Six requirements, each load-bearing in the design that follows.

1. **Serve both populations, without charging both the same price.** Most
   patterns are one-offs — somebody worked with a model for an afternoon and
   now has a thing. That author will never read a compatibility rule, so the
   default rules must be applied by tooling rather than learned. Some
   patterns are long-lived and shared, depended on by people the author has
   never met; the complete machinery must exist for them. One substrate
   serves both: the deliberate path adds to the simple one, never
   contradicts it.

2. **Prefer the simple rule to the precise one.** Most code around these
   patterns is written by models, including inexpensive ones, and an
   elaborate rule is one more thing to get subtly wrong while nobody is
   watching.

3. **Keep the interface a promise.** Code that holds an object leans on its
   interface without checking. Take that away and every caller turns
   defensive — if this method exists use it, otherwise try that one,
   otherwise fall back. Agents can cope with such code; people maintaining
   it are miserable.

4. **Put the uncertainty in one place.** Old pieces make uncertainty
   unavoidable, but it can be placed. The livable designs concentrate it at
   the moment a caller first takes hold of a piece — establish what it is
   holding once, rely on a guarantee from then on. The miserable designs
   spread it across every call site.

5. **Hold across authors.** Patterns by one party will depend on contracts
   offered by another's, and those contracts must be clear, reliable, and
   enforceable. If a stranger can break the shape your mechanism depends on,
   the rational move is to fork — forfeiting exactly the composition the
   substrate exists for.

6. **Reach what is already deployed.** The pieces and holders that exist
   today are the ones with real data. A design reachable only by patterns
   not yet written has to say how the installed base gets there.

## The design

### Verbs are promises, and names are permanent

A verb is declared as something a piece definitely has, not something it may
have. Code that holds a piece and calls a verb holds a guarantee, and does
not check first.

Names never change: a verb is never removed and never renamed. That refusal
is the one rule in today's gate genuinely protecting callers, and it stays.
Retiring a verb means adding its replacement and marking the old one
`@deprecated`, which hides it from listings while keeping it callable. A
verb whose contract must change incompatibly gets a new name, spelled
`append_v2`, introduced when the second generation actually appears.

Retirement currently ends there — a deprecated verb stays callable forever,
implementation and all. Actually removing one is a deliberate break, taken
when usage data says nobody calls it, and needs the scoped acknowledgment
and call counting described under tooling. Until both exist, accumulation is
the price of permanence.

This is the floor. Everything below stands on it.

### A holder demands only what it uses

When one pattern stores another, it writes down what it *uses*, not what the
other pattern *is*: the fields it reads or writes, the verbs it calls, the
reference itself. A board that keeps notes but never appends to them does
not mention `append`.

The refusal that motivated this document then disappears at its root. Adding
`append` to notes no longer changes the board's shape, because the board
never demanded `append`. Nobody's promise weakens: a holder that *does* call
a verb declares it, and holds a guarantee for exactly what it declared.

The principle is old — declare what you need, not what they are — and it is
how Go interfaces work: declared by the consumer, satisfied by shape, best
kept tiny. TypeScript already types pattern code structurally at compile
time; the difference is that a demand is durable, written into the holder's
shape and proved again at link time against a provider that evolves
independently. The runtime already proves that a stored link satisfies the
shape its holder demands. What is new is that holder-side types are
*demands*, written that way on purpose, and that the tooling says so.

Two honest costs. An author now writes two kinds of type — a pattern's own
full truth, and its demands on others — and a demand is a real contract that
must stay as small as it claims. And shape carries no meaning: a demand can
say "has a verb named `append` taking text," never "and `append` means what
I think it does." Small demands keep that gap harmless; closing it properly
is what names and versions are for.

### Named, versioned interfaces are where this goes

An interface gets a name and a version of its own, separate from any one
pattern: "Notes, version 2" is a first-class thing, patterns declare which
interfaces they provide, and consumers declare the minimum version they
accept. Binding checks once; after that the caller holds a guarantee.

This is what satisfies the across-authors requirement, and why it is
scheduled rather than left in the distance: a name and a version are what
let one author rely on another author's contract and know when it has moved.
Without them, the honest advice to somebody building on a pattern they do
not own is to fork it.

It is also the most machinery of anything here — an identity, a registry, a
compatibility rule of its own, a place in the shape — and Fabric-types is
the natural vehicle. It is a design stream of its own (see
[the longer arc](#the-longer-arc)), with everything else in this document
standing as the interim until it lands.

### A maybe is resolved once, at binding

A published interface may carry optional members, because a piece deployed
under an earlier generation genuinely lacks the later generation's verbs.
Absence there is a fact about the piece, not a hedge — an interface handed
to consumers covers every generation still running, even where the pattern's
own declaration marks the member required.

What an optional member does not license is a maybe at every call site. A
caller resolves it **once, when it takes hold of the piece** — into a real
fallback or a real failure — and holds a promise from then on:

```tsx
// Shown at module scope.
declare const activityLog: { logEvent?: Stream<{ text: string }> };

// Never this: when the verb is absent, nothing happens and nothing says so.
activityLog.logEvent?.send({ text: "started" });

// Resolve once, into a guarantee or a failure someone can act on.
const logEvent = activityLog.logEvent;
if (logEvent === undefined) {
  throw new Error("activity log predates logEvent; Notes v2 required");
}
logEvent.send({ text: "started" });
```

The first form is the tempting rewrite and the one to refuse: it does not
resolve the maybe, it defers it to every call site, and it fails silently —
no error, no log, no signal; in a test, a real failure becomes a pass. The
second turns absence into something a person can act on. A real fallback —
another way to get the work done — resolves it just as well; what is not
acceptable is nothing.

And when a caller cannot proceed without the member at all, an optional is
the wrong tool. The answer is an interface version the caller requires:
"this needs Notes v2, and the piece provides v1" is a failure someone can
act on; a skipped `send` is not.

### A verb's output changes by getting a new name

Nothing checks outputs, so a convention has to do the work: **a change to
what a verb hands back is treated exactly like a rename, and gets a new verb
name.** Adding to an output is safe; changing or removing anything in one is
not, and no gate catches it. This costs nothing to adopt and is the only
protection available until Fabric-types records outputs in the shape — at
which point the convention is replaced by a check.

### A true break is a redeploy

Some changes are genuinely incompatible, and no declaration discipline makes
them compatible. Those are handled by deploying a new pattern and migrating
the data, not by updating in place. Migration is a good bet to get cheaper —
moving data between shapes is work a model can do, and the useful form is
generated migration logic, not per-piece hand-holding — but it stays the
exception. The default is to stay compatible, because most patterns are
updated by models that will cheerfully jump through hoops to avoid a break,
and because a compatible update keeps the piece's identity.

Identity is the gap to know about. A redeploy mints a **new piece with a new
identity**, and other pieces hold references to the old one — boards hold
notes, topics hold cross-references. Nothing re-points those references;
migrating the data does not move them. There is no forwarding mechanism — no
way for an old identity to hand its callers on to its successor — and
building one has not been scheduled. Until it exists, whoever redeploys a
referenced pattern re-points the references themselves.

## How the design holds up

Cross what a provider might do to its interface against what a holder wrote
down, and read the cells. Five kinds of demand are reachable: embedding the
provider's whole **Output** type (today's default), a narrow demand naming
**fields only**, one naming a **required verb**, one naming an **optional
verb**, and a **versioned** interface demand. Probing callers are omitted —
they bind late and survive every row.

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

"Holder refused" means the gate stops the *holder's* next update: nothing
breaks at runtime, but the holder is stuck. "Breaks at call" means every
gate passes and the failure arrives when someone calls the verb.

Four things fall out of it.

**Every refusal lives in one column.** The whole cost of today's default is
the Full Output column, and both of its refusals are the same event — a
provider adding an action. That is the argument for holder-side demands, and
why the mechanical check belongs where embedding happens.

**Two rows are red everywhere.** Requiring more of a verb's input and
changing a verb's output break every demand shape equally, because neither
is recorded where a gate can see it. The first is the filed defect
([#5663]), the second the naming convention above; until they close, a
holder's care buys nothing on those rows, and versioning does not rescue
them until outputs are in the shape and a provider actually bumps.

**The optional-verb and versioned columns are identical.** So the choice
between them is not about what can evolve but about what a reader can tell.
`BackwardsCompatibleProfile` in `packages/patterns/system/profile-home.tsx`
is the exhibit: a `PartialBy` over the full Output that records its vintages
in a comment, because the type cannot say them, plus a hand-maintained
instruction to add every future stream to the list. The optionality *is* a
version boundary with its name erased; versioning names the vintage, and
moves the maybe from every seam to bind time.

**The columns are not reachable from one another.** A deployed holder cannot
move rightward — every such move hits the write-once wall in the holder
table, and escalating a versioned demand from v1 to v2 is the same event. So
the design is complete for holders that do not exist yet and inert for every
holder already deployed: on its own it fails the reach-what-is-deployed
requirement, which puts scoped acknowledgment and migration on the critical
path for adoption.

## What the tooling does

The rules above are only as good as the number of authors who never have to
learn them. These are the mechanisms that carry them.

### The rule is about embedding, not exporting

A pattern's output type has to be **exported** — TypeScript cannot otherwise
name the factory's return type, which
[composition](../common/patterns/composition.md) requires. Export is not the
vector anyway: the refusal reproduces in a single file with no imports, when
a board stores `NoteOutput[]` declared in the same module.

The enforceable joint is **embedding**: a holder does not put another
pattern's Output type into its own schema; it declares the fields and verbs
it uses, usually a title and a single verb. The transformer already has the
resolved type at every `pattern<I, O>` call, so it can check this where it
happens — including aliases that sound narrow and are not, where a name like
`EventPiece` turns out to be a whole Output. Embedding stays right in one
case: the holder genuinely means "that interface, with those required
verbs." The other reason it happens — the type is large and restating it is
redundant — is practical rather than principled, and worth designing away.

`skills/pattern-critic/SKILL.md` already asks for this direction under
"oversized cross-pattern contracts" (critique-guide category 17): prefer a
consumer-owned minimal structural type over the full pattern schema and over
`Pick`/`Omit` coupling. What a critique cannot do is enforce the rule or
record which demands exist, which is what everything below needs.

### Demands are recorded as demands

Today a holder's demand is indistinguishable from its own state — the
refusal path `argument.notes[].append` *is* the demand subtree, unmarked.
That single gap is why the impact report below cannot count anything, why
the gate treats giving up a demand as a break rather than the safe narrowing
it is, and why a deliberate break can only be acknowledged by turning the
whole gate off. Marking demands is the substrate the rest of the tooling
stands on.

[#5746] prototypes both halves: a `Demand<T>` marker whose stamp rides the
referencing node — a shared definition stays neutral; each use site declares
its own demand-ness — and an advisory warning when a contract embeds a
foreign Output type, with self-reference still legal and `@sharedContract`
opting a genuine protocol type out.

Adopting narrow demands across already-deployed patterns is itself a break,
on both sides: a deployed holder cannot drop the fields it stopped needing
(the holder table above), so the migration needs the scoped acknowledgment
below rather than a quiet edit.

### Authoring time shows the blast radius

Compatibility is discovered today by having an update refused. The same
comparison the gate runs can run before anything deploys — and, because
holders record what they demand, it can report what a change would hit:

```
This update breaks 14 recorded consumer contracts across 6 patterns:
- 9 are owned by you
- 3 appear automatically adaptable
- 2 belong to other authors

Choose: revise the change, generate migrations or adapters, or proceed and
mark affected consumers incompatible.
```

This is what lets nobody classify a pattern's permanence up front: its
dependencies say whether it is a one-off or a load-bearing contract, and the
report is where they say it. Compatibility stays the default; an intentional
break stays possible with impact and recourse visible. Generated migrations
and adapters — applied eagerly, or lazily when a piece is next touched — are
the recourse this grows into.

### A break is acknowledged one at a time

The only override today turns the entire gate off, so accepting one
deliberate break silences every other protection. A break should be
acknowledgeable by name — this field, this verb, this consumer. That
**scoped acknowledgment** is what "proceed and mark affected consumers
incompatible" needs underneath it, what the demand migration above rides on,
and what eventually lets a dead verb be removed rather than hidden.

### Verb calls are counted

Retirement policy is guesswork without usage data; deprecation windows work
in other systems because usage is observable. The planned invocation-record
work is the natural place for this to ride, and the blast-radius report is
far more useful when it can say which contracts are live.

## The longer arc

The pressure behind this document does not go away: pieces live a long time,
carry their interface with them, and the code around them keeps changing.
Other systems have faced exactly this and converged on the same small set of
mechanisms — none of them by making the interface uncertain. They kept the
promise, versioned it, and built machinery for old and new to live side by
side. Four mechanisms recur; this is an open design stream.

**1. Interfaces carry versions, and consumers name the minimum they
accept.** COM froze every published interface: you never changed `IFoo`, you
published `IFoo2`, an object implemented both, and a caller asked once. OSGi
imports at "version 1.2 or newer"; Kubernetes serves several API versions at
once. Fabric-types is where a declared version would ride here.

**2. Compatibility has declared boundaries, and breaking one is a
decision.** Semantic versioning is the everyday form — a break is a major
version, chosen on purpose, never a side effect of an edit. Avro checks
compatibility pairwise, structurally what our update gate does; the
difference is that Avro's rules are a published contract authors design
against, while ours are discovered at refusal time.

**3. Upgrades are per-piece, and every piece has an upgrade policy.** Erlang
runs at most two versions of a module and migrates each process
individually; Orleans routes each call to a host compatible with that
actor's version; upgradeable smart contracts record who may upgrade as
state. We ran the unmanaged experiment ourselves: a board update left old
and new pattern versions writing to the same space, and the write storm
measured 96% of all commits there. Coexistence without management is a
failure mode we have met, not a hypothesis.

**4. Upgrades can run code.** Sooner or later a new shape needs data the old
shape did not store. Erlang gives every process a state-transform callback;
Common Lisp's object system migrates each instance lazily, when next
touched; Rails migrations and event-sourcing upcasters are the same idea for
databases and logs. The recurring fork is eager against lazy, and systems
with many small stateful things mostly chose lazy.

Two of the rules above were derived by measurement against our own runtime
and turned out to be classical results: "a published interface only grows"
is COM's frozen interfaces and protobuf's permanent field numbers, and "a
newly required input breaks callers" is so well established that proto3
removed `required` from the language. The rest of this map is worth reading
before we draw more of it ourselves.

## Considered and set aside

**All verbs optional, as the default.** Declaring every verb as something a
piece may have buys the most evolution for the least machinery — adding a
verb is then always allowed, anywhere. It is set aside because it moves the
maybe into every call site, permanently, failing the promise requirement: an
interface whose every member is optional is not a contract but a suggestion.
Every system in the longer arc bought the same evolution while keeping the
promise. The measurements are kept because they locate who depends on verb
declarations:

- **8 call sites** in shipped pattern code read a verb off another piece,
  across four files.
- **396 call sites across 50 test files** do the same, every one of the form
  `instance.verb.send(...)` — the documented way to test a pattern.

Optional verbs turn each of those into a possibly-absent value, and the
obvious rewrite, `instance.verb?.send(...)`, does nothing at all when the
verb is absent. Whether the compiler would even catch a missed rewrite is
unestablished: pattern `*.test.tsx` files are excluded from `deno task test`
in `packages/patterns` and run through the `cf` binary instead.

Optional members survive where absence is a real state — a generation that
lacks a verb, a capability present by configuration — resolved once at
binding. They are not an evolution device.

**Versioning every verb from day one.** Spelling the first generation
`append_v1` taxes every verb forever to serve the few that ever need a
second generation. The suffix appears when the second generation does.

## What is not settled here

One question is open by design, and it is the one the cross product exposes:
**how a deployed holder moves.** Narrow demands, required-verb demands and
versioned demands are all reachable when a holder is written and none of
them afterwards, so every adoption path runs through a scoped acknowledgment
or a migration that rewrites holders. Which carries it — and whether the
gate should learn that removal beneath a demand marker is narrowing rather
than breakage — decides how much of this design applies to what is already
running.

One mechanism is missing and unscheduled: **reference forwarding.** A true
break mints a new piece identity, and nothing re-points stored references to
the successor; until something does, a redeploy means re-pointing them by
hand.

Three smaller calls belong to whoever does the work:

- Whether the embedding rule warns, lints, or fails, and in what order those
  arrive; [#5746] starts at advisory on purpose.
- How wide the baseline reset has to be once narrow demands land (the
  recorded shapes under `packages/patterns/baselines/` that updates are
  checked against), and how it is sequenced against the append-only
  baselines gate.
- Whether an interim output check is possible before Fabric-types, given
  that the shape discards verb outputs today.

[#5662]: https://github.com/commontoolsinc/labs/issues/5662
[#5663]: https://github.com/commontoolsinc/labs/issues/5663
[#5746]: https://github.com/commontoolsinc/labs/pull/5746
