---
status: historical
created: 2026-08-28
archived: 2026-08-28
reason: "Record of the first model-driven `cf:pattern:` composition run (CT-2104)."
---

# A model-authored `cf:pattern:` import, end to end

Two turns of one cf-harness console session, 2026-08-28, against a local
toolshed on `http://localhost:8000`, space `pattern-index-demo`, the deployed
pattern index, model `gpt-5.6-terra`, CFC at max-enforcement with flow labels
persisting and `enforce-explicit`. The point of the run was to see whether a
model, unprompted about mechanism, would decompose a task into an atom and a
composition and reach the atom through the index rather than rebuilding it.

## Turn 1 — the atom

> Build me a small piece that shows a random number and a button that rolls a
> new one. Keep it to that one thing, and give it the slug dice-atom.

The parent delegated once, to `pattern-author`, declaring no `returnSchema`
(the profile's own contract applies), and wrote into the delegation's context
"no source required in response". The child searched the index first, found
nothing close, and iterated `run_pattern` three times through compile errors —
a bare factory, then `pattern()`, then `action()` for the click handler —
before it ran. It returned `{ ok: true, resultRef, describes, hashtags }`, six
of whose string positions sealed into opaque links; the `resultRef` arrived at
the parent as a handle token, which the parent passed to `assign_slug`.

Result: `http://localhost:8000/pattern-index-demo/dice-atom`, published to the
index under `dice, random, roll, button, interactive` with the description
"Displays a die number and rolls a new random number from 1 through 6 when its
button is pressed."

## Turn 2 — the composition

> Now build a piece that shows three of those dice side by side and displays
> the sum of the three. Reuse the dice component you already published — find
> it in the pattern index and import it — rather than writing a new one. Give
> it the slug dice-table.

The parent delegated again, passing down the words to search under rather than
anything about the first pattern's identity — it holds no pattern id, because
the id never crossed the return boundary. The child's first call was
`search_patterns "dice random roll button interactive"`, which matched the
atom on 5 of 5 query terms, and its first `run_pattern` already carried

```
import Die from "cf:pattern:fJFEmPDyg47R8OpD33N-3Wz7YxEZ60fOQPdyUnkZJ60";
```

with three instantiations and a `computed()` over their values. Two compile
errors followed — `Cell<number>` has no `+`, then `computed()` outside an
allowed context — and the third call ran, returning `{ "total": 3 }`: three
dice at 1 each, summed live through the composed sub-patterns.

Result: `http://localhost:8000/pattern-index-demo/dice-table`.

## What the run establishes

- A model-authored `cf:pattern:` import compiled and ran against an atom
  published by an earlier run's child. The composition machinery had been
  unit-tested; this is the first time a model drove it.
- Reuse travelled through the index, not through the parent. No pattern source
  and no pattern id crossed a delegation boundary in either direction. The
  parent named the capability in words; the child found the id itself.
- The `pattern-author` return contract carried the work: a result-cell handle
  the parent could slug, with the prose and hashtags sealed beside it.

## What it does not establish

The rendered DOM was not checked. Both pieces are addressable and the composed
one computed a live total, but opening the shell needs an identity this session
could not supply, so "renders in a browser" rests on `run_pattern`'s result
rather than on a snapshot.

The run also carried a broken CFC mediation environment: every `bash` and every
`read_file` came back `observation-denied` / `not-observable`, because the
`runsc-cfc` Docker runtime on the host was configured without
`--cfc-result-dir`. The children worked from their preloaded skills, the index,
and compile diagnostics alone. See CT-2105.
