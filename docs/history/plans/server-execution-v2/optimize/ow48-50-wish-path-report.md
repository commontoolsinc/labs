---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW48/OW49/OW50 served-wish-path seat report (optimize-on-main): OW48's premise refuted by reproduction — the local TransformerError was cross-instance contamination (API_URL defaulting to a stale localhost:8000 toolshed serving pre-#6019 sources), not #6098 × the ON serving compile; OW49 envelope decoded with the CFC-owner recommendation; OW50 failure-surfacing built red-first."
---

# OW48–OW50 — the profile-embed served-wish path (seats S-H, S-I, S-J)

Agent: served-wish-path seat, optimize-on-main phase. Worktree
`/Users/berni/labs-worktrees/ow48-wishpath`, branch
`claude/server-exec-v2-ow48-wish-path` off `origin/main` @ `ce92b445f`.
PR: [#6157](https://github.com/commontoolsinc/labs/pull/6157)
(coordinator merges).
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

## 2. OW49 (seat S-I) — the envelope, decoded: evidence + recommendation
## (FLAGGED for the CFC owner; no cfc/ change made)

The register asked which anyOf branches diverge at `/result` and why
(served vs local schema vintage? instance-keyed envelope?). Answered —
by store extraction, source reading, and a deterministic unit-level
reproduction — and the answer is NEITHER of the register's guesses.

### 2a. Which branches

The stored schema envelope of the wish-state doc (extracted from a
clean-env failing run's store: derived commit seq 35, op 4 — the
content-addressed schema doc `cid:fid1:-3unxofTXj3…`, 9,849 bytes)
carries at `properties.result`:

```
anyOf: [
  { type: "undefined" },                    ← branch 0: NO ifc
  { type: "object", asCell: ["cell"],       ← branch 1: the profile
    properties: { $NAME, $UI,                 consumer view — ifc
      name/avatar/bio/externalLinks/          (addIntegrity
      elements/verifiedIdentities: {ifc…},     represents-principal,
      …streams… },                             ownerPrincipal,
    required: […] }                            writeAuthorizedBy)
]
```

This is the WISH BUILTIN'S OWN canonical result declaration —
`wishStateSchemaForResult` (runner `builtins/wish.ts`) wraps every
requested schema as `result: anyOf[{type:"undefined"},
<requestedSchema asCell>]` — the "no result yet | the resolved value"
presence union. Whenever the requested schema carries ifc (any
Cfc-wrapped consumer view — the profile family via
`BackwardsCompatibleProfile`), the wish-state envelope carries
ifc-in-anyOf by construction. The full doc has 13 ifc sites: six under
`candidates.items.properties.*` (plain positions — these are what make
the doc cfc-relevant and the label metadata persist), six under
`result.anyOf[1].properties.*` (the copy the assert refuses), one in
`$defs`.

**Not a vintage divergence, not instance-keyed:** both writers produce
the byte-identical interned envelope (ONE `cid:` schema doc); the two
branches are the wish's own presence union, and only ONE of them
carries ifc at all.

### 2b. Why only under ON — the two-writer sequencing

`assertNoDivergentIfcBranches` fires only inside
`mergeCfcSchemaEnvelopes`, whose UNCAUGHT reachable call site in
`prepareBoundaryCommit` is the link-write verification merge
(`mergeCfcSchemaEnvelopes(candidate, storedSchemaClaimsForLinkWrites(…))`
— prepare.ts; the CI stack pins schema-merge.ts:611, i.e. the FIRST
assert: the CANDIDATE side, the raw:wish action's own write schema).
Reaching it requires a STORED envelope AND a link write in the same
prep.

- **OFF (one writer):** the client's first wish commit preps with NO
  stored envelope → the asserting merge is unreachable → the commit
  lands and persists the envelope. The /result link is written once;
  no later prep meets the merge. Green forever.
- **ON (two writers):** the serving loop derives the wish and persists
  the envelope FIRST (clean-env run: derived commit seq 35 at
  17:52:04, service-session id, carrying the /result link write and
  the `cid:` schema doc). The browser's raw:wish action ALSO runs, and
  its prep — one second later (17:52:05.182) — finds the stored
  envelope plus its own /result link write and walks into the assert.
  Killed at commit-prep; the wish UI never mounts, even though the
  SERVED result is durably in the store.

Whoever writes second dies. Under ON there is always a second writer.

### 2c. The poison-pill property (new finding)

Once the envelope is stored, EVERY later writer whose prep merges
against it is refused — including writers whose own candidate is
benign: the runtime's error-report write (a plain `error`/`$UI` value
write) was observed refused with the same assert text via the CAUGHT
try-site merge, because the STORED side fails the merge's entry assert
regardless of the candidate. That is the previously-mysterious
"Can't report … in the surface it belongs to" follow-on: the report
met the same refusal as the failure it was reporting. No retry
converges; nothing heals short of replacing the envelope or changing
the rule.

### 2d. Deterministic reproduction (no cfc/ edits)

`packages/runner/test/cfc-prepare-crash-surfacing.test.ts` reproduces
the class at unit level with a minimal faithful envelope (the same
view under `candidates.items` — persistence/relevance — and under
`result.anyOf[1]` — the refused copy), and the full live mechanism
end-to-end through the REAL wish builtin on the live two-writer
topology (one shared memory server, two runtimes: writer A persists
the envelope, the wish target is repointed, writer B's changed
/result link is refused). 3/3 deterministic.

### 2e. Recommendation (the decision is the CFC owner's)

1. **Preferred: narrow the assert to actual ambiguity, with a merge
   rule for the presence union.** The assert exists because policy
   under divergent branches is ambiguous — which branch's ifc governs
   a value both branches could match. The wish's shape has no such
   ambiguity: branches are type-disjoint (`undefined` vs `object`) and
   exactly ONE carries ifc. Proposal: allow a combinator when at most
   one branch contains ifc AND every ifc-free branch is type-disjoint
   from the ifc-carrying one; the merge treats the ifc-carrying branch
   as the policy carrier (a policy unioned with its absent case is the
   policy). Everything genuinely divergent stays refused.
2. **Alternative (producer-side): remove the combinator from the wish
   result declaration** — declare /result as the requested schema
   directly with presence tracked outside the type union. Narrower: it
   fixes only the wish's own top-level union; any other ifc-under-
   union family re-trips the same assert (profile-home.tsx's comments
   already document Default<>-union proneness), and §2c means each
   such envelope poisons its doc.
3. **The register's third option — "normalizing the served envelope
   before merge" — is refuted by the evidence:** served and local
   envelopes are the same interned content (one cid: doc), and the
   assert fires on the CANDIDATE argument before any served content
   is consulted. There is nothing served-side to normalize.
4. **#6083 (content-addressed schemas on by default, open PR):** no
   interaction with this failure. The schema doc is ALREADY stored
   content-addressed (`cid:fid1:…` observed in the derived commit);
   both writers already agree byte-for-byte; there is no envelope
   vintage skew for #6083 to fix or worsen.

Also answered, rootcause §6.3 (the wish compile/run division of labor
under ON): the raw:wish action demonstrably runs on BOTH sides — the
serving runtime (derived commits under the service session) and the
browser (the killed action) — and today the CLIENT's run is the only
path that mounts the wish UI, which is why the client kill blanks the
surface while the served result sits durably in the store. Whether the
client should run raw wishes at all under ON is a design question for
the coordinator to route with OW49.

## 3. OW50 (seat S-J) — BUILT: commit-prep failures now surface

Red-first (all three watched failing before the fix, in
`packages/runner/test/cfc-prepare-crash-surfacing.test.ts`), three
layers, none touching `cfc/schema-merge.ts` or `cfc/prepare.ts`
semantics:

1. **A prep crash is a modeled refusal, not an escaped throw**
   (`storage/extended-storage-transaction.ts`, `prepareCfc`): an
   exception escaping `prepareBoundaryCommit` — the divergence assert
   is the live instance — is recorded as a prepare reason
   (`CFC commit-prep crashed: <message>`, loudly logged), putting the
   transaction in the same `invalidated` state as every modeled
   refusal. `commit()` then rejects through the standard
   pre-storage-rejection path: the caller gets the REAL cause (before:
   a misleading bare "relevant transaction was not prepared"), commit
   callbacks fire (rollback observers run), and observe-mode commits
   survive the crash instead of throwing. Fail-closed is preserved
   exactly. **Deliberate contract change, flagged for review:** three
   pins in `test/cfc-policy-of-label.test.ts` asserted `prepareCfc()`
   THROWS on PolicyOf authoring errors ("is not installed",
   "malformed PolicyOf schema marker", "compiler-lowered PolicyOf");
   those crashes are the same scheduler-wedge class (a pattern with a
   malformed policy marker killed its action unsettled), so the pins
   were re-pinned to the new surface — `prepareCfc()` returns `""`,
   the commit rejects, and the SAME diagnostic text arrives in the
   rejection message. Fail-closed and the diagnostics are unchanged;
   only the delivery mechanism moved. If the CFC owner wants the
   authoring class to stay a hard throw, the revert is confined to
   the one `catch` in `prepareCfc` plus those three pins.
2. **The scheduler survives any prep throw**
   (`scheduler/run.ts`, `startReactiveActionCommit`): a throw escaping
   `prepareTxForCommit` previously re-entered the finalize path from
   the run promise's rejection handler, threw again, and escaped as an
   unhandled rejection (the CI log's SES_UNHANDLED_REJECTION) with the
   run promise never resolving and the transaction never settling. Now
   the transaction is aborted with the cause and the ordinary
   failed-commit machinery takes over. Pinned by a persistent-throw
   red test (once-only throws self-healed, masking the wedge).
3. **The killed wish shows its failure where its UI belongs**
   (`builtins/wish.ts`): `sendWishState` installs one commit callback
   per action transaction; on a settled non-transient failure it
   writes `{error: <real cause>, [UI]: errorUI(...)}` into the wish
   state doc in a fresh bookkeeping transaction. Three hard-won
   mechanics: (a) the error write uses RAW value writes, because a
   cell write records the stored schema as a candidate and re-meets
   the §2c poison refusal (observed live before the change); (b)
   conflict-class failures are NOT surfaced (the scheduler re-runs and
   converges them — surfacing would flash noise; observed: a
   transient "missing link source metadata" refusal that self-healed
   on retry); (c) one in-flight surfacing per state doc (the refused
   action's bounded retries each fire the observer; unserialized
   writers raced each other). The prior error-report path's
   single-shot "would meet whatever refused it the first time"
   assumption is corrected for the transient classes (bounded
   retries after settle) — the which-direction distinction OW50
   flagged.

Result, unit-proven on the live mechanism: the wish state that
previously froze at its stale value now carries
`error: "…ifc inside divergent anyOf branches is unsupported at
/result…"` and a visible error UI. Deliberately NOT changed: the
refused action still consumes its bounded retry budget
(`StorageTransactionAborted` is not in `TERMINAL_REJECTION_NAMES`;
classifying modeled CFC refusals as terminal would change every
modeled refusal's retry behavior — CFC-adjacent, flagged not filled).

## 4. Skip entry + register status

- `tasks/server-execution-on-skips.ts` profile-embed entry: re-scoped
  in this PR — the blocker is OW49 alone; OW48 named as refuted, OW50
  as built. The skip STAYS (the file cannot green ON until OW49 is
  decided); the flip bar is unchanged.
- verification-coverage.md §3: OW48 annotated refuted-premise
  (closed), OW49 annotated with the decoded envelope + the
  poison-pill finding + the recommendation pointer (still FLAGGED,
  CFC-owner), OW50 closed as built (this PR), each pointing here.

## 5. Verification inventory

| probe | result |
|---|---|
| #6098 PR body + rule + survey | read; rule deliberately exempts the three nested consumers |
| posture matrix compile (5 postures × current bytes) | ALL GREEN |
| program-id reconciliation (`computeId`) | pre-#6019 sources reproduce the logged ids byte-for-byte (`fid1:XFbZ…`, `fid1:UvY4…`) + the identical error; current sources produce different ids and compile green |
| live localhost:8000 probe | Loom production toolshed (vendored labs, pre-#6019 pin) serving `profile-home.tsx` = `La0G…` with `[UI]: unknown` |
| clean-env profile-embed ON (fresh store, self-referential API_URL, land-off ON binary on :8125) | NO TransformerError; the OW49 assert, byte-identical to CI shard 6 |
| CI shard 6 log (run 32447348664) | full stack extracted; assert at schema-merge.ts:611 via prepare.ts:5428 (the un-caught verification merge, candidate side) |
| store archaeology (run1 store) | the divergent envelope extracted from derived commit 35 (service session); two-writer timeline confirmed against the browser kill timestamp |
| unit red suite | 3 tests / 5 steps, each watched RED before its fix, all green after |
| wish-half red re-verify | wish.ts reverted alone → the surfacing test fails with the silent-stale shape; restored → green |
| neighbor suites (cfc-schema-merge, cfc-additive-default, extended-storage-transaction, memory-v2-transaction-commit-rejection, cfc-boundary, wish×3, scheduler-core, scheduler-commit-backpressure) | failures identical to UNTOUCHED main on this machine (pre-existing local env: scheduler-core "rechecks downstream readers", wish scope/#now family, commit-backpressure family); no new failures from this diff |

## 6. Flagged residuals (not filled)

1. OW49's decision (§2e) — CFC owner.
2. Whether modeled CFC refusals should be terminal-classified for the
   scheduler's retry budget (a doomed wish re-runs its bounded budget
   today) — CFC-adjacent scheduler policy.
3. Whether the browser should run raw:wish at all under ON, given the
   served result was already durable (§2b/§6.3) — coordinator.
4. The serving runtimes' pattern-fetch trust surface and the
   local-repro API_URL/MEMORY_URL default-collision hazard (§1c).
5. The machine-local pre-existing test failures listed in §5 —
   verified identical on untouched main; not investigated further.
