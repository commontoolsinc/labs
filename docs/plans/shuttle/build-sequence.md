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

**A1 — export entries.** Done (#6626). Importing `@commonfabric/cli`'s `.`
entry runs CLI startup, so the package carries workspace-internal entries
for the modules a sibling calls: `./lib/piece`, `./commands/piece`,
`./lib/wish`, `./lib/piece-render`. The completion listing is not a plain
entry: it is `listCellKeys` in `packages/cli/lib/cell-listing.ts`,
exported as `./lib/cell-listing` behind a `PieceResolutionDeps` seam with
`keysOf` beside it. The providers are designed to fail silently and
empty — right for tab completion, wrong for `ls` — so the listing raises
its errors and completion's provider dispatch swallows them at its own
call site. Keep the list to what shuttle names — an export entry is a
contract, and the short list is the record of which internals have a
second caller. (The view substrate's entries wait for B3, which is when
they earn their place on that record.)

**A2 — connection injection for the write path.** Done (#6646). The write
path takes the connection as a parameter, so a held `PiecesController`
serves every call rather than each opening a runtime, a storage manager,
and a socket of its own: `setCellValue`, `removePiece`, `linkPieces`,
`renderPiece`, `callPieceHandler`, and `getPieceView` in `lib/piece.ts`
and `lib/piece-render.ts`, plus the `lib/acl.ts` loaders, beside
`stepPiece`, whose seam (#6556) the rest are modeled on. `withAcl`
disposes only a runtime it opened itself, so an ACL call over a held
connection leaves it open. Each carries the unit test the seam makes
possible — a controller stub driving the function's body against a doubled
piece, with no socket and no server behind it — which is the PR's
standalone value.

**A3 — extract `callFromCommand`.** Done (#6682). `call` carries the
named-export shape its siblings have: the mount's spelling and the two
arrays Cliffy splits the argv into — this command's own arguments, the
line past `cf call`, which a grammar refusal reprints, and the words past
`--`, which the read step parses — are parameters beside the options and
the positionals, so nothing under the action line needs the binding. The
dispatch and the `render`/`hint` sinks ride a deps bag, which holds
collaborators and no data. Its unit tests drive the whole action over a
stub dispatcher and reach the success tail, which is what the extraction
is worth in coverage: seven lines of `commands/piece.ts`, measured, and no
other tracked file moves. The package's coverage shadow is real and lies
elsewhere — it opens inside the chained `piece` command expression, around
its first inline action, and `buildCallCommand` is a standalone function
well before it.

**A4 — exit and output seams audit.** Done. `exitWithDataError` and
`exitPieceCallFailure` default to `Deno.exit(1)` and take a `deps`
override in its place — `printError`, `printHint`, and an `exit` typed
`never` — and every seam a v1 verb reaches forwards the caller's own:
`getCellValueFromCommand`, and `callFromCommand` at each of its three
exits, the payload rejection reported from inside the dispatch's promise
chain included. An `exit` typed `never` throws rather than returning, so
that rejection's throw lands in the action's own catch;
`callFromCommand` records that an exit ran and rethrows, rather than
describing the shell's exit as a second failure of the call.
`describePieceFromCommand` takes `render`/`hint` beside them, so its page
and next steps land where the caller puts them, and the confirmation
`cf call` puts on stderr for a JSON payload — so that stdout stays the
machine surface — rides the caller's `printError` rather than the
process's. The bulk seams — survey, repair, retarget, `setsrc --check` —
are on no v1 verb's path and keep the exits they have. Each threaded
seam carries the test the override makes possible: an injected exit that
throws, and the report read back as a value.

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
and its owner module — the whole pair, position *and* scope, because scope
is half of what a place is (decision 20): `cd @user` and `cd @space` move
it, the prompt renders it, and `pwd` prints both halves. The prompt, a
readline loop, and `cd` / `ls` / `pwd` / `get` over one held
`PiecesController`, with `cd -` for the previous place and `#name` wish
targets navigable within the connected space (`cd #favorites`, and the
`wish` verb, over the `./lib/wish` export entry A1 adds; a home-anchored
target from elsewhere is refused with the reason — decision 5). Slug and
name resolution rides the machinery `--piece` already uses
(`resolveStoredPieceAddress`, `listSpaceSlugs`), so no CLI-surface arc
step gates B1. `where` lands here as the printing
surface for the ambient record; later milestones add their dimensions to it
as they add the dimensions themselves. Facets `slugs/` and `pieces/` only.

Liveness, in two halves. The held controller is memoized cf-harness-style,
which covers the construction that never succeeds — the case that cache
actually addresses. Recovery of an *established* connection needs nothing
from shuttle: the memory client reconnects and re-arms its watches by
itself ([`runtime-integration.md`](runtime-integration.md)), so B1 proves
that rather than rebuilding it — a test that drops the transport under a
standing watch and shows the subscription still delivering afterwards. What
B1 does build is the observation seam, reporting live, reconnecting, and
permanently failed, because no such surface exists today and both the
prompt and the view markers consume it. No retry loop in shuttle on either
half.

**B2 — writes, calls, handles** (after A2, A3, and A4 — a failed call or
write must surface as a value, never reach `Deno.exit`). `set` with
inline values,
`edit` over `$EDITOR`, and `link` — the one spelling that writes a
reference instead of copying a value (decision 14), which leans on
`cf piece link`. `edit` is the only write of the three with no `cf`
equivalent behind it. `call` through
`callFromCommand`, with `verbs` and `describe` beside it, since listing a
piece's callables is what makes `call` usable without leaving the shell.
Numbered handles from listings land here, and `more` with them: `more`
continues a listing *and its handle numbering* (decision 24), so it needs
the handle table, not merely a page cursor. Handles are structured at mint
— each row's kind, plus receiver and verb name for a callable row — which
is what `call %n` resolves against (decision 27). The invocation session is
minted once at startup and passed explicitly. The step-10 call section
is shuttle's own line grammar, parsed locally and fed to the
schema-derived flag machinery `cf` already exports (`pieceCallRawArgs`,
`pieceCallInvocation`), so no arc step gates it either. Reaching-in-warms
lands here, since `set` is what makes stale computed state visible.

**B3 — watch and views** (after A4; view-substrate export entries added
here). `Cell.sink` with the guard-plus-`idle()` settling discipline; the
value, list, and structured piece-overview views on the `cf view` pager
substrate; session watches (`watch`, `watches`, `unwatch`) with prompt
event lines. Governed by [`views.md`](views.md); it opens with the two
experiments and the raw-document-subscription proving test from issue
[#6534](https://github.com/commontoolsinc/labs/issues/6534), falling back
to the capped deep sink if the seam disappoints.

**B4 — externals and escapes.** `>` and `<` to and from `file:` externals
under the scheme-absolute rule; the external working location
(`xcd`/`xpwd`, the `x:` base); the `!` escape family — line-initial `!`,
`|!` in a pipeline (bare `|` reserved, its error naming `|!`), and `!cf`
with place-derived flags injected. With the external location, `where`
reaches its v1 surface: every dimension printed, the light ones settable
(decision 22).

B4 closes v1. The deferred set — the pinned strip, cold-browse mode, the
native tool set, heavyweight `where` edits, the `fuse/` facet,
fabric-to-fabric redirection, `https:` read ends, and `search` — is
designed and preserved in [`futures.md`](futures.md), each returning as
its own slice when scheduled.

## Working rules

- Every stage-A PR carries the unit tests its seam enables; a seam PR
  without tests is the shape the `FromCommand` rationale exists to
  prevent.
- `packages/cli` coverage gates apply to stage A; the extraction PRs are
  coverage-positive by construction, which is the order's second reason.
- Shuttle stays out of `deno task check`'s path list until B1 gives it
  real code, and registers there in the same PR that does.
