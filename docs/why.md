*Draft. The argument is settled enough to write down; the wording is
not, and the claims below are checked against the code as of this
commit. If one of them stops being true, fix it here.*

Software is alchemy. Combine data with code and something appears that
was not there before, and the more of it you can combine, the more the
result is worth. That is the whole promise, and forty years of it is
still locked in silos, guarded by goblins.

We are all renters in our digital lives. Your data lives on someone
else's machine, under someone else's rules, and the only lever you have
is asking nicely. Our personal context got shattered into a million
pocket universes, one per app, and the walls between them are the
product: these are my users, and anyone who wants to talk to them pays
my toll. We live in windowless silos to be safe. But that is antisocial,
and the value forfeited is combinatorial — every pair of things that
never got to meet.

None of this is villainy. It is arithmetic. The trust model everything
runs on says: hand your data to the software, and trust the software.
Data accumulates inside a boundary at a rate proportional to how much is
already inside. Nobody had to conspire; the rule did the work, and the
entity that is supposed to be working for you ends up holding power over
you.

The patches never addressed it, because they could not. A permission
prompt is responsibility laundering — technically you consented, and the
consent is hollow, and the company you consented to may belong to
somebody else in five years. Each patch is another epicycle on a model
that has the wrong thing at the center. The same-origin model orbits the
code. It should orbit the data.

The arrangement is not a law of nature. Inverting it means new software
all the way down, and until recently nobody could afford that. Two
ingredients changed it. Secure enclaves — silicon originally built to
run against the interests of the machine's owner, pointed the other way
— mean a machine you do not own can prove what it is running before your
data ever reaches it. And language models write software for
approximately free, so a new framework no longer means convincing humans
to write for an empty ecosystem.

So we built a runtime on the opposite rule. The software is untrusted,
and safety attaches to the data. Every datum carries its own policies,
the way GPL code carries its license, and anything derived from it
carries them too. Code that cannot prove it honors those policies does
not compile. What it adds up to is a distributed, trusted microkernel
for networked software in the AI era.

Concretely. A program that imports your mail gets a token that could
read all of it. In the fabric that token carries four lines: never
logged, never leaves the verified runtime, only ever sent to the one
place that issued it, and only in the one field that place expects. That
is the whole list. Any program can hold that token now, including one a
model wrote thirty seconds ago, because the rules ride with the data
instead of with the program's good intentions.

Identity is a keypair, not an account. There is nothing to suspend, and
no one to ask.

What that buys is not a better app store. It is the end of needing
apps — thinking in apps was always unnatural, and the answer is not to
make it more natural but to not need them. Code flows to the data
instead of data flowing to the code. Software finds you rather than
being installed. Programs stop being monuments and become crowd-sourced,
cached save points in the latent space of software: some rando sneezes,
and what comes out is a thing you can actually run on your real data,
because the substrate is what keeps you safe rather than the author's
good name. What accumulates in a close-ended system gets trapped. In an
open-ended one it blossoms.

[How it works](./how.md) is the code: what the compiler emits for an
ordinary pattern, where the runtime checks the result, and what the
exits are. [The full argument](./plans/inverting-the-physics-of-trust.md)
is the physics and the hardware.

Most of what is here is early, and all of it is readable. What runs
today: the compiler, the checker — rejecting at explicit boundaries, the
third of four rungs — a hundred-odd patterns, and machines that prove
which runtime they are before your data arrives. What does not: label
propagation defaults to off and is rolling out, strict-by-default is the
current work, a space still has a host that can revoke a participant,
and robustness and performance are not there yet. The people who came
before us settled arguments like this one by writing code rather than
papers, and we would rather be judged the same way.

Nothing here needs a token, a chain, or a consensus mechanism — only
that trust be checkable by anyone, from evidence.

Same-origin was a hotfix. It got hardened until it felt like a law of
gravity, but people made it in a hurry, and people can replace it. We do
not know whether we are the ones who will. Language models make software
infinite, and infinite software inside the same broken frame gives you
infinite islands — not a continent. The substrate is the part that
decides which one you get, and that is where we are spending our shot
rather than waiting for somebody else to.
