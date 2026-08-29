# Shuttle — build sequence

Satellite of [`README.md`](README.md): the order of construction,
as small landable pull requests. Stage A is seam work inside `packages/cli`
— each PR stands on its own merits there, shuttle or no shuttle, because a
seam that lets a sibling inject a connection is the same seam that lets a
unit test run the action body (the documented rationale of the
`*FromCommand` family). Stage B is the shuttle package itself, in vertical
slices. A-PRs go first in line because they gate everything and review
latency is the scarce resource; B milestones start as soon as their named
prerequisites land.

## Stage A — seams in `packages/cli`

**A1 — export entries.** `@commonfabric/cli` exports only `.` → `mod.ts`,
whose import runs CLI startup. Add workspace-internal export entries for
the modules a sibling calls: `./lib/piece`, `./commands/piece`,
`./lib/wish`, `./lib/piece-render`, `./lib/completion/providers`. Keep the
list to what shuttle names — an export entry is a contract, and the short
list is the record of which internals have a second caller. (The view
substrate's entries wait for B3, which is when they earn their place on
that record.)

**A2 — connection injection for the write path.** Thread
`deps.loadPieces` (the existing `PieceResolutionDeps` seam) through the
functions that hardcode `await loadPieces(config)` today, in order of
shuttle's need: `setCellValue` and `callPieceHandler` and `stepPiece`
first (v1 verbs), then `removePiece`, `getPieceView`, `renderPiece`, the
`lib/acl.ts` loaders. Each conversion carries the unit test the seam
makes possible; that is the PR's standalone value.

**A3 — extract `callFromCommand`.** `buildCallCommand`'s action is inline
and bound to Cliffy's `this` (`getLiteralArgs`); its constituents are
already exported. The extraction makes the literal-args array a parameter
and gives `call` the same named-export shape as its siblings. Independent
value: an inline action body is uncoverable and everything registered
after it sits in coverage shadow, so extraction retires debt in the
package where coverage debt is a standing cost.

**A4 — exit and output seams audit.** Every seam shuttle calls must accept
an exit override (`exitWithDataError` / `exitPieceCallFailure` call
`Deno.exit(1)` by default — a data error must not kill the shell) and
route output through the `render`/`hint` deps rather than stray
`console.error`. One audit PR that threads what is missing, with the test
that proves a data error surfaces as a value.

**A5 — module-global state.** `quietMode` is a file-level `let`;
`setLLMUrl` is written by both `loadPieces` and
`PiecesController.initialize`. Either scope them per connection, or land a
recorded limit: one connection per process for shuttle v1, revisited when
multiple places arrive. The cheap honest move is the recorded limit; the
PR is whichever the review rules.

## Stage B — the shuttle package

**B0 — scaffold** (after A1). `packages/shuttle` with its path in the root
`deno.jsonc` workspace array and its own `tasks.test` entry — the two
edits a new package needs, the second one load-bearing. Dependencies
follow `docs/development/DEPENDENCIES.md`. No behavior; the package
compiles and its empty test task runs.

**B1 — walking skeleton** (after A1; A2 for nothing yet). The place value
and its owner module, the prompt, a readline loop, and `cd` / `ls` /
`pwd` / `get` over one held `PiecesController` built cf-harness-style
(memoized factory, cache cleared on rejected construction). Facets
`slugs/` and `pieces/` only; `fuse/` waits. Liveness: this milestone is
where the reconnect story is proven, because everything after leans on it.

**B2 — writes, calls, handles** (after A2, A3). `set` with inline values,
`edit` over `$EDITOR`, `call` through `callFromCommand`, numbered handles
from listings, and the invocation session minted once at startup and
passed explicitly. Warm-on-enter lands here, since `set` is what makes
stale computed state visible.

**B3 — watch and views** (after A4; view-substrate export entries added
here). `Cell.sink` with the guard-plus-`idle()` settling discipline; the
value, list, and structured piece-overview views on the `cf view` pager
substrate; session watches with prompt event lines and the pinned strip;
cold-browse mode. Governed by [`views.md`](views.md); it opens
with the two experiments and the raw-document-subscription proving test
from issue [#6534](https://github.com/commontoolsinc/labs/issues/6534),
falling back to the capped deep sink if the seam disappoints.

**B4 — redirection, schemes, pipes.** `>` and `<` over fabric paths,
`file:` and `https:` read ends, the native tool set v0 and the local
escape. The external working location (`xcd`/`xpwd`, the `x:` base) and
the full `where` surface land here.

**B5 — search, pagination polish, `!cf` escape.** `search` at any place,
cursoring over large listings, and the subprocess escape with
place-derived flags injected.

## Working rules

- Every stage-A PR carries the unit tests its seam enables; a seam PR
  without tests is the shape the `FromCommand` rationale exists to
  prevent.
- `packages/cli` coverage gates apply to stage A; the extraction PRs are
  coverage-positive by construction, which is the order's second reason.
- Shuttle stays out of `deno task check`'s path list until B1 gives it
  real code, and registers there in the same PR that does.
