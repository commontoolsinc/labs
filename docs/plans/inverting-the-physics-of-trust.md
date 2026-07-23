# Common Fabric: Inverting the Physics of Trust

The runtime, and why it is shaped the way it is.

## TL;DR

All networked software runs on a trust model improvised in the
mid-nineties: data lives with the code that collected it, so you must
trust the software with your data. The industry has been patching around
that decision ever since with a handful of jury-rigged solutions: terms
of service, permission dialogs, silos. The patches held because software
was expensive to make, and its makers were few, with reputations at
stake.

AI ends both conditions at once. Software becomes infinite (anyone can
produce it by asking), so the old gate, trusting the reputation of the
maker, stops scaling. And all text becomes executable: an agent reading
your email treats any sentence in it as potential instructions, which is
why prompt injection is a property, not a bug. Every ceiling the
industry is hitting with agents right now (injection, permission
fatigue, agents that cannot be given real access to anything that
matters) is the same ceiling: sensitive data, untrusted input, and
network access cannot safely coexist under the current rules.

The fabric is a runtime built on the opposite rule: the software is
untrusted, and safety attaches to the data.

1. Every datum carries cryptographically verified provenance (who and
   what created it) and policies (where it may go, who may use it for
   what). Both travel with every copy, and anything derived from the
   datum inherits its policies.

2. Contextual Flow Control is type checking for privacy policies: if the
   software compiles, it by construction has no data flows that violate
   the policies. So a stranger's code, or code a model generated a
   second ago, can safely touch your most sensitive data.

3. Remote attestation lets any machine prove, bit for bit, that it is
   running the open-source runtime, in memory its own operator cannot
   read. Nodes refuse peers that cannot prove it, and a trusted mesh
   emerges from machines nobody trusts individually: your data may flow
   anywhere that can prove itself, and nowhere else. Identity is a
   keypair, not an account.

Concretely: the fabric's Gmail importer is ordinary code a stranger
could have written, and the OAuth token that can read all your mail is
protected by a four-line policy attached to the token itself. Any code
can handle it safely, because the danger is fenced by the data, not by
the code's good intentions.

In this repository: the runtime; a compiler that turns ordinary
TypeScript into policy-checkable dataflow graphs; the flow-checking
machinery; the sandboxing; a reactive, multiplayer-by-default storage
layer with keypair identity; roughly two hundred running programs,
including a live demonstration of prompt injection being structurally
contained; an attestation pipeline running on Intel TDX hardware. The
semantics run today, enforcement is hardening from observe toward
strict, and robustness and performance are the current work.

If it works, the potential of infinite software is actually unleashed.
Infinite software will not be infinite apps; it will be one system that
does infinite things. The software melts away, and it feels like your
data coming alive, structurally aligned with your intentions wherever it
flows. Multiplayer, sharing, and offline become substrate defaults
rather than features. Software finds you, instead of being installed.
And shared state can finally accumulate in places no one can hold
hostage.

That is the whole argument. The rest of this document is the same
argument again, slower: the why in full, and then the machine.

## The property nobody designed for

Data is viral. It is approximately free to replicate at perfect
fidelity. As soon
as it is out of your sight, anything could happen to it; once it has
been given to computation you do not control, access to it can never be
revoked. With data, more power means more danger. That is the basic
physics of information, and no computing platform has ever grappled with
it.

The property is not obscure; it is the first thing anyone learns about
information. But in the mid-nineties the same-origin model arrived as a
hotfix, decided by the Netscape team to handle an early JavaScript
security problem: data lives with the site that collected it, and the
site's code decides what happens to it. You must trust the software with
your data. It started as a quick fix, and because it was a reasonable
simplifying policy it hardened until it felt like a law of gravity. Over
time we forgot there was ever anything else we could do. But unlike a
law of gravity, it can be changed. We made it; we can change it.

The original sin of the same-origin model is fusing data to apps, and
then putting the app in charge. All of the negative consequences are
downstream of that decision, and everything we call privacy is a patch
on top of it. Terms of service, which are non-negotiable and difficult
to enforce anyway. Endless permission dialogs, which provide no real
choice and launder responsibility: read what the dialog actually asks —
do you trust the creator of this app, who can push arbitrary
Turing-complete code that can make arbitrary network requests, now and
into the future, even if they get acquired by some private equity firm
in five years? Technically, users consent. But they do not understand
what they consented to, so the consent is hollow; heaping on
ever-more-precise dialogs is adding epicycles to make a geocentric model
work, when the same-origin security model orbits the code and should
orbit the data. And the biggest patch of all: silos. Prevent data from
mixing and it cannot leak — but it is also trapped on someone else's
turf, and the combinatorial value of your data, which is most of its
value, is forfeited. We live in windowless silos to be safe. But that's
antisocial.

The industry's shape follows from that model by arithmetic. Data
accumulates within a boundary at a rate proportional to how much data is
already inside, which leads inexorably to aggregators. The same-origin
model is a generator of moats: silos hold your data hostage and then
rent it back to you, and we have all become renters in our digital
lives. The equilibrium is a handful of maximally-used, minimally-liked
products. For thirty years this was tolerable, because software was
expensive, so there was not much of it, and its creators had a lot to
lose.

## What language models change

Language models broke both assumptions at once: the expense, and the
accountability.

Software stopped being expensive. Shitty software in the small is now
practically free to create, and shitty software in the small is most of
the software anyone actually needs. But only the cost of production
collapsed. The cost of distribution is set by the laws of physics of the
security model, and language models do not affect the marginal cost of
distribution: every new program is still a new open-ended trust decision
about a stranger. That was an acceptable arrangement when creators had a
lot to lose. It is not a good assumption when some rando can sneeze and
produce software. Infinite software inside the same broken frame gives
you infinite islands. Not a continent.

Meanwhile, it used to be that only code could harm you, and code was a
small subset of all data; you only had to trust the entity that made the
code. Now language models make all text executable. Any text with access
to tools, and any untrusted text at all, can harm you, so you have to
trust anyone who made any data, a much larger surface area. The failure
is called prompt injection, and it cannot be patched away, because the
model's usefulness and its injectability are the same property. The
industry's mitigation, telling the model to please be really sure not to
get tricked, is not a security model. Simon Willison named the trap the
[lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/):
sensitive data, network access, untrusted input. A system can have at
most two and remain safe. If you want all three, and every interesting
agent wants all three, you would need new laws of physics.

There is a quieter emergency underneath. Finding zero-days in networked
software used to be hard enough that the equilibrium was mostly safe:
you had to scuba dive to find issues, and humans are expensive. Frontier
models lower the sea level by multiple meters at a time. Suddenly the
surface area is an existential problem.

None of this can be patched into safety, and there is precedent. When
the web exploded, it invalidated Windows 95's security model, and no
level of patching atop a monolithic kernel could make it safe. Windows
95 was a dead end that had to be routed around, with NT: a kernel with
the boundary designed in from the start. Networked software as a whole
has crossed the same threshold. And the standard objection, that nobody
will rewrite everything, has expired, because writing software is the
one thing that just became free. Language models are the cause of and
the solution to the security problem of infinite software.

## The inversion

Remember the decision the Netscape team made. Today you have to trust
the software with your data. Invert it: you trust your data with the
software. The trust emanates from the part you control. The software can
be untrusted, which means you don't have to trust it at all. Even if it
is naive or malicious, it doesn't matter, because it can't harm you.

Every datum in the fabric is tagged with metadata that defines its
provenance (where it came from, who and what created it) and its
policies (where it may go, and who may use it for what in the future).
The metadata is cryptographically verified no matter where in the
network it came from, and it travels with every copy. Policies are
viral: anything computed from a datum absorbs the datum's policies.
Viral policies are kind of like GPL on your data. Data used behind your
back is alienated from your intention; with policies attached to the
data itself, flowing wherever it flows, it becomes inalienable. Your
intentions travel with it.

Policies attach to data rather than code for a reason. Code is
open-ended, inherently; a checker can only refuse what it cannot prove,
the conservative bargain every type system makes. Data is close-ended,
and a finite policy on a finite datum is exactly what a checker can
prove. Putting policies on data allows open-ended possibilities without
open-ended trust.

None of this is new science. Information Flow Control is an applied-math
framework that has been around for fifty or so years, Bell-LaPadula
through HiStar, and Meta uses it as a fundamental concept underpinning
its internal privacy infrastructure. It never shipped to consumers as
flow control because there was never an economic reason to deploy it to
consumers. The reason just arrived.

Here is what it looks like in practice. The fabric has a program that
imports your Gmail. There is nothing special about it; anyone could have
written it, and in the fabric that is the normal case. The session token
it obtains is extremely sensitive: anyone with access to it can fetch
your email. Under Contextual Flow Control the policy on that token needs
only four lines:

- never logged
- never transmitted outside the attested fabric, not even to your own
  browser (your mail can render there; the token has no business there)
- sent only to the origin that minted it, google.com
- and only in the Authorization header

That is the whole list. It neatly circumscribes the dangerous outcomes
for the token, and the policy attaches to the token, everywhere it
flows.

The taint checker can refuse to run code if there is any possibility
that data could be used against its policies, and the error names the
flow. Rust programmers know the shape of this bargain: the borrow
checker is a bit of a nag, and the reward for satisfying it is code that
provably has no data races. Humans find such checkers a slog. Language
models have infinite patience: they are happy to grind against the
checker until it is satisfied, and whatever they come up with is safe by
construction, because it must fit all of the policies. And because
programs carry no authority of their own, if anyone has spent the tokens
to make a bit of software before, even a total stranger, you can safely
use it. Programs are crowd-sourced, cached save points in the latent
space of software.

Then the distribution physics flip too. When code is expensive, data
flows to code; when code is cheap, code flows to data — a Copernican
shift. Imagine flipping gravity: throw something, and it will almost
certainly go infinitely far. Software that is safe by construction has
nothing left to slow its spread: no install decision, no permission
prompt, no trust decision about an author. It can even run
speculatively, on your data, privately; there is no guarantee you see
the result, but if it is useful you likely will. Content has spread
frictionlessly this way for a decade, and content is passive. Software
can do things.

All of it stands on one small thing. Instead of open-ended trust in
strangers, you have close-ended trust that a minimal microkernel of
label accounting is properly implemented. If you can trust that
accounting, you can trust the result. That is the microkernel of
networked software. Run it on your own machine and the story could end
here, with local-first software and enforceable policies. But then
everyone would need to run their computation locally, on a runtime they
trusted. The remaining problem is machines you do not own.

The hardware for that problem has been shipping in commodity servers for
years, and it was built for the opposite side. Confidential computing
bundles two very different abilities: encrypted memory, and remote
attestation. The first means the chip runs code in memory encrypted
against the machine's own operator. Think of it like an embassy: your
own sovereign territory, embedded in another context. Encrypted memory
only matters if your threat model includes the datacenter itself (a
hostile host, a subpoena, a nation-state), so the silicon sat in a
niche, and its most famous deployment was DRM: silicon built to run code
against the interests of the machine's own owner.

The second ability is the overlooked one. Remote attestation lets the
hardware generate a signed statement of exactly what software was
loaded, and any recipient can convince themselves that the machine is
running exactly what the host says it is. Pointed the way it has always
been pointed, attestation proves to a media company that your machine
will keep secrets from you. Pointed the other way, it proves to you that
a stranger's machine is running exactly the open-source runtime you
would have chosen, before your data ever arrives. Captured enemy
artillery, wheeled around to face the other direction. It flips the
power dynamic of a key constraint of cloud computing: you get the
convenience of someone else running and administering the machine,
without having to blindly trust them.

Why has nobody used it this way? The obstacle has been economic rather
than technical. An attestation is only as strong as the ecosystem that
checks it: independent verifiers, transparency logs, reproducible
builds, people who notice when a hash changes. Nobody stands up that
ecosystem for one workload; a payments enclave is not worth it. It
becomes worth it in exactly one case: a runtime general enough that
everyone relies on it for everything. The open-ended runtime is not just
the thing being verified. It is what makes the verification ecosystem
worth building.

So the iron law of the fabric: nodes refuse to connect to any peers not
running precisely, bit for bit, the expected open-source runtime. With
this law in place, the ecosystem grows inductively into a planet-spanning
mesh: your data may flow to any machine on earth that can prove itself,
and to no other. You can build a trusted fabric out of untrusted nodes.

The obvious objection is that this relocates trust into chip vendors,
and enclaves get broken; SGX's record says to assume it. But the chip is
a strengthening layer, not a foundation: provenance, policies, and flow
checking remain checkable with no enclave in sight, and a broken enclave
exposes what flowed through that node while it was broken and until its
keys are revoked. It cannot forge history or alter policies elsewhere.
The guarantee is not absolute, just as a host country could force its
way into an embassy; but a boundary that raises the cost of violation by
orders of magnitude is a different thing from the status quo, where the
boundary is a sign, not a cop. Nor does the mesh need to standardize on
one vendor: attestations from independent silicon can be required in
combination, k-of-n, so no vendor's key is a single point of failure.
And your own hardware is always a valid node: the enclave extends the
guarantee you have at home to machines you do not own, and never
replaces it.

Nothing in this design requires a token, a chain, or a consensus
mechanism; blockchains solve one of the least interesting problems in
this domain. The requirement is only this: trust should be derivable,
not declarative. Checkable by anyone, from evidence, rather than
declared in a document.

## The machine

None of the above is a proposal. The runtime is this repository, open
source, and most of the machinery above is code you can run this
afternoon.

State lives in cells: small addressable units of data that carry
provenance and policies. Programs are patterns: TypeScript modules that
declare what they read and write. A running instance of a pattern is a
piece. Patterns can do six things: compute; produce data, which is
implicitly persisted and available to other patterns under policy;
declare UI; make network requests where policy allows; and instantiate
other patterns, fetched from strangers or generated on demand. The sixth
is the weirdest but the most powerful: a pattern can wish. It declares a
need for data or a capability it does not have, and the system may
satisfy the wish from whatever is present. Wishes allow open-ended
emergence in the system.

Cells live in spaces, and a space is named by a public key. Identity in
the fabric is a keypair; there is no account. Writes carry causal
references and every session is authorized by its author's key, so a
space is an ordered history rather than a mutable blob. Several things
fall out without additional machinery: any set of keys can share a
space, so software is multi-user by default; offline writes replay
against the causal history on reconnect, where disjoint writes land and
true conflicts surface rather than silently losing data; and the history
is portable by construction, so no operator can withhold it.

A pattern looks like this (abridged from
`packages/patterns/counter/counter.tsx`):

```tsx
import {
  action, computed, Default, NAME, pattern,
  Stream, UI, type VNode, Writable,
} from "commonfabric";

interface CounterInput {
  value?: Writable<number | Default<0>>;
}

interface CounterOutput {
  [NAME]: string;
  [UI]: VNode;
  value: number;
  decrement: Stream<void>;
}

const Counter = pattern<CounterInput, CounterOutput>(({ value }) => {
  const decrement = action(() => value.increment(-1));
  const label = computed(() => `Counter: ${value.get()}`);

  return {
    [NAME]: label,
    [UI]: (
      <cf-hstack gap="2">
        <cf-button onClick={decrement}>−</cf-button>
        <div>{value}</div>
      </cf-hstack>
    ),
    value,
    decrement,
  };
});
```

The types are the interface, and the compiler is where much of the work
went. Patterns are plain TypeScript; the compiler derives JSON schemas
from the types, extracts each closure into an isolated unit that can run
in its own sandbox, and rewrites every closure to capture only the
fields it actually reads. Taint is therefore tracked per field rather
than per program, and touching one confidential cell does not poison
everything downstream. The full dataflow graph of a pattern is known
before it runs, and the graph is what the policy checking consumes. The
guarantee is scoped: it governs where data may go; what a program does
within those bounds is an ordinary integrity problem, and the
append-only history makes it revertible. None of this is hidden:
`cf check <pattern> --show-transformed` prints the exact code the
runtime executes.

The runner, the part of the runtime that executes patterns, carries the
Contextual Flow Control machinery: label views over the cell graph,
write ceilings, commit-boundary gating of external effects, enforcement
modes from observe to strict. Policies are less about what computation
may happen, and more about what communication may happen after that
computation: authorization tells you who is at the door, and CFC tells
you what they can carry out. The pattern catalog carries a dozen live
CFC demonstrations, among them row-level labels on shared records,
render policies, staged publication, and a working demo that
structurally contains a prompt-injection attack
(`packages/patterns/cfc-agent-prompt-injection-demo/`). And provenance
marks are minted at the ingest boundary: when data enters the fabric
from outside (OAuth, a webhook, a location feed), the runtime, not the
importing pattern, stamps where it came from.

Around the core: nearly two hundred live patterns, from counters to
group chat; a CLI that deploys, calls, and inspects pieces; spaces
mountable as a filesystem; a browser shell where several keys sharing a
space is the normal case. The components are inspectable by package: the
compiler in `ts-transformers`, the label accounting in `runner`, the
execution harness in `cf-harness`, the sandbox in `iframe-sandbox`. An
attestation pipeline runs on Intel TDX hardware; the mesh protocol
around it (receipts, verification, trust) is the layer under active
construction, specified in `docs/specs/verifiable-execution/`.

The fabric is a protocol with an open runtime, not a service. A machine
joins the mesh by proving what it runs, with no registration, no
permission, and no relationship with any company. And the hardware
behind that proof, memory encrypted against the host, is what denies
operators, including the runtime's authors, privileged read access to
anything inside.

## More than one user

Everything above is about safety. The reason to want it is what becomes
possible between people.

Start with one person. Imagine a shopping list that automatically sorts
itself based on the layout of the grocery store you are shopping in.
Even if a store built it, you would not use it: the store would make a
crappy shopping list, and everyone shops at multiple stores anyway. No
startup can be built on it either — a feature, not a product, an
investor would say. There are thousands and thousands of such long-tail
use cases, below the Coasian floor of the app paradigm: features that
would be useful but make no sense as individual startups or apps. In the
fabric each one is a small pattern (the aisle sorter is
`packages/patterns/store-mapper.tsx`), safe by construction, distributed
at zero cost.

Add a second person. Today it is hard to find a shopping-list app to
coordinate with your family; if the list lacks the feature your spouse
wants, you cannot use it to coordinate at all. In the fabric the
shopping list is a space; your spouse's key has access; you each see it
through whatever UI you prefer. Nothing was integrated. Multiplayer is
not a feature of the list pattern. It is a property of the substrate the
list is stored in.

Add strangers, at the level of structure. The aisle sorter needs a
description of the store's layout, so it wishes for one, and the wish is
satisfied by whatever has already been published. Someone, anyone, who
shops at your store wrote a layout, once; every list in every fabric can
now sort itself in that store. Schemas and tags accrete the same way,
bottom-up, by use, with wishes matching against whatever conventions
exist. A folksonomy is an ecosystem-wide averaging process: it does not
find great, it finds robustly good. Robustly good, shared by everyone,
compounds.

Add strangers, at the level of computation. Self-improving patterns
(`packages/patterns/self-improving-classifier.tsx`) carry a hifi model
and a lofi model. The hifi model is treated as ground truth: for
example, a frontier LLM. The lofi model is treated as potentially below
the bar of good enough: for a pattern that classifies incoming email as
bills, a list of regular expressions, initially empty. When an input
comes in that the two models disagree on, that is a surprise, and it is
stored as an example for the lofi model to improve against. Over time
the lofi model converges on the hifi model's judgment for your actual
mail, and the expensive model drops out of the loop. Spend the model in
proportion to surprise; a judgment that cost tokens becomes code that
costs nothing.

The regular expressions are private by default, since they were derived
from your mail and may contain pieces of it. But the pattern can publish
them under a threshold policy: a rule proposed independently, byte for
byte, by ten different keys becomes public — the count, not the keys. A
new user's lofi model can bootstrap from the shared list and work on day
one. Everyone's token burn helps everyone else, anonymously.

Add strangers, at the level of aggregate signal. A maps product can tell
you how busy a restaurant is right now because an aggregator distills
the location pings of millions of anonymous users into a high-quality
signal. You cannot actually verify that privacy-preserving techniques
are used in that pipeline, and the aggregate signal is owned by the
aggregator, not the users. In the fabric the same computation is a
pattern whose input policy is mechanical: anyone who contributes real
data to the pot can see the aggregate results, which must meet a
specific differential-privacy threshold before they can be shared with
anyone, and nothing else may read the contributions. The policy is
enforced by the same flow checking as everything else, and any
participant can verify it, so the signal can be produced by, and belong
to, the people whose data it is. Consumers could pool their data and set
rules on how it may be used: a consumer union is a space with a policy.

Each example has the same shape: every increment of sharing is safe,
because the policies travel with the data, and every increment of
sharing makes the whole more useful for everyone already in it. The
sharing comes in three depths: deeply, with people like your spouse;
transactionally, scoped to a particular project; and ecologically, where
the effort you invest helps strangers emergently, and vice versa. Karma,
embodied in the physics of the system. Compounding of this kind
previously required an aggregator in the middle, taking custody of the
data as its fee. Here the middle is a protocol.

Meaningful state tends to accumulate around Schelling points. In the
same-origin paradigm, when the Schelling point is one origin's turf, the
origin accumulates the power over everyone's data. When data is not
locked to an origin, Schelling points emerge naturally and fluidly, and
the durable ones form where no participant can hold the state hostage.

## Where things stand

Security models are hard to retrofit, because everything in the system
is downstream of them; the security model sits at the lowest pace layer,
and you cannot retcon one onto an existing system, because it sets the
physics everything above it obeys. Trust at the bottom means you do not
have to trust anything on top, which is what allows open-ended value
creation. And the value is combinatorial: combining data from multiple
sources gives combinatorial value, while a thousand disconnected safe
apps sum to only a thousand apps. So the unit of construction is the
whole substrate: runtime, compiler, policy machinery, attestation mesh.
That is a large amount of work, but it is not exotic work. Attach
provenance and policy to every datum, check every flow, verify every
runtime — then let anything run.

The layers are at different stages: each is useful without the ones
above it. The runtime, the compiler, and the sandboxing work today. The
flow checking runs, with enforcement hardening from observe toward
strict; the trusted base is still larger than the microkernel it is
meant to shrink to, and shrinking it is part of the work. Attestation
runs on hardware and is specified as protocol. The semantics are in
place; robustness and performance are not yet, and they are the current
work. That is the ordinary condition of a young kernel.
`docs/tutorial/` walks the mechanisms. `packages/patterns/` is where to
start.
