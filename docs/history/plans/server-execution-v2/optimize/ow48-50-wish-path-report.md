---
status: active
created: 2026-08-21
reason: "OW48/OW49/OW50 served-wish-path seat report (optimize-on-main): OW48's premise refuted by reproduction — the local TransformerError was cross-instance contamination (API_URL defaulting to a stale localhost:8000 toolshed serving pre-#6019 sources), not #6098 × the ON serving compile; OW49 envelope evidence; OW50 failure-surfacing build."
---

# OW48–OW50 — the profile-embed served-wish path (seats S-H, S-I, S-J)

Agent: served-wish-path seat, optimize-on-main phase. Worktree
`/Users/berni/labs-worktrees/ow48-wishpath`, branch
`claude/server-exec-v2-ow48-wish-path` off `origin/main` @ `ce92b445f`.
Register rows: verification-coverage.md §3 OW48/OW49/OW50. Evidence
base: stage-c/on-render-stall-rootcause.md §4/§6, first-on-ci-gate.md
row 3, and the raw investigation logs (still on disk in the shared
session scratchpad: `toolshed-on.log`, `profile-embed-local*.log`,
`home-profile-local.log`).

## 1. OW48 (seat S-H) — REFUTED premise: the TransformerError was
## environment contamination, not #6098 × the serving compile

**Claim under test** (register row OW48, rootcause §4b): main's #6098
reserved-result-keys rule makes the SERVER fail to load
`profile-create.tsx` / `profile-picker.tsx` in the ON serving-compile
posture ONLY, while the OFF arm compiles the same byte-identical files
green.

**Finding: the premise is false.** The sources that failed were NOT
byte-identical to the checkout — they were a pre-#6019 vintage fetched
over HTTP from a DIFFERENT, stale toolshed that the local investigation
environment reached by defaulted config. #6098's rule fired correctly
on genuinely defective historical sources. Main's current system
patterns compile green under every runtime posture, including the
serving one.

### 1a. The reproduction chain (each step verifiable)

1. **The rule author's own survey already covered these files.** #6098's
   PR body: compiling all 337 authored patterns finds "no result-side
   root occurrence" and exactly three NESTED ones —
   `system/home.tsx`, `system/profile-create.tsx`,
   `system/profile-picker.tsx` — "precisely the population a careless
   rule would break", deliberately left legal. A rule that failed those
   three files on current bytes would contradict its own landing
   evidence.

2. **Posture matrix — all green on current bytes.** Compiling the
   HttpProgramResolver-shaped program (`/api/patterns/system/…` names,
   current `profile-create.tsx` + `profile-home.tsx` bytes) via
   `runtime.patternManager.compilePattern` under five postures —
   client OFF (with and without cacheCtx), client ON
   (`serverExecution` without `servingPosture`), and SERVING
   (`servingPosture + serverExecution`, with and without cacheCtx) —
   is GREEN in every cell. The compile stack reads neither
   `serverExecution` nor `servingPosture` (grep: no hits in
   ts-transformers, js-compiler, harness/engine): there IS no
   "ON serving-compile posture" at the transformer level.

3. **The logged error names its program id, and the id is
   content-derived.** Every TransformerError in `toolshed-on.log`
   carries the compiled program's id in the diagnostic path:
   `/fid1:XFbZgLVPkBIIrveilidcLZe-ElXtDTP8wNYrV7_S-Rs/api/patterns/system/profile-home.tsx:636:16`
   (profile-create), `fid1:UvY44-80Pvos…` (profile-picker),
   `fid1:l1RzgL4jfQga…` (home.tsx, from the pattern updater).
   `computeId(program)` hashes the program's own file bytes
   (engine.ts). Recompiling the **pre-#6019** sources
   (`git show a2c45a873^:packages/patterns/system/…`) reproduces
   **byte-identical ids AND the byte-identical error**:
   `profile-create @ a2c45a873^` → `fid1:XFbZgLVPkBIIrveilidcLZe-ElXtDTP8wNYrV7_S-Rs`
   + the same `profile-home.tsx:636:16 $UI` diagnostic;
   `profile-picker @ a2c45a873^` → `fid1:UvY44-80Pvos871g5q7PCPOIFYIE6-vzMK_cDfj2wf8`.
   Current sources produce different ids (`fid1:oomofGu2…`,
   `fid1:E3MLQwvHA0…`) and compile green. The failing compiles
   therefore consumed **pre-#6019 bytes** — the vintage in which
   `ProfileHomeOutput` still declared `[UI]: unknown` at its result
   root (the exact defect #6019 hand-repaired and #6098 now rejects).
   The coordinates confirm it independently: pre-#6019 has the
   pattern call at profile-home.tsx:635 / home.tsx:178; the compile
   pipeline's one injected helper-import line shifts both to the
   logged 636/179. (Current bytes would put it at 644.)

4. **Where pre-#6019 bytes came from.** The failing process
   (`toolshed-on.log`) is a dev toolshed on **:8123** that logs
   `Configured to remote storage: http://localhost:8000`. Both
   `MEMORY_URL` and `API_URL` default to `http://localhost:8000`
   (packages/toolshed/env.ts). `startServerExecutionHost` hands
   `apiUrl: new URL(env.API_URL)` to the serving runtimes, and the
   wish sidecar + pattern updater fetch
   `apiUrl + api/patterns/system/<name>` — so the :8123 server's
   serving runtimes fetched their system patterns **from whatever
   listened on :8000**. On this machine that is **Loom's production
   toolshed** (`deno … index.ts --port=8000`, cwd
   `/Users/berni/looms/primary/vendor/labs/packages/toolshed`), whose
   vendor pin predates #6019: it live-serves `profile-home.tsx` with
   sha256 `La0GRMfnib2uuX_R4qz05I0TBlRfR5r-jSisXopPG2w` — exactly the
   pre-#6019 hash — with `[UI]: unknown` at the result root
   (verified by live curl during this seat's work). The :8123 server
   itself served CURRENT bytes to its own clients (its request log
   carries the current profile-home ETag `gFs1wbyN…`; the stale ETag
   appears in no captured request log — the stale fetches went to
   :8000 and are logged only as the resulting TransformerErrors).

5. **Why the OFF arm looked green and CI looked different.** The OFF
   control's client compiled patterns fetched from its own harness's
   correctly-configured server (current bytes) — green for the boring
   reason. CI has no stale :8000; its fresh compiles of current bytes
   pass the transformer, and the profile-embed CI red is the OW49
   assert alone. Rootcause §4b's byte-cache explanation for the
   CI/local difference ("in CI the compile byte-cache skips fresh
   transformation") is unnecessary: the fresh transformation of the
   bytes CI actually fetches passes.

### 1b. Consequences for the register

- **OW48 closes as refuted-premise** (no code change owed on main for
  it): #6098 × the ON serving compile of main's system patterns is not
  a defect. The row should be annotated, not "fixed" — a pattern-side
  `$UI` typing change or a serving-compile relaxation would each be a
  fix for a defect that does not exist.
- **The profile-embed ON skip's blocker reduces to OW49** (+OW50
  detectability). Skip-entry reason text updated in this PR.
- Rootcause §6.5 (does #6098 break any OFF-lane server-adjacent
  compile): answered — the rule rejects PRE-#6019 SOURCES wherever
  they are compiled, in either arm; it breaks nothing compiling
  current sources. The OFF lanes fetch current bytes; green.
- Rootcause §6.3 (wish compile's division of labor under ON): the
  sidecar compile provably RUNS on the serving runtime (the
  TransformerErrors are in the server's stdout, wish.ts:1585), AND on
  the client (the browser shell runs the same wish.ts against the
  same pattern environment). See §3 below for the live-run
  confirmation on a clean environment.

### 1c. Flagged, not filled (for the coordinator)

1. **The serving runtimes' pattern-fetch trust surface.** Under ON,
   `env.API_URL` decides which server the serving runtimes compile
   system patterns from, its default is another process's port, and a
   stale-but-healthy neighbor produces silent wish-path kills that
   look exactly like a main defect (this whole surface). Whether the
   serving loop should refuse a cross-origin/cross-vintage pattern
   source (e.g., pin `apiUrl` to self when co-hosted, or verify the
   served `?identity` against its own patterns route) is a design
   question for the owner — not filled here.
2. **Historical stored sources × new transformer rules.** The
   contamination accidentally demonstrated a real adjacent exposure:
   any recompile-from-source of STORED piece sources predating #6019
   (e.g., the ESM cell-cache repair path after a compile-cache
   `runtimeVersion` bump) now fails the transformer, with the same
   silent wish-UI kill downstream if the piece is wish-loaded. No
   live surface hit it yet (all observed hits were the contamination);
   whether vintage-tolerance belongs in the recompile path or stored
   sources get migrated is not this seat's call.
3. **The local-repro hygiene hazard.** The investigation ran an ON
   toolshed whose runtime ALSO pointed `MEMORY_URL` at :8000 — Loom's
   production memory — by default. Nothing in this seat's evidence
   suggests writes landed there (the serving loop's storage is the
   in-process loopback), but the default-collision hazard for local
   ON repro deserves a note in the testing runbook.

## 2. OW49 (seat S-I) — evidence + recommendation (CFC-owner call)

_(in progress — envelope dump at `prepareBoundaryCommit` next)_

## 3. OW50 (seat S-J) — wish-action commit-prep failures must surface

_(in progress — red-first test next)_

## 4. Skip entry status

_(pending: update `tasks/server-execution-on-skips.ts` profile-embed
reason text to name OW49 as the remaining blocker once §2's evidence
is in)_
