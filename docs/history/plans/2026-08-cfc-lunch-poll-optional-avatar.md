---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Executed the Lunch Poll argument compatibility correction found by vintage replay."
---

# Lunch Poll optional avatar compatibility correction

This work order records one necessary correction found while replaying stored
Lunch Poll state under the strict CFC rollout. The numbered section is one
commit. It follows the rollout work orders without changing the two leading
boundaries: the first commit contains only switch changes, and the second
contains only tests that directly inspect those switches.

## 1. Accept identity-card invocations without an avatar

The participant identity card added `profileAvatar` as a required pattern
argument after the pinned Lunch Poll vintage was captured. Stored invocations
therefore have no value at that argument path. Recompiling the parent Lunch
Poll pattern makes the runner validate those old child arguments against the
current card schema, which refuses the whole update before any state can be
replayed.

Make `profileAvatar` optional at the card's public argument boundary. The card
already normalizes an absent value to the empty string before rendering or
passing it to the join handler, so this restores the declared schema to the
behavior the implementation already provides. Exercise the absent form in the
card's pattern test. Record the resulting card contract in the append-only
pattern compatibility baselines.
