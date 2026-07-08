# System-Pattern Auto-Update — Implementation Plan

Implements `docs/specs/pattern-imports/pattern-updates.md`, **scoped to system
patterns** (the space-root pattern: `default-app.tsx` first, then `home.tsx`).
Read that doc first for the *why*; this plan is the *how*, written to be
executed literally. When plan and spec disagree, stop and ask.

## Implementation status (2026-07-08)

M0–M4 are implemented behind the default-off `systemPatternAutoUpdate` flag
(home behind a second `systemPatternAutoUpdateHome` flag). Five corrections
surfaced during a ground-truth pass and while wiring the check — the plan below
is otherwise accurate, but read these first:

1. **`MetaField` is a closed union.** `"patternSource"` had to be added to it
   (`packages/api/index.ts`) before `setMetaRaw("patternSource", …)` would
   typecheck. The plan did not mention this.
2. **Light identity hashes PRISTINE bytes, not `mapped.files`.** The engine
   restores pre-injection authored source (`pristineModuleSources`) before
   hashing, so `computeEntryIdentity` prefixes names but hashes the *original*
   contents. Implementing the plan's steps 3–5 literally (feeding the
   helper-injected `pretransformProgramForModules(...).files`) would have failed
   the linchpin cross-check.
3. **`?identity` must use URL-pathname names.** A module's identity folds in its
   authored path, and the worker names modules by their URL pathname
   (`HttpProgramResolver` → `/api/patterns/…`), so the toolshed computes
   `?identity` over pathname-prefixed names, not patterns-root-relative ones.
   Verified by a parity test compiling the real system patterns the worker's
   way. (M0.2 originally used root-relative names and was wrong.)
4. **The gate runs in the worker, not `lib-shell`.** The update check (and thus
   `buildsMatch`) executes in the per-space worker (`PiecesController`), so the
   gate helpers live in the runner (`harness/version-gate.ts`), and the client
   build sha is threaded to the worker as `Runtime.clientVersion` via
   `InitializationData` (sourced from the shell's `COMMIT_SHA`).
5. **No storage-socket-reset event exists.** The `?identity`/gitSha caches use a
   TTL backstop plus an explicit `clearPatternUpdateCaches()`; hanging
   invalidation off a real reconnect event is a follow-up.

The closure guard is also scoped to the entry's *reachable* set (BFS) rather
than every module, so passing a superset of files is safe.

## How to work this plan

- Milestones in order (M0 → M4). Within a milestone, tasks are dependency-
  ordered; do not reorder.
- Every task is red-green: write the listed test(s) first, watch them fail for
  the right reason, then implement. Run the package's `deno task test` before
  moving on.
- Commit per task (small, coherent). Pre-commit hooks misbehave in worktrees
  for new files — verify locally, then `git commit --no-verify`.
- To see a real emitted identity: `deno task cf check <file>.tsx
  --show-transformed --no-run` and the runner's identity tests.
- **Do not modify a file not named in a task without flagging it** in the
  commit message.

## Decisions already made — do not relitigate

1. **Apply is a meta write, not new machinery.** An update writes a new
   `{ identity, symbol }` to the root piece's `patternIdentity` meta; the
   existing watcher (`runner.ts:1246`) cancels the old nodes and re-instantiates
   the new pattern onto the **same result cell**. Never call `run()` a second
   time on a running piece; never use `recreateDefaultPattern` (it mints a new
   piece and loses state).
2. **`patternSource` is a plain string meta on the piece.** For system patterns
   it is a toolshed source path (`/api/patterns/system/default-app.tsx`); the
   `cf:`-ref form is a later phase. Name it `patternSource` — **not** `source`
   (that key is the doc-level producer annotation used elsewhere).
3. **Toolshed computes `?identity` the light way** — pure
   `pretransformProgramForModules` + `computeModuleIdentities` over the pattern
   file set; **no** TS compiler, `resolve`, runtime, or storage. This is exact
   at the same build because the only injected import is the bare specifier
   `commonfabric` (`cf-helpers.ts:8`), which folds into identity as a string,
   and because `resolve` only ever adds `.d.ts` (filtered out) and prunes
   unreachable files (which don't affect a given entry's identity).
4. **Version-skew gate, not a stored sidecar.** Compare the client build to the
   space's toolshed build (`/api/meta` `gitSha`). Match → the light `?identity`
   equals what the worker would compute → direct compare against the running
   `patternIdentity` is valid. Mismatch → **do not update**; emit a
   `versionSkew` IPC to the shell. The gate is *why* the light `?identity` is
   sound (we never compare across builds).
5. **Scope: the space-root pattern only.** M0–M3 build the machinery and enable
   it for the **non-home default-app root** (least durable state). `home.tsx`
   (carries favorites/journal/spaces) is M4, gated on a stable-addressing audit
   — do not enable it earlier.
6. **Behind a default-off flag** until CI golden-replay coverage exists.

## Architecture recap (the loop)

```
space open (worker) ──► ensureDefaultPattern (unchanged: lazy create)     [existing]
        │
        └─► checkAndUpdateDefaultPattern(space)                            [M3]
              1. url  = patternSource(rootPiece) ?? deriveBySpaceType()    [M2]
                 host = mappedHostFor(space) ?? apiUrl                      (runtime.ts:1423)
              2. version gate: clientBuild == metaGitSha(host)?  ──no──► IPC versionSkew, STOP   [M1]
              3. currentId = cached GET {host}{url}?identity                [M0 endpoint]
                 (cache key (host,url); cleared on socket reset)
              4. currentId == getPatternIdentityRef(rootPiece).identity ? ──yes──► STOP
              5. compilePattern(fetch(url), {space}) ──► newPattern
                 rootPiece.setMetaRaw("patternIdentity", entryRef(newPattern))  ──► watcher re-instantiates in place  (runner.ts:1246)
```

## Glossary

- **root piece** — the piece a space's `defaultPattern` link points at
  (`spaceCell.defaultPattern`, `piece/src/manager.ts`); its result cell carries
  `patternIdentity`.
- **light identity** — the entry-module identity computed by
  `pretransformProgramForModules` + `computeModuleIdentities`, no compile.
- **version gate** — client-build vs space-toolshed-build `gitSha` equality.
- **`?identity`** — the query form of the toolshed pattern route returning a
  pattern file's light identity instead of its source.

---

## M0 — Toolshed `?identity` endpoint

### M0.1 Light identity helper (shared, drift-free)

Goal: one function both a test and toolshed call, producing the **same** entry
identity the runtime stores — without compiling.

New file `packages/runner/src/harness/entry-identity.ts`:

```ts
// Shown for illustration only.
import type { Source } from "@commonfabric/js-compiler";
import { pretransformProgramForModules } from "./pretransform.ts";
import { computeModuleIdentities } from "../sandbox/module-record-compiler.ts";

/**
 * The entry-module content identity of `main` within `files`, computed WITHOUT
 * compiling — the same value `compileToRecordGraph` stores as
 * `patternIdentity.identity` for a same-build compile of the same source.
 *
 * `files` must include the entry's full internal import closure (a superset is
 * fine; unreachable files do not affect the entry's identity). Extra `.d.ts`
 * files are ignored. Throws if, after resolution, the entry (or any reachable
 * module) still has an internal-looking dep (`./`, `../`, `/`) that did not
 * resolve to an included file — that means the closure is incomplete and the
 * identity would be silently wrong.
 */
export function computeEntryIdentity(
  main: string,
  files: readonly Source[],
): string;
```

Implementation:
1. `const program = { main, files: [...files] };`
2. `const id = "cf-entry-id";` — a constant. The prefix is stripped by
   `computeModuleIdentities`, so its value does not affect the result (verify
   with a test that two different constants give the same identity).
3. `const mapped = pretransformProgramForModules(program, id);`
4. `const moduleFiles = mapped.files.filter((f) => !f.name.endsWith(".d.ts"));`
5. `const identities = computeModuleIdentities(moduleFiles, { idPrefix: \`/${id}\` });`
6. **Closure guard**: recompute import edges with `resolveModuleImports({ main:
   "", files: moduleFiles })` (`harness/module-identity.ts`); for every module,
   if any `externalDeps` entry starts with `./`, `../`, or `/`, throw
   `"incomplete closure: '<specifier>' in '<file>' did not resolve to an
   included file"`. (Runtime-module bare specifiers like `commonfabric` are
   expected externals and pass.)
7. `const entry = identities.get(mapped.main); if (!entry) throw …; return entry;`

Export it from `packages/runner/src/index.ts` (toolshed imports from the
package root).

Tests `packages/runner/test/entry-identity.test.ts`:
- **Drift cross-check (the linchpin):** for a small two-file program (entry
  imports a sibling that imports `commonfabric`), compute the identity via
  `computeEntryIdentity`, and ALSO via the real engine path
  (`engine.compileToRecordGraph` → returned `entryIdentity`). Assert equal.
  This is the test that proves toolshed will not drift from the runtime. Mirror
  an existing engine test's runtime bootstrap (grep `compileToRecordGraph` in
  `packages/runner/test`).
- Prefix-independence: two calls with the id constant swapped internally (add a
  temporary param or a second exported helper in the test) give the same hash —
  or simpler, assert the identity equals the engine's, which uses a *different*
  (content-hash) id.
- Closure guard fires: drop the sibling from `files` → the entry's `./sibling`
  becomes external → throws the incomplete-closure error.
- Sensitivity: change a byte in the entry → identity changes; change a byte in
  the sibling → identity changes (transitive).

### M0.2 Toolshed boot-time identity map + `?identity` serving

File map (from the existing route):
`packages/toolshed/routes/patterns/patterns.routes.ts` (route,
`/api/patterns/:filename{.+}`), `patterns.handlers.ts` (`getPattern`),
`patterns-server.ts` (`Deno.readFile` of the raw file).

1. In `patterns-server.ts`, add a **memoized** identity resolver:
   ```ts
   // Shown for illustration only.
   // Patterns are baked into the binary / fixed on disk for the process's
   // lifetime, so the identity map is computed once and cached forever.
   let identityMap: Map<string, string> | undefined;
   export async function patternIdentity(filename: string): Promise<string | undefined>;
   ```
   On first call: read the pattern file set the entry could reach. **Simplest
   robust approach**: read every `*.ts`/`*.tsx` under the patterns root into
   `Source[]` (name = path relative to root, leading `/`), then for the
   requested `filename` call `computeEntryIdentity("/" + filename, allFiles)`.
   Cache per filename. (A superset file set is safe per M0.1; the closure guard
   catches a genuinely missing file.) Reuse the existing patterns-dir resolution
   in `patterns-server.ts` (the same dir `getPattern` reads from).
2. In the handler (`patterns.handlers.ts`), branch at the top of `getPattern`:
   if the request URL has the `identity` query param present, return
   `patternIdentity(filename)` as `text/plain` (200), or 404 if undefined
   (unknown file) / 400 with the closure-guard message if it throws. Otherwise
   fall through to the existing raw-file serving unchanged.
3. Add `identity` as an optional query param to the OpenAPI route schema in
   `patterns.routes.ts` (so the 200 response can be `text/plain`); keep the
   existing `text/typescript-jsx` response for the no-`identity` path.

Tests `packages/toolshed/test` (mirror an existing patterns-route test if one
exists; else an app-level request test):
- `GET /api/patterns/system/default-app.tsx?identity` → 200, body is a 43-char
  base64url hash (`/^[A-Za-z0-9_-]{43}$/`).
- The returned hash **equals** `computeEntryIdentity` over the same on-disk file
  set (import the helper in the test and compare — a second drift guard at the
  HTTP boundary).
- `GET …/default-app.tsx` (no `?identity`) still returns the TSX source,
  `text/typescript-jsx` — unchanged.
- `GET /api/patterns/system/does-not-exist.tsx?identity` → 404.

**Acceptance M0**: runner + toolshed suites green; the drift cross-check
(M0.1) and the HTTP-boundary drift guard (M0.2) both pass.

---

## M1 — Version-skew gate + shell IPC

### M1.1 Client & toolshed build version

1. **Toolshed side already exists**: `/api/meta` returns `{ did, gitSha }`
   (`packages/toolshed/routes/meta/`). Confirm `gitSha` is populated in built
   binaries (`tasks/build-binaries.ts` / `compiler-fingerprint.deno.ts`); if it
   can be `null` in dev, treat `null` as "unknown" (see gate policy).
2. **Client build version**: establish a build-time constant the worker can
   read. Grep first (`grep -rn "gitSha\|BUILD_VERSION\|buildVersion" packages/{shell,lib-shell,runtime-client}`); if one exists, use it. If not, add a
   generated constant module built from the same git SHA the binary uses
   (reuse `compiler-fingerprint.deno.ts`'s source), imported by the worker.
   Flag this as the one "establish, don't assume" step — if no clean SHA is
   available client-side, STOP and ask before inventing one.

### M1.2 The gate

New `packages/lib-shell/src/version-gate.ts` (or nearest worker-side util):

```ts
// Shown for illustration only.
/** undefined = unknown (missing gitSha either side) → treated as "skew". */
export async function toolshedGitSha(runtime, host): Promise<string | undefined>;
export function clientGitSha(): string | undefined;
/** True only when both are known AND equal. Unknown → false (fail-safe: do not update). */
export async function buildsMatch(runtime, host): Promise<boolean>;
```

- `toolshedGitSha`: `GET {host}/api/meta`, read `gitSha`; **cache per host**,
  cleared on socket reset (same lifecycle hook as the `?identity` cache, M3.2).
- Policy: unknown on either side → `false` (do not auto-update; safer to skip
  than to compare a light identity across an unknown build).

Tests: match → true; differing shas → false; either unknown → false.

### M1.3 `versionSkew` IPC + shell surface

- Add a worker→shell push message `versionSkew: { space, clientVersion,
  toolshedVersion }`. Find the existing worker→shell push channel
  (`runtime-client/backends/runtime-processor.ts` sends responses; grep for how
  diagnostics/errors are pushed to the shell — reuse that mechanism, do not
  invent a new transport).
- Shell: on `versionSkew`, show a non-blocking banner ("A newer version is
  available — reload to update"). A reload/worker-restart control is optional
  in v1 (open question in the spec); a banner is the minimum.

Tests: a unit test that the gate-mismatch path (M3) enqueues exactly one
`versionSkew` message with the right fields; a shell view test that the banner
renders on receipt (mirror an existing DebuggerView/AppView message test).

**Acceptance M1**: gate returns correct booleans; skew emits the IPC; banner
renders. No behavior change yet (nothing calls the gate until M3).

---

## M2 — `patternSource` on the piece

### M2.1 Meta accessors

- Writer/reader next to `getPatternIdentityRef` (`runner.ts:4441`):
  `setPatternSource(resultCell, tx, url: string)` →
  `setMetaRaw("patternSource", url)`; `getPatternSource(resultCell): string |
  undefined` → `getMetaRaw("patternSource")`. Export `getPatternSource` from
  `index.ts` (piece/shell read it).
- **Do not** touch the `patternIdentity` accessors or the `pattern` builtin
  backlink.

Tests: set/get round-trip on a cell; absent → undefined.

### M2.2 Stamp at creation

In `ensureDefaultPattern` (`pieces-controller.ts:342`), at the atomic
create+link step (~`:407-439`, where `runtime.run(tx, pattern, {}, pieceCell)`
runs), also `setPatternSource(pieceCell, tx, patternConfig.urlPath)` — the
exact `urlPath` chosen at `:352-373` (home → `home.tsx`; else the resolved
default/custom URL). One write, same transaction.

Tests (in-process runtime, mirror an existing pieces-controller/piece test):
- A freshly ensured non-home root carries `patternSource ===
  "/api/patterns/system/default-app.tsx"`.
- A home root carries `home.tsx`.
- (custom-app path, if easily seeded) carries the custom URL.

### M2.3 Derive-on-missing (existing spaces)

Spaces created before this ships have no `patternSource`. Add a pure helper
`deriveSystemPatternUrl(space, runtime): string` — home space
(`space === runtime.userIdentityDID`) → `home.tsx`, else the default
`default-app.tsx`. The update check (M3) uses `getPatternSource(root) ??
deriveSystemPatternUrl(...)`.

**Known v1 limitation (document in code + the spec's risk list):** an existing
*custom-app* space with no stored `patternSource` derives to `default-app.tsx`
— so its first auto-update could switch it to the default app. Mitigation:
Phase M4 enables auto-update only where `patternSource` is present OR the
running identity matches a known system identity; until then the flag stays off
for such spaces. Do NOT silently roll a custom app to default.

Tests: derive returns `home.tsx` for the home DID, `default-app.tsx` otherwise.

**Acceptance M2**: new roots carry `patternSource`; derive covers the missing
case; no update behavior yet.

---

## M3 — The update check + in-place apply

### M3.1 `checkAndUpdateDefaultPattern`

New method on `PiecesController` (`pieces-controller.ts`):

```ts
// Shown for illustration only.
/** Returns "updated" | "current" | "skipped-skew" | "skipped-disabled". */
async checkAndUpdateDefaultPattern(space): Promise<UpdateOutcome>;
```

Steps (exactly):
1. **Flag gate** (M4): if the feature flag is off → `"skipped-disabled"`.
2. Read the root piece via the existing `defaultPattern` link
   (`getDefaultPattern`); if none → `"current"` (nothing to update; `ensure`
   creates lazily elsewhere).
3. `url = getPatternSource(root) ?? deriveSystemPatternUrl(space, runtime)`.
   `host = runtime.mappedHostFor(space) ?? runtime.apiUrl` (`runtime.ts:1423`).
   *(This per-space host is a change from `ensureDefaultPattern`'s global
   `runtime.apiUrl` at `pieces-controller.ts:274/375`; use the space host
   here.)*
4. **Version gate** (M1.2): `if (!(await buildsMatch(runtime, host)))` → emit
   `versionSkew` IPC, return `"skipped-skew"`.
5. `currentId = await cachedPatternIdentity(host, url)` (M3.2).
6. `running = getPatternIdentityRef(root)?.identity`. If `currentId ===
   running` → `"current"`.
7. **Apply**: build the program from the fetched source
   (`HttpProgramResolver(new URL(url, host))` → `harness.resolve` →
   `compilePattern(program, { space })`, exactly as `ensureDefaultPattern` does
   at `:274-289`). Get the compiled pattern's entry ref
   (`getArtifactEntryRef(newPattern)`); if undefined, `{ identity: currentId,
   symbol: "default" }` as a fallback. In one `editWithRetry`,
   `root.withTx(tx).setMetaRaw("patternIdentity", entryRef)` and
   `setPatternSource(root, tx, url)` (back-fill). Return `"updated"`.
   - The watcher (`runner.ts:1246`) observes the `patternIdentity` change and
     re-instantiates onto the same result cell. `compilePattern` has already
     registered the pattern in the in-memory artifact index, so the watcher's
     `artifactFromIdentitySync` fast path resolves synchronously and no storage
     round-trip is needed for the swap. Do NOT call `run()` or `stop()`.

### M3.2 `?identity` cache with socket-reset invalidation

- A small per-`PiecesController` (or per-runtime) `Map<"{host}\0{url}", string>`
  plus an in-flight-promise map (single-flight). `cachedPatternIdentity(host,
  url)` returns the cached value or does `GET {host}{url}?identity`.
- **Invalidate on socket reset**: find where a space's storage session
  reconnects (`storage/v2-remote-session.ts` `WebSocketTransport`
  open/close; or a runtime-level "session reset" event) and clear the cache
  (both this map and the `toolshedGitSha` cache from M1.2). If no clean hook
  exists, add a `runtime.onStorageSocketReset(cb)` seam and wire both caches —
  flag this if it turns out non-trivial.

### M3.3 Wire into space open

In the worker, after `ensureDefaultPattern` resolves in
`handleGetSpaceRootPattern` (`runtime-processor.ts:1074-1082`) and in
`handleEnsureHomePatternRunning` (`:994-1030`), call
`checkAndUpdateDefaultPattern(space)` **after** the ensure returns, and do not
block the root-pattern response on it (fire-and-forget with logging, or await
but tolerate failure — the update is best-effort; a failed check must never
break space open). Log the outcome.

Tests `packages/runner/test` or `packages/piece/test` (in-process runtime + a
stub toolshed source, mirror how existing pieces-controller tests provide
pattern source; you may need a fake `?identity`/source responder):
- **No-change**: identity unchanged → `"current"`, no `patternIdentity` write
  (assert the meta is untouched and the result cell entity is identical).
- **Change → in-place swap**: point the source at a new pattern version →
  `"updated"`; the root piece's **entity id is unchanged**, its
  `patternIdentity.identity` is the new one, and a value the new pattern
  computes is present (proves the watcher re-instantiated on the same cell).
- **State preserved**: seed a durable cell the root reads by stable key; after
  update, it is still readable (guards the in-place property — use
  `default-app.tsx`-shaped state).
- **Skew**: force `buildsMatch` false → `"skipped-skew"`, no write, one
  `versionSkew` IPC.
- **Cache**: two checks in a row do one `?identity` fetch; after a simulated
  socket reset, the next check re-fetches.
- **Failure isolation**: a throwing `?identity` fetch → the check logs and
  returns without throwing; space open still succeeds.

**Acceptance M3**: all above green; full runner + piece suites green.

---

## M4 — Rollout: enable for default-app, gate home

### M4.1 Feature flag

- Add `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE` (env, default off), read where
  other experimental flags are read (grep `EXPERIMENTAL_` in
  `packages/runner`/`runtime-client`). `checkAndUpdateDefaultPattern` step 1
  honors it.

### M4.2 Enable non-home default-app; hold home

- With the flag on, `checkAndUpdateDefaultPattern` runs for **non-home** spaces.
- For the **home** space, keep it gated behind a second condition (a distinct
  flag or an explicit allowlist) until the `home.tsx` stable-addressing audit
  (spec § open question 4) is done — do not auto-update home in this phase.
- Test: with the flag on, a non-home root updates; the home root does **not**
  (assert `"skipped-disabled"` or a home-specific guard).

### M4.3 Safety net

- Document (in the spec's phasing) that a **CI golden replay** against the
  system patterns must exist before flipping the flag on by default: instantiate
  a space from version N of `default-app.tsx`, seed representative state, roll to
  version N+1 in place, assert no crash and state survives. Wire it if the
  harness makes it cheap; otherwise leave a `// TODO(golden)` and a spec note.

**Acceptance M4**: flag off → zero behavior change (assert the existing
space-open tests are untouched); flag on → default-app rolls forward in place,
home does not.

---

## Invariants checklist (the reviewer will check every one)

1. **Flag off ⇒ byte-for-byte no change** to space open, creation, and the
   root-pattern response. Existing tests pass unedited.
2. **The apply never creates a new piece.** The root piece's entity id is
   invariant across an update; only `patternIdentity` (and `patternSource`)
   change. `recreateDefaultPattern` is never called by this code.
3. **No update across a build boundary.** If `buildsMatch` is false or unknown,
   the code does not write `patternIdentity`; it emits `versionSkew`.
4. **Toolshed `?identity` == the runtime's stored identity** for the same
   source at the same build (proven by the M0 cross-check and the HTTP-boundary
   guard). Toolshed computes it without a compiler/runtime.
5. **A failed check never breaks space open.** Every fetch/compile/read in the
   check is best-effort; failures log and return.
6. **Home is not auto-updated** until M4.2's explicit gate is lifted.
7. **`patternSource`, not `source`.** The doc-level `source`/`pattern`
   annotations are untouched.
8. **Per-space host.** The check (and any URL it builds) resolves the host via
   `mappedHostFor(space)`, never the global `apiUrl`.

## Risk register (check early, in this order)

| Risk | Check | Fallback |
|---|---|---|
| Light `?identity` drifts from the runtime's identity | M0.1 cross-check test FIRST, before building the endpoint | If it ever differs: the injected helper or pretransform changed shape — escalate; do not "adjust" the light path to match, fix the shared seam |
| Closure incomplete (a system pattern imports outside the patterns dir) | M0.1 closure guard throws; run it over the REAL `home.tsx`/`default-app.tsx` file sets in a test | Widen the file set read at M0.2 to include the referenced dir |
| Watcher not enabled on the root (would make the swap inert) | Verified on: `ensureDefaultPattern` runs `run(tx,pattern,{},pieceCell)` with no `doNotUpdateOnPatternChange` (`pieces-controller.ts:302/434`, default off `runner.ts:1341`). Add an M3 assertion that the swap actually re-instantiates | If a caller sets the flag, remove it for roots |
| `compilePattern`'s identity ≠ toolshed `currentId` at same build | M3 test asserts post-update `patternIdentity.identity === currentId` | Same-build ⇒ equal; if not, the M0 drift is real — escalate |
| Socket-reset hook missing | M3.2: if no clean reset event exists, adding `onStorageSocketReset` touches session lifecycle | A conservative TTL on the cache is an acceptable interim; note it |
| Existing custom-app space mis-derives to default-app | M2.3 limitation; M4 gates on `patternSource` present or known-identity match | Keep flag off for such spaces; require `patternSource` before acting |

## What NOT to do

- Do NOT `recreateDefaultPattern`, `run()`, or `stop()` the root to apply an
  update. The apply is a `patternIdentity` meta write; the watcher does the rest.
- Do NOT compute `?identity` in the runtime worker per space open (that's the
  frequency the whole design avoids). Toolshed computes it once; the worker
  caches it.
- Do NOT compare identities across builds. Gate first.
- Do NOT auto-update the home root in this work.
- Do NOT re-implement the pretransform/identity sequence inside toolshed by
  hand — call the shared `computeEntryIdentity`.
- Do NOT block or fail space open on the update check.
- Do NOT touch `computeModuleHashes` / `module-identity.ts` or the
  `patternIdentity` watcher itself.
