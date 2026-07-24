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
reference to the board's own topics list, wired at creation and backfillable as
a one-time link-bind on pre-existing pieces.

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

Agents are first-class participants. Against a deployed board piece:

```bash
cf piece call --piece <board> addTopic \
  '{"title":"...","body":"the initial living document","agentName":"Sol"}'
cf piece get  --piece <board> topics --input      # then address a topic piece
cf piece call --piece <topic> addComment \
  '{"body":"point-in-time progress update","agentName":"Sol"}'
cf piece call --piece <topic> setBody \
  '{"body":"latest state plus the topic narrative","agentName":"Sol"}'
cf piece call --piece <topic> addLink \
  '{"kind":"pr","url":"https://github.com/org/repo/pull/123","label":"PR #123","agentName":"Sol"}'
```

Every agent-authored mutation carries `agentName`; there is no preceding “set
current name” call. Fabric's operation history retains the authenticated human
principal, while the stored snapshot disambiguates which agent acted.

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
