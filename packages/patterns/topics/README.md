# Topics

A multi-user tracker over **#topic** pieces — durable units of shared attention.
A topic is a title, a **living body document** (durable conclusions get folded
up into the body; the thread holds the deliberation), a flat chronological
comment thread, and typed links out to other core objects (PRs, agent sessions,
other topics — URLs in v0).

The board publishes an **index**: one row per topic carrying the topic's
canonical address, a reference to the topic itself, and the scalars a survey
reads (`title`, `createdAt`, `createdBy`, `commentCount`, `lastActivityAt`). The
same rows render the board's cards, so a headless survey and the rendered board
read one derivation rather than two.

Deliberately absent until reached for: statuses (not even open/closed), labels,
assignees, attachments, nesting, and a topic-to-topic reference graph. What a
topic grows next is part of the experiment.

This is the first wedge of Common Fabric's internal dogfooding program — the
team's own issue-tracker replacement, built on the platform it tracks. The
project's live design record is the "Build Topics v0" topic itself (bootstrap
lineage: Linear CT-1878, which this pattern exists to absorb).

## Design commitments

- **One principal, explicit actor.** Fabric authenticates every write with the
  identity key that made it. In the short-term agent model, that key belongs to
  the human user; an agent also supplies `agentName` in the same mutation event.
  Topics stores a structured `{ kind: "agent", name }` snapshot so the UI can
  say “Sol (agent)” without pretending the agent has a separate principal.
- **Profile-native browser authorship.** Human-facing controls use the current
  viewer's canonical `#profile` name/avatar and store a `{ kind: "person", … }`
  snapshot. There is no free-text “commenting as” field.
- **Wish-free agent handlers.** CLI streams do not depend on profile wishes.
  Blank `agentName` values reject the mutation, and the signature is carried in
  the same event as the content, avoiding shared mutable attribution state.
  During the deployed-schema migration, omission (distinct from an explicit
  blank value) remains accepted for old callers; topic/comment attribution then
  falls back to their hidden legacy `myName`.
- **Mergeable writes everywhere users collide**: comments, links, and topics are
  `push` appends; concurrent writers all land. The body is a large string
  (whole-value conflict semantics), so body edits go through an explicit
  Edit→Save toggle rather than a live-bound textarea.
- **Fabric owns history and concurrency.** Topics adds neither an activity-log
  duplicate nor an application-level revision/CAS protocol. If Fabric cannot
  preserve history or safely arbitrate concurrent body writes, this dogfood
  surface should expose the framework gap rather than conceal it mechanically.
- **Compatibility is temporary but honest.** The previous result contract made
  `myName`, `createdByName`, and `authorName` observable, and its mutation
  streams omitted `agentName`. Those surfaces remain deprecated but functional:
  new structured writes mirror the legacy display strings, while old unsigned
  topic/comment calls use `myName` and the other streams preserve their prior
  behavior. New browser and agent callers never depend on them.
- **`mentionable` is a structural reference, not derived data.** The board
  passes its own topics list at creation; the topic's body editor autocompletes
  `@`-mentions over it. Backfillable as a one-time link-bind on pieces created
  before the input existed.
- **A declared schema is the only thing that bounds a read.** The transformer
  shrinks a derivation's input schema to the paths it can see the body reach,
  and gives up when it cannot: `topics.get().length` declares `items: unknown`
  and expands no topic, while the same count through a helper it cannot see into
  declares `items: true` and reads every topic whole — thread, verbs, and
  rendered UI included. That is how one derived value ends up reading the whole
  space. So every derivation here is a module-scope `lift`, because a `lift`'s
  declared parameter type is a ceiling an opaque helper cannot widen.

  `boardRows`, the one derivation that runs over the whole board, declares
  `TopicSummary` — a title and four scalars. Building every row therefore
  expands no topic's body, thread, verbs, or rendered UI.

  A lift's parameter and its result are one type in TypeScript, which looks like
  it forces a choice: narrow the parameter to bound the read, and the row's
  `topic` narrows with it, so a card could no longer render a body snippet. It
  is not a real choice. A reference that passes through a lift is a link, and a
  link resolves to the whole topic however little of it the lift declared — so
  `boardRows` reads `TopicSummary` and asserts each row's reference back to
  `TopicPiece`. The parameter bounds the read; the assertion states what the row
  actually holds. It carries a `HACK:` note: the runtime already guarantees
  this, and a generic lift that carried the input reference type through to the
  output would say it without a cast.

  What each reader of a row gets from that one link is then its own declared
  schema's business. The published `index` declares it title-only, so a survey
  cannot expand a topic at all; `TopicCard`, which the board's ordering and card
  rendering are declared over, projects two display fields out of it. Neither
  type is published, which is what leaves both free to be that narrow.

  The rule for new code stands regardless: prefer a scalar reduction
  (`topics.get().length`) over anything that hands the array to a helper.
- **Row identity is a cell, not an array position.** Each row goes in a cell
  caused by the topic it describes, and the rows array holds links to those
  cells rather than the row values inline. The card list is a mapped
  sub-pattern, and `map` keys its element runs by each element's normalized
  link: a link resolves to the row's own entity and stays the same wherever the
  row sits, while an inline value resolves to the array position. Because the
  board sorts by activity, every append is a prepend — with inline rows, one new
  topic re-keys every card and rebuilds its whole subtree.
- **Authoring: cf-code-editor in the Edit→Save draft flow.** The editor binds
  the session-local `bodyDraft` (never live to the shared string — whole-value
  conflict semantics hold) with `@`-mention autocomplete over `mentionable`. The
  read view renders the body as markdown.
- **Nothing derived is persisted.** The index is recomputed from the board on
  read; no derived field is written back into a topic. A pattern that writes
  derived data into its own children can destroy real data when it runs from a
  partial-view replica, so any future persisted index needs single-writer +
  full-view preconditions first.
- Verified by `multi-user.test.tsx` (two isolated runtimes, one shared board).

## Headless / agent use

Agents are first-class participants. **Deployed lag:** a live board can run an
older pattern than this source — the Estuary team board does today — and an
older schema silently discards fields it does not declare. Until a migration
lands, `body`-at-create and the loud rejections described here may not be live
on a given board; check `cf piece verbs`, whose listing carries the deployed
pattern's source identity, before relying on either. Against a deployed board
piece:

```bash
cf piece call --piece <board> addTopic \
  '{"title":"...","body":"the initial living document","agentName":"Sol"}'
# -> { "result": { "topic": … } }: the topic this call created
cf piece get --piece <board> topics --input \
  --select title,createdAt,lastActivityAt,commentCount
cf piece call --piece <topic> addComment \
  '{"body":"point-in-time progress update","agentName":"Sol"}'
cf piece call --piece <topic> setBody \
  '{"body":"latest state plus the topic narrative","agentName":"Sol"}'
cf piece call --piece <topic> addLink \
  '{"kind":"pr","url":"https://github.com/org/repo/pull/123","label":"PR #123","agentName":"Sol"}'
```

**A full-board survey is one bounded read of `index`.** Each row is the topic's
canonical `fid`, the child reference, and scalar summaries (`title`,
`createdAt`, `createdBy`, `commentCount`, `lastActivityAt`). The reference is
declared through a title-only schema, so the read cannot expand a topic's body,
thread, or verbs no matter how it is projected.

```bash
cf piece get --piece <board> index --step
```

The `fid` on a row is the canonical address of the topic that row describes —
the one to pass as `--piece` for that topic's own reads and verbs. A row's
`topic` reference resolves to the same address through `--select topic@`, so
this field is a convenience rather than the only way through. What it buys is
composition with `--filter`, which `@` does not have: a filtered array's
survivors no longer say which positions they came from, so finding one topic by
title and learning where it lives is one read with this field and two without.
It is derived from runtime-only cell surface and reads `""` for a topic whose
own entity has not resolved yet.

The board input links to complete Topic objects, including bodies, threads, and
handlers. Targeted headless discovery beyond the index should therefore combine
an exact/range `--filter` with a concise `--select` instead of materializing the
whole corpus:

```bash
cf piece get --piece <board> index --step \
  --filter '.title == "<exact title>"' \
  --select fid,title,lastActivityAt,commentCount
cf piece get --piece <board> topics --input \
  --filter '.lastActivityAt >= <epoch-milliseconds>' \
  --select title,lastActivityAt,commentCount,createdBy.kind,createdBy.name
cf piece get --piece <topic> comments --input \
  --filter '.author.name == "Sol" or .authorName == "Sol"' \
  --select sentAt,author.kind,author.name,authorName,body
cf piece get --piece <topic> links --input \
  --filter '.kind == "pr"' --select kind,url,label,addedAt
```

Filtering happens before projection and preserves list order. The jq-inspired
predicate subset supports paths, JSON literals, comparisons, boolean operators,
and parentheses; it does not provide substring search, regexes, sorting, or an
arbitrary jq pipeline. These transforms execute as a session-scoped computed
pattern expression, so their CFC metadata behavior matches authored
filter/map/lift expressions. The durable `topics --input` list remains evidence
when the computed `index --step` read cannot materialize, but only a successful
index row supplies the canonical Topic fid.

Every agent-authored mutation carries `agentName`; there is no preceding “set
current name” call. Fabric's operation history retains the authenticated human
principal, while the stored snapshot disambiguates which agent acted.

**Every mutating verb returns what it recorded.** `addTopic` returns the topic
it created — the piece itself, so the caller addresses the new topic straight
from the create instead of filing it and then searching the board for it.
`addComment` and `addLink` return the appended record, `setBody` the persisted
body plus the attribution it wrote; each carries fields the pattern resolved
(the structured author derived from `agentName`, the write-time timestamp) that
a caller cannot compute for itself. Counts are deliberately not returned: these
appends are mergeable ops, so a length observed inside one handling is not a
fact about the resulting list — read `commentCount` when you want the count.

A returned value reaches the caller through the handling's receipt. A result
carrying a piece (`addTopic`) travels the result-pattern projection path; the
plain records (`addComment`, `addLink`, `setBody`) project into the receipt
under `plainResultReceipts`, which is on by default
(`docs/development/EXPERIMENTAL_OPTIONS.md`). Setting
`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false` restores the discard, and those three
verbs then still perform their write and simply report no result.

`addTopic` takes the body at create (optional): a topic born with a body appears
with it atomically — no reader observes a title-only halfway state, and no
follow-up `setBody` is needed to finish filing (the verb contract's atomic-unit
rule, `docs/plans/pattern-verb-contract.md`). Body-at-create is not a body
_update_: `bodyUpdatedBy`/`bodyUpdatedAt` stay unset.

Invalid mutations **throw** instead of silently returning (verb contract rule
4): an empty title, an empty comment body, a blank or non-http(s) link URL, and
a blank `agentName` on any verb all surface as a failed call — a nonzero CLI
exit — never as apparent success. An _omitted_ `agentName` remains the tolerated
legacy-caller path. The UI composer wrappers keep their silent guards: an empty
draft is a non-event in a composer, not a headless mutation.
