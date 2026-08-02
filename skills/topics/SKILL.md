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

The board's durable `topics` input is the reliable discovery corpus. Project it
immediately: an unprojected row follows the linked Topic and can include its
body, comments, handlers, and reference graph.

```bash
deno task cf piece get --url "$TOPICS_BOARD_URL" topics --input \
  --schema title,createdAt,lastActivityAt,commentCount,createdBy.kind,createdBy.name
```

`--filter` is useful for exact field and range searches. It runs before
`--schema`, so a predicate can inspect a field that the result omits:

```bash
# Find one Topic by exact title.
deno task cf piece get --url "$TOPICS_BOARD_URL" topics --input \
  --filter '.title == "<exact title>"' \
  --schema title,lastActivityAt,commentCount

# Find Topics active at or after an epoch-millisecond threshold.
deno task cf piece get --url "$TOPICS_BOARD_URL" topics --input \
  --filter '.lastActivityAt >= 1785074400000' \
  --schema title,lastActivityAt,commentCount,createdBy.kind,createdBy.name

# Combine predicates for a narrower field search.
deno task cf piece get --url "$TOPICS_BOARD_URL" topics --input \
  --filter '.createdBy.name == "<name>" and .commentCount > 0' \
  --schema title,lastActivityAt,commentCount
```

Filtering preserves board order; it does not sort by activity. The predicate
language supports paths, JSON literals, comparisons, boolean operators, and
parentheses, but not substring, regex, sorting, or arbitrary jq programs. Use
exact known fields or numeric ranges to shrink the corpus, then inspect the
small result. Always combine a Topic-list filter with `--schema`; filter alone
returns every property of each match.

Address a selected Topic by the canonical fid published in the board's
`crossrefs` result. Filter and project that computed index too:

```bash
deno task cf piece get --url "$TOPICS_BOARD_URL" crossrefs --step \
  --filter '.topic.title == "<exact title>"' \
  --schema fid,topic.title,topic.lastActivityAt,topic.commentCount
export TOPIC_URL='https://estuary.saga-castor.ts.net/topics-dev-476ea34f/<topic-fid>'
deno task cf piece get --url "$TOPIC_URL" title --input
deno task cf piece get --url "$TOPIC_URL" body --input
deno task cf piece get --url "$TOPIC_URL" comments --input \
  --schema sentAt,author.kind,author.name,authorName,body
deno task cf piece get --url "$TOPIC_URL" links --input \
  --schema kind,url,label,addedAt,addedBy.kind,addedBy.name

# Search within a selected Topic's arrays.
deno task cf piece get --url "$TOPIC_URL" comments --input \
  --filter '.author.name == "<agent>" or .authorName == "<legacy name>"' \
  --schema sentAt,author.kind,author.name,authorName,body
deno task cf piece get --url "$TOPIC_URL" links --input \
  --filter '.kind == "pr"' --schema kind,url,label,addedAt
```

Each crossref row's `fid` is the canonical address for its `topic`. Prefer it to
the intermediate wrapper link stored in the board's topics array. Read the
existing topic's input before changing it, especially its full body, comments,
and links. Input reads are durable and do not need `--step`; use `--step` on
result reads that must be current. If `topics --input` is non-empty but
`crossrefs --step` is empty or fails, do not infer that the board is empty. The
compact `topics --input` search remains valid evidence, but it does not expose a
canonical Topic fid, so report the crossref materialization blocker rather than
guessing an address.

## Creating and updating

Create a topic through the board rather than deploying the Topic pattern
directly:

```bash
deno task cf piece call --url "$TOPICS_BOARD_URL" addTopic \
  '{"title":"<title>","agentName":"<agent name>"}'
deno task cf piece get --url "$TOPICS_BOARD_URL" crossrefs --step \
  --filter '.topic.title == "<exact title>"' --schema fid,topic.title
```

Find the new topic's canonical fid in `crossrefs` before applying further
changes. All handler arguments are JSON; encode multiline Markdown rather than
passing an unescaped string.

```bash
deno task cf piece call --url "$TOPIC_URL" setBody \
  '{"body":"<complete revised body>","agentName":"<agent name>"}'
deno task cf piece call --url "$TOPIC_URL" addComment \
  '{"body":"<point-in-time update>","agentName":"<agent name>"}'
deno task cf piece call --url "$TOPIC_URL" addLink \
  '{"kind":"pr","url":"<PR URL>","label":"<PR label>","agentName":"<agent name>"}'
deno task cf piece get --url "$TOPIC_URL" commentCount --step
```

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
mentioning it only in prose is not enough. Topic-to-topic connections are
derived automatically from topic fids or page URLs mentioned in bodies,
comments, and link URLs, so do not add manual `kind: "topic"` links.

## Persistence and computed results

Topics handlers commit source writes before result recomputation. Verify bodies,
comments, links, titles, and the board's topic list with
`piece get ... --input`. To read `topicCount`, `crossrefs`, `commentCount`,
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
  Report the deployment or authorization blocker unless external state changes.
- If `topics --input` is non-empty while `crossrefs --step` is empty or fails,
  do not call the board empty. Preserve the input evidence and report the
  result-materialization failure.
- Do not substitute `piece ls` for the board's topic list. Pieces created inside
  handlers can be absent from that listing; `crossrefs --step` is the canonical
  fid index, with `topics --input` as the durable fallback.
