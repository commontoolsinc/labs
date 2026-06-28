# Multiplayer State Inspector Proposal

> Status: Proposal draft for review (revised 2026-06-26).
>
> This document is provisional. It describes a direction and a staged plan for
> review by runtime, storage, shell, and toolshed owners. It is not a final
> architecture decision.
>
> **Revision note (2026-06-26):** Re-centered from a "capture a trace bundle"
> design to a "build the lens over the durable store that already exists"
> design, after auditing the actual surfaces in `runner`, `memory/v2`, `shell`,
> the multi-runtime harness, and `toolshed`. Two decisions drove the rewrite:
> the primary goal is **forensic autopsy first** (understand multiplayer bugs
> after they happen), and the first-class consumer is **agents, with a thin UI
> layered on top**. The original "trace bundle + client capture + correlation"
> plan is preserved in spirit but demoted to a later overlay, because the
> expensive net-new plumbing it required is not where the leverage is.

## Review Metadata

| Field | Value |
| --- | --- |
| Proposal date | 2026-06-26 |
| Primary goal | Make multiplayer, multi-identity, multi-space behavior inspectable from the durable store, retroactively |
| First-class consumer | Agents (queryable index + query vocabulary); thin UI as a consumer of the same index |
| Proposed first milestone | Value/link/schema decoder + offline indexer over existing memory v2 SQLite |
| Review owners | TODO |
| Runtime reviewers | TODO |
| Storage reviewers | TODO |
| Shell/debugger reviewers | TODO |
| Toolshed/server reviewers | TODO |
| Test harness reviewers | TODO |

## Summary

The system increasingly depends on behavior that no single client or log stream
can explain: multiple browser tabs, devices, and identities hold persistent
subscriptions; optimistic commits, conflict recovery, pending local writes,
session resume, and server sync interact over time; scheduler actions read and
write across cells, paths, scopes, spaces, branches, and pattern instances.

The central insight from auditing the codebase is this:

> **The server's memory v2 SQLite store is already a durable, totally-ordered
> flight recorder.** It records who committed (`session_id`), in what canonical
> order (`seq`), what each commit read, what conflicted, what sync was emitted,
> and — behind the `persistentSchedulerState` flag — the scheduler read/write
> dependency graph. This history is *retroactive* (the bug already happened, no
> capture needed), *production-shaped* (the real local DBs under `engine-v3/`),
> and requires *no client cooperation* to inspect.

The gap is not that we fail to record this. The gap is that we have no **lens**:
no decoder for Fabric values/links/schemas, no index that joins commits to the
scheduler graph and to per-client subscription state, and no query vocabulary
that answers concrete multiplayer questions.

This proposal therefore leads with the lens:

1. a reusable **value/link/schema/ifc decoder**,
2. an **offline indexer** over the existing memory v2 SQLite that reconstructs
   timelines, state-at-`(branch, seq)`, and the scheduler dependency graph,
3. a **per-path convergence diagnosis** primitive — the multiplayer-native unit
   of inspection,
4. an **agent-first query vocabulary** (stable CLI/SQL surface), and
5. a **thin UI** that is a consumer of the same index, not the owner of the data
   model.

Client-side telemetry capture, a portable trace bundle, and harness fault
injection are real and valuable, but they are *overlays* layered on this
foundation later, not prerequisites.

## What Changed From The First Draft (and why)

The first draft proposed capturing a normalized `events.ndjson` from every
client plus SQLite snapshots into a shareable bundle, then indexing that bundle.
The audit showed two problems with leading there:

1. **The correlation spine the bundle plan assumed mostly does not exist yet.**
   Of the ~19 identifiers the draft wanted to join on, the only spine that
   exists is server-side: `(space, sessionId, localSeq) → canonical seq`. On the
   runtime/client side, `clientId`, `traceId`/`runId`, `batchId`, and `mountId`
   do not exist; `connectionId` exists only as a server-internal
   `crypto.randomUUID()` that is never sent to the client
   (`packages/memory/v2/server.ts:846`); `eventId` is minted but never emitted
   in telemetry; and runtime telemetry carries no `sessionId`/`connectionId` at
   all. So "correlation" was net-new plumbing, not joining — the expensive part,
   front-loaded.

2. **The durable store already answers most autopsy questions with no capture
   step.** Leading with "start a capture, run the scenario, stop, bundle" misses
   that the most common real bug is "it already happened in the wild." The
   server SQLite recorded it. Inspecting the durable store directly is cheaper,
   retroactive, and needs no hot-path changes.

The reordering: the draft's Milestone 3 (offline indexer over SQLite) becomes
Milestone 1; the draft's Milestones 1–2 (client capture + correlation) become a
later, optional overlay; harness fault injection remains a separate, later track
(it is the *reproduction* product, not the *autopsy* product).

## Goals

- Inspect the durable memory v2 store retroactively, with no capture step and no
  runtime hot-path changes, to reconstruct a coherent multiplayer timeline.
- Decode Fabric values, `@link` references, schemas, cell representation, and
  `ifc`/security labels correctly and reusably.
- Answer concrete multiplayer questions: who wrote a path, what value held at
  `(branch, seq)`, which actions read/wrote it, which sessions had it subscribed,
  why two clients disagree, and why a write was rejected.
- Make the primary unit of inspection a **per-path convergence diagnosis** that
  classifies divergence (cursor behind, pending local write, sync integrated but
  no render, conflict loser), not just a row dump.
- Expose all of this as a stable, documented query vocabulary that an agent can
  run cold, with a thin UI as a second consumer.

## Non-goals

- Do not replace memory v2's commit/revision/head/snapshot/branch model.
- Do not make scheduler observations ordinary user data.
- Do not require client capture, a portable bundle, or a live visualizer for the
  first milestone to be useful.
- Do not add hot-path telemetry overhead to ship the autopsy product.
- Do not rely on wall-clock timestamps for ordering or causality (see Ordering
  Model).
- Do not attempt perfect replay of process-local state never captured (in-flight
  promises, JS object identity, timers, DOM listener internals).
- Do not produce a shareable artifact spanning multiple identities without an
  explicit cross-principal redaction story.

## Core Concepts

### Concept 1: The durable store is the recorder; build the lens

Confirmed by audit (`packages/memory/v2/engine.ts`):

- `commit`: canonical per-space `seq` (PK), keyed `(session_id, local_seq)`
  UNIQUE (`engine.ts:141`). Stores original payload, reads, resolution.
- `revision`: append-only entity mutations by `(branch, id, scope_key, seq,
  op_index)`.
- `head`, `snapshot`, `branch`, `blob_store`.
- Scheduler tables (persisted today, gated by `persistentSchedulerState`):
  `scheduler_observation`, `scheduler_action_snapshot`,
  `scheduler_observation_replay`, `scheduler_read_index`,
  `scheduler_write_index`, `scheduler_action_state`.
- One SQLite file per space under `engine-v3/`, WAL mode.

This is enough to reconstruct, with zero runtime changes: per-space commit
timelines, who committed each (via `session_id`), conflict/retry chains, sync
effects, state-at-`(branch, seq)`, and the action read/write dependency graph.

### Concept 2: The per-path convergence diagnosis is the primitive

The multiplayer mental model: each space is a totally-ordered log keyed by `seq`;
each client is a **cursor** (the `seq` it has integrated) plus a **local pending
overlay** (un-acked optimistic writes). Divergence between clients is always one
of a small, classifiable set:

- **cursor behind** — client has not integrated the sync that carries the newer
  `seq`,
- **pending local write** — client shows an optimistic value not yet committed
  (or rejected),
- **integrated but not rendered** — sync landed, cell did not fire, or VDOM
  batch did not flush,
- **conflict loser** — the client's write was rejected by `findConflictSeq` and
  it has not reconciled.

The killer view, for a given `space/branch/id/scope/path`:

| Source | seq cursor | value | pending ops | last sync integrated | last render |
| --- | --- | --- | --- | --- | --- |
| server canonical | — | value@head | — | — | — |
| session A | … | … | … | … | … |
| session B | … | … | … | … | … |

…with the mismatch flagged and **classified** into the set above. The
server-only columns come from SQLite alone (Milestone 1). The client columns
(render, pending overlay as perceived) come from the optional client overlay
(later milestone); until then they are shown as "unknown from server view,"
which is honest and still useful.

### Concept 3: Order by `seq` + causal edges, never timestamps

Within a space, `seq` is the total order — use it. Cross-layer causality is an
explicit edge chain: `request → accepted commit (seq) → sync (fromSeq..toSeq) →
client integrate → cell fire → render`. Cross-space causality has no global
clock; model it as a `(space, seq)` lattice plus explicit causal edges, not by
comparing wall-clocks across browser/worker/server/Deno-worker processes.
Timestamps are display-only and never load-bearing for correctness. This
deletes the draft's hardest open question ("timestamp alignment") by
construction.

### Concept 4: Agent-first — the index is the product

The deliverable is a stable, documented query vocabulary over a derived
`index.sqlite`, plus a dozen canned diagnostic queries an agent can run cold.
The UI is a second consumer of the same index. This matches how the repo is
actually worked (agent-heavy) and keeps the rot-prone surface (UI) off the
critical path.

## Existing Surfaces (audited)

### Memory v2 SQLite — the foundation

As above. All claimed tables exist; commits keyed `(session_id, local_seq)` →
canonical `seq`; scheduler observations persisted behind `persistentSchedulerState`.
Conflict detection lives in `findConflictSeq` (`engine.ts:3572`); `SessionSync`
(`fromSeq`/`toSeq`/upserts/removes) and session resume are real protocol
concepts. **This is the indexer's primary input and needs no changes.**

### Runtime Telemetry — rich, but process-local and uncorrelated

`packages/runner/src/telemetry.ts` defines ~12 marker families (scheduler run /
invocation / preflight / commit / subscribe / dependencies.update /
graph.snapshot / non-settling, cell.update, storage push/pull/connection/
subscription). Reality check for correlation:

- Carries `actionId`/`handlerId`/`reads[]`/`writes[]`.
- **Does not carry** `sessionId`, `connectionId`, `traceId`, `clientId`,
  `runId`, `batchId`, `mountId`. `eventId` is minted (`event-identity.ts`) but
  **never emitted**.
- Transport is a local `EventTarget`; ephemeral; not persisted across processes.
- The useful events (`scheduler.run`, `event.commit`, `cell.update`,
  `subscribe`) are **unconditionally emitted today** — stamping trace context on
  them has real hot-path cost (see Cost Honesty).

This is the input to the *optional client overlay*, not the autopsy foundation.

### Shell Debugger — useful, but capped and browser-local

`packages/shell/src/lib/debugger-controller.ts` toggles telemetry, stores
markers (capped at 1000), tracks graph edges, watches cells, runs diagnosis, and
exports JSON (raw marker array). No session/identity metadata is correlated.
Confirms UX value; not joined to SQLite.

### Multi-runtime Harness — good base, zero fault injection

`packages/patterns/integration/multi-runtime-harness.ts`: one runtime per Deno
Worker, shared memory server; models identities↔sessions↔spaces
(`user:<did>` / `session:<did>:<id>` partitions, `PerSpace` via subscription
push); emits diagnostics (`getGraphSnapshot`, settle stats, action-run trace).
**No latency, disconnect, reconnect, or contention injection exists.** This is
the base for the *reproduction* track (separate product).

### Toolshed OpenTelemetry — HTTP + LLM only

HTTP spans + LLM (Phoenix) + a single `memory.socket.setup` span. **No
per-message memory tracing**; `requestId` is not propagated into spans; no
websocket→commit correlation exists today. Relevant only to the later overlay.

### Existing diagnostic to fold in, not reinvent

`packages/runner/src/storage/write-stack-trace.ts` already captures
`writerActionId` + stack for writes to matched paths. This is the "which code
wrote this" primitive — the inspector should expose it, not duplicate it.

## Architecture

### 1. Value/Link/Schema/ifc decoder (Milestone 1, deliverable #1)

A single reusable TS library that decodes Fabric values, `@link` references,
schemas, cell representation, and `ifc`/security labels from SQLite rows into a
stable, inspectable form. **Everything downstream depends on this** (state-at-seq,
diffs, the convergence table). It is the reason the whole tool stays in
TypeScript/Deno — the domain codecs already live there. Treat it as the central
asset.

### 2. Offline indexer over existing SQLite (Milestone 1)

Reads one or more space SQLite files directly (read-only, snapshot-safe) and
produces a derived `index.sqlite` (or in-memory model for the first prototype)
with tables/views including:

- `commit`, `revision`, `entity_head`, `entity_value_at_seq` (keyed by
  `(branch, seq)`),
- `scheduler_observation`, `scheduler_read_edge`, `scheduler_write_edge`,
  `action_state`,
- `cell_path`, `conflict_summary`, `hot_path_summary`,
- `subscription_summary` (server-visible portion).

### 3. Query vocabulary (Milestone 1, agent-first)

Canned commands an agent runs cold:

- `cf inspect value-at <space> <branch> <id/scope/path> <seq>`
- `cf inspect path <space> <id/scope/path>` (all writers, conflicts, readers)
- `cf inspect commits <space> [--session <id>]`
- `cf inspect action <space> <actionId>` (reads/writes, dirty/stale state)
- `cf inspect converge <id/scope/path> --spaces <a,b,…>` (the convergence table)
- `cf inspect conflicts <space> [--path …]`
- `cf inspect summary <space>` (hot paths, conflict counts, actors)

### 4. Thin UI (later, a consumer of the index)

Timeline lanes, state browser with value-at-seq + diff, scheduler graph browser,
commit browser, client browser. All read the derived index; none own the data
model.

### 5. Minimal client correlation spine (optional overlay, later)

The entire join key between client telemetry and server SQLite is four small
changes — stated plainly so they don't get lost in a 19-identifier wishlist:

1. expose the server `connectionId` to the client,
2. stamp `(connectionId, sessionId, localSeq)` into runtime telemetry,
3. emit the already-minted `eventId`,
4. attach `requestId` to the memory websocket OTel span.

With these, client-only events (render, optimistic overlay, perceived sync
timing) join to server commits and complete the convergence table's client
columns. Until then, the server columns alone are useful.

## Cost Honesty

The autopsy product (Milestones 1–3) requires **no runtime hot-path changes** —
it reads the durable store offline. The optional client overlay does not: the
useful telemetry events are emitted unconditionally today, and this repo's
performance gate has flagged comparable changes before (cross-space
materialization, seed memoization). The overlay must therefore either gate those
events (a behavior change) or explicitly budget the overhead. This decision
belongs to the overlay milestone, not the autopsy foundation.

## Elevated Dimensions (were under-weighted)

- **Branches are core, not optional.** State-at-seq is meaningless without
  `(branch, seq)`; the schema has fork/merge. Branch awareness is required in
  the indexer and query vocabulary from Milestone 1.
- **`ifc`/security labels are top-tier for a multi-identity tool.** "Why was this
  write rejected / why can't this principal read this" will be a top-3 question
  as identities multiply. Decode and surface labels in Milestone 1, not as an
  optional view.
- **Fold in `write-stack-trace`** as the "which code wrote this" answer.

## Privacy And Redaction

The autopsy tool reads local space DBs for local developer use. The moment any
derived artifact is shared, note that a multi-identity index is **cross-principal
data exposure**, not merely "user data." Before sharing: `--redact-values`, path
allow/denylist, payload truncation, principal anonymization, blob omission by
default, and a manifest flag recording redaction mode. Open question: redact at
indexing time, at export time, or both.

## Proposed Milestones

### Milestone 0: Inventory and decode contract

- [ ] Confirm reviewers/owners.
- [ ] Confirm the value/link/schema/ifc decode contract and stable output shape.
- [ ] Confirm read-only snapshot method for live WAL SQLite (backup API /
      `VACUUM INTO` / checkpoint+copy fallback; record method used).
- [ ] Confirm `(branch, seq)` is the canonical addressing key everywhere.
- [ ] Pick the first dogfood space (candidate: lunch-poll multi-user contention,
      or shared-profile roster across identities).

### Milestone 1: Decoder + offline indexer + query vocabulary (autopsy core)

- [ ] Reusable value/link/schema/ifc decoder library.
- [ ] Read space SQLite read-only; decode commits/revisions/snapshots.
- [ ] Build state-at-`(branch, seq)` lookup for entities and paths.
- [ ] Join scheduler observations + read/write indexes into a queryable graph.
- [ ] Produce derived `index.sqlite`.
- [ ] Ship the query vocabulary (`value-at`, `path`, `commits`, `action`,
      `conflicts`, `summary`).
- [ ] Surface `ifc` labels and `write-stack-trace` origins.

### Milestone 2: Per-path convergence diagnosis (server-view)

- [ ] `cf inspect converge` across multiple space DBs.
- [ ] Classify divergence into cursor-behind / conflict-loser from server data;
      mark client-only causes (pending overlay, render) as "unknown from server
      view" pending the overlay.
- [ ] Conflict/retry chain reconstruction per `local_seq`.

### Milestone 3: Thin UI over the index

- [ ] Load a derived index.
- [ ] State browser (value-at-seq + diff), commit browser, scheduler
      graph/read/write browser, actor timeline lanes.
- [ ] Render the convergence table.

### Milestone 4 (optional overlay): Client correlation spine

- [ ] Expose `connectionId` to the client.
- [ ] Stamp `(connectionId, sessionId, localSeq)` + emit `eventId` in runtime
      telemetry (decide gating vs. overhead budget).
- [ ] Attach `requestId` to memory websocket OTel span.
- [ ] Complete the convergence table's client columns (render, pending overlay).
- [ ] Optional portable bundle format for sharing (with cross-principal
      redaction).

### Separate track (reproduction product): Harness fault injection

> This is the *reproduction* product, independent of autopsy. Pursue it when the
> sharper pain is catching multiplayer races in CI rather than autopsying them.

- [ ] Latency / held-response / disconnect-reconnect wrappers on the harness
      memory transport.
- [ ] Deterministic contention scenarios.
- [ ] Emit the same decoded events the indexer consumes, so a reproduced run
      feeds the same lens.

## Open Questions

- What is the safest portable read-only SQLite snapshot in Deno with
  `@db/sqlite` for live WAL databases?
- How should single-file `DB_PATH` mode (vs. one-file-per-space) be represented?
- Should blobs be copied, omitted, or represented by hash/metadata only?
- For the overlay: gate the always-on telemetry events, or budget the
  stamping overhead?
- Should the derived `index.sqlite` become canonical after indexing, or remain a
  rebuildable cache of the source space DBs?
- Redaction at indexing vs. export vs. both.

## Appendix: Example Questions The Autopsy Core Must Answer

### Why did Bob's vote clobber Alice's vote? (server-view, Milestone 1–2)

1. `cf inspect path <space> poll/.../votes` → all writers + conflicts.
2. Read Bob's commit row: its read set and resolved `seq`.
3. Compare Alice's prior commit `seq` to Bob's read watermark via
   `findConflictSeq` semantics.
4. `cf inspect value-at` before/after each commit.

### Why do two browsers disagree on this value? (convergence, Milestone 2)

1. `cf inspect converge <id/scope/path> --spaces A,B`.
2. Read the classification: cursor-behind / conflict-loser from server data;
   client-only causes flagged pending the overlay.

### Which path causes the most contention? (Milestone 1)

1. `cf inspect summary <space>` → `conflict_summary` / `hot_path_summary`.
2. Drill with `cf inspect path` for writers, readers, and value diff across the
   conflict window.

## Decision Log

| Date | Decision | Owner | Notes |
| --- | --- | --- | --- |
| 2026-06-26 | Lead with autopsy (durable-store lens), not capture bundle | Ben | Forensic pain is sharper; SQLite already records it |
| 2026-06-26 | Agent-first: index + query vocabulary is the product, UI is a consumer | Ben | Matches repo workflow |
| 2026-06-26 | Order by `seq` + causal edges, timestamps display-only | — | Deletes timestamp-alignment open question |
| 2026-06-26 | Reproduction (harness fault injection) is a separate, later track | — | Independent of autopsy |
