*Draft. The argument is settled enough to write down; the wording is
not, and the claims below are checked against the code as of this
commit. If one of them stops being true, fix it here.*

We are all renters in our digital lives. Your data lives on someone
else's machine, under someone else's rules, and the only lever you have
is asking nicely.

That is not because anyone conspired. The trust model everything runs on
says: hand your data to the software, and that rule produces the same
thing every time. Forty years of software's potential is still locked in
silos, guarded by goblins.

Two ingredients recently became available at once, and together they
make a different arrangement possible. Secure enclaves mean a machine
you do not own can prove what it is running before your data ever
reaches it — networked trust. And language models write software for
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

[How it works](./how.md) is the code: what the compiler emits for an
ordinary pattern, where the runtime checks the result, and what the
exits are. [The full argument](./plans/inverting-the-physics-of-trust.md)
is the physics and the hardware.

What runs today: the compiler, the checker — rejecting at explicit
boundaries, the third of four rungs — a hundred-odd patterns, and
machines that prove which runtime they are before your data arrives.
What does not: label propagation defaults to off and is rolling out,
strict-by-default is the current work, a space still has a host that can
revoke a participant, and robustness and performance are not there yet.

Nothing here needs a token, a chain, or a consensus mechanism — only
that trust be checkable by anyone, from evidence.

Same-origin was a hotfix. People made it in a hurry, and people can
replace it. We do not know whether we are the ones who will. We think
this is where the leverage is, and we are spending our shot on it rather
than waiting for somebody else to.
