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
`./lib/wish`, `./lib/piece-render`, and `./lib/llm-friendly-ref`, which a
place reads every reference operand through. The completion listing is not a
plain
entry: it is `listCellKeys` in `packages/cli/lib/cell-listing.ts`,
exported as `./lib/cell-listing` behind a `PieceResolutionDeps` seam with
`keysOf` beside it. The providers are designed to fail silently and
empty — right for tab completion, wrong for `ls` — so the listing raises
its errors and completion's provider dispatch swallows them at its own
call site. Keep the list to what shuttle names — an export entry is a
contract, and the short list is the record of which internals have a
second caller. (The view substrate's entries are not on it, nothing having
named them yet; each lands with the milestone that first calls it, which is
how a module earns its place on that record.)

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
line past `cf piece call`, which a grammar refusal reprints, and the words past
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

**A4 — exit and output seams audit.** Done (#6704). `exitWithDataError` and
`exitPieceCallFailure` default to `Deno.exit(1)` and take a `deps`
override in its place, each with an `exit` typed `never` beside the sinks
its own report needs — `printError` and `printHint` for the data error,
`printError` and `render` for the call failure, whose expiry writes
Invocation JSON to the machine surface. Every seam a v1 verb reaches
forwards the caller's own:
`getCellValueFromCommand`, and `callFromCommand` at each of its three
exits, the payload rejection reported from inside the dispatch's promise
chain included. An `exit` typed `never` throws rather than returning, so
that rejection's throw lands in the action's own catch;
`callFromCommand` records that an exit ran and rethrows, rather than
describing the shell's exit as a second failure of the call.
`describePieceFromCommand` takes `render`/`hint` beside them, so its page
and next steps land where the caller puts them, and the confirmation
`cf piece call` puts on stderr for a JSON payload — so that stdout stays the
machine surface — rides the caller's `printError` rather than the
process's. `announce` beside those carries what a call publishes in
flight — the invocation pair, and the spans under `--verbose` — which
raw stderr serves for a one-shot command and corrupts for a caller
drawing its own screen. The bulk seams — survey, repair, retarget,
`setsrc --check` — are on no v1 verb's path and keep the exits they have.
Each threaded seam carries the test the override makes possible: an
injected exit that throws, and the report read back as a value.

**A5 — module-global state.** Done (#6717), as the recorded limit rather
than as scoping: **shuttle v1 holds one connection per process**, revisited
when
multiple places arrive ([`futures.md`](futures.md) candidate 3). What the
limit covers is `quietMode` (`commands/piece.ts`), the process's hint
posture; `receipted` (`lib/write-receipt.ts`), which memoizes the write
receipt for the life of the process; and a connection's own settings —
the LLM endpoint, the base URL a pattern's relative `fetch` resolves
against, and the ambient experimental flags a `Runtime` applies — which
land in globals under `packages/llm` and `packages/runner` that no
connection owns. Part of that is mechanically enforced and the rest is
prose: `claimProcessDeployment` (`lib/process-deployment.ts`) refuses a
connection to a second *deployment*, a weaker bound than the limit and
the one where those settings actually fight, since a verb reaching an
un-injected library function opens another connection to the same
deployment as a matter of course. The three declarations that name the
limit are all in `packages/cli`; the inventory, both bounds, and the
globals in the other two packages, recorded there and nowhere else, are
in item 6 of [`runtime-integration.md`](runtime-integration.md).

## Stage B — the shuttle package

**B0 — scaffold** (after A1). Done (#6741). `packages/shuttle` is a
workspace member: its path sits in the root `deno.jsonc` workspace array,
and its
own `deno.jsonc` carries the `tasks.test` entry — without which a
`deno task test` run there resolves the root workspace task instead and
re-runs the whole suite inside itself. The scaffold is configuration
alone: no package name and no exports, because nothing imports shuttle
and an export entry is a contract, and no dependency, because
`deno task check-unused-deps` fails an alias no source file imports. It
ships no source either. That is what the working rule below asks for —
shuttle joins `deno task check`'s path list with B1's code — and it
leaves `coverage-debt: packages/shuttle`, a metric group the gate
derives from the path with no allowlist, at zero, so B1 lands its code
and the tests covering it together.

**B1 — walking skeleton** (after A1; A2 for nothing yet). Landing in
slices, and open until the last of them lands. Each slice moves what it
built into the first list.

Landed:

- **B1a — the place value and its owner module**
  (`packages/shuttle/src/place.ts`). The whole pair, position *and* scope,
  because scope is half of what a place is (decision 20): `cd` over relative
  segments, `..`, `-`, `/`, a scope-only `@scope`, and rooted and complete
  references; the `slugs/` and `pieces/` facets a space root reserves, and
  nothing else there; the rendering `pwd` prints of both halves, the position
  line carrying the scope so that it denotes one cell wherever it is read; and
  the refusals — a reference carrying `#argument`, a `#` buried in a bare
  piece id, a part no rendering would name back, and a move into a space other
  than the connected one, which is the gate a home-anchored entry point meets
  once resolution hands it a space. Two operands come back for the connection
  rather than moving: a `#name` wish target, which B1b resolves, and a
  reference naming its space by name, which is a two-step protocol — the
  caller resolves the name and hands the move back with the space it resolved
  to, and the place is landed or refused there.
- **B1b (slice 1) — the held connection**
  (`packages/shuttle/src/connection.ts`). One `PiecesController` for the
  process, opened on the first ask and served to every ask after, where `cf`
  builds one per invocation. The connection half of the ambient record maps
  onto `SpaceConfig` and is handed to `loadPieces`, so shuttle reaches the
  connect sequence and none of the flag parsing in front of it. The memo is
  cf-harness's: a rejected construction is not held, so the next ask opens
  again rather than replaying a terminal failure, which covers the connection
  that never opened and says nothing about one that later drops. Ownership is
  named by the source rather than inferred from an overridden collaborator —
  a connection opened here is closed here, one handed over is left to whoever
  opened it — so either can be driven with no socket behind it. A close that
  fails is terminal: the disposal stays rejected and the holder serves nothing
  after it, which is what a disposal that is process shutdown wants. A
  `disconnect` verb makes a run carry on past one, and then a single transient
  teardown error kills the holder for the rest of the run — so that verb
  revisits this trade rather than inheriting it. No verb reaches the
  connection yet, and the place is untouched.

- **B1b (slice 2) — the line grammar** (`packages/shuttle/src/line.ts`). How
  a line becomes tokens, and how a value prints as one of them. `cf` is
  handed words the operating system's shell already split; shuttle is handed
  the line, and both halves are its own. The split is POSIX quoting —
  whitespace separates, single quotes are literal, double quotes group, a
  backslash escapes one character and between double quotes only a quote or
  another backslash, and runs that touch are one token — and a line is
  refused for one of two reasons: a quote that never closes, naming the
  column it opened at, and a trailing backslash with nothing to escape.
  The printer quotes only where quoting is needed, which is what keeps a
  slug, a handle, a flag and a path each printing as themselves; what forces
  it is whitespace, either quote, the backslash, and the characters the
  grammar spends on structure, collected in one constant rather than counted
  in prose. The characters an operand writes an address with stay out of that
  set: what the pair guarantees is that a printed value splits back into that
  one value, and a quote reaches no further than that. No verb reads a line
  yet.

- **B1b (slice 3) — `ls`, and the vocabulary a segment speaks**
  (`packages/shuttle/src/listing.ts`). What stands at a place — a space root's
  facets, the slugs the index records, the space's pieces, the keys directly
  under the cell a place names — read over the held connection through
  `listSpaceSlugs`, `listPieces` and `listCellKeys`, each of which takes that
  connection as `deps.loadPieces`. A row that failed on its own account is
  still a row and carries what went wrong; a read that failed outright raises.
  `slugs/` says what it is a listing of. Its index records the names assigned
  since it existed, which is not the set of slugs that resolve: one assigned
  before the index is not listed, and one that is listed may no longer resolve,
  nothing removing an entry once made. So `ls slugs/` does not enumerate what
  resolves, and a row carries its own error where the name it lists reaches
  nothing. A slug stands in a place unresolved and the read resolves
  it the way `--cell` does, which is what makes a slug typed back off a listing
  reach its piece.

  The slice settles the two questions held for it, both of them recorded in
  [`grammar.md`](grammar.md). A quote reaches no reading, so a name whose own
  characters are readings prints as the reference that names it rather than as
  a quoted spelling of itself — which is what makes every name a listing prints
  one `cd` takes back to that row, and leaves the split returning plain
  strings. And every door holds a piece to the slug and handle vocabularies,
  `validatePieceSegment` being called rather than copied, so a walk, a resolved
  target and a settled move hold a piece to what a reference holds one to, and
  give its reason. What the first ruling costs is one shape: a key whose first
  character is `#` has no direct spelling — neither the name on its own nor a
  reference names it — and a listing prints no name for it. Some multi-segment
  operand does reach it, `#` being data in every segment but the first, but a
  route is not a name; [`grammar.md`](grammar.md) carries the ruling and
  characterizes the routes no further. Which keys are spelled through one door
  and
  not the other is pinned case by case in
  `packages/shuttle/test/place.test.ts`, each case under a mutation, so the
  record moves when the behavior does and not otherwise.

Still to come:

- **The prompt, a readline loop, and the verbs** (B1b for the verbs and
  the connection, B1c for the prompt) — `cd` / `ls` / `pwd` / `get` read off
  a line and dispatched, over one held `PiecesController` and over the
  listing above, with `#name` wish targets
  navigable within the connected space (`cd #favorites`, and the `wish`
  verb, over the `./lib/wish` export entry A1 adds; a home-anchored target
  from elsewhere is refused with the reason — decision 5).

  The line editor is the view substrate's rather than `node:readline`'s.
  `EditBuffer` (`packages/cli/lib/view/editbuffer.ts`) holds the motions and
  the substrate's key handler binds them to emacs keys, and `decodeKeys`
  (`packages/cli/lib/view/keys.ts`) supplies the key stream a binding table
  reads — where `node:readline` offers no keymap hook at all, so a second
  binding table is unreachable behind it. That is what keeps modal editing
  an option later ([`futures.md`](futures.md)), and it is what brings the
  view substrate's export entries with the prompt: the line editor calls
  those modules, and an entry lands with the milestone that first calls one.

- **`where`** (B1c), the printing surface for the ambient record; later
  milestones add their dimensions to it as they add the dimensions themselves.
  It prints the record `pwd` prints, so it chooses the format for both — a
  test helper reads that format back by slicing a label width, which is what a
  change to it has to move with. `pwd` is complete and has no short form, the
  prompt being the short surface, so a format that shortens has to stay
  pasteable — and decision 13's shortened-id fallback is a prefix spelled
  exactly like a whole handle, which is the part that does not. The format's
  own hazards belong with it: a newline in a part is refused before it reaches
  a place, because it would leave a shorter reference naming another cell,
  while a carriage return, a vertical tab, a form feed, a no-break space and
  the Unicode line and paragraph separators all read back whole and reach only
  a terminal.
- **Liveness, in two halves.** Recovery of an *established* connection needs
  nothing from shuttle: the memory client reconnects and
  re-arms its watches by itself
  ([`runtime-integration.md`](runtime-integration.md)), so B1 proves that
  rather than rebuilding it — a test that drops the transport under a
  standing watch and shows the subscription still delivering afterwards.
  What B1 does build is the relay that carries the memory client's
  connection state up, reporting it as live, reconnecting, and permanently
  failed, because the storage layer publishes none today and both the
  prompt and the view markers consume it. No retry loop in shuttle on
  either half.

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

**B3 — watch and views** (after A4; the substrate modules it is first to call
bring their export entries with them). `Cell.sink` with the guard-plus-`idle()`
settling discipline; the value, list, and structured piece-overview views on
the `cf view` pager substrate; session watches (`watch`, `watches`, `unwatch`)
with prompt event lines. Governed by [`views.md`](views.md); it opens with the
two experiments and the raw-document-subscription proving test from issue
[#6534](https://github.com/commontoolsinc/labs/issues/6534), falling back to
the capped deep sink if the seam disappoints.

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
