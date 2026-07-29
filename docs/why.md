*Draft. The argument is settled enough to write down; the wording is
not, and the claims below are checked against the code as of this
commit. If one of them stops being true, fix it here.*

We are all renters in our digital lives. Your data should be yours —
readable by the software you choose and by nothing else, with no company
in the middle that has to be trusted and no account anyone can suspend.

That is not how any of it works, and not because anyone conspired. The
trust model everything runs on says: hand your data to the software, and
that rule produces the same thing every time. Forty years of software's
potential is still locked in silos, guarded by goblins.

Inverting the rule means new software all the way down, which nobody
could afford until language models made writing software approximately
free.

So we built a runtime on the opposite rule. The software is untrusted,
and the policies ride with the data.

Concretely. A program that imports your mail gets a token that could
read all of it. In the fabric that token carries four lines: never
logged, never leaves the verified runtime, only ever sent to the place
that issued it, and only in the field that place expects. Anything
computed from it inherits them — the labels join at every commit, so a
value derived from your mail is still your mail as far as the checker is
concerned. Code that cannot prove it honors those lines does not
compile. Any program can hold that token now, including one a model
wrote thirty seconds ago, because the rules ride with the data instead
of with the program's good intentions.

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
that trust be checkable by anyone, from evidence. The people this
matters most for are the ones with the least room to be wrong about who
is holding their data.

Same-origin was a hotfix. People made it in a hurry, and people can
replace it. We do not know whether we are the ones who will. We think
this is where the leverage is, and we are spending our shot on it rather
than waiting for somebody else to.
