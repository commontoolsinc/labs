# Topics

A multi-user tracker over **#topic** pieces — durable units of shared attention.
A topic is a title, a **living body document** (durable conclusions get folded
up into the body; the thread holds the deliberation), a flat chronological
comment thread, and typed links out to other core objects (PRs, agent sessions,
other topics — URLs in v0).

The board also surfaces the corpus's **prose reference graph**: any topic fid
pasted in a body, comment, or link URL (bare, `of:`-prefixed, page URL, or
percent-encoded share link) becomes a navigable "references →" / "← referenced
by" chip on the topic's card, and the graph is exported as the `crossrefs`
output for headless consumers. Each topic also derives its own row of the graph
on its detail page (a **Connections** card) from the `mentionable` input — a
reference to the board's own topics list, wired at creation like `myName` and
backfillable as a one-time link-bind on pre-existing pieces.

Deliberately absent until reached for: statuses (not even open/closed), labels,
assignees, attachments, nesting. What a topic grows next is part of the
experiment.

This is the first wedge of Common Fabric's internal dogfooding program — the
team's own issue-tracker replacement, built on the platform it tracks. The
project's live design record is the "Build Topics v0" topic itself (bootstrap
lineage: Linear CT-1878, which this pattern exists to absorb).

## Design commitments

- **Wish-free handlers.** Nothing gates event dispatch on a `wish()` binding
  (unresolved wish bindings drop events silently — CT-1879). Authorship is a
  fallback chain: `myName` snapshot at write → identity → profile enrichment
  later, when the cross-host profile story lands.
- **Mergeable writes everywhere users collide**: comments, links, and topics are
  `push` appends; concurrent writers all land. The body is a large string
  (whole-value conflict semantics), so body edits go through an explicit
  Edit→Save toggle rather than a live-bound textarea.
- **`myName` is `PerUser` on the shared piece** — one tracker, one name per
  authenticated identity, shared with every topic the tracker creates.
- **`mentionable` is a structural reference, not derived data.** The board
  passes its own topics list at creation; the topic derives its Connections
  read-side from it (SELF + equals to find its own row). Requires the
  path-scoped wildcard fix (#4714) — the derive combines a resolveAsCell chain
  with an equals-only SELF capture in one computed.
- **Authoring: cf-code-editor in the Edit→Save draft flow.** The editor binds
  the session-local `bodyDraft` (never live to the shared string — whole-value
  conflict semantics hold) with `@`-mention autocomplete over `mentionable`;
  inserted `[Name](/of:fid1:…)` links are matched by the same fid scan as pasted
  URLs. The read view renders the body as markdown.
- **Cross-references are derived at read time, never persisted.** The board
  rescans the whole corpus per render (trivial at board scale) instead of
  materializing backlinks into topics: an index pattern that writes derived
  edges back can destroy real data when run from a partial-view replica, and a
  retracted mention should simply stop being an edge. Any future persisted index
  needs single-writer + full-view preconditions first.
- Verified by `multi-user.test.tsx` (two isolated runtimes, one shared board).

## Headless / agent use

Agents are first-class participants. For now, an agent uses the exact same
Estuary identity key as its human user rather than minting an agent-specific
key. Because that transport identity is shared, set `myName` immediately before
each mutation and sign the mutation's text with `— <agent name> (agent)`. Use a
final signature line for bodies and comments, and an inline suffix for titles
and link labels.

Against a deployed board piece:

```bash
cf piece call --piece <board> setMyName '{"name":"Fable"}'
cf piece call --piece <board> addTopic '{"title":"... — Fable (agent)"}'
cf piece get  --piece <board> crossrefs --step     # recompute + canonical fids
cf piece call --piece <board> setMyName '{"name":"Fable"}'
cf piece call --piece <topic> addComment '{"body":"...\n\n— Fable (agent)"}'
cf piece get  --piece <topic> commentCount --step  # recompute + verify
```

Handler source writes commit before result recomputation, so `--input` reads can
verify bodies, comments, links, and the board's topics list immediately. For
computed result fields such as `topicCount`, `crossrefs`, `commentCount`, or
`lastActivityAt`, use `piece get --step`: start, recomputation, and the read
must share one CLI runtime when derived cells are session-scoped. Prefer the
canonical topic fids exported by `crossrefs` over intermediate wrapper links in
the board's input array. Never interpret an empty `crossrefs` as an empty board
without comparing `topics --input`; a failed result projection is not absence.
