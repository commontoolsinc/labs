# Shell completion coverage — implementation plan

`cf completion` answers a Tab with candidates for the slot under the cursor.
This plan sequences the work that makes it answer correctly across the surface
it already claims, and extends it to the pattern-owned vocabulary it does not
yet reach.

The design is unchanged and is not restated here.
[`packages/cli/README.md`](../../packages/cli/README.md#shell-completion) is
the reference for what completion covers and how it is installed;
[Verbs over the CLI](../common/verbs/over-the-cli.md) is the caller-facing
surface most of this plan serves. Read those for reasoning; read this for
order.

## Why

Completion is the one part of the CLI that fails by staying silent. Every
provider failure degrades to an empty candidate list on purpose, because a
completion request runs between two keystrokes and must never paste a stack
trace into the command line. That is the right disposition and it is also why
a defect here does not announce itself: a slot that resolves nothing and a slot
that has no provider are the same experience at the prompt.

Three consequences follow, and they are what this plan is for.

**Completion trails the command surface.** The resolver walks the live Cliffy
tree, so a new subcommand or flag becomes completable the moment it is
registered. The *values* do not: they come from two hand-maintained tables in
`lib/completion/providers.ts`, and a new command reaching the tree with no
entry in either is indistinguishable at the prompt from one whose fabric is
unreachable.

**The chain has a weak first link.** Reaching a piece, a verb, or a cell path
needs a space, `--space` is required on every command that reads one, and
`--space` completes to space DIDs discovered from local stores — while the
value a caller types is a space name. A name derives its DID one way, so a
discovered DID can never produce the name that made it.

**Nothing exercises a live provider.** The unit tests cover the pure shaping
functions and assert that a slot with no fabric context degrades to empty.
Every path that reaches a fabric is unverified, and the defects below sit
exactly where no live exercise runs.

## How this list is ranked

Two axes, because either one alone gets the order wrong.

**Correctness gates value.** A slot that offers a candidate the command
rejects, or that hides candidates it holds, is worse than a slot that offers
nothing: the first teaches a caller something false, the second only fails to
help. Those defects are also the smallest edits here. They go first, cheapest
first, and nothing is built on a slot that is still answering wrongly.

**After that, rank by whose vocabulary it is.** Completion earns its keep where
the words are not the CLI's own. A flag name, an enumerated value, and a
subcommand are each one `--help` away, so completing them saves keystrokes. A
piece id, a verb name, a verb's flags, a cell path, and the field paths of a
verb's result are none of them derivable from the CLI — they belong to a
deployed pattern, and the only other way to learn one is to make a call and read
what comes back. Completing those saves a round trip and a context switch, which
is a different order of saving.

Frequency multiplies it. The slots on the call path — name a piece, name a verb,
fill its event, shape its result — are hit on nearly every command; `inspect`'s
positionals are hit by an operator during an investigation.

So: correctness first, then pattern-owned vocabulary on the call path, then
everything a caller could have read out of `--help` anyway. The rank column
records which of those an item is, and the table is in working order.

## State

Where every item stands. The sections below carry the detail and are what to
read before picking one up; this table is the roll-up.

| # | Item | Rank | Status |
| --- | --- | --- | --- |
| 1 | Inline `--option=value` drops every live candidate | correctness | not started |
| 2 | Flags offered past a `stopEarly()` boundary | correctness | not started |
| 3 | Target resolution lags the reference grammar | correctness | not started |
| 4 | Verb flags do not complete | pattern vocabulary | shaper now, wiring after step 10 |
| 5 | Result field paths for `get` and `wish` | pattern vocabulary | not started |
| 6 | Result field paths for `call` and `exec` | pattern vocabulary | needs step 10 |
| 7 | Slugs never complete | pattern vocabulary | not started |
| 8 | `--space` has no source a caller recognizes | first link | partly settled |
| 9 | A verb's annotation is its kind, not its prose | comprehension | not started |
| 10 | Wrapper and deprecated verbs are offered unmarked | comprehension | not started |
| 11 | Every Tab costs two process starts | felt cost | needs a decision |
| 12 | `nospace` is inert on the stock macOS bash | felt cost | not started |
| 13 | Space and entity positionals across `inspect` | operator surface | not started |
| 14 | `wish` targets and scopes | CLI vocabulary | not started |
| 15 | Remaining path-shaped and enumerable values | CLI vocabulary | not started |
| 16 | Two provider entries that can never fire | hygiene | not started |
| 17 | The README table omits the top-level spellings | hygiene | not started |
| 18 | A live-provider test seam | mechanism | not started |
| 19 | A gate that fails when a new slot has no decision | mechanism | not started |

**What can be picked up today.** Everything except one wiring change and one
item. Items 1, 2, 3, 5 and 7 are independent of each other and of the surface
work, and are worth doing in that order. Items 9, 10, 12, 13, 14, 15, 16 and 17
are mechanical and can be taken at any time.

Item 2 holds under either grammar. A `cf` flag written past the verb is refused
today and belongs to the callable after step 10, so declining to offer one there
is correct now and stays correct. It leaves the position offering nothing until
item 4 fills it, which is the honest state for a position whose vocabulary the
command cannot yet name — and a great deal better than offering flags the
command rejects.

Item 4 splits. Turning a verb's `inputSchema` into `--kebab-case` candidates is
a pure function of the listing, belongs beside `shapeVerbCandidates`, needs no
fabric to test, and is the same function under either grammar. Build it now.
Only its wiring — which slot receives it — waits, because step 10 decides
whether a verb's fields are written before the marker or after it.

Item 6 is the one to leave alone. Under the current grammar it needs the whole
line read for context, since a projection precedes the verb it shapes; after
step 10 the verb is already before the cursor and it needs nothing. Building it
now means building the machinery that step 10 makes unnecessary.

Items 8 and 11 hold open decisions and are not work yet. Items 18 and 19 are the
mechanism, and are worth having early rather than last: item 18 is the only way
to see a live provider fail, and everything above it is a shape no live exercise
currently runs.

## What this list covers, and what it cannot

Two of the four ways completion can be wrong are enumerated here exhaustively,
and two are not. Knowing which is which is the difference between working the
list and trusting it.

**Enumerated exhaustively.** A slot with no provider entry: the keys of both
provider tables are derivable from the same command tree the resolver walks, so
walking the tree and subtracting the tables names every one. That is items 13
to 16, and item 19 is the same walk made permanent.

**Enumerated exhaustively.** A provider entry with no slot: the same
subtraction run the other way. That is item 16.

**Not enumerated.** A provider that returns the *wrong set* rather than an
empty one. This is invisible at the prompt — plausible candidates look like
correct ones — and there is no mechanical test for it. Item 2 is one instance,
found by reading a flag's help text rather than by any method that would find
the next one. The open questions of this kind are listed under item 18, because
a live seam is what turns them from questions into assertions.

**Not enumerated.** Defects in the installed shell functions rather than in the
callback they invoke. The bash function has been driven directly and agrees
with the callback on the cases tried, including reproducing item 1 end to end.
zsh's `_describe` rendering, the colon escaping that piece ids and DIDs need,
and the `deno` binding are untested.

## Working on this

Completion swallows every error on purpose, so a provider that throws, a fabric
that is unreachable, and a slot with no provider are one experience: no
candidates. Nothing here can be debugged by watching a shell, and a change that
looks like it worked at the prompt has not been observed.

**Drive the callback directly.** The installed shell function calls one command,
and so should you. It takes the line and the cursor offset, and prints what the
shell would have offered:

```bash
cf completion complete --shell zsh --line "cf call --piece x " --point 18
```

The shell functions themselves are a separate surface and are exercised by
sourcing what `cf completion bash` prints and calling `_cf_complete` with
`COMP_LINE`, `COMP_POINT`, `COMP_WORDS` and `COMP_CWORD` set. Reach for that
only when the defect is in the script rather than in the candidates.

**Live slots need a space, a piece, and something deployed in it.** A piece id,
a verb name, a cell path and a result shape are all read from a running fabric,
so a provider cannot be exercised without one: point `CF_API_URL` at a local
server, `CF_IDENTITY` at a keyfile, deploy a fixture, and complete against it.
An empty result from a provider proves nothing until the same target answers
the equivalent `cf` command.

**Where the tests go.** `packages/cli/test/completion-*.test.ts` hold the pure
half — line resolution, candidate shaping, the degrade-to-empty path — and are
the right home for anything answerable without a fabric.
[`unit-test-coding-style.md`](../development/unit-test-coding-style.md) governs
their shape and is worth reading first, since not every file in that directory
follows it. Anything that needs a fabric belongs beside
`packages/cli/integration/verbs-over-the-cli.sh`, which is item 18.

**Two traps in the parsing layer.** A throwaway Cliffy command used to parse a
token list needs `.noExit()`, or a bad flag ends the process instead of
throwing. And `parseExecArgs` takes the spec first and the arguments second.

## Correctness

### 1. Inline `--option=value` drops every live candidate

`--space=<TAB>`, `--piece=<TAB>`, and `--api-url=<TAB>` offer nothing, while the
same options completed as `--space <TAB>` work. Enumerated values are
unaffected: `--log-level=<TAB>` completes.

`complete` in `lib/completion/mod.ts` filters candidates against the word under
the cursor, which for this spelling is `--piece=`. `staticCandidates`
re-attaches that prefix through `withInlinePrefix`, so its candidates survive
the filter.
`liveCandidates` returns bare values, so every one of them fails the prefix test
and is dropped.

The fix is to apply the inline prefix to the live half as well, which means
`complete` carrying the slot's `inlinePrefix` across both sources rather than
`staticCandidates` owning it alone.

This spelling is why `tokenizeLine` exists — bash splits its own words on `=` —
so it is the one form the implementation is built to serve and the one that does
not work.

Directives are the other half of the same slot: `--identity=<TAB>` emits a files
directive whose glob the shell applies to a word still carrying `--identity=`.
Settle both in one change.

### 2. Flags offered past a `stopEarly()` boundary

After the callable name, `cf call` offers `--invocation`, `--filter`,
`--select`, `--quiet` and the rest of its own flags. The command rejects all of
them there: `buildCallCommand` in `commands/piece.ts` is `stopEarly()`, so the
first positional ends option parsing and every later word belongs to the
callable's schema-derived parser. The flags' own help text says so — each
description ends "(before the callable name)". `cf exec` has the same shape and
the same defect, its descriptions ending "(before the mounted file)".

`resolveCompletionLine` in `lib/completion/line.ts` has no notion of the
boundary, so `option-name` stays reachable for the whole line. Cliffy records it
as `_stopEarly` with no accessor; either read that field or have the completion
layer name the two commands. Reading the field keeps the property where the
command declares it, which is the reason to prefer it.

This holds under either grammar. A `cf` flag past the verb is refused today, and
after step 10 of [Naming the target](cli-surface-shape.md#naming-the-target) the
position belongs to the callable — so declining to offer one there is correct
now and stays correct. It leaves the position offering nothing until item 4
fills it, which is what a position whose vocabulary the command cannot yet name
should offer.

### 3. Target resolution lags the reference grammar

Three documented ways to name a target complete nothing:

```bash
cf call --piece /@did:key:.../of:fid1:... <TAB>   # canonical reference
cf call --space donuts /of:fid1:... <TAB>          # positional address
cf get --piece fid1:...#argument <TAB>             # the arguments cell
```

The `--url` spelling of the same target works, which is what makes this read as
random rather than as a missing capability.

`resolvePieceContext` in `lib/completion/providers.ts` takes `--piece` verbatim
as a piece id. The canonical form is not one, so the listing call fails and the
slot degrades to empty. `normalizeLLMFriendlyRef` is the function that already
parses this grammar — the embedded space, the `@scope` suffix, the trailing
path, and `#argument` — and completion is an intake seam that does not use it.

The positional address is a second, independent break: it occupies positional
index 0, so `resolveSlot` resolves the cursor to the variadic `tail` rather than
to `callable`, and the callable provider is never consulted. Whichever way
completion learns the address form, it has to shift the positional index the way
the command does.

`#argument` selects the arguments cell, the same selection `--input` spells as a
flag. `cellPathCandidates` reads `--input` and not the suffix, so the two
spellings of one selection complete differently.

## Pattern vocabulary

This is the half of the list that pays for itself. Every slot in this section
names something a deployed pattern owns, so the alternative to completing it is
a call to `cf piece verbs` or `cf get` and a read of what comes back.

### 4. Verb flags do not complete

A verb's own fields are the pattern author's vocabulary rather than the CLI's,
so this is the position where a caller has least to go on and completion has
most to give. Nothing is offered there.

Where "there" is depends on step 10. Today the fields are written after `--`;
afterwards the verb opens the callable's section and they are written directly
after the verb, with `--` closing that section and opening the read step's:

```text
cf call --piece <piece> addItem --ti<TAB>        # after step 10
cf call --piece <piece> addItem -- --ti<TAB>     # before it
```

**The candidates and their slot are separable, and only the slot waits.**
Turning an `inputSchema` into `--kebab-case` candidates is a pure function of
the listing. It belongs beside `shapeVerbCandidates`, is testable with no
fabric, and is the same function whichever position the fields are written in —
so it can be built and landed before step 10 decides.

The wiring is what waits. `liveCandidates` dispatches on `option-value` and
`argument` slots only, so neither position reaches a provider today, and routing
it to the current position would teach the spelling step 10 retires while the
retirement is being taught.

The data needs no new request. `listPieceCallables` — the call
`callableCandidates` already makes — returns each verb's `inputSchema`, and
`flagNameForKey` in `lib/exec-schema.ts` is the kebab-case mapping the parser
itself applies. A verb declaring `title` accepts `--title`, and both halves of
that sentence are already in the process.

`--help` belongs in this slot too: it falls inside the callable's section, where
it reaches the verb and prints that verb's own page.

The slot past the marker is not this one. It belongs to the read options, and
completing it from the verb's declared result is item 6.

### 5. Result field paths for `get` and `wish`

`--select` takes comma-separated, dot-separated field paths into the value a
read returns, and `--schema` accepts the same spelling. Both complete nothing.

The grammar is its own, and is not the cell-path grammar:
`parseSelectProjection` in `lib/cell-selection.ts` splits a list on `,` and a
path on `.`, where `cellPathCandidates` walks `/`. A segment ending in `@`
asks for that position's address rather than its value, and a bare `@` asks the
read for its own — so a complete candidate set offers both spellings of a
position.

For `cf get` the vocabulary needs no new request and no new reachability: the
value being projected is the one at the piece and path already named, which
`getCellValue` reads and `keysOf` already turns into keys. That makes this the
cheapest high-value item on the list, and independent of item 4.

`cf wish` projects the resolved target the same way. A wish declares no result
shape the way a verb declares an `outputSchema`, but a shape is not what this
provider reads: it reads a value and takes its keys, and a wish is a read. So
the target resolves and its keys are the candidates, the same walk `cf get`
needs. `wish` is also the one command whose `--space` is optional, so this
completes from an identity alone.

Confirm before building it that resolving a wish writes nothing. The profile
ordering consults a most-recently-used list, and a Tab that reordered it would
be a keystroke with a side effect — which is a bar completion has to clear
whatever the candidates are worth.

### 6. Result field paths for `call` and `exec`

The same flags on a call shape the verb's result, whose vocabulary is the verb's
`outputSchema` — carried by the same listing item 4 reads.

This one is not really a completion item, and the surface work dissolves most
of it. `stopEarly()` requires a projection before the callable name today, and a
caller who writes it after gets one of three outcomes with no rule connecting
them:

```text
call <verb> --select item.title '{...}'   Use a single inline JSON argument or
                                          "--" before schema-derived flags.
call <verb> -- --title x --select y       "--select" at <event> is not a field
                                          this verb declares.
call <verb> --json '{...}'                works
```

The first message names a rule the caller did not break: they passed a single
inline JSON argument, and `--select` is not a schema-derived flag. It is what
`--invocation` and `--show-links` say too. The second is a good message about
the wrong subject. The third succeeds, because `--json` is a token the
callable's parser accepts — so the surface is not "a `cf` flag never works after
the verb", it is "some do", which is not a rule anyone can infer from using it.

[Naming the target](cli-surface-shape.md#naming-the-target) settles this: the
verb opens the callable's section and `--` closes it, so a projection is written
after the marker and therefore always after the verb. That ordering is what this
item was waiting on, and it arrives with the verb already on the line ahead of
the cursor — so the candidates come from the `outputSchema` the listing in item
4 already carries, read from the words before the cursor like every other slot.

What survives is one improvement completion wants on its own account.
`resolveCompletionLine` derives two different things from `words.slice(1,
cursor)` — which slot the cursor is in, and which piece and verb the line names
— and only the first needs the prefix. Resolving the slot from the prefix while
gathering context from the whole line is what makes mid-line editing complete
against the position being edited rather than against the end of the line. It is
no longer load-bearing for this item, and it is still the difference between a
line that completes as it is typed and one that completes however it is edited.

### 7. Slugs never complete

A slug is a valid `--piece` value — the alias grammar names it alongside the
bare id — and `listSpaceSlugs` enumerates every slug a space's index records.
Completion offers ids only. `piece set-slug` takes a slug positionally and
completes nothing there either.

Offer slugs beside ids in the `--piece` slot, annotated so the two are
distinguishable. A slug is the readable half of this vocabulary, so it belongs
above the opaque id in the candidate order.

## The first link

### 8. `--space` has no source a caller recognizes

`--space` takes a space name or a DID, is required on every command that reads a
space, and has no environment fallback. Completion offers DIDs discovered from
local memory-v2 stores. A name derives its DID one way, so the discovered DID is
never the name that produced it, and a caller who works in names gets candidates
they cannot use.

Discovery is also positional: `candidateRoots` walks up from the working
directory looking for a store, so completion offers spaces in a checkout that
holds one and nothing in a worktree that does not — while both talk to the same
server.

[Naming the target](cli-surface-shape.md#naming-the-target) settles where the
*command* gets a space it was not given: `CF_SPACE`, with the flag overriding
it. Two candidate sources follow from that and need no further decision — the
ambient value itself, and the identity's home space, which is derivable from
`--identity` alone with no server and no local store and is where a profile
target resolves.

An ambient space also changes how much this slot matters. `--space` is written
to override rather than to state the usual case, so it is reached for less
often once it has a default.

What stays open is whether anything holds a space **name**. Local stores yield
DIDs and are the only source completion reads today; making them independent of
the working directory keeps those candidates and stops them depending on where
the caller stands, but they are still DIDs. The one source that could hold a
name is a record of the spaces this CLI has opened, written at the moment a
session resolves one — which is new state on disk, and the question of when an
entry expires. That is a decision rather than a task, and it is worth deferring
until `CF_SPACE` has been in use long enough to say whether the slot is still
reached for.

## Comprehension

### 9. A verb's annotation is its kind, not its prose

`shapeVerbCandidates` annotates every candidate with `handler` or `tool`. The
listing row carries `description` — the doc comment the author wrote on the
property, the same sentence the verb's help page opens with. The annotation
column is where that sentence belongs; the kind is a two-value fact that rarely
decides anything at the prompt.

Fall back to the kind where a verb carries no prose, so a candidate is never
unannotated.

### 10. Wrapper and deprecated verbs are offered unmarked

`cf piece verbs` hides `tier: "wrapper"` and `deprecated` rows unless `--all`,
and prints a note saying how many it held back. `shapeVerbCandidates` maps the
full array, so completion offers what the listing hides, and offers it looking
like everything else.

Both are callable, so offering them is defensible and hiding them is defensible.
What is not defensible is the two surfaces disagreeing silently. Marking them in
the annotation column is the cheapest way to agree — it keeps a name reachable
while saying what it is.

## Felt cost

A completion that arrives late is experienced as one that did not arrive. These
two items are what a caller feels on slots that are otherwise working.

### 11. Every Tab costs two process starts

`bin/cf` runs `launcher.ts`, which spawns a second Deno process for the CLI, and
both start on every Tab. Measured against a local server from a warm checkout: a
purely static completion — subcommand names, no I/O at all — settles in about
0.34s, and a completion that reaches the fabric takes 0.44s to 1.2s. This agrees
with the figure `packages/cli/README.md` already records for the source path
against the compiled binary.

The compiled binary is declined for a reason that has nothing to do with
completion: nothing invalidates it, so a stale one rejects newer flags and skews
against an updated server. That reasoning is sound and this item does not
reopen it.

What has not been considered is whether the cost has to be paid per keystroke at
all. The static half of the surface needs no fabric and no piece listing, and
the live half re-reads the same listing on every Tab of the same line. Both are
shapes a cache or a resident process could serve, and both are decisions about
where state lives rather than about how fast a process starts.

Worth sizing before it is scheduled: it may be that the correctness and
vocabulary items above change the experience more than a faster Tab would.

### 12. `nospace` is inert on the stock macOS bash

Cell paths and link endpoints complete one segment at a time and emit a
`nospace` directive so the cursor stays attached for the next `/`. The bash
function applies it through `compopt`, which is bash 4 and later; macOS ships
bash 3.2. The script comments note the cost as a keystroke. It is a keystroke
*per segment*, on the default shell of the platform most of this repository is
developed on, and it lands on the deepest and most useful completion there is.

A candidate that carries its own trailing separator is one way around it, since
the shell's added space then falls after a `/` rather than inside a path.

## Operator surface and CLI vocabulary

### 13. Space and entity positionals across `inspect`

Every `cf inspect` subcommand that reads a space takes it positionally, and none
of the eighteen have a provider — while `space clone` and `space fingerprint`,
which take the same thing the same way, do. `inspect` reads local stores
directly, so the provider it wants is the one `space clone` already uses, and
item 8's disposition applies unchanged.

The `<entity>` positional beside them is a piece id within the named space, and
`inspect entities` is what enumerates them.

### 14. `wish` targets and scopes

`cf wish <target>` takes a documented vocabulary — the profile targets and the
space-relative ones its help enumerates — and completes nothing. `--scope`
accepts exactly `~`, `.`, `profile`, or a space DID, which is an enumerated set
plus the space provider.

Both sets are in the command's own help, which is what puts this below the
pattern-owned slots rather than beside them.

### 15. Remaining path-shaped and enumerable values

The mechanical remainder, each one an entry in an existing table:

- Pattern files: `piece set-home <main>`.
- Files and directories: `piece getsrc <outpath>`, `deps update <file>`,
  `fuse mount|unmount <mountpoint>`, `--dir`, `--out`, `--output`, `--from`.
- API URLs: `--remote`, which takes what `--api-url` takes.
- Enumerated values, which belong beside the four already in
  `ENUMERATED_OPTION_VALUES`: `piece map --format` (`ascii`, `dot`),
  `inspect entities --kind` (seven values its help lists).

## Hygiene

### 16. Two provider entries that can never fire

`OPTION_VALUE_PROVIDERS` carries `log-file` and `state-path`. Both belong to
`fuse-supervisor` and `fuse-daemon`, which take raw arguments and declare no
Cliffy options, and which completion drops from its subcommand candidates as
internal. Neither entry is reachable.

### 17. The README table omits the top-level spellings

The completion table in `packages/cli/README.md` lists `piece call`, `piece
get`, and `piece set`. The top-level `cf call`, `cf get`, and `cf set` complete
identically and are the spellings the surface leads with. The table also
predates everything this plan adds, so it is the document to update as each item
lands.

## Mechanism

### 18. A live-provider test seam

No test drives a provider against a fabric. `completion-providers.test.ts`
covers the shaping functions and the degrade-to-empty path; the integration
scripts under `packages/cli/integration/` do not mention completion.

Every correctness defect above is a shape no live exercise runs. A script
alongside `verbs-over-the-cli.sh` — deploy a fixture, then assert what a Tab
offers at each slot of the chain — is the coverage that would have caught them,
and it composes with the existing harness rather than needing a new one.
`verb-session-gaps.sh` is the precedent for asserting a gap so that it fails
loudly the day it closes.

It is also the only way to settle the questions no table walk can reach, which
are the ones to write first:

- Whether `cellPathCandidates` should stop at a `$link` boundary or follow it,
  and which it does.
- Whether the `--piece` listing and the dispatcher agree about scope, so that
  every completed id is one the same command can then read.
- Whether a verb stored on both the input and result cells completes against the
  cell the dispatcher will reach it on, which is the shadowing rule the verbs
  listing states.

### 19. A gate that fails when a new slot has no decision

Completion falling behind the command surface is the mechanism this whole plan
is a list of instances of. The tables are keyed by option long name and by
`<command path>:<argument name>`, and both keys are derivable from the tree that
`resolveCompletionLine` already walks, so the drift is machine-detectable: walk
the tree, and name every value-taking option and every positional with no
provider entry and no enumerated set.

The check cannot decide that a slot *should* complete — plenty should not. It
can require that every slot has been decided about, which is what an allowlist
of deliberate omissions records. That turns the next command's completion from
something remembered into something the gate asks for.

Item 16 is what the same walk finds in the other direction, so both fall out of
one implementation.
