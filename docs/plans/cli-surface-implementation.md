# The CLI surface — implementation plan

[The CLI surface shape](cli-surface-shape.md) describes what `cf` should look
like and lays out seven steps to get there. Steps 1–3 are the read layer, and
[the verbs plan](verbs-implementation.md) builds them. This plan is steps 4–7:
the part that changes what a caller types.

The split is deliberate, though not absolute. The read layer breaks two things,
both of which it owns and sequences itself. Scoping invocation ids to a session
makes `--invocation` without one an error — a spelling that works today and that
[Verbs over the CLI](../common/verbs/over-the-cli.md) teaches — and that lands
alone, ahead of anything that publishes an address. Checking projection keys
against an allowlist refuses a schema carrying a key that was silently dropped
before, which is a command that exited zero and now does not.

The second is a different kind of break from anything here: it fails a caller
who was already getting the wrong answer, and the failure is the repair. This
arc
renames, aliases and merges, so its risk is different in kind — entirely in what
breaks for someone who already learned the current spelling. The two want
different sequencing, different tests, and different appetites for landing
quickly.

## Where this stands

Stages 1 through 3 are on main, and step 6b has removed the piece-mounted
`get`, `set` and `call` — `cf get`, `cf set` and `cf call` are the only
spellings. Stage 4 is the open work, along with step 7 and the second arc's
step 10 in [the shape document](cli-surface-shape.md).

## Governing decisions

**Additive until 6b.** Steps 4 through 6a only add: 6a adds a warning, not a
removal, so each old spelling kept working until the date its warning named —
two weeks after 6a reached main, written into the warning as a literal so it
read the same on any day. 6b is the removal that date was for.

**A deprecated spelling keeps working.** It costs a line of aliasing to leave a
redirect in place, and it costs every script and skill file that used it to
remove one — including files outside this repository, which no sweep here can
reach.

**Step 7 is not sequencing.** Each of its pairs is two working commands with
different behavior. Merging them decides which behavior survives, so each pair
is its own decision and none of them are mechanical.

## What is settled, and where

The shape document decides the target surface, and this plan does not reopen it.
Four decisions it explicitly declines to make are inherited as constraints:

- **`wish` stays its own command.** It resolves to whatever satisfies a query
  rather than to an address. It shares the output step, not the way you arrive.
- **`exec` may or may not become an address form.** That depends on how far the
  address grammar should reach into the filesystem projection, which step 4
  settles.
- **`piece step` is not redundant with `--step`.** A separate step process cannot
  carry its work into a later read in another process. Any merge preserves both.
- **`piece link` stays.** It writes a link with reactive-wiring meaning that a
  general value write does not express.

## The accounting

`cf piece` has twenty-six subcommands:

```
apply  describe  get-label  getsrc  inspect  link  ls  map  new
recreate-root  render  repair  restore  retarget  rm  rollback  search
set-home  set-label  set-slug  setsrc  slugs  step  survey  verbs  view
```

The target surface keeps eight — `new`, `setsrc`, `getsrc`, `rm`, `ls`,
`search`, `verbs`, `set-slug` — plus `step` and `link`, which are settled above.
`get-label` and `set-label` (#5673) postdate the shape document's accounting;
whether they stay piece-scoped or join a label surface is a step-7-class
decision that document has not made, so they are queued with the merges rather
than silently kept or moved. The bulk operations — `survey`, `repair`,
`retarget`, `rollback`, `restore` — and `describe` and `slugs` postdate it the
same way and are queued on the same terms. The rest move:

| Today | Becomes | Step |
| --- | --- | --- |
| `piece inspect` | merged with `cf inspect piece` | 7 |
| `piece view`, `piece render` | merged with `cf view` | 7 |
| `piece map` | merged with `cf inspect graph` | 7 |
| `piece apply` | merged with `cf set` | 7 |
| `piece recreate-root`, `piece set-home` | `cf space …` | 7 |

## Stage 1 — addresses become positional

**P1. A positional address beside `--piece`.** *(M)* `cf get <addr> [path]`
accepts what `--piece <addr>` accepts, and both spellings work. An entity id, a
slug, or a URL.

*The decision this needs.* What a command means when it is given both. Refusing
is the safe answer and matches how `--select` and `--schema` were split, but it
is a decision rather than an inference, and it belongs in the same place as that
one so a caller meets one rule instead of two.

**P2. The `#argument` suffix beside `--input`.** *(M)* `<addr>#argument` names a
position within an address, replacing the `--input` flag. Both work.

*Why a suffix and not a second positional.* An address and a position within it
travel together — a caller that copies one and drops the other has an address
that means something different, silently. Joining them in one token makes the
pair the unit that moves.

*Exit:* every command that takes `--piece` takes a positional, every command that
takes `--input` takes the suffix, and the existing flags behave exactly as they
do today. `deno task check-skill-facts` passes without a skill being rewritten,
because nothing has been removed yet.

## Stage 2 — the honest names

**N1. `cf get`, `cf set`, `cf call`.** *(S)* The data commands take top-level
names. One definition per command, reached by a routing entry rather than
copied; while both names were mounted, a divergence between them was the defect
this stage could introduce.

**N2. `cf wish` and `cf exec` keep their names** and gain nothing here. They are
already top-level and already honest.

*Exit:* while both spellings were mounted, `cf get X` and `cf piece get X`
produced byte-identical output for the same input, asserted rather than
assumed.

## Stage 3 — deprecation

**D1. The old spellings warn.** *(S)* `cf piece get|set|call` kept working and
said what replaced them, until 6b removed them.

**D2. The documentation moves.** *(M)* Twenty files under `docs/` and `skills/`
teach `--piece` or `--input` today. They move to the new spellings in one pass,
because a skill teaching a warned spelling teaches an agent to generate warnings.

*Decided: a date, not a traffic threshold.* Each warning names the day its
spelling stops working, two weeks after D1 reaches main, written in as a literal
so the warning reads the same whenever it is read. Traffic was never measurable
here — both spellings mount the same builder and emit identical requests, and
the CLI sends nothing that would let a server attribute one to either, so the
condition could only ever have been estimated.

*Exit:* no file in this repository taught a deprecated spelling, and every
deprecated spelling still worked — the condition 6b then removed them under.

## Stage 4 — the merges

Each of these is a decision, not a refactor. Sizes are for the code once the
decision is made; the decision is the expensive part.

**M1. Two `inspect`s.** `cf inspect piece` and `cf piece inspect`. Top-level
`inspect` is forensics over stored state, twenty-two subcommands wide and
offline but for `inspect pull`, which fetches from a remote.
`piece inspect` reports on a live piece. Whether these are the same operation is
the question — if they are not, the fix is naming rather than merging.

**M2. Two `view`s, and a `render`.** `cf view`, `cf piece view`, and
`cf piece render`. Three commands that turn a piece into something displayable.

**M3. `piece map` against `inspect graph`.** Both draw the connections between
pieces. `inspect graph` already produces DOT output and takes a space; `piece
map` is piece-scoped.

**M4. `piece apply` against `cf set`.** `apply` passes new inputs to a piece;
`set` writes a value at a path. Whether "new inputs" is a distinct operation or a
write to the argument position is the decision.

**M5. `piece recreate-root` and `piece set-home` move to `cf space`.** These are
space-level operations that sit under `piece` for historical reasons. Named here
because the shape document assigns them to this step, but they are a move rather
than a merge and could land earlier.

*Exit:* one command per operation, and a caller who knew the old surface can find
each one from what they used to type.

## Non-goals

**No new capability.** Nothing in this plan lets a caller do something they could
not do before. If a stage finds itself adding a feature, the feature is separate
work.

**Not the read options.** `--select`, `--schema` and `--filter` are the other
plan's, including which commands have them.

**Not `fuse`, `id`, `acl`, `space`, `check`, `test`, `init`, `deps`.** They are
outside the accretion this addresses.

## Dependencies

| Item | Blocked by | Note |
| --- | --- | --- |
| P1 | — | independent of the read-layer plan entirely |
| P2 | P1 | the suffix attaches to the positional |
| N1 | P1, P2 | a new name should be born with the new address forms, not gain them later |
| N2 | — | nothing to do |
| D2 | P1, P2, N1 | it teaches what those three add, so it cannot precede them |
| D1 | N1, D2 | cannot deprecate before the replacement exists, nor before the sweep: a warning that fires on examples this repository still teaches trains agents to generate warnings |
| M1–M5 | — | each independent of the others and of everything above |

The merges do not depend on the renames. They are ordered last because they are
the ones that change behavior, not because they are blocked.

## Test strategy

**P1 and P2 are equivalence tests.** The same operation expressed both ways
produces the same result. That is the whole property, and it is cheap to assert
across every command that gains a positional.

**N1 was byte-identity.** While both names were mounted they were one
implementation, so the test was that their outputs did not differ — including
error output, which is where an aliasing seam shows first. With one name left,
what remains to guard is that the piece mount is absent.

**D1 is that the warning does not reach stdout.** A deprecation notice on stdout
corrupts the JSON an agent parses. It goes to stderr, and a test pins that.

*And whether `--quiet` silences it.* The CLI's convention is that `--quiet`
suppresses hints but not warnings, and a deprecation notice can be read as
either. Deciding it when the notice is written costs a sentence; deciding it
after a script depends on the answer costs a behavior change. The plan does not
prejudge which — only that D1 does not ship without an answer.

**The merges want characterization tests before the decision.** For each pair,
what each command does today, captured, so the merge can be judged against
behavior rather than against intent.

## Risks

**A rename reaches outside this repository.** Skills, scripts, and agent
transcripts elsewhere use the current spellings. Deprecation warnings and
redirects are what make that survivable, and removing a spelling is not part of
this plan.

**Aliases drift.** Two names for one implementation stay honest only while they
are one implementation. The byte-identity test is what keeps N1 from becoming two
commands that agree by coincidence.

**A merge decides behavior quietly.** Each pair in stage 4 has two working
behaviors, and merging keeps one. Without characterization tests first, the
survivor is whichever was easier to keep.

**Deprecating on an unmeasurable condition.** Retired: the condition is a date
the warning itself carries, so "whenever someone feels ready" is not available
as an answer. What the date cannot cover is consumers outside this repository,
who are unreachable by any sweep here and unmeasurable by any signal the CLI
could add — which is what the two weeks are for.

## Documentation owed

| Step | Owed |
| --- | --- |
| P1 | Address forms wherever `--piece` is taught — the CLI README and the tutorial's workflow chapter |
| P2 | `#argument` beside every `--input` example, in the same places |
| N1 | The new spellings alongside the old ones everywhere both work |
| D2 | The old spellings removed from every file that teaches them |
| M1–M5 | Whatever each merge decides, including the redirect from the name that loses |
