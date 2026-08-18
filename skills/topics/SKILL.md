---
name: topics
description: Interact with the Common Fabric team's Topics board on Estuary through
  the Labs cf CLI. Use when reading, creating, or updating Topics; posting Topic
  progress comments; or attaching pull request links to Topics.
---

# Topics on Estuary

Topics is the team's minimal issue tracker. This skill names the deployed board,
its CLI surface, and the team's authorship and editorial conventions. For the
general CLI map, use `skills/cf/SKILL.md`; for Topics semantics, the canonical
source is `packages/patterns/topics/README.md` and the handlers in
`packages/patterns/topics/main.tsx` and `packages/patterns/topics/topic.tsx`.

## Deployment

Run commands from the Labs repository root. This skill is intentionally specific
to the current Estuary dogfood deployment:

```bash
export TOPICS_BOARD_URL='https://estuary.saga-castor.ts.net/topics-dev-476ea34f/fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34'
export CF_IDENTITY="<exact path to the key your human user uses>"
```

The board space is `topics-dev-476ea34f`. A topic URL has the same host and
space, with the topic's `fid1:...` in place of the board fid.

## Identity and authorship

For now, use the same Estuary identity key as your human user. Do not mint a
separate agent key, guess a key from a wildcard, use another human's key, or use
the publicly derivable `implicit trust` identity against Estuary. If the exact
key path is not already explicit, ask your human user; if the key is unavailable
locally, stop rather than creating one.

The transport identity is shared, so every content mutation must carry
`"agentName":"<stable agent name>"` in the same JSON payload. The pattern stores
that as structured authorship and renders it as `<agent name> (agent)`, while
Fabric retains the human principal behind the key. Do not call `setMyName`,
decorate titles or link labels, or add manual signature lines to bodies and
comments. If your stable agent name is unclear, ask before writing.

Legacy boards and topics may still contain `myName`, `createdByName`, or
`authorName`. The pattern temporarily mirrors those fields for consumers of the
previous deployed schema. Treat them as output-only compatibility details: never
set or copy them into agent mutations.

## Reading Topics

The current pattern exports `index` — a compact discovery result whose rows ARE
the Topics, declared through scalar summaries, so one read surveys the whole
board without expanding any Topic:

```bash
deno task cf get --url "$TOPICS_BOARD_URL" index --step
```

A deployed board can run an older pattern without `index` — the read above
erroring on an unknown path is the tell. Survey such a board through the durable
`topics` input instead, projected immediately: an unprojected row follows the
linked Topic and can include its body, comments, and handlers.

```bash
deno task cf get --url "$TOPICS_BOARD_URL" topics --input \
  --filter '.title != null' \
  --select title,createdAt,lastActivityAt,commentCount,createdBy.kind,createdBy.name
```

The title predicate keeps discovery output uniformly object-shaped by omitting
valid null rows. Concise projection itself preserves nullable rows and follows
declared nested arrays without exposing sibling fields.

`--filter` is useful for exact field and range searches. It runs before
`--select`, so a predicate can inspect a field that the result omits:

```bash
# Find one Topic by exact title.
deno task cf get --url "$TOPICS_BOARD_URL" topics --input \
  --filter '.title == "<exact title>"' \
  --select title,lastActivityAt,commentCount

# Find Topics active at or after an epoch-millisecond threshold.
deno task cf get --url "$TOPICS_BOARD_URL" topics --input \
  --filter '.lastActivityAt >= 1785074400000' \
  --select title,lastActivityAt,commentCount,createdBy.kind,createdBy.name

# Combine predicates for a narrower field search.
deno task cf get --url "$TOPICS_BOARD_URL" topics --input \
  --filter '.createdBy.name == "<name>" and .commentCount > 0' \
  --select title,lastActivityAt,commentCount
```

Filtering preserves board order; it does not sort by activity. The predicate
language supports paths, JSON literals, comparisons, boolean operators, and
parentheses, but not substring, regex, sorting, or arbitrary jq programs. Use
exact known fields or numeric ranges to shrink the corpus, then inspect the
small result. Always combine a Topic-list filter with `--select`; filter alone
returns every property of each match.

Address a selected Topic by the address its own `index` row carries. Project
that computed index to ask for it:

```bash
deno task cf get --url "$TOPICS_BOARD_URL" index --step \
  --select @,title,lastActivityAt,commentCount
export TOPIC_URL='https://estuary.saga-castor.ts.net/topics-dev-476ea34f/<topic-fid>'
deno task cf get --url "$TOPIC_URL" title --input
deno task cf get --url "$TOPIC_URL" body --input
deno task cf get --url "$TOPIC_URL" comments --input \
  --select sentAt,author.kind,author.name,authorName,body
deno task cf get --url "$TOPIC_URL" links --input \
  --select kind,url,label,addedAt,addedBy.kind,addedBy.name

# Search within a selected Topic's arrays.
deno task cf get --url "$TOPIC_URL" comments --input \
  --filter '.author.name == "<agent>" or .authorName == "<legacy name>"' \
  --select sentAt,author.kind,author.name,authorName,body
deno task cf get --url "$TOPIC_URL" links --input \
  --filter '.kind == "pr"' --select kind,url,label,addedAt
```

A `--select` segment ending in `@` returns that position's address instead of a
copy of what is behind it, which is what a following `piece call` needs. It does
not compose with `--filter` — a filtered array's survivors no longer say which
positions they came from — so ask for an address in its own unfiltered read:

```bash
deno task cf get --url "$TOPICS_BOARD_URL" index --step \
  --select @,title
```

An index row IS its Topic, so the row's own address is the Topic's. Prefer it to
the intermediate wrapper link stored in the board's topics array. Read the
existing topic's input before changing it, especially its full body, comments,
and links. Input reads are durable and do not need `--step`; use `--step` on
result reads that must be current.

A board too old to publish `index` publishes `crossrefs` instead — the removed
reference-graph result. Its rows carry a row-level `fid`, which is that board's
address source, so it answers the same question. Search it by `.topic.title`
rather than `.title`: the row-level `title` was added to `crossrefs` later than
`index` was, so a board old enough to need this read is one whose rows do not
have it, and `.topic.title` is the form that works on every generation that
publishes `crossrefs` at all. On such a board this is the only address source,
so reach for it there and nowhere else:

```bash
deno task cf get --url "$TOPICS_BOARD_URL" crossrefs --step \
  --filter '.topic.title == "<exact title>"' --select fid,topic.title
```

If `topics --input` is non-empty while neither computed read materializes, do
not infer that the board is empty. The non-null rows from a compact
`topics --input` search remain valid evidence, but the search does not expose a
Topic's address, so report the materialization blocker rather than guessing one.

## Creating and updating

Create a topic through the board rather than deploying the Topic pattern
directly:

```bash
deno task cf call --url "$TOPICS_BOARD_URL" addTopic \
  '{"title":"<title>","agentName":"<agent name>"}'
deno task cf get --url "$TOPICS_BOARD_URL" index --step --select @,title
```

`addTopic` returns the topic it created, so a board running this source hands
back the new topic on the call itself, and the follow-up read is only a
convenience. An older deployed `addTopic` returns nothing, and a board that old
may also predate `index` — in which case the `crossrefs --step` lookup under
"Reading Topics" is what works there. Establish which board you are talking to
BEFORE creating anything: `cf piece verbs` reports the deployed pattern's source
identity, and a create whose fid you then cannot find leaves a topic you cannot
address. All handler arguments are JSON; encode multiline Markdown rather than
passing an unescaped string.

```bash
deno task cf call --url "$TOPIC_URL" setBody \
  '{"body":"<complete revised body>","agentName":"<agent name>"}'
deno task cf call --url "$TOPIC_URL" addComment \
  '{"body":"<point-in-time update>","agentName":"<agent name>"}'
deno task cf call --url "$TOPIC_URL" addLink \
  '{"kind":"pr","url":"<PR URL>","label":"<PR label>","agentName":"<agent name>"}'
deno task cf get --url "$TOPIC_URL" commentCount --step
```

Each of these three returns the record it wrote — the appended comment or link,
or the persisted body plus its attribution — which spares the verification read
above. That result rides `plainResultReceipts`, on by default; only an explicit
`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false` discards it. The write happens either
way, so treat an absent result as "not enabled here", never as "the mutation did
not land".

Name mutations so an interrupted run can retry them safely: mint one invocation
session per run
(`export CF_INVOCATION_SESSION="$(deno task cf invocation-session new)"`) and
pass `--invocation <your-key>` on mutating calls. A retry with the same pair
settles on the original outcome instead of posting twice — the handler body
re-runs, but nothing commits twice. The settled envelope also carries `receipt`,
the address of the outcome, which `deno task cf get --piece <receipt id>` reads
back later without re-invoking.

The body is the living big-picture document. Replace it in place with the full
revised body so a reader sees the current state without replaying the thread,
while retaining the Topic's meaningful narrative and decisions. A compact
current-state section followed by historical context is often useful. Fabric
owns the revision history; do not reproduce it as a separate activity ledger
inside the body.

Comments are append-only, point-in-time progress records. Add one after a
meaningful work increment to explain what changed, what was learned or decided,
and what comes next; use the body for the synthesized narrative rather than
trying to revise earlier comments.

Add every relevant pull request explicitly with `addLink` and `kind: "pr"`;
mentioning it only in prose is not enough.

A connection to another Topic is a **reference**, not a string. `mention` takes
the piece itself, and `unmention` removes every entry naming that piece —
writing the fid into the body does nothing, because nothing scans prose for
addresses.

Reach them from the topic's own page rather than the CLI. An inline call
argument is parsed as plain JSON, so an address written in one arrives as the
string it looks like rather than as the topic it names: the call settles, and
the reference it stored points at the text. Record a connection through the
References card, whose @-mention picker hands the verb the piece.

A person retracts one from the same place — the References card lists what was
added this way, each row with a remove control. A mention written into the prose
is not listed there: it is removed by editing the prose. Both are mergeable, so
concurrent callers all land, and mentioning the same piece twice is still one
edge — the graph asks whether anything names a topic, not how often. Each Topic
publishes what it points at as `mentions`, and who points at it as
`referencedBy` — both derived, so retracting a mention removes the edge and
nothing is left behind in the target. An `addLink` whose URL names a piece also
becomes a reference; one that names a web page stays a web page.

## Persistence and computed results

Topics handlers commit source writes before result recomputation. Verify bodies,
comments, links, titles, and the board's topic list with
`piece get ... --input`. To read `topicCount`, `index`, `commentCount`,
`lastActivityAt`, or other computed results, use `piece get ... --step`. This
keeps start, pull, recomputation, synchronization, read, and stop in one CLI
runtime; a separate `piece step` process cannot carry session-scoped
materialization into a later `piece get` process.

An unstepped result read with stored raw data but unresolved required values
exits nonzero and points to `--step`; it is not an empty or absent result. If
`--step` itself reports that a required value did not materialize, use input
reads to establish what committed, but do not claim result-dependent
verification succeeded.

## Troubleshooting

- If initial CLI synchronization times out, no piece read or mutation ran.
  Report the blocker; rerun only after Tailnet/API reachability or identity
  authorization has been re-established.
- If a mutation fails or times out after `invocation:` was announced on stderr,
  the write may still have committed. Do not re-send it blind: re-invoke with
  the same `--invocation` id under the same session — it deduplicates against a
  committed outcome and executes fresh only if nothing landed.
- If `topics --input` is non-empty while the board's fid index — `index --step`,
  or `crossrefs --step` on a board that predates it — is empty or fails, do not
  call the board empty. Preserve the input evidence and report the
  result-materialization failure.
- A compact transformed read of a present source exits nonzero when its value
  cannot materialize and explicitly says the failure is not JSON `null`. A
  printed `null` is a valid projected null or an absent optional source, not an
  empty array or proof of no matches; use `--filter '.title != null'` when null
  Topic rows are irrelevant.
- Do not substitute `piece ls` for the board's topic list. Pieces created inside
  handlers can be absent from that listing; `index --step` is the canonical fid
  index — `crossrefs --step` on a board that predates it — with `topics --input`
  as the durable fallback for everything except the fid.
