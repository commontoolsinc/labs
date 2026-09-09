---
status: historical
created: 2026-09-05
archived: 2026-09-05
reason: "Architecture and implementation review of shuttle at the end of B1, before B2 starts; a point-in-time assessment with the changes it asks for."
---

# Shuttle at the end of B1: an architecture and implementation review

## Scope and method

The subject is the shuttle project as a whole — the design under
`docs/plans/shuttle/`, the code under `packages/cli/lib/shuttle/`, the `cf sh`
command, and the stage-A seams in `packages/cli` insofar as the shell rests on
them. The tree reviewed is `main` at `7ac15b4382` with the two open pull
requests applied on top: #6901 (the prompt, `where`, and `cf sh`) and #6975
(operand edges read as written), tip `0ffb74b0e5`. Seventeen merged pull
requests preceded them; they were used to find the relevant files, not as the
unit of review.

Three kinds of evidence were used, and each finding says which it rests on:

- **Reading.** Every module under `lib/shuttle/`, `commands/sh.ts`,
  `bin/cfsh`, the seven design documents, and the seams the shell calls
  (`loadPieces`, `getCellValue`, `listCellKeys`, `readWish`,
  `normalizeLLMFriendlyRef`, `claimProcessDeployment`, `PiecesController`).
- **The unit suite.** `packages/cli`'s runner over the eleven shuttle test
  files.
- **Driving the shell.** A toolshed started from this tree on a port offset, a
  fresh space holding the `counter` and `simple-list` example patterns under the
  slugs `counter` and `todo`, and `cf sh` driven through a pseudo-terminal with
  external `cf` commands interleaved between lines. Every behavioral claim
  below marked *observed* was seen in that session.

The audience weighting given for the review: the operator debugging a live
space first, the pattern developer's inner loop second. The built foundation is
judged against the unbuilt B2–B4 stages, not only against what exists.

## Summary

The foundation is well made and the design is unusually well recorded. The
place model, the line grammar, the held connection, and the terminal layer are
each a small module with one owner, a value-returning surface, and a test file
that drives it with nothing behind it. The refusal messages are the best in the
repository. The reference grammar is consumed rather than forked, and every
piece name passes the canonical vocabulary check whichever door admitted it.
The design documents ask and answer questions a reviewer would otherwise have
to ask.

What is wrong is not in what was built but in what the build order left out,
and in three places where a settled decision and the running code disagree.
Driving the shell for ten minutes against real pieces produced the following,
each of which an operator will hit in their first session:

1. `cd` verifies nothing. It lands on keys, pieces, and slugs that do not
   exist, and every later command fails with a raw runtime error.
2. A rooted `/slugs/todo` is silently read as a piece slugged `slugs`, so the
   spelling a person learns at the root is a trap one level down.
3. Computed values are served stale from storage with no label, which is the
   exact failure decision 10 exists to prevent.
4. A read that has to reach the server cannot be interrupted. Keystrokes typed
   during the wait are queued blind and executed when it returns.
5. `get` at a piece dumps the whole `[UI]` tree, hundreds of lines of it.
6. There is no `help`, no command history, no completion, and no option
   grammar — `get --help` is read as a path.

None of these is hard to fix, and several are already scheduled. The argument
of this review is that four of them (1, 3, 4, and the option grammar behind 6)
are foundations B2 will build on rather than features B2 adds, and that
building writes and calls on top of the current shape will make each of them
more expensive to correct than it is today. The rest of this document says why,
and what to change.

## Strengths worth keeping

These are named so that the changes below are read as adjustments to a sound
structure and not as a call to rework it.

- **Value in, value out.** A verb returns an `Outcome`; the prompt decides
  where it lands; the terminal module is the only one that touches a TTY. This
  is the right shape for B3, where the same outcome has to land in a view, an
  event line, or the scrollback, and it is what makes the whole loop drivable
  from a scripted key stream.
- **The place is a value with doors.** `place.ts` reads the operand through
  the canonical parser, adds only the navigation spellings that parser has no
  room for, and refuses at every door what no rendering would name back. The
  round-trip property — every name a listing prints is one `cd` takes back —
  is tested by construction over awkward parts rather than by example.
- **Two-step settling.** A move that needs a read (a `#name` target, a space
  written as a name) comes back unlanded and is settled by the layer that
  holds the connection. This is exactly the seam finding 1 below needs; it is
  already there and only has to be used for one more case.
- **The held connection.** `HeldConnection` memoizes one controller per
  process with cf-harness's rejection policy, owns or borrows explicitly, and
  disposes once. Every read reaches it through `deps.loadPieces`, so no verb
  opens a socket of its own. The unit tests cover the racing cases (disposal
  crossing a construct, a second dispose during the first) that usually go
  untested.
- **Terminal safety.** Control characters are refused at the doors as names
  and glyphed or JSON-escaped as messages and values, with the reasoning for
  the difference written down. Raw mode is restored on every exit path a
  process can bind. This is more care than `cf view` took.
- **The refusals.** Every refusal names what was wrong and what would have
  worked. `cd #favorites` refused with the home space's DID, the connected
  space's DID, and the sentence "a shuttle started against that space" is the
  standard the rest of `cf` should be held to.
- **The record.** Design documents distinguish ruled from proposed, say what
  each decision costs, and record the road not taken where a future reader
  would otherwise re-derive it. `futures.md` preserves deferred designs so
  they are re-scheduled rather than re-litigated.

## Changes required

Ordered by how much later work each one gates. Each names the evidence, the
reason, and the recommended change.

### 1. `cd` must settle a move against the fabric before adopting it

**Observed.** From `counter`, `cd nosuchkey` lands; the prompt reads
`counter/nosuchkey`; `ls` then reports `Cannot access path "nosuchkey"`. From
`pieces/`, `cd nonexistent-slug` lands the same way. From `/`, `cd /slugs/todo`
lands on a piece named `slugs` (finding 2) and every later command reports
`Slug "slugs" not found`.

**Why it matters.** A shell's `cd` is the one command whose success means
something: after it, the prompt is a promise that the place exists. Here the
prompt promises nothing, and the failure surfaces one command later with the
runtime's own message rather than shuttle's. For an operator debugging a
misbehaving space this inverts the tool's purpose — the tool now needs
debugging. It also bears on B2 directly: `set` and `call` will be issued
against places `cd` never checked, and a write to a slug that no longer
resolves, or to a path that does not exist, is a write the receipt will
describe as having succeeded somewhere.

**The design already allows it.** `place.ts` is value-only by decision, and
correctly so. But decision 5 and the B1a record already give `cd` a two-step
protocol for spellings that need a read, and `verbs.ts` already runs it for two
of them. A relative segment inside a piece and a slug inside a facet are two
more spellings that need a read; they should come back from `movePlace`
unlanded in the same way, and `landing` should settle them by reading — a
`listCellKeys`-shaped existence check for a key, `resolvePieceAddress` for a
slug or handle — and refuse with a shuttle-worded reason when the read finds
nothing.

**What it costs.** One read per `cd`, on the connection the process already
holds. In the driven session every read returned in under 0.3 s. The
alternative, a place that may not exist, costs a read on every later command
anyway, plus the confusion.

**Recommended.** Add a `pending` arm to `Move` carrying the position to
verify; settle it in `verbs.ts` through the existing deps; refuse with the
reason and the sibling keys where the read has them (the runtime's message
already lists "Available keys: decrement, increment, value" — shuttle should
print that as its own refusal rather than as a relayed error). Keep
`CurrentPlace.aim` value-only, since `get` reads anyway and its failure is the
read's.

### 2. A rooted reference whose first segment names a facet must be ruled

**Observed.** `cd /slugs/todo` from the root lands on a piece named `slugs`
with path `todo`; the prompt reads `slugs/todo`, one character away from the
facet rendering `/slugs/`; `pwd` prints
`/@did:…/slugs@space/todo`. `cd /pieces` likewise. Both are correct by the
grammar as written — facets are reserved at the root only, and a rooted
reference is the canonical grammar's — and both are a trap.

**Why it matters.** The shell teaches `cd slugs` and `cd pieces` at the root
in its first minute. The natural next spelling, from anywhere, is
`cd /slugs/todo`. It is what every filesystem shell would mean, and the
listing at `/` printed `slugs` as a name `cd` takes. The grammar document's own
principle — a rendering may be refused but may never name a cell other than
the one it was printed for — is preserved only because the facet rendering
lacks a leading slash; a person adds one without noticing.

**Recommended.** Rule that the facet names are reserved as the first segment
of a rooted reference too, and read `/slugs/<x>` and `/pieces/<x>` as walks
from the root. This costs exactly one thing: a piece slugged `slugs` or
`pieces` is reachable by handle and not by slug through a rooted spelling. The
root already pays that cost, and a slug named after a facet is one the slug
vocabulary could refuse outright at `set-slug`. The alternative ruling —
refuse the spelling with a message naming `cd /` then `cd slugs/todo` — is
acceptable but leaves absolute container paths unspellable, which B4's
redirection targets and any transcript a person pastes back will want.

### 3. Reaching in must warm, or every read must say it is cold

**Observed.** With the shell standing at `todo`, an external `cf cell set` of
the arguments cell changed `items`, and `get items` in the shell showed the
change at once (the subscription pushes). `get summary` — a computed value —
stayed `""`. After an external `cf piece step`, it read `"○ bread"`. After an
external `cf piece call … addItem --text jam`, `get items` showed two items and
`get summary` still read `"○ bread"`, and a fresh `cf cell get` confirmed that
is what storage holds until something runs the pattern. The `counter` piece
behaved the same: `get value` tracked every external write, `get '$NAME'` read
`"Counter: 0"` throughout. `verbs.ts` says so in its own words: "The read does
not start the piece, so a computed value is as fresh as the last thing that ran
the pattern."

**Why it matters.** Decision 10 says reaching in warms, "so every read shuttle
serves is live and v1 has no unlabeled stored-state path." The build sequence
defers that to B2 ("since `set` is what makes stale computed state visible").
Between the two, the shell today is the tool the README describes `cf` as: it
prints snapshots. For the operator use case this is the worst kind of wrong
answer — a confident value that is stale in a way nothing on screen says. For
the pattern developer it means every edit-and-check loop needs an external
step. Both audiences the review was asked to weigh are misled by it today.

**The mechanism.** `PiecesController.startPiece` and `stopPiece` exist and are
what `stepPiece` composes. A persistent shell wants `startPiece` once per
piece, a set of warm pieces held by the run, and `stopPiece` for each on the
way out. `getCellValue`'s `--step` dance (start, pull, idle, synced, stop) is
the one-shot shape and is not what to call; the shell needs the halves
separately.

**Recommended.** Land warming in B1's remaining slice rather than in B2, or —
if the warm set's lifecycle needs more design than fits there — land the cold
label first: until a piece is warm, `get` of a value the schema marks computed
prints a one-line marker saying so. Either closes the unlabeled path. Two
questions the warm set raises should be ruled at the same time and are not
ruled anywhere yet: whether a warm piece is ever stopped before exit (a long
session that touches hundreds of pieces has no cooling policy), and whether
`ls` of a piece warms it (decision 10 says merely listed pieces stay cold, but
`ls` inside a piece reads its whole value through `getCellValue`, which is a
read aimed into it).

### 4. The prompt loop must be an event loop before B2, not B3

**Observed.** With the toolshed paused, `get /todo/items/0/text` (a document
the session had not yet fetched) blocked. `ctrl-c` and `pwd` typed during the
wait were not echoed and did nothing. When the server resumed, the read
completed, the `ctrl-c` abandoned an empty line, and `pwd` ran. The signal
listeners in `terminal.ts` do not apply: in raw mode the terminal generates no
`SIGINT` for `ctrl-c`; it is a key, and the key is not read until the awaited
verb returns.

**Why it matters.** `runPrompt` is `for await (const key of terminal.keys)`
with `await report(...)` inside it, so the run has one event source at a time.
Three consequences:

- No line in flight can be interrupted. For the operator use case the server
  being slow or unresponsive is the normal condition of a debugging session,
  and a shell that freezes with it is a shell that has to be killed.
- Keys typed during a wait are queued and executed blind. Today the queue can
  only navigate and read. In B2 it can `set` and `call`.
- B3's event lines (decision 28) and views need the loop to multiplex keys
  with settled runtime changes. `views.md` names this as B3's first work
  item, but the prompt itself needs it, and B2's `call` — which publishes an
  invocation pair and spans through `announce` while it runs — needs somewhere
  to put those lines while a line is in flight.

**Recommended.** Restructure `runPrompt` so the key stream is read
continuously and a running line is a task beside it: `ctrl-c` while a line is
in flight cancels it (an `AbortSignal` threaded through `VerbDeps`, honored at
least between the read's phases even where the runtime's own reads cannot be
cut short), and any key that is not `ctrl-c` is either buffered into the next
line visibly or discarded with a bell — but never executed silently. Give
`PromptTerminal` a third write, the out-of-band line: text that lands above
the line being edited, with the prompt redrawn beneath it. That one primitive
is the event line of decision 28, the `announce` sink of A4, and the home for
the runtime's own console output (see finding 8). Doing it now means B2's
`call` lands on the loop it needs rather than on one it will have to replace.

### 5. `get` needs projection and a bound before B2 makes it the default read

**Observed.** `get` at the counter piece printed the whole result, including
`[UI]` as a vnode tree with base64 data URIs several hundred characters wide,
well over two hundred lines for the simplest example pattern. `ls` at the same
place is five lines.

**Why it matters.** Decision 7 says data verbs take `cf`'s read and projection
options — `--filter`, `--select`, `--schema`, `--json`. None is accepted;
there is no option grammar at all (finding 6). `getCellValue` already takes a
`selection`, and `parseCellSelectionOptions` already parses the flags, so the
seam is a matter of plumbing. Without it `get` is unusable at any piece root,
which is where a person stands after `cd`.

**Recommended.** Two changes. Accept the three projection flags on `get`
through the parser `cf cell get` uses, which needs the option grammar of
finding 6. And bound the default rendering: elide `$UI` unless asked for (it
is a rendering artifact, not state an operator debugs at this layer), and
truncate a value past a height-fit page with a status line naming `more` or
`--select`, the way decision 24 already rules for `ls`. The `cf view` pager is
in the same package and is the right destination for a long value; a `get`
that opens the pager when its output exceeds the screen would cost little and
serve the browse loop.

### 6. Decide the option grammar now, once, for every data verb

**Observed.** `get --help` was read as a relative path and refused as "names
no facet." `help` is not a verb.

**Why it matters.** Every B2 verb takes options: `set` a value or `-`, `call`
the step-10 section (verb name, schema-derived flags, `--`), `get` and `ls`
their projections and `--limit`, `more` its continuation. The design says the
call section is "parsed locally and fed to the schema-derived flag machinery
`cf` already exports," which is right, but nothing in `line.ts` or `verbs.ts`
distinguishes an option from an operand today, and the per-verb arity helpers
(`takesAtMostOne`, `takesNothing`) will not survive the first verb that takes
a flag. Deciding this per verb in B2 produces three small parsers.

**Recommended.** One rule in `verbs.ts`: after the split, tokens beginning
with `-` up to a bare `--` are options, parsed by a table the verb declares,
and the rest are operands; `-` alone is an operand (the stdin sentinel and the
previous place). Reuse Cliffy's option parsing on the token array where a verb
mirrors a `cf` command, so `--select`'s spelling and errors stay `cf`'s. Add
`help` and `<verb> --help` in the same change; a shell whose only help is a
refusal listing six words is not serving the "teammates second" audience
decision 3 names.

### 7. The place should hold a resolved piece, and the prompt a checked name

**Read.** `PiecePosition.piece` is "the piece as the operand named it: a
handle or a slug." Every read re-resolves it through `resolvePieceAddress`.
`samePosition` compares the string, so `slugs/todo` and
`pieces/fid1:KCUml…` are two positions for one cell, against the doc comment's
own promise that "two arrivals at one cell are one position."

**Why it matters.** Three reasons, in increasing order.

- Cost: a resolution per command, which finding 1's settle step would pay once
  at `cd`.
- Decision 13: the prompt should show a slug the index confirms and an id
  otherwise. Today it shows what was typed, so `cd pieces/fid1:…` shows a
  fifty-character handle for a piece that has a slug, and `cd slugs/todo`
  shows a slug the index may have since reassigned.
- B2: a slug is a redirect. If it is reassigned mid-session, a place held by
  slug silently moves to another piece, and the next `set` writes there. A
  place held by handle cannot move.

**Recommended.** Resolve to the handle at `cd` (the same settle step as
finding 1), store the handle in the position, and keep the slug beside it as
the name the prompt shows while the index still confirms it. `pwd` then prints
the handle form, which is the only form `namesResolvedParts` accepts for a
durable link — and `pwd` is ruled to be "what to copy."

### 8. Route every out-of-band writer through the prompt before pieces run

**Read.** `loadPieces` installs a `navigateCallback` that writes to raw
`console.log`, sets `consoleHandler` only under `jsonOutput`, and
`runtime-integration.md` item 5 lists the `console.warn` sites in
`lib/piece.ts` that a v1 verb reaches. The prompt has no way to receive any of
them: `PromptTerminal` writes under the current line and nowhere else.

**Observed.** An external `cf cell set` printed a runtime `[WARN] slow-traverse`
line to its own stderr. Nothing in the driven session made the shell's runtime
log, because no piece ran in it — which is finding 3. Once one does, a pattern's
`console.log`, the traverse warnings, and the navigate line land in the middle
of the painted prompt line, in raw mode, without the carriage return raw mode
needs.

**Recommended.** This is finding 4's out-of-band primitive with two more
producers. Set the runtime's `consoleHandler` and the navigate callback to it
in `run.ts`, and finish the item-5 sweep in `lib/piece.ts` before B2 warms a
piece. It belongs in the milestone that first runs a pattern in-process, which
finding 3 argues is the end of B1.

### 9. Pagination and handles are one design, and `ls` needs it before B2

**Read.** `renderListing` prints every row, unnumbered. Decision 24 rules a
height-fit page with a status line, decision 17 numbered handles, decision 27
handles carrying the row's kind and, for a callable, receiver and verb name.
`ListingRow` has a name, an operand, and an error, and no kind.

**Why it matters.** `ls` at `pieces/` in a populated space prints thousands of
lines, and the shell is a debugging tool for populated spaces. B2's `call %4`
needs the kind at mint time; B3's list view needs the same rows. Adding `kind`
to `ListingRow` now — container, value, link, callable, piece, slug — costs
one field and one classification per row, and it is what would let `ls` mark
a link row (the open question `pathref.md` leaves for `ls`) and a callable row
(what the grammar document promises "surface inline in listings, annotated as
callable").

**Recommended.** Give `ListingRow` a `kind` and a handle number in the next
listing slice, and print the page bound with the status line decision 24
describes. The handle table is a session object beside the place; `more`
continues it. This is scheduled for B2 and is right there; the point is to
land it as the first B2 slice, before `call`, since `call` reads it.

### 10. History and completion belong in v1, and neither is scheduled

**Read.** The bindings table has no `up`/`down`; `EditBuffer` has no history
surface; `futures.md` candidate 4 defers *persistent* history, which is a
different thing. No stage of `build-sequence.md` mentions completion, though
decision 3 names it as what serves the second audience and the prior-art
table says `lib/completion/providers.ts` gives shuttle its tab completion.

**Recommended.** In-session `up`/`down` over the lines this run typed is a few
lines on top of `EditBuffer` and should land with the option grammar. Tab
completion of verbs, facet names, slugs, and keys under the place is a call
into `listCellKeys` and the slug index the shell already reads, with the
candidates filtered by the prefix on the line; the completion package's
providers resolve their own connection from a half-typed `cf` line and are
not directly reusable, but the listing they read is. Schedule both explicitly,
and say which stage owns them.

## The move into `packages/cli`

Decision 2 originally placed shuttle in a package of its own and ruled out a
`cf` subcommand; #6901 reversed both, with the reasoning recorded in the
decision. The review was asked to weigh this as open.

**The move is right, on one condition.** Decision 9 already fixed the
execution model as in-process calls through `cli`'s library seams. A sibling
package would have needed every one of those seams exported — the seven
subpath entries #6626 added and #6901 removed — and each entry is a contract
`cli` has to keep for one consumer. `lib/view` is the precedent inside the
package for exactly this shape: a full-screen terminal subsystem with its own
directory, its own raw-mode module, and pure state beside it. And `cf sh`
means one binary to install and one `--space` to explain. Against it: `cli`
is already the largest package in the tree, `lib/piece.ts` alone is over
five thousand lines, and shuttle's tests, coverage, and type-check now ride
`cli`'s. That is a cost the package was already paying for `cf view`, and
shuttle adds around six thousand lines to it.

**The condition** is that the dependency direction inside the package is held
mechanically. Today `lib/shuttle/` imports only from `lib/` and
`commands/sh.ts` imports downward from it, which is correct: nothing under
`lib/shuttle/` imports `commands/`, and `parseSpaceOptions` is read by the
command rather than by a place. That is a fact about the current files and
not about the design, and the first B2 slice that reaches for `callFromCommand`
in `commands/piece.ts` will be tempted to import upward. Add a lint rule (the
`cf-imports` plugin already exists) that refuses `commands/` imports from
`lib/shuttle/`, and move `callFromCommand`'s library-grade half into `lib/` if
`call` needs it — which `runtime-integration.md` already argues is the one
wrapper worth reaching.

One consequence the decision text does not record: the prompt now says
`shuttle` and the command says `sh`, and `packages/cli/README.md` explains the
pair well. The `bin/cfsh` forward is fine as written.

## Stage A, as the shell rests on it

The seams are sound and the shell uses them as designed. Three observations.

- **`claimProcessDeployment` is the right bound and is weaker than the shell's
  limit**, as `runtime-integration.md` item 6 says. What the review adds:
  nothing in the shell today can violate the limit, but B2's `!cf` escape
  spawns a second process by design, so it is safe, while any B2 verb that
  reaches an un-injected function (`setPieceSlug`, `applyPieceInput`,
  `savePiecePattern`) opens a second connection to the same deployment in
  this process and leaks it — item 7's disposal point. The inventory names
  them; the B2 plan should say which of them `set`, `edit`, and `link` avoid.
- **The write receipt is per process** and prints to raw `console.error`.
  Under the prompt it is finding 8's problem; per connection it is the
  design's own note. Both are cheap to fix together when the sink lands.
- **`getCellValueFromCommand` returns nothing** and `callFromCommand` is the
  one wrapper the shell reaches. The runtime-integration analysis of why the
  other wrappers are intake rather than logic is correct and should stay the
  rule for B2: compose from the library, never from a `*FromCommand`.

The noun restructure (#6703) and the suffix work (#6761) carry blast radius
beyond shuttle and were not reviewed as standalone changes. As the shell rests
on them: `#argument` riding every spelling is what makes `get topics#argument`
consistent with `cf`, and the shell's reading of it is correct and tested.

## The design against B2–B4

Beyond the changes above, five places where the built foundation and the
unbuilt stages pull against each other.

**Writes through links.** `pathref.md` rules that `cd` crosses a link
implicitly and leaves what `set` does through a write-redirect link as "a
separate question, and a real one." B2 is `set`. The question has to be ruled
before `set` lands, not after: whether `set owner/name` where `owner` holds a
link writes into the link's target or replaces the link. The fabric's
`overwrite: "redirect"` says the former is what a link means; the shell's
`link` verb being "the only spelling that creates a reference" says the
distinction must stay visible. Rule it, and have `ls` mark link rows
(finding 9) so a person can see which case they are in.

**Whole-value writes against mergeable collections.** The grammar document's
own open question: `set` writes whole values, and the fabric's collection
writes are operation-based. For the pattern developer's inner loop, "add one
item" being read-modify-write is a regression from `cf piece call addItem`,
which the pattern already offers. B2 should at least make `call` the easy
path — it is — and record that `append` is deferred with a use, or rule it in.

**Scope and `set`.** `cd @user` then `get value` on the counter reported
`property "value" not found` — the overlay holds nothing until something
writes it. B2's `set` under `@user` will write into the overlay, and the
prompt's `@user` is the only thing that says so. That is the design working as
ruled (decision 20), and it is also the moment the write receipt should name
the scope as well as the space. Add the scope to the receipt when the sink
lands.

**The `@` collision.** Issue #6775 is real and stays dormant only because a
space named by name is refused unless it is the connected one. B4's `!cf`
escape injects place-derived flags, and a place rendered into `--cell` carries
`@scope` on the piece; if it ever also carries `/@name/`, the escape emits
the ambiguous form. Render the DID, never the name, in anything the shell
hands to a subprocess, and say so in B4's design.

**Connection state.** The relay carrying live/reconnecting/failed up through
the storage layer is B1's last item and is unbuilt. The driven session showed
why it cannot wait for B3: with the server paused, `get value` on a cached
document returned instantly and correctly, and nothing on screen said the
server was gone. The prompt marker is the smallest possible surface for that
fact, and the operator use case is the one where the server being gone is the
thing under investigation.

## Tests

The unit suite is thorough: 146 cases for the place alone, constructed
round-trip properties, mutation-checked per the pull requests, and every case
drives a module with stubs rather than a server. Two gaps.

- **No test runs the shell against a fabric.** Every read is stubbed, so the
  suite cannot see findings 1, 2, 3, or 5 — each of which is a property of
  the composition of real seams, not of any module. `packages/cli/integration/`
  has shell-script integration tests for the rest of `cf`; one that starts a
  toolshed, deploys the two example patterns, drives `cf sh` through a
  pseudo-terminal, and checks a `cd`, an `ls`, a `get`, and a stale-versus-warm
  read would have caught all four and is the test B2 and B3 need most. The
  driver this review used is a hundred lines of Python and can be the seed.
- **The prompt tests stub the terminal but not the loop's timing.** Finding 4
  is invisible to a test that feeds keys and awaits the run, because the
  queued keys do execute — later. A test that starts a read which blocks on a
  deferred promise, sends `ctrl-c`, and asserts the line was abandoned before
  the read resolves is the pin for the event loop.

Issue #6874's vacuous-guard finding in `listing.test.ts` is still open and is
the kind of thing the suite's own discipline should have closed; it is small.

## Smaller items

- `messageOf`, `escapeControlCharacters`, `escapeControlCharactersInJson`,
  and `holdsControlCharacter` live in `place.ts` and are imported by
  `connection.ts`, `listing.ts`, and `prompt.ts`. They are a text-safety
  module, not a place concern; `place.ts` is 1,343 lines and would read better
  without them.
- The `Experimental flag overrides:` line `loadPieces` prints reaches the
  screen before the first prompt. Harmless, and finding 8's sink is where it
  goes.
- The prompt for a piece held by handle is over sixty characters before the
  path. Decision 13 is the answer and finding 7 is how to reach it.
- `verbs.ts`'s `refuse` and `place.ts`'s `refuse` build the same shape; one
  `Refusal` type exported from one place would let the prompt's `report`
  switch be exhaustive over a shared union.
- `where` prints the identity as the key file's path. For the operator that is
  the right answer; when identity switching lands (deferred), the DID beside
  it will be wanted.
- `cd 'a b'` inside a piece lands on the key `a b` (after #6975). Correct, and
  worth an example in the README's quoting paragraph, since it is the case the
  fix exists for.
- The listing's bound line for `slugs/` is printed on every `ls`. It is true
  and it is long; a shorter spelling, or printing it once per run, would keep
  `ls` scannable.
- Issues #6944 and #6945 (display of fabric values JSON cannot spell, and the
  `$bigint` convention's home) are correctly filed as `cf`-wide rather than
  shuttle's, and nothing here changes that.

## Recommended order

What to do before B2's first writing verb lands, in the order that lets each
step use the one before it:

1. The option grammar and `help` (finding 6), since every later verb reads
   through it.
2. `cd` settling against the fabric, with the piece resolved to a handle and
   the facet-rooted spelling ruled (findings 1, 2, 7).
3. The event loop with `ctrl-c`, the out-of-band line, and the runtime's
   console routed through it (findings 4, 8).
4. Warming with a warm set and stop-on-exit, or the cold label until then
   (finding 3), and the connection-state marker in the prompt.
5. `get` projection and bounding, and `ls` rows with kind, numbering, and a
   page (findings 5, 9).
6. History and completion (finding 10), scheduled to a named stage.
7. One integration test through a real toolshed, and the `ctrl-c` timing
   test.

Then B2. The design documents should absorb the rulings from findings 2, 3
(the warm set's lifecycle), and the link-write question from `pathref.md` as
they are made, in the decisions list where the rest live.
