# Shuttle — build sequence

Satellite of [`README.md`](README.md): the order of construction,
as small landable pull requests. Stage A is seam work inside `packages/cli`
— each PR stands on its own merits there, shuttle or no shuttle, because a
seam that lets a sibling inject a connection is the same seam that lets a
unit test run the action body (the documented rationale of the
`*FromCommand` family). Stage B is the shell itself, in vertical slices,
under `packages/cli/lib/shuttle/`. A-PRs go first in line because they gate
everything and review latency is the scarce resource; B milestones start as
soon as their named prerequisites land.

## Stage A — seams in `packages/cli`

**A1 — the library seams a place reads through.** Done (#6626). Each is
reachable on its own, without the module that builds the command tree:
`lib/piece`, `commands/piece`, `lib/wish`, `lib/piece-render`, and
`lib/llm-friendly-ref`, which a place reads every reference operand through.
The completion listing is the one that took work: `listCellKeys`
(`packages/cli/lib/cell-listing.ts`) sits behind a `PieceResolutionDeps` seam
with `keysOf` beside it, and the providers are designed to fail silently and
empty — right for tab completion, wrong for `ls` — so the listing raises its
errors and completion's provider dispatch swallows them at its own call site.
The shell reads four of them — `lib/piece`, `lib/wish`,
`lib/llm-friendly-ref` and `lib/cell-listing` — with `lib/cell-selection`
beside them and `commands/piece` read by the command rather than by a place;
`lib/piece-render` waits for the milestone that renders a piece. Each is
reached by relative path, the view substrate with them: the shell is this
package's own code, so `packages/cli/deno.jsonc` carries `.` alone, under the
rule the map states.

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
Invocation JSON to the machine surface. Each seam that reports through one
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

## Stage B — the shell itself

**B0 — scaffold** (after A1). Done (#6741). The shell needs no
configuration of its own. It sits under `packages/cli/lib/shuttle/`, so
`deno task check` reaches it through that package's path entry, its tests run
under that package's runner, and its uncovered lines land in that package's
coverage group. What a package of its own would have needed — a path in the
root `deno.jsonc` workspace array, and a `tasks.test` entry in its own, without
which a `deno task test` run there resolves the root workspace task instead and
re-runs the whole suite inside itself — `cli` has already.

**B1 — walking skeleton** (after A1; A2 for nothing yet). Landing in
slices, and open until the last of them lands. Each slice moves what it
built into the first list.

Landed:

- **B1a — the place value and its owner module**
  (`packages/cli/lib/shuttle/place.ts`). The whole pair, position *and* scope,
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
  (`packages/cli/lib/shuttle/connection.ts`). One `PiecesController` for the
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

- **B1b (slice 2) — the line grammar** (`packages/cli/lib/shuttle/line.ts`). How
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
  (`packages/cli/lib/shuttle/listing.ts`). What stands at a place — a space root's
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
  characters are readings prints as the reference that names it rather than
  as a quoted spelling of itself — which is what makes every name a listing
  prints one `cd` takes back to that row, and leaves the split returning plain
  strings. And every door holds a piece to the slug and handle vocabularies,
  `validatePieceSegment` being called rather than copied, so a walk, a resolved
  target and a settled move hold a piece to what a reference holds one to, and
  give its reason. What the first ruling costs is one shape: a key whose first
  character is `#` has no direct spelling — neither the name on its own nor a
  reference names it — and a listing prints no name for it. Some multi-segment
  operand does reach it, `#` being data in a segment that names a data key,
  but a route is not a name; [`grammar.md`](grammar.md) carries the ruling and
  characterizes the routes no further. Which keys are spelled through one door
  and
  not the other is pinned case by case in
  `packages/cli/test/shuttle-place.test.ts`, so the record moves when the behavior
  does and not otherwise.

- **B1b (slice 4) — the verbs** (`packages/cli/lib/shuttle/verbs.ts`). A line
  splits, its first token names a verb, and the tokens after it are that
  verb's operands: `cd`, `ls`, `pwd`, `get` and `wish`, over the one held
  connection and over the listing above. Nothing writes. A verb returns what
  it did — a place that moved, text shuttle wrote, a value the fabric holds,
  or a refusal carrying its reason — so where any of it lands is the prompt's
  decision, and every case drives the whole surface with no terminal behind
  it. A read that failed is the one thing that is not an outcome: it raises,
  so a server that cannot be reached is told apart from a line that was
  wrong.

  The slice settles the two `Move` arms B1a left for the connection. A
  `#name` target resolves through `readWish` asked for the target's
  *address* rather than its value, which is what `--select` spells `@`: the
  space a target resolved in rides in the answer, so a home-anchored one is
  refused with the reason decision 5 gives and nothing has to know which
  targets are anchored where. A space written as a name is held against the name
  the connection was opened under (`PiecesController.getSpaceName`). One
  connection serves one space, so all such a reference can want to know is
  whether it names this one, and the recorded name answers that — the
  comparison being exact is not an approximation of the key derivation but its
  own answer, since a named space's key hangs off the name's bytes and the
  reference reading has already read back the `~1` a name holding the
  separator is written with. A session opened by a DID recorded no name and is
  refused, which is the honest arm rather than an error path: whether a name
  denotes that space is exactly what it cannot say, and the refusal names
  starting against that name as what would. What `cd` asks a wish through is
  `--select`'s own parser (`lib/cell-selection.ts`), read by relative path as
  every seam here is.

  `get`'s operand goes through the door `cd`'s goes through *plus the
  `#argument` suffix that door turns down*, read from where shuttle stands
  rather than from a standing built for the occasion, which is what makes the
  two agree about `..`. `CurrentPlace.aim` is that door and
  `CurrentPlace.resolveNamedSpace` the settling twin beside it. A place is
  result-rooted and cannot stand in an arguments cell, which is why `cd`
  refuses the suffix in every spelling; reading one is a different act, and
  `get topics/3#argument` is how an operand asks for it.

  The one spelling `get` does not take is a `#name` target: `cf cell get`
  takes none and `cf wish` does, and a data verb here means what it means
  there. The two `#` readings pull opposite ways for a reason that is not
  arbitrary — the suffix says which of a piece's two cells to read and its
  place is reachable either way, so refusing it would put a cell out of reach,
  while a `#name` is a whole target with a verb of its own that answers a
  second way as well as a second time, so taking it would put a second answer
  in reach.

- **B1c — the prompt, `where`, and the launcher.** A line read off a terminal,
  handed to the dispatch above, and its outcome written under it. Where a run's
  output comes from is one place: a verb returns what it did rather than
  writing it, so everything a line puts on screen passes through the prompt in
  the order the person caused it, and a case drives the whole loop with a
  scripted key stream and reads back what it produced. A refusal and a read
  that failed both land there as text and the loop reads the next line — what
  the seam's distinction buys here is that a shell whose server went away is
  still a shell.

  The line editor is the view substrate's rather than `node:readline`'s.
  `EditBuffer` holds the motions and `decodeKeys` supplies the key stream a
  binding table reads, so the bindings are a value with room for a second table
  beside it — which is what keeps modal editing an option
  ([`futures.md`](futures.md)). `node:readline` has no supported place for a
  second table: its exported surface is an interface, three cursor helpers and
  a keypress decoder, and that interface's prototype carries one public method,
  `question()` — everything else on it, the key dispatch `_ttyWrite` among
  them, is underscore-prefixed.
  What is exported and would have helped — the keypress decoder — is the job
  `decodeKeys` already does, so the interface is the part that cannot be
  reused and the decoder is the part there is no need to.

  `where` prints the whole ambient record, and so chooses the format `pwd`
  prints two dimensions of: one dimension to a line, its name in a column of
  fixed width, and the width exported so a caller reading a value back slices
  it rather than spelling the label again. Each dimension is named by whatever
  owns it — the connection's three by the connection, the place's two by the
  place — and `where` reads nothing, so it still prints for a shuttle whose
  connection will not open.

  The prompt carries the place short, and the only shortening it does is
  leaving the space out: one connection serves one space, so that part is the
  same on every line of a run and `where` prints it. Nothing else is
  abbreviated, which leaves decision 13's checked names and the shortened-id
  question they raise exactly where [`grammar.md`](grammar.md) has them — the
  prompt is no address, and `pwd` is what to copy.

  The launcher is decision 19's pair. `cf sh` is a command in the `cf`
  tree, with the three flags every command taking a space and an identity
  declares, read once by `parseSpaceOptions` and handed on as a settled
  connection; its action imports what it runs, the shell being this package's
  own code. `bin/cfsh` forwards to `cf sh` and carries no checkout logic
  of its own.

Still to come:

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

**B3 — watch and views** (after A4). `Cell.sink` with the guard-plus-`idle()`
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

One question B4 settles rather than inherits: what a rendering carries when
it is not going to a terminal. Up to here there is one destination, and it
is what the treatment of a control character rests on — a message is
glyphed and a name refused because a person is reading them on a terminal
([`grammar.md`](grammar.md)). `>` to a `file:` external and `|!` into a
pipeline are the second destination, and the same treatment reads
differently there: glyphs in a file are noise rather than safety, and a
redirected `get` is where somebody wants the value as the fabric holds it.
Which way that goes is open. The canonical output form
([`futures.md`](futures.md)) forks on the same fact for the same reason, so
whichever answer B4 takes is the one that form inherits.

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
- A slice adds no configuration of its own: the shell is `packages/cli`'s
  code, so it rides that package's entry in `deno task check`'s path list, its
  test runner, and its coverage group. A test file that stands in for a
  process-wide member — an environment variable, a `Deno` member — goes in that
  runner's `SERIAL_TESTS` list, because the parallel pass runs every other file
  on a thread of one process.
