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
- **Mergeable writes everywhere users collide**: comments, links, and topics are
  `push` appends; concurrent writers all land. The body is a large string
  (whole-value conflict semantics), so body edits go through an explicit
  Edit→Save toggle rather than a live-bound textarea.
- **Fabric owns history and concurrency.** Topics adds neither an activity-log
  duplicate nor an application-level revision/CAS protocol. If Fabric cannot
  preserve history or safely arbitrate concurrent body writes, this dogfood
  surface should expose the framework gap rather than conceal it mechanically.
- **Storage compatibility is read-only.** `myName`, `createdByName`, and
  `authorName` remain optional in accepted schemas so existing boards/topics
  load and render. New code does not read `myName` or write any legacy field.
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
cf piece call --piece <board> addTopic '{"title":"...","agentName":"Sol"}'
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

Do **not** run `cf piece step` from a fresh CLI replica: a replica with a
partial view persists deriveds computed from that partial view. Writes commit
fine on their own; renderers derive for themselves. Verify writes via a renderer
or post-materialization fid reads.

## Local workload diagnostics

`topics-diagnose.ts` runs the board in worker-isolated local runtimes sharing an
in-process memory server. It creates a fresh space per matrix case, drives real
root and nested Topic streams, and emits one pretty JSON report on stdout;
progress goes to stderr. Local runs require no collector.

```bash
# Small smoke matrix (two users, two topics).
deno run --frozen -A packages/patterns/tools/topics-diagnose.ts --quick

# Focused two-state whole-root conflict/storage profile.
deno run --frozen -A packages/patterns/tools/topics-diagnose.ts --profile=conflicts

# Explicit matrix and a focused scenario subset.
deno run --frozen -A packages/patterns/tools/topics-diagnose.ts \
  --cases=2x2,8x4 --rounds=3 --typing-steps=5 \
  --scenario=names,comments,bodies

# Two sessions per identity with deliberate storage-frame delay.
deno run --frozen -A packages/patterns/tools/topics-diagnose.ts \
  --topics=4 --users=2 --sessions-per-user=2 --ws-delay-ms=10
```

Supported scenarios are `names`, `create-topics`, `noops`, `titles`, `comments`,
`links`, `bodies`, `crossrefs`, and `root-oscillation`. The matrix default keeps
the original scenarios; `--scenario=all` adds root oscillation.
`--profile=conflicts` is intentionally small and deterministic: 2 topics, 2
users, 2 sessions per user, a 10ms WebSocket frame delay, 4 rounds, and only
`root-oscillation`; `--quick` keeps that topology but uses 2 rounds. Every
explicit dimension or `--scenario` overrides profile defaults.
`root-oscillation` has each worker read the stored topics link array locally,
preserve those links, and prepare the reversed whole-root value between two
sessions. Its diagnostic-only harness operation replaces the containing
document's `value` record (preserving siblings), so canonical memory telemetry
records a literal `/value` patch rather than nested `/value/topics/*` diffs. It
requires at least two topics and two total sessions. The `noops` phase repeats
each topic's current title and body so write elision is measured directly.
`names` sends `setMyName` handler traffic: Topics does not expose the writable
UI-bound display-name input as an output. When `create-topics` is not selected,
setup creates the seed topics serially so focused profiles begin from a known
baseline. Each target is prepared from the same confirmed root in two sessions
then committed concurrently; the accepted root write and stale conflict/revert
are both observed before the next target. Phase snapshots use an event-driven
drain of delayed frames, worker synchronization, and server refreshes before
counter reset or collection. `--program`, `--topics`, `--users`, `--rounds`,
`--typing-steps`, `--sessions-per-user`, `--ws-delay-ms`, and
`--cases=TOPICSxUSERS` are also available; invalid explicit values fail instead
of falling back.

Each phase reports logical submitted operations plus direct set/push accepted
and rejected outcomes; queued stream sends are submitted, not accepted. It also
reports scheduler invocations, scheduler commit markers, direct UI-style
commits, retries, read/write/changed-write totals, truncated-write markers,
distinct invoked/successful/dropped event counts, fixed drop and permanent
rejection reason maps, and changed writes grouped by structural marker path. The
worker correlates event IDs only in private sets; JSON reports contain no event
IDs, handler IDs, paths, content, DIDs, or URLs beyond the fixed path shapes
described below. `changedWriteCount` includes locally applied/speculative paths
from failed or retried attempts; `writesByPathShape` contains only fixed
structural shapes (`value`, `*`, `#`, `metadata`, `other`, `$root`), never IDs
or field/content keys. Derived ratios show changed and attempted writes per
submitted operation; `elided` is `writeCount - changedWriteCount` clamped at
zero, so it is a candidate signal, not proof of a product-level no-op. Graph
samples are post-settle cross-session maxima and settle samples are trailing
cumulative history, not per-phase peaks. Workload inputs and control paths may
cross into workers, but Topics diagnostic responses contain only numeric
aggregates, booleans, fixed outcomes, and structural metadata. Equality tokens
and bootstrap piece IDs travel only between workers over a fresh private
BroadcastChannel; workers aggregate their scheduler graph and settle data into
numeric counts and durations before transfer, so no scheduler nodes, edges,
histories, action traces, or pattern values cross IPC for Topics diagnostics.
They and storage-conflict churn are local runtime observations; compare them
across the same machine/configuration, not as stable production benchmarks. Each
local diagnostic phase also includes `memoryTelemetry`, a snapshot reset at the
phase boundary from the canonical memory server: transact/accepted/rejected
counts, conflict and replay counts, total/max received commit bytes, confirmed
read entries/bytes, operation entries/bytes, newly persisted revisions, and
rejections grouped by error name. It also reports fixed-vocabulary patch-op
counts for received requests and newly applied non-replay revisions (including
`append`); these counts contain no patch values, paths, or IDs. Canonical patch
paths use the same privacy rule; a whole document `value` replacement is
reported as `value-root`. `rootOscillation` is content-free metadata: the number
of intended distinct states, target writes, and two-step eligible/repeat
count/ratio. `targetWriteCount` counts one intended accepted state per competing
transaction pair; the phase's `operations.submitted` also includes each stale
contender. `twoStepEligibleCount` is `max(0, target writes - 2)`. It contains no
links, IDs, values, or fingerprints. When no two-step comparison is eligible,
its ratio is `null`; a one-round conflict profile remains valid and still
measures accepted root writes and stale conflicts. Final convergence reports
only a boolean equality result and per-session cardinality arrays; private
comparison data and the user-supplied program path are never serialized. Failed
cases use only fixed diagnostic error codes, never exception messages or input
content: `invalid-configuration`, `harness-initialization-failed`,
`phase-verification-failed`, `phase-operation-failed`,
`root-oscillation-failed`, `convergence-failed`, or `unknown-error`.

Canonical byte definitions and the oscillation sequence shape are stable local
diagnostic signals. Their totals, accepted/rejected outcomes, conflict counts,
scheduler churn, graph/settle samples, and timing remain observational: they can
vary by runtime scheduling and should not be compared as exact production
benchmarks.

### Telemetry privacy

Topics diagnostics use aggregate-only workers. They do not attach the runtime
OTel bridge and suppress worker error output, so identifier-bearing worker spans
and scheduler error payloads cannot escape through the diagnostic process. The
local memory server also uses non-recording spans and suppresses free-form
warnings in this mode. Aggregate workers reject generic read, raw-read, link,
detailed-diagnostics, and logger-map RPCs; only lifecycle controls and the
fixed-shape Topics commands are available. The report retains only numeric
aggregates and fixed categories.
