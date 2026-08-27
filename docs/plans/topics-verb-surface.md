# The Topics verb surface

Topics is a multi-user tracker over `#topic` pieces: a title, a living body
document, a flat comment thread, and typed links out to other objects. Humans
drive it in the browser; agents drive it over the CLI, which is a generic
projection of a pattern's verbs. That makes the verb surface *the* agent
product surface, and it is why this plan exists — the surface is deliberately
minimal, and how it grows without breaking the pieces already holding data is
the design problem.

This plan sequences that growth. The design argument behind it, the survey of
what the surface looks like today, and the discussion with Topics' author are
in the topic *"Topics verb surface: design and evolution"* on the team board;
this document is the part that has to stay accurate as the work proceeds.

## The position

**A holder demands only what it uses.** The board stores topics, so it writes
down the shape it requires of a stored one. That declaration is write-once: a
deployed holder cannot add a required member later, and a verb can never carry
a default, so a verb named in the holder's demand prices every future verb as a
deliberate break.

The board calls no topic verb. Its demand therefore names none, and a topic
grows verbs without the board's shape moving at all. This is what keeps a verb
**non-optional**: the alternative is a verb declared optional on the shared
projection, which pushes a maybe to every call site whose obvious spelling
skips in silence.

**A caller reaches a topic by its own address.** Survey the board through
`index`, take the row's address, and call the topic there, where its own schema
governs. A consumer reading through the board's projection sees the display
fields and nothing else — which is the correct model rather than a concession.

**What a pattern publishes is bounded by what it demands.** A pattern cannot
serve a wider view of a stored piece than the one it requires, so narrowing a
demand narrows the publication with it. Losing the thread, the links, and the
verbs from the board's published projection is accepted: the board is a
directory, and details come from navigating to the topic.

## The demand

`TopicDemand` in `packages/patterns/topics/main.tsx` is what the board requires
of a stored topic. Eight members, no verbs:

| member | why it is demanded |
| --- | --- |
| `title` | the card, and the index row |
| `body` | the card's snippet |
| `commentCount` | the card, and the index row |
| `createdBy` | the card's attribution, and the index row |
| `lastActivityAt` | the card, the index row, and the activity sort |
| `createdAt` | the index row |
| `mentions` | the crossref pivot's join |
| `[NAME]` | published onward as each topic's mention universe, where the editor requires it |

`[NAME]` is the one no reader of the board shows: the board hands the same
array on as the mention universe, so the name has to survive the demand to
reach the editor. Counting only what the board reads is what drops it, and
dropping it costs no type error and empties every `@`-mention completion.

Seven of the eight carry a default. `createdAt` is the exception, and it is
safe for a different reason rather than by oversight: the topic pattern
defaults its own `createdAt` input to `0` and publishes it unconditionally, so
every topic produces the path whether or not it was ever stamped.

That is the property the demand rests on, and defaults are how it is usually
bought. A demanded path a stored topic cannot produce makes the whole array
unreadable — not the one row, the array — while a value the topic always
produces is simply read. A ninth member is safe when one of the two holds, and
a default is the only one of them a board can grant itself.

## Stages

| stage | carries | state |
| --- | --- | --- |
| A | compatible updates: verb and event prose, the describe layer, `setTitle`, a compact `addTopic` result | landed in source |
| B | one rehearsed break, four items batched | batched in PR #6143, in review |
| C | items gated on platform work | designed for, not started |

### Stage A

Landed. Every item passed the update gate as an ordinary deploy. `setTitle`
went onto the topic's own output rather than the shared projection, which is
the pattern every new verb follows until Stage B lands.

Stage A is not yet deployed to the team board: no deployed topic carries a
`setTitle` stream.

### Stage B

Four items, batched into a single rehearsed migration rather than paying the
rehearsal four times:

All four are written and batched into PR #6143, which is in review. None of
them has landed until that merges, and they merge together or not at all —
that is what batching a single rehearsed migration means.

1. **Narrow the board's `topics` demand and the topic's `mentionable`
   demand** to the fields above.
2. **Require `agentName` on every verb**, retiring the unsigned legacy path and
   with it the misattribution where an unsigned body edit leaves the previous
   author's name on content they did not write.
3. **Retire `myName`, `setMyName`, `createdByName`, `authorName`** and their
   mirrors in results.
4. **Open the `kind` value domains** on links and authors, which are closed
   enums in provided data and so cannot widen — and with them relax
   `addLink`'s `kind` and `label`, which the handler already defaults and
   which the gate refuses to relax on their own.

Baselines are recorded ONCE, when the batch is complete — not after each item.
A baseline recorded mid-batch describes a contract that never ships, and the
next item in the batch breaks it, so it has to be forgiven by an accepted-break
entry that exists only to excuse an artifact. Baselines cannot be deleted
either, so that churn is permanent. The cost of waiting is that the
compatibility gate reports unrecorded contracts, and stays red, until the last
item lands; that is the honest state of a break that has not finished being
taken.

Item 1 additionally needed, before it could land, and each is in the PR:

- an accepted-break entry for `topics/main.tsx` and `topics/topic.tsx` naming
  the baselines the narrowing cannot apply over and only the paths it blames,
  plus the break record the entry points at;
- removal of the accepted-break entries that no longer forgive a finding, since
  an exemption cannot outlive its break;
- baselines recorded for the contract the break leaves behind, and a
  `pattern-vintage` run, which replays a real deployed board and refuses a card
  field that lost its default.

### Stage C

Each item waits on platform work rather than on this plan:

- **`removeLink`, and comment edit and removal.** References-as-arguments has
  landed, so these are buildable. They go on the topic's own interface and need
  no migration; the no-synthetic-ids rule is what prepared for them.
- **`AgentActor` execution provenance** replacing per-event `agentName`, when
  the retention-and-provenance track clears its review. Required-now relaxes to
  optional-then-deprecated, which is the compatible direction and the reason
  item 2 above tightens rather than waits.
- **`Demand<T>` markers** replacing the interim rule that new verbs go on the
  topic's own output only.
- **Statuses, labels, assignees, and whatever else usage asks for**: optional
  fields and new verbs, compatible on the topic's own schema and invisible to
  the board until the board widens its demand with an optional field.

## Testing the board through a narrowed demand

A pattern test reaches a stored topic only through the holder's projection, so
the narrowing takes several properties out of its reach. They are guarded in
`packages/patterns/integration/topic-board-child-contract.test.ts`, which does
what a caller does: file through the board, resolve the row to the topic's own
address, then read and call the topic there. That covers `addTopic` wiring its
child to the pivot, a body given at create not being recorded as a body update,
an index row tracking a thread that grew after the row was built, and the
pivot's own rules.

Two constraints shape what can be tested where, and both are worth knowing
before writing a case:

- A piece built in a pattern body cannot be placed on a board. Pushing one in
  reports a schema mismatch and the write never runs, seeding the array at
  construction is refused because a cell constructor takes static data, and
  writing the board's input through the piece controller is refused by the
  contract check. A test therefore cannot hold a topic that is both on a board
  and callable.
- The pivot excludes a topic from its own inbound edges by identity rather than
  array position. Only a list holding the same topic twice separates those, and
  no board can produce one, so `mentionedBy` is exported for a test to call
  with a list built by hand.

## Deploying to the team board

Stage B rewrites the shape of live team data, so it goes through the rehearsal
in [Topics migration rehearsal](topics-migration-rehearsal.md): a snapshot
first, two consecutive clean passes against a clone, the board before its
children,
and a content export that the restore drill exercises rather than assumes.

Two preconditions belong to the board rather than to the code:

- **The board must converge.** Its topics run more than one child pattern
  identity, and a migration that assumes one shape will not find one.
- **The space must be healthy enough to rehearse against.** A clone of a space
  whose pieces cannot start is not a rehearsal.

## Decisions

- A result narrowing happens in place rather than under a new verb name;
  breaking source-level consumers is accepted and updating them is part of the
  work.
- `removeLink` waits for references-as-arguments rather than taking a
  URL-keyed interim form.
- Stage B keeps the existing verb names. The rehearsed break is the *one*
  deliberate break in this plan: anything break-shaped discovered along the way
  rides it, and every other change stays gate-clean.
- The board's demand names the eight members above, and losing the excluded
  fields from the board's published projection is accepted.
