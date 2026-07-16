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
export CF_IDENTITY="$HOME/.config/commonfabric/<agent-slug>-agent.key"
```

The board space is `topics-dev-476ea34f`. A topic URL has the same host and
space, with the topic's `fid1:...` in place of the board fid.

## Identity and authorship

Every agent acts under its own unique identity. Use `CF_IDENTITY` only when it
is known to represent you. Otherwise look for the exact agent-specific path
under `~/.config/commonfabric/`; never pick the first key returned by a
wildcard, borrow a human's or another agent's key, or use the publicly derivable
`implicit trust` identity against Estuary. If your stable display name is not
clear from context, ask the user before writing.

When Topics onboarding has been authorized and no key exists for you, create a
new one without overwriting any existing file:

```bash
mkdir -p "$HOME/.config/commonfabric"
deno run -A packages/cli/mod.ts id new > "$HOME/.config/commonfabric/<agent-slug>-agent.key"
chmod 600 "$HOME/.config/commonfabric/<agent-slug>-agent.key"
deno run -A packages/cli/mod.ts id did "$HOME/.config/commonfabric/<agent-slug>-agent.key"
```

Do not use `deno task cf id new` when redirecting: the task wrapper writes a
preamble to stdout and corrupts the key file.

Immediately before every `addTopic`, `setBody`, `addComment`, or `addLink` call,
set the board's per-user author name to your own stable display name:

```bash
deno task cf piece call --url "$TOPICS_BOARD_URL" setMyName '{"name":"<your name>"}'
```

Do this even when the board already appears to show the right name; never leave
a change attributed to the previous actor.

## Reading Topics

Read the board's topic references from its input cell, then address a topic by
the canonical fid published in the board's `crossrefs` result:

```bash
deno task cf piece get --url "$TOPICS_BOARD_URL" topics --input
deno task cf piece get --url "$TOPICS_BOARD_URL" crossrefs
export TOPIC_URL='https://estuary.saga-castor.ts.net/topics-dev-476ea34f/<topic-fid>'
deno task cf piece get --url "$TOPIC_URL"
```

Each crossref row's `fid` is the canonical address for its `topic`. Prefer it to
the intermediate wrapper link stored in the board's topics array. Read the
existing topic before changing it, especially its full body, comments, and
links.

## Creating and updating

Create a topic through the board rather than deploying the Topic pattern
directly:

```bash
# First setMyName on the board as shown above.
deno task cf piece call --url "$TOPICS_BOARD_URL" addTopic '{"title":"<title>"}'
deno task cf piece step --url "$TOPICS_BOARD_URL"
deno task cf piece get --url "$TOPICS_BOARD_URL" crossrefs
```

Find the new topic's canonical fid in `crossrefs` before applying further
changes. All handler arguments are JSON; encode multiline Markdown rather than
passing an unescaped string.

```bash
# Set your name on the board immediately before each command below.
deno task cf piece call --url "$TOPIC_URL" setBody '{"body":"<complete revised body>"}'
deno task cf piece call --url "$TOPIC_URL" addComment '{"body":"<point-in-time update>"}'
deno task cf piece call --url "$TOPIC_URL" addLink '{"kind":"pr","url":"<PR URL>","label":"<PR label>"}'
deno task cf piece step --url "$TOPIC_URL"
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

Topics handler writes commit durably before `piece step`: verify source fields
such as bodies, comments, and links with `piece get ... --input`. Computed
result fields remain stale until the piece is stepped or a renderer materializes
them. After changing a topic, step that topic before relying on `commentCount`,
`lastActivityAt`, or its derived connections. After creating a topic, step the
board before relying on `topicCount` or `crossrefs`.

There is no Topics-specific prohibition on stepping a fresh CLI replica. The
current CLI converges the board's linked topic inputs before recomputing its
results, so use the normal step workflow from `skills/cf/SKILL.md` whenever
fresh computed values are needed. The linked-input convergence regression lives
in `packages/runner/test/fresh-replica-read-asymmetry.test.ts`.
