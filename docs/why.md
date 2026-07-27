Personal computing was supposed to make computers personal. Instead,
your mail lives on someone else's machine, under someone else's rules.
We are all renters in our digital lives. The landlords didn't win an
argument — they got there first, with a trust model somebody improvised
in the mid-nineties and everyone has been patching around ever since.
Forty years of software's potential is still locked in silos, guarded
by goblins.

None of this is villainy. It is arithmetic. These are the physics of
trust everything runs under — hand your data to the software, and trust
the software — and silos are what those physics produce, every time.
Nobody had to conspire. The rule did the work.

The arrangement is not a law of nature. Inverting it means new software,
all the way down, which nobody could afford until language models
started writing software for approximately free. The rewrite that was
unthinkable is now just work. Arrangements like this one have rarely
been replaced by anything but working code, so that is what we started
writing.

The rule underneath everything you use is: hand over your data, trust
the software. We built a runtime on the opposite rule. The software is
untrusted. Safety rides with the data. Every datum carries its own
policies, the way GPL code carries its license, and anything derived
from it carries them too. Code that cannot prove it honors those
policies does not compile. Hold that rule and a stranger's program can
touch your most private data and provably do only what you allow. That
is the whole bet, and it is checkable.

The full argument — the physics, the hardware, the objections — is
written up in [docs/plans/inverting-the-physics-of-trust.md](./plans/inverting-the-physics-of-trust.md).
This file is the short version: what already runs, and what we hold.

What already runs, in this repository, today:

- a compiler that turns ordinary TypeScript into policy-checkable
  dataflow — run `cf check <pattern> --show-transformed` and it prints
  the exact code the runtime executes, no trust required
- the flow checking that evaluates those policies, in
  `packages/runner/` — observe mode today, see 5 below
- a hundred-odd running patterns in `packages/patterns/`, counters to
  group chat — enough to show the runtime isn't bent around one use
  case, and nowhere near the number that would matter

And on real silicon, a machine you don't own can prove — bit for bit —
that it runs the open runtime before your data ever reaches it. That
part runs on the hardware today; the protocol around it is written up
in `docs/specs/verifiable-execution/`.

The people who came before us settled arguments like this one by
writing code rather than papers, and we would rather be judged the same
way. Most of what is here is early. All of it is readable.

What we hold:

1. Identity is a keypair, not an account. There is nothing to suspend,
   and no one to ask.
2. Every line is open source. The runtime proves itself to you before
   your data arrives — you are never trusting our word, you are checking
   the machine's.
3. Your data leaves with you, whole, policies and all. No one you did
   not choose can hold it, and no one can hold it hostage.
4. Software is multiplayer without a landlord. State lives where no
   participant can lock the others out of it.
5. The unfinished parts, plainly: the flow checking runs in observe
   mode today, strict-by-default is the current work, and robustness
   and performance are not there yet. That is a real gap, and it is
   ours to close.

Here is what "policies ride with the data" means in practice. A program
that imports your mail gets an access token that could read all of it.
In the fabric that token carries four lines: never logged, never leaves
the verified runtime, only ever sent to the one place that issued it,
and only in the one field that place expects. That is the whole list.
Any program can hold that token now, because the rules ride with the
data, not with the program's good intentions.

Nothing here needs a token, a chain, or a consensus mechanism. Only that
trust be checkable by anyone, from evidence.

Clone it. Run a pattern. Write one — it is plain TypeScript, and the
checker names the exact flow a policy would forbid before anything runs.
`docs/tutorial/` walks the mechanisms, and `packages/patterns/` is where
to start.

The aim is not modest. The rule we are trying to replace sits
underneath everything, and what it has been holding back is most of what
software could have been. The work is unglamorous: types, a checker, a
runtime, patterns, and years of it. That is the only kind of work that
has ever moved a rule like this one, and all of it is open to inspect.

Same-origin was a hotfix. People made it in a hurry, and people can
replace it. We do not know whether we are the ones who will. We think
this is where the leverage is, and we are spending our shot on it rather
than waiting for somebody else to.
