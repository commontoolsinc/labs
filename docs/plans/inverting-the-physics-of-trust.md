# Common Fabric: Inverting the Physics of Trust

The runtime, and why it is shaped the way it is.

## The inverted rule

Data is viral: free to replicate at perfect fidelity, and once given to
computation you do not control, access to it can never be revoked. With
data, more power means more danger. No computing platform has ever
grappled with that physics.

All networked software today runs on a trust model improvised in the
mid-nineties: data lives with the code that collected it, so you must
trust the software with your data. The industry has been patching around
that decision ever since with a handful of jury-rigged solutions: terms
of service, permission dialogs, silos. And the patches set the
industry's shape: data accumulates within a boundary at a rate
proportional to how much is already inside, which leads inexorably to
aggregators. Silos hold your data hostage and then rent it back to you;
we are all renters in our digital lives. The equilibrium is a handful of
maximally-used, minimally-liked products. It was tolerable because
software was expensive to make, and its makers were few, with
reputations at stake.

AI ends both conditions at once. Software becomes infinite (anyone can
produce it by asking), so the old gate, trusting the reputation of the
maker, stops scaling. Infinite software inside the same broken frame
gives you infinite islands. Not a continent. And all text becomes
executable: an agent reading your email treats any sentence in it as
potential instructions, which is why prompt injection is a property, not
a bug. The industry's mitigation, telling the model to please be really
sure not to get tricked, is not a security model. Every ceiling the
industry is hitting with agents right now (injection, permission
fatigue, agents that cannot be given real access to anything that
matters) is the same ceiling: sensitive data, untrusted input, and
network access cannot safely coexist under the current rules.

The fabric is a runtime built on the opposite rule: **the software is
untrusted, and safety attaches to the data.** Three mechanisms enforce
it, and all three are built. Together they form a distributed, trusted
microkernel for networked software in the AI era.

## In this repository

- the runtime
- a compiler that turns ordinary TypeScript into policy-checkable
  dataflow graphs
- the flow-checking machinery
- the sandboxing
- a reactive, multiplayer-by-default storage layer with keypair identity
- roughly two hundred running programs, including a live demonstration
  of prompt injection being structurally contained
  (`packages/patterns/cfc-agent-prompt-injection-demo/`)
- an attestation pipeline running on Intel TDX hardware

## Policies travel with the data

Every datum carries
cryptographically verified provenance (who and what created it) and
policies (where it may go, who may use it for what). Both travel with
every copy, and anything derived from the datum inherits its policies.
Viral policies are kind of like GPL on your data.

The inversion attaches policies to data rather than code for a reason:
code is open-ended, inherently; a checker can only refuse what it cannot
prove, the conservative bargain every type system makes. Data is
close-ended, and a finite policy on a finite datum is exactly what a
checker can prove. Putting policies on data allows open-ended
possibilities without open-ended trust.

Concretely: the fabric's Gmail importer is ordinary code a stranger
could have written, and the OAuth token that can read all your mail is
protected by a four-line policy attached to the token itself:

- never logged
- never transmitted outside the attested fabric, not even to your own
  browser (your mail can render there; the token has no business there)
- sent only to the origin that minted it, google.com
- and only in the Authorization header

That is the whole list. Any code can handle the token safely, because
the danger is fenced by the data, not by the code's good intentions.

## Flow checking at compile time

Contextual Flow Control is type
checking for privacy policies: if the software compiles, it by
construction has no data flows that violate the policies. The taint
checker can refuse to run code if there is any possibility that data
could be used against its policies, and the error names the flow. So a
stranger's code, or code a model generated a second ago, can safely
touch your most sensitive data.

Rust programmers know the shape of this bargain: the borrow checker is a
bit of a nag, and the reward for satisfying it is code that provably has
no data races. Humans find such checkers a slog. Language models have
infinite patience: they are happy to grind against the checker until it
is satisfied, and whatever they come up with is safe by construction.
And because programs carry no authority of their own, any program anyone
has already spent the tokens to make can be safely reused: programs are
crowd-sourced, cached save points in the latent space of software.

What makes the check tractable is the compiler: programs are plain
TypeScript, and the compiler rewrites every closure to capture only the
fields it actually reads, so taint is tracked per field rather than per
program, and the full dataflow graph is known before anything runs. None
of this is hidden: `cf check <pattern> --show-transformed` prints the
exact code the runtime executes.

## A mesh of proven machines

Remote attestation lets any machine
prove, bit for bit, that it is running the open-source runtime, in
memory its own operator cannot read. Nodes refuse peers that cannot
prove it, so you can build a trusted fabric out of untrusted nodes: your
data may flow anywhere that can prove itself, and nowhere else. Identity
is a keypair, not an account. State accretes at Schelling points, and
durable Schelling points form where no participant can hold the state
hostage.

Attestation is existing hardware pointed backward. Confidential
computing's most famous deployment was DRM: silicon built to run code
against the interests of the machine's own owner. Pointed the way it has
always been pointed, attestation proves to a media company that your
machine will keep secrets from you. Pointed the other way, it proves to
you that a stranger's machine is running exactly the open-source runtime
you would have chosen, before your data ever arrives. Captured enemy
artillery, wheeled around to face the other direction.

Nobody has used it this way because the obstacle is economic: an
attestation is only as strong as the ecosystem that checks it
(independent verifiers, transparency logs, reproducible builds), and
nobody stands up that ecosystem for one workload; a payments enclave is
not worth it. A general-purpose runtime that can run anything is a
different matter: verify the runtime once, and every program that ever
runs on it inherits the verification.

## Four classes of cloud security

There are four classes of cloud security:

1. Cloud apps: couch surfing in someone else's apartment. The host can
   do whatever they want.
2. Cloud VMs: renting an apartment. The landlord can come in, but only
   in an emergency.
3. Trusted execution environments: an embassy. Snooping would be an act
   of war.
4. ZK proofs: a volcano lair on a remote island. Society would have to
   have broken down.

Each class is an order of magnitude better than the last, and the vast
majority of the cloud today is in the first two. Moving most computing
to the embassy class would be a massive improvement — and the class gets
stronger with every hardware generation. Real embassies can be breached,
but breaching one is a nation-state act, and that is the right size for
what the enclave buys. It also buys something the lower classes cannot:
mutually trusted private infrastructure, a place where parties who do
not trust each other can still share computation, because each of them
can verify what runs there. The architecture does not need enclaves to
be perfect: the flow checking stands with no enclave in sight, a broken
enclave exposes only what flowed through that node while it was broken,
and attestations from independent silicon can be required k-of-n.

Nothing in this design requires a token, a chain, or a consensus
mechanism. The requirement is only that trust be derivable, not
declarative: checkable by anyone, from evidence.

## A hotfix, not a law of gravity

The rule being inverted is younger than it feels. The same-origin model
arrived as a hotfix, decided by the Netscape team to handle an early
JavaScript security problem, and because it was a reasonable simplifying
policy it hardened until it felt like a law of gravity. But unlike a law
of gravity, it can be changed. We made it; we can change it.

And there is precedent for routing around a security model: when the web
exploded, it invalidated Windows 95's security model, no amount of
patching a monolithic kernel could make it safe, and the industry moved
to NT, a kernel with the boundary designed in from the start.

There is also a reason this is buildable now and was not before: two
ingredients arrived almost at once. Secure enclaves make trust across a
network possible. And language models write software for approximately
free; a new framework used to mean convincing humans to write for an
empty ecosystem, and now models will happily write for it. The standard
objection, that nobody will rewrite everything, has expired. Language
models are the cause of and the solution to the security problem of
infinite software.

## Resonant by default

Hollow things are things you like, but afterwards you are left feeling
regret. Resonant things are things you like, and afterwards you feel
nourished. They are superficially similar but fundamentally different.
Modern society — modern tech, modern business, modern politics — is
great at delivering hollow experiences and terrible at delivering
resonant ones. AI supercharges everything, so it is more important than
ever that software become resonant by default. And to do that, you need
to invert the physics of trust.

[Resonant computing](https://resonantcomputing.org) has five
principles, and the inversion is what turns each one from aspiration
into structure:

- **Private.** Policies on data make people the primary stewards of
  their own context, determining how it is used.
- **Dedicated.** Flow checking proves at compile time that software
  works exclusively for you — no hidden agendas, no conflicting
  interests.
- **Plural.** The attestation mesh and keypair identity mean no single
  entity controls the digital spaces we inhabit.
- **Adaptable.** Infinite software, safe by construction: open-ended,
  able to meet the specific, context-dependent needs of each person.
- **Prosocial.** A multiplayer substrate where collective signals
  belong to the people whose data they are — software that helps us
  become better neighbors, collaborators, and stewards of shared
  spaces.

## From cells to a city

This is what life did with dangerous chemistry: put it in boundaries.
The mechanisms above are the membrane, and what they make possible is
small, bounded programs — policy-checked, provenance-carrying, unable
to leak what they touch. A single one is unimpressive. But as more
patterns accumulate, they transmute into something radically different,
with emergent power that makes the individual programs look puny: a
general-purpose material that can be shaped into nearly infinite
variety.

Infinite software will not be infinite apps; it will be one system that
does infinite things. The software melts away, and it feels like your
data coming alive — something that lives with you, holding up the day
like a tray: light, organized, human-scale, the mundane scaffolding of
a good life. Alive not like a person, with one face you can talk to,
but like a city. A whole city of cognitive labor that works just for
you.

## The whole unlock

For forty years we have structurally underproduced software: the
expense of creating it, and the verticalized world of the same-origin
paradigm. LLMs have changed the first. We can change the second.
Personal computing was supposed to make computers personal; instead, it
made people subordinate to software. This is the way back: a personal
fabric that everyone can own, woven into a society-scale common fabric
of intention. If the singularity comes, let it be plural: exuberant,
creative, messy — billions of experiments in flourishing, not one
experiment in species-wide management.

And none of it survives without the inversion. Every property above
leans on the same rule — the fabric has your intentions woven in,
structurally guiding what it can and cannot do, not as some hastily
jury-rigged solution on top. Safety attaches to the data, not the
software. Inverting the physics of trust is the whole unlock.

## Where things stand

The layers are at different stages, and each is useful without the ones
above it. The runtime, the compiler, and the sandboxing work today. The
flow checking runs, with enforcement hardening from observe toward
strict; the trusted base is still larger than the microkernel it is
meant to shrink to, and shrinking it is part of the work. The
attestation pipeline runs; the mesh protocol around it is specified in
`docs/specs/verifiable-execution/`. The semantics are in place;
robustness and performance are not yet, and they are the current work.
That is the ordinary condition of a young kernel.

`docs/tutorial/` walks the mechanisms; `packages/patterns/` is where to
start.
