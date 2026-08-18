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

Topics reference each other. A reference is a **cell**, not a string: picking a
completion in the body editor stores the destination piece itself, and a link
whose URL names a piece resolves to that piece. Nothing scans prose for pasted
addresses, so a reference survives a rename, a move, and a redirect, and there
is no id to mint or keep in step.

Deliberately absent until reached for: statuses (not even open/closed), labels,
assignees, attachments, nesting. What a topic grows next is part of the
experiment.

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

  Two derivations run over the whole board, and each declares only what it
  reads. `crossrefTable` takes one list of references per topic and builds the
  mention pivot from it; `cardsByActivity` takes a single timestamp per topic
  and orders the cards by it. Neither expands a topic's title, prose, thread,
  verbs, or rendered UI.

  A lift's parameter and its result look like one type, which seems to force a
  choice: narrow the parameter to bound the read, and what comes out narrows
  with it, so a card could no longer render a body snippet. It is not a real
  choice, and it is not settled by a cast either. A generic lift states the two
  separately — the CONSTRAINT is what the body reads, the type parameter is what
  the caller handed in — and a reference that passes through resolves to the
  whole topic however little the lift declared. `cardsByActivity` is written
  that way: it reads one timestamp and gives back the topics themselves.

  What each reader of a topic gets is then its own declared schema's business.
  The published `index` declares the five scalars a survey reads, so a survey
  cannot expand a topic past them, while the card list's argument schema is
  shrunk to the handful of fields its body renders. Neither widens the topic,
  which is what leaves both free to be that narrow — and it is why every field a
  card renders carries a default, since that schema is what a piece holding
  older topics is updated against.

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
  conflict semantics hold) with `@`-mention autocomplete over `mentionable`, and
  `$references` — the map where a picked completion stores its destination. The
  read view renders the body as markdown.
- **The mention map is staged with the prose, not written through it.** The
  editor writes an entry the instant a mention is inserted and drops one the
  instant its token leaves the document, neither waiting for Save. Both bindings
  therefore address session drafts: `bodyDraft` and `referencesDraft`, seeded
  together by Edit and published together by Save. Pointing `$references` at the
  durable map instead would make Cancel non-transactional in both directions — a
  discarded insertion would leave an edge no token names, and a discarded
  deletion would strip the destination out from under a token the durable body
  still carries. Each `destination` survives the two copies because it is
  declared `unknown`, which is what carries a reference across a whole-value
  read and write instead of expanding the piece behind it.
- **A reference is a cell, and identity is the only thing compared.** The board
  derives the whole graph once, in `crossrefTable`, from the same topics array
  read under two minimal declared views: one for identity, one for what each
  topic points at. Matching is a linear scan of `equals` — with a cell reference
  as the identity there is nothing to key a map by, and at board scale it is a
  few hundred comparisons of resolved links.

  Each topic then does a lookup rather than the join: find yourself among the
  siblings, take the row at that position. It searches `mentionable` rather than
  the table itself because **a link survives being read as an element of an
  array a parameter declares at its top level, and does not survive being read
  as a field nested inside one** — the nested read resolves it to a plain object
  and leaves `equals` nothing to follow. Rows align with the topics array by
  construction, since the pivot maps over it.

  Every row is addressed by the topic it describes (`Writable.for(topic)`), so a
  row keeps its identity however the board is reordered, and a lookup re-run by
  an unrelated change recomputes the same links at the same address and writes
  nothing.
- **Agents reference through a verb.** `mention` and `unmention` take the piece
  itself. With prose no longer scanned there is otherwise no headless way to
  make a reference, and `kind: "topic"` links are ordinary links unless their
  URL resolves.
- **Nothing derived is persisted.** The index and the reference graph are
  recomputed from the board on read; no derived field is written back into a
  topic, so retracting a mention simply removes the edge. A pattern that writes
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
cf call --piece <board> addTopic \
  '{"title":"...","body":"the initial living document","agentName":"Sol"}'
# -> { "result": { "topic": … } }: the topic this call created
cf get --piece <board> topics --input \
  --select title,createdAt,lastActivityAt,commentCount
cf call --piece <topic> addComment \
  '{"body":"point-in-time progress update","agentName":"Sol"}'
cf call --piece <topic> setBody \
  '{"body":"latest state plus the topic narrative","agentName":"Sol"}'
cf call --piece <topic> setTitle \
  '{"title":"a sharper name for the same attention","agentName":"Sol"}'
cf call --piece <topic> addLink \
  '{"kind":"pr","url":"https://github.com/org/repo/pull/123","label":"PR #123","agentName":"Sol"}'
```

`addLink` still requires `kind` and `label` even though the handler would
default them (`"web"`, the URL): the compat gate compares a verb's event schema
in the result direction, where required-to-optional is refused, so the
relaxation rides the next acknowledged schema break. `setTitle` renames with
attribution — it stamps `titleUpdatedBy`/`titleUpdatedAt` and moves
`lastActivityAt`, so a renamed topic surfaces in the board's most-recent sort.
It lives on the topic's direct interface rather than the shared `TopicPiece`
projection: a holder's required demands are write-once, so a verb added to the
projection every board embeds would refuse those boards' updates. Address the
topic itself and the verb is there.

**A full-board survey is one bounded read of `index`.** Each row IS the topic it
describes, declared through a schema of scalar summaries (`title`, `createdAt`,
`createdBy`, `commentCount`, `lastActivityAt`). The declared schema is the
bound, so the read cannot expand a topic's body, thread, or verbs no matter how
it is projected.

```bash
cf get --piece <board> index --step
```

A row's own address is the address of the topic it describes — the one to pass
as `--piece` for that topic's own reads and verbs. `--select index[].@` resolves
it. An address names a position and a filtered array's survivors no longer say
which positions they came from, so `@` and `--filter` do not combine: read the
index, which the row schema keeps narrow enough to read whole, and pick the row
you want.

The board input links to complete Topic objects, including bodies, threads, and
handlers. Targeted headless discovery beyond the index should therefore combine
an exact/range `--filter` with a concise `--select` instead of materializing the
whole corpus:

```bash
cf get --piece <board> index --step \
  --select @,title,lastActivityAt,commentCount
cf get --piece <board> topics --input \
  --filter '.lastActivityAt >= <epoch-milliseconds>' \
  --select title,lastActivityAt,commentCount,createdBy.kind,createdBy.name
cf get --piece <topic> comments --input \
  --filter '.author.name == "Sol" or .authorName == "Sol"' \
  --select sentAt,author.kind,author.name,authorName,body
cf get --piece <topic> links --input \
  --filter '.kind == "pr"' --select kind,url,label,addedAt
```

Filtering happens before projection and preserves list order. The jq-inspired
predicate subset supports paths, JSON literals, comparisons, boolean operators,
and parentheses; it does not provide substring search, regexes, sorting, or an
arbitrary jq pipeline. These transforms execute as a session-scoped computed
pattern expression, so their CFC metadata behavior matches authored
filter/map/lift expressions. The durable `topics --input` list remains evidence
when the computed `index --step` read cannot materialize, but only a successful
index row supplies a Topic's address.

Every agent-authored mutation carries `agentName`; there is no preceding “set
current name” call. Fabric's operation history retains the authenticated human
principal, while the stored snapshot disambiguates which agent acted.

**Every mutating verb returns what it recorded.** `addTopic` returns the topic
it created — the piece itself, reaching the caller as a link the CLI renders as
an address, so the caller addresses the new topic straight from the create
instead of filing it and then searching the board for it. The result is declared
through the index's row schema rather than the full topic: the declared schema
bounds the default readback, and every name a verb's result publishes is
permanent, so the create hands back the survey row plus the write-time facts
only the pattern could resolve (`createdAt`, `createdBy`). `addComment` and
`addLink` return the appended record, `setBody` the persisted body plus the
attribution it wrote, `setTitle` the persisted title plus its attribution; each
carries fields the pattern resolved that a caller cannot compute for itself.
Counts are deliberately not returned: these appends are mergeable ops, so a
length observed inside one handling is not a fact about the resulting list —
read `commentCount` when you want the count.

A returned value reaches the caller through the handling's receipt. A result
carrying a piece (`addTopic`) travels the result-pattern projection path; the
plain records (`addComment`, `addLink`, `setBody`, `setTitle`) project into the
receipt under `plainResultReceipts`, which is on by default
(`docs/development/EXPERIMENTAL_OPTIONS.md`). Setting
`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false` restores the discard, and those verbs
then still perform their write and simply report no result.

`addTopic` takes the body at create (optional): a topic born with a body appears
with it atomically — no reader observes a title-only halfway state, and no
follow-up `setBody` is needed to finish filing (the verb contract's atomic-unit
rule, `docs/plans/pattern-verb-contract.md`). Body-at-create is not a body
_update_: `bodyUpdatedBy`/`bodyUpdatedAt` stay unset.

Invalid mutations **throw** instead of silently returning (verb contract rule
4): an empty title, an empty comment body, a blank or non-http(s) link URL, and
a blank `agentName` on any verb all surface as a failed call — a nonzero CLI
exit — never as apparent success. An _omitted_ `agentName` remains the tolerated
legacy-caller path on the verbs that predate signing; `setTitle` postdates it,
so there the field is simply required. The UI composer wrappers keep their
silent guards: an empty draft is a non-event in a composer, not a headless
mutation.
