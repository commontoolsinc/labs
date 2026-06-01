# SQLite builtins — implementation log

Running log of the build on branch `feat/sqlite-builtin-impl` (based on
`feat/sqlite-builtin`, the spec branch). Records progress, decisions made to keep
moving autonomously, and places where the spec was incomplete or wrong.

## Execution strategy (decision)

The full spec spans the distributed memory v2 protocol, server, engine
transactions, runner scheduler, and the ts-transformer. End-to-end Phase 1/2
(live websocket server-side query; commit-folded atomic writes) need a running
toolshed to exercise and are high-risk to land "CI-green" purely autonomously.

To maximize *real, tested* progress, I implement the foundation as isolated,
compiling, unit-tested modules first (genuine red-green TDD in `packages/runner`,
which has a real `deno test` runner), then layer the protocol/transport wiring:

1. **Foundation (testable in isolation):**
   - Statement guard (`classify`/`assertReadOnly`/`assertSafe`) — Phase 1 core.
   - `_cf_link` codec (encode cell → absolute sigil link string; decode →
     `Cell`) with throw conditions — Phase 4 core.
   - `table()` / `cfLink()` schema helpers — Phase 0/1.
2. **Phase 0 wiring:** api types + builder factories + factory exports + builtin
   registration. Must `deno check`.
3. **Engine-side query/exec** against a local `@db/sqlite` temp file (ATTACH +
   guard + query/insert) — unit-tested directly, proving the SQL half without
   the websocket.
4. **Protocol/transport wiring** (sqlite.query verb, commit `sqlite` op) — built
   structurally; live integration deferred to an integration phase and flagged.

**Decision (reordering):** foundation units (guard, cf-link codec, schema
helpers) are built before/alongside Phase 0 even though some belong to later
phases in the plan, because they are the most self-contained and TDD-able and
several phases depend on them. Phase *numbering* in commits refers to the spec's
plan; ordering is adjusted for testability. Noted so the plan and the build
sequence can be reconciled.

## Conventions

- Tests: `@std/testing/bdd` + `@std/expect`, files in `packages/runner/test/*.test.ts`.
- Run: `cd packages/runner && deno task test` (or targeted `deno test <file>`).
- New code under `packages/runner/src/builtins/sqlite/`.

## Phase log

(entries appended as work proceeds)
