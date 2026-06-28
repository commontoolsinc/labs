# State Inspector — the Multiplayer Turn (v1 reframe)

> Status: design / latest thinking. Written 2026-06-29. Supersedes the
> comprehension-surface roadmap's "Phase 3" bullets where they conflict.

## Why this doc

Phases 1–2 made the tool *fluent* about ONE space's `space`-scope state (model,
grouping, graph, time-travel, the HTML explorer). Dogfooding against real
multi-user data exposed that this is, in effect, a **single-space DB viewer** —
and the tool's actual charter (`2026-06-26-runtime-trace-inspector.md`, the
"Multiplayer State Inspector") is to make **multi-identity, multi-space,
per-user, async/conflict** behavior inspectable. Owner's steer: build the
scope-as-identity and cross-space dimensions **together** (they're entwined —
each identity has a home space, each profile has a space, and per-user/session
state lives *within* spaces), **CLI-first / agent-first** (`--json`), keeping
the HTML explorer in step. Conflicts/async are a **second pass**. Don't
over-invest in the legacy on-disk format (revisit only if old+new coexist in
practice).

## The grounded scope model (verified on real DBs)

`revision.scope_key` partitions an entity's rows into scopes that **overlap by
id**:

- `space` — shared / default (PerSpace cells).
- `user:did:key:<DID>` — per-user state (PerUser cells).
- `session:did:key:<DID>:<uuid>` — per-session state (PerSession cells).

**Verified (home space z6MkeZZv…):** 633 `space` entities + 16 `user:<DID>`
entities, and **all 16 user ids also exist in `space`** — i.e. the same cell
holds a `space` value AND a per-user override, and **the values differ**
(`space` often a link/default; `user` the concrete state — a `true` toggle, a
per-user `{children,name,props,type}` VDOM = per-user render state). So:

> **Composition is most-specific-scope-wins: session:X:sid ⊕ user:X ⊕ space.**
> "View as identity X" overlays X's scopes on top of the shared space. The
> per-user VDOM divergence is exactly the "looks different for me" multiplayer
> bug class the tool must show.

The whole package currently hardcodes `scope_key = 'space'`, so it is blind to
all per-user/session state. That is the #1 gap.

## Identity = a DID, spanning scopes AND spaces

An identity (a DID) implicates:
- its **home space** (space DID == identity DID),
- its **profile spaces** (home `profiles[]` → cross-space links),
- the **main/pattern spaces** it acts in (`commit.session_id` principal == DID),
- and, *within any of those spaces*, the `user:<DID>` + `session:<DID>:*` scopes.

Grouping (Phase 2) already recovers the space side. The new work adds the scope
side and unifies them: "show me everything for this user."

## Plan (CLI-first; HTML kept in step)

### 1. Scope primitive — `scopes.ts`
- `listScopes(space)` → `Scope { raw, kind: space|user|session, principal?,
  sessionId?, entities, revisions }`.
- `resolveScopeChain(identity, sessionId?)` → the precedence list
  `[session:X:sid, user:X, space]`.
- `valueAsIdentity(space, id, identity, {sessionId, atSeq})` → composed value +
  which scope it resolved from.
- `scopeOverlay(space, id)` → the entity's value in EVERY scope it appears in
  (the per-user/session divergence table for one id).

### 2. CLI (agent-first, `--json`)
- `cf inspect scopes <space>` — enumerate scopes (who + counts).
- `cf inspect overlay <space> <entity>` — value across all scopes for one id.
- `--as <DID>` (and `--session <sid>`) on read commands (`entities`, `piece`,
  `value-at`) → compose the overlay so "what does user X see" works. `--scope`
  stays the raw escape hatch.

### 3. Identity world — `cf inspect identity <DID>`
Unify grouping + scopes: the DID's home/profile/main spaces, and within each the
`user:<DID>`/`session:<DID>:*` scopes it owns, with per-scope entity counts.

### 4. HTML explorer kept in step
- A **"view as"** selector (space / each user / each session) that re-renders
  the detail value from the chosen scope and **flags entities with per-user
  overrides** (id present in >1 scope with differing values).
- **Cross-space links navigable** (open the target space / profile), and the
  home→profiles→main group as a surface to jump between identities.

### 5. (Second pass) Conflicts / async
`cf inspect conflicts` + per-entity who-wrote/who-lost chain from
`commit.original` reads vs `resolution`/`findConflictSeq`, and a
concurrent-writer/contention view over the timeline. The proposal's "killer
view"; deferred per owner steer.

## Out of scope for v1
- Legacy on-disk format beyond current best-effort.
- Client-side correlation overlay (connectionId/eventId) — net-new runtime
  plumbing, explicitly the proposal's later phase.
