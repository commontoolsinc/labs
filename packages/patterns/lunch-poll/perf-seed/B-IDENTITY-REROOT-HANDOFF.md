# Handoff — B: content-addressed action identity (re-root off `.src`)

**Branch:** `gideon/lunch-poll-load-investigation` (off `main`).
**Status:** core re-root **implemented + runner suite green (721/0)**; NOT yet
PR'd. Merge-gate = adversarial/red-team review (per
`content-addressed-action-identity.md` §"Red-team pass").

This is the runtime fix that came out of the lunch-poll **initial-load** perf
arc. Full background + the boot-floor root cause + why it's a runner (not
transformer) change: **[`BOOT-FLOOR-FINDINGS.md`](./BOOT-FLOOR-FINDINGS.md)**
(read §5–§6 first).

---

## 1. What B does (one sentence)

Make scheduler action **identity** (action ids + the durable implementation
fingerprint) come from the content-addressed `{ identity, symbol }` (module hash
+ hoisted `__cfReg`/export symbol) instead of `fn.src` (the source location),
so identity no longer depends on `.src` or its broken/colliding source-map
resolution. `.src` becomes debug-only.

Why it matters for perf: the eager `.src` annotation (`getLineAndColumnAtOffset`
etc.) is ~80–100ms of every piece boot; once nothing on the hot path needs
`.src`, it can go lazy (that's step C, separate). B is the architectural
prerequisite (and removes a latent id-collision bug — see §5).

## 2. The diff (6 files, +103/−35, all in `packages/runner`)

| file | change |
|---|---|
| `src/runner.ts` | **`applyImplementationHash`** (~:2528) re-rooted: derives `cf:module/<identity>:<symbol>` from `getVerifiedProvenance(implementation)`, **not** `implementationHashForSource(.src)`. Both call sites (~:3540 pass `module.implementation`; ~:3987 pass `impl`). |
| `src/scheduler/diagnostics.ts` | New `contentAddressedActionIdentity(action)` helper (provenance → `cf:module/<id>:<symbol>`). `getSchedulerActionId` now: `implementationHash` → `contentAddressedActionIdentity` → `.name` → generated. **No `.src`.** |
| `src/scheduler/action-run.ts` | `schedulerImplementationFingerprint`: `impl:${implementationHash}` → else `impl:${contentAddressedActionIdentity}` → telemetry. **`src:` fallback removed.** |
| `test/action-fingerprint.test.ts` | asserts the new invariant ("content-addressed, NOT src"). |
| `test/scheduler-observations.test.ts` | 2 synthetic actions re-keyed off `.src` onto a content-addressed `implementationHash`. |
| `test/reload-sibling-overdirty.test.ts` | filter switched from `actionId.includes("main.tsx")` (path) to `startsWith("cf:module/")` (ids are now path-free). |

**Proof it's actually `.src`-free:** action ids flipped from
`cf:module/<hash>:3:20` (`.src`-derived `:line:col`) to
`cf:module/<hash>:double` (the symbol).

## 3. Verified

- **Full runner suite: 721 passed / 0 failed.** cf check ✓, lunch-poll 42/0,
  fmt clean.
- Key canaries green: `content-addressed-identity` (+adversarial),
  `cfc-implementation-identity`, `cfc-nonexported-binding-identity`,
  `esm-source-location`, **`inspace-child-owner-write` (CT-1754 verified-source
  regression)**, `action-fingerprint`, `scheduler-observations`,
  `reload-sibling-overdirty`, `stack-trace-patterns`, `module-identity-engine`.

## 4. Remaining to PR-ready (in order)

1. **`.src`-garbled invariant harness** (the proof rig — was Gideon's ask, and it
   would have caught the §"lesson" leak instantly). An e2e test that runs a
   pattern with `.src` deliberately garbaged and asserts **every** action id /
   fingerprint / CFC identity is byte-identical (+ no collisions, suites green).
   Build it; it should now pass.
2. **Gate:** `deno task integration pattern-tests` (68) + the generated-patterns
   suite (147) — schema/identity changes need the runtime gate (see
   `feedback_schema_changes_need_runtime`). Plus full `fmt --check` + `lint`.
3. **Cleanup:** `implementationHashForSource` (`engine.ts:1271`,
   `harness/types.ts:217`) is now **dead** (its only caller was re-rooted) —
   remove it. Decide on `identityFromCanonicalSource` (`verified-provenance.ts:96`):
   still used as the `.src` **guard** in `recordModuleProvenance`
   (`engine.ts:1053`) — keep as guard or retire (red-team call).
4. **Open the PR.** Small, contained, behavior-preserving.

## 5. Design decisions flagged for the red-team / Berni

- **Discriminator = `symbol`** (`__cfLift_N`/export name), NOT the spec's stated
  `:line:col` (which is `.src`-derived). Symbol matches CFC's
  `{ moduleIdentity, symbol }` (spec §3) and is `.src`-free. It **changes id
  *values*** (`:line:col` → `:symbol`). Siblings stay distinct (verified by
  `reload-sibling-overdirty`); no collisions observed.
- **`recordModuleProvenance` still *reads* `.src`** as a cross-module mismatch
  **guard** (`engine.ts:1053`, via `identityFromCanonicalSource`) — it never
  *derives* identity from `.src`, so the invariant holds, but a purist "no `.src`
  read at all" would retire it.
- **getActionId / fingerprint were made consistent** (both prefer
  `implementationHash` → provenance). `implementationHash` is now set from
  provenance (step §2), so this is `.src`-free.

### The lesson (worth keeping)
The first cut re-rooted only the *consumers* and looked green — but
`implementationHash` was still `.src`-derived (`applyImplementationHash` →
`implementationHashForSource(.src)`), so identity was secretly still `.src`-bound
(the `:3:20` id). Caught by directly inspecting the emitted id + grepping for the
assignment, NOT by the passing tests. **Build the garble-harness FIRST next
time** — it makes this failure loud.

## 6. Resume mechanics

- **Branch** `gideon/lunch-poll-load-investigation`; runner diff is the 6 files
  above. `main.tsx` shows modified only because it was refreshed to `origin/main`
  for the rapids deploy (the #4404 cast tweak) — not part of B.
- **Art re-add** (the #4325 render-only comeback, unrelated to B) is shelved in
  `stash@{0}`.
- **Offset-20 toolshed rig** (8020 / shell 5193 / inspector 9249, isolated store
  in scratch) may still be up from the perf measurements; it currently serves a
  short-circuited `worker-runtime.js` (rebuild from clean runner if reused).
- **Re-run B's verification:** `cd packages/runner && deno task test` (full),
  or the focused canary set in §3.
- **Inspect an id form:** the scheduler logs `cf:module/<hash>:<symbol>` on
  action runs; `cf:module/...:double` good, `cf:module/...:3:20` = regression.
