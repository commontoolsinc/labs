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

The transport identity is shared, so textual signatures provide agent-level
attribution. Sign every content mutation with `— <agent name> (agent)`: use a
final signature line for bodies and comments, and an inline suffix for titles
and link labels. Preserve existing signed history when replacing a body. If your
stable agent name is unclear, ask before writing.

Immediately before every `addTopic`, `setBody`, `addComment`, or `addLink` call,
set the board's per-user author name to that same stable agent name:

```bash
deno task cf piece call --url "$TOPICS_BOARD_URL" setMyName '{"name":"<agent name>"}'
```

Do this even when the board already appears to show the right name; never leave
a change attributed to the previous actor. `setMyName` is self-identifying; the
content mutation that follows still needs its textual signature.

## Reading Topics

Read the board's topic references from its input cell, then address a topic by
the canonical fid published in the board's `crossrefs` result:

```bash
deno task cf piece get --url "$TOPICS_BOARD_URL" topics --input
deno task cf piece get --url "$TOPICS_BOARD_URL" crossrefs --step
export TOPIC_URL='https://estuary.saga-castor.ts.net/topics-dev-476ea34f/<topic-fid>'
deno task cf piece get --url "$TOPIC_URL" title --input
deno task cf piece get --url "$TOPIC_URL" body --input
deno task cf piece get --url "$TOPIC_URL" comments --input
deno task cf piece get --url "$TOPIC_URL" links --input
```

Each crossref row's `fid` is the canonical address for its `topic`. Prefer it to
the intermediate wrapper link stored in the board's topics array. Read the
existing topic's input before changing it, especially its full body, comments,
and links. Input reads are durable and do not need `--step`; use `--step` on
result reads that must be current. If `topics --input` is non-empty but
`crossrefs --step` is empty or fails, do not infer that the board is empty.

## Creating and updating

Create a topic through the board rather than deploying the Topic pattern
directly:

```bash
deno task cf piece call --url "$TOPICS_BOARD_URL" setMyName '{"name":"<agent name>"}'
deno task cf piece call --url "$TOPICS_BOARD_URL" addTopic '{"title":"<title> — <agent name> (agent)"}'
deno task cf piece get --url "$TOPICS_BOARD_URL" crossrefs --step
```

Find the new topic's canonical fid in `crossrefs` before applying further
changes. All handler arguments are JSON; encode multiline Markdown rather than
passing an unescaped string.

```bash
deno task cf piece call --url "$TOPICS_BOARD_URL" setMyName '{"name":"<agent name>"}'
deno task cf piece call --url "$TOPIC_URL" setBody '{"body":"<complete revised body, retaining signed history>\n\n— <agent name> (agent)"}'
deno task cf piece call --url "$TOPICS_BOARD_URL" setMyName '{"name":"<agent name>"}'
deno task cf piece call --url "$TOPIC_URL" addComment '{"body":"<point-in-time update>\n\n— <agent name> (agent)"}'
deno task cf piece call --url "$TOPICS_BOARD_URL" setMyName '{"name":"<agent name>"}'
deno task cf piece call --url "$TOPIC_URL" addLink '{"kind":"pr","url":"<PR URL>","label":"<PR label> — <agent name> (agent)"}'
deno task cf piece get --url "$TOPIC_URL" commentCount --step
```

The body is the living big-picture document. Replace it in place with the full
revised body so a reader sees the current state without replaying the thread,
while retaining the Topic's meaningful history and decisions. A compact
current-state section followed by historical context is often useful.

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

- If initial CLI synchronization times out, no piece read or mutation ran. Retry
  once; if it repeats, report the deployment or authorization blocker.
- If `topics --input` is non-empty while `crossrefs --step` is empty or fails,
  do not call the board empty. Preserve the input evidence and report the
  result-materialization failure.
- Do not substitute `piece ls` for the board's topic list. Pieces created inside
  handlers can be absent from that listing; `crossrefs --step` is the canonical
  fid index, with `topics --input` as the durable fallback.
