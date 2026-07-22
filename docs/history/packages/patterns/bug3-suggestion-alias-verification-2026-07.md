---
status: historical
created: 2026-07-21
archived: 2026-07-21
reason: "Verification of the December 2025 survey's Bug 3; the $alias render defect does not reproduce."
---

# Bug 3 verification: dynamically-instantiated pattern values no longer render as `$alias`

This record closes out the second of the two findings in the December 2025
pattern bug survey
([`PREEXISTING_BUGS.md`](PREEXISTING_BUGS.md)). The first finding, Bug 1
(compiler.tsx "Navigate To Piece"), was verified working in July 2026 and its
stale catalog note removed; that work landed upstream as PR #4733. Bug 3 had
never been checked until this investigation.

## What Bug 3 claimed

When the Suggestion pattern instantiated a Counter (or any other pattern)
through `fetchAndRunPattern`, the survey reported that reactive cell values in
the Counter's rendered UI appeared as raw alias objects instead of resolved
values. The concrete example given was the Counter's caption rendering as
`"Counter is the {"$alias":...} number"` — the literal serialized alias — where
the intended output was the resolved ordinal, for example `"Counter is the 1st
number"`. The survey suspected the cause lay in how patterns are dynamically
instantiated through the large-language-model tool-call path inside
`fetchAndRunPattern`.

## Why the symptom is a render-time question

For the `$alias` string to appear, the Counter must have rendered at all: the
surrounding template text (`Counter is the … number`) was present, and only the
embedded reactive value failed to resolve. The defect is therefore in how a
dynamically-compiled pattern's reactive user-interface values are resolved and
subscribed to at render time. That render path is downstream of `compileAndRun`
and of the pattern that produced the program. It does not depend on where the
program source came from (a fetched URL versus inline source) and it does not
depend on the large-language-model tool-call wiring. Whatever supplies the
compiled program, the reconciler renders the same pattern instance with the same
alias structure.

## How it was verified

The survey's own reproduction recipe no longer matches the tree: the Suggestion
patterns moved to `packages/patterns/system/suggestion.tsx` and
`packages/patterns/examples/suggestion-test.tsx`, and the recipe's port was
stale. More importantly, the full Suggestion path is awkward to drive in
isolation: it depends on home-space system wishes (`#summaryIndex`,
`#mentionable`, `#recent`, `#patternIndex`, `#learnedSummary`) that a fresh,
isolated space does not provide, and it hard-codes a model name the local
gateway no longer offers.

The verification instead exercised the exact render mechanism the defect lived
in, with a self-contained pattern deployed to a local space and rendered in the
shell. The pattern compiled an inline Counter source with `compileAndRun` — the
same builtin `fetchAndRunPattern` wraps — and rendered the resulting cell inline
through `cf-cell-context`, mirroring how `suggestion.tsx` renders its
large-language-model result. The inline Counter reproduced the reported template
exactly: a direct cell value shown as `{value}`, and a `computed` ordinal shown
as `Counter is the {ordinalDisplay} number`.

Observed result:

- On first render the direct value resolved to `0` and the ordinal resolved to
  `Counter is the 0th number`. No `$alias` text appeared anywhere in the
  rendered document.
- After incrementing the compiled Counter three times, the direct value became
  `3` and the ordinal updated to `Counter is the 3rd number`. The resolved
  values are live subscriptions across the compiled-pattern boundary, not
  one-time snapshots, and still no `$alias` appeared.

Both a plain cell reference and a derived `computed` — the two shapes a reactive
value can take in a pattern's user interface — resolve correctly when the
pattern is produced by `compileAndRun` and rendered inline. The reported Bug 3
symptom does not reproduce.

## An orthogonal observation, recorded so it is not mistaken for Bug 3

A separate reproduction that drove `fetchProgram` against a program URL (the
GitHub raw URL the pattern index points at) never left the "fetching" state:
`fetchProgram` stayed pending indefinitely, with no error surfaced to the
pattern, so `compileAndRun` never received inputs and the Counter never ran.

This is the Common Fabric capability layer's outbound-request gate behaving as
designed, not a defect in the render path. `fetchProgram` dispatches its network
request as a "sink-request" through `enqueueSinkRequestPostCommitEffect`
(`packages/runner/src/cfc/sink-request.ts`). When the release check
(`verifySinkRequestRelease`) is not satisfied, that effect fails closed: the
actual fetch is never sent, and the failure is noted to capability statistics
rather than raised to the pattern. In an isolated test space without the
capability preparation the normal product flow performs, the outbound program
fetch is therefore withheld and the fetch cell remains pending. This is a
property of the isolated test environment and the capability policy, and it is
independent of the `$alias` question, which concerns rendering after a program
has already compiled and run. The inline-source verification above deliberately
avoids the outbound fetch so the render path can be exercised on its own.

## Outcome

Bug 3 does not reproduce. Unlike Bug 1, no live document advertised Bug 3 — the
pattern catalog carries no note about `suggestion.tsx` — so there is nothing to
correct or remove. No runtime change was made.
