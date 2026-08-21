#!/usr/bin/env -S deno run --allow-read

// The EXPLICIT per-phase skip lists of the server-execution v2 ON arm
// (docs/specs/server-side-execution/testing.md §2): in CI the integration
// suites run twice — the DEFAULT lanes (flag unset = the first-party
// default, which is OFF: Phase 7 landed flip-READY with the constant
// `false` by owner ruling 2026-08-16, the flip being its own later PR) and
// the explicit-`EXPERIMENTAL_SERVER_EXECUTION=true` ON lanes (the toolshed
// server ON, the test processes ON, AND the binary's baked browser shell
// ON-built — `build-toolshed-on`) — and the ON arm may skip a test only by
// listing it here, with the plan phase whose not-yet-landed surface it
// exercises and a reason. Never by silent filtering: the CI step prints
// every skip from this file, and an empty list means the ON arm runs the
// full suite. When the flip PR lands the lane roles swap (default = ON
// with this list; explicit-`false` = the OFF regression guard on an
// OFF-built binary) — the flip PR MUST land with this list EMPTY.
//
// An entry retires when its phase lands (docs/plans/server-execution-v2.md);
// a file listed here that no longer exists fails the run, so the lists
// cannot go stale unnoticed.

/** The integration suites that run an ON arm (testing.md §1–§2). */
export type ServerExecutionSuite =
  | "patterns"
  | "runner"
  | "runtime-client"
  | "shell";

/** The plan milestone whose landing retires the skip (never "phase-1": the
 * ON arm exists from Phase 1 stage A, so nothing can be waiting on it). */
export type ServerExecutionPhase =
  | "phase-2"
  | "phase-3"
  | "phase-4"
  | "phase-5"
  | "phase-6"
  | "phase-7"
  | "phase-2-followup"
  | "phase-3-followup";

export type ServerExecutionOnSkip = {
  /** Test file, relative to the suite's package root (the directory the
   * suite's `deno test` runs from), e.g. "integration/counter.test.ts". */
  file: string;
  /** The plan phase that, once landed, unskips this file (or step). */
  phase: ServerExecutionPhase;
  /** Why the ON arm cannot run this file (or step) before that phase. */
  reason: string;
  /**
   * STEP-LEVEL entry (Phase 7 fixer, 2026-08-16): the exact name of ONE
   * `it`/step inside `file` that the ON arm skips while the REST of the
   * file runs. The file is NOT dropped (`--ignore` / `--filter` leave it
   * in); instead the test file itself guards that step with
   * {@link serverExecutionOnStepSkip} — so the guard is BOUND to this entry
   * (remove the entry and the step runs again) and the validator requires
   * the file to name the step AND call the guard. For a one-file suite
   * (runtime-client's `integration/client.test.ts`, 45 steps) this keeps
   * the ON lane's coverage instead of turning the whole lane vacuous over
   * one red step. Printed by the CI step like every other entry.
   */
  step?: string;
};

const SUITE_PACKAGE_DIR: Record<ServerExecutionSuite, string> = {
  patterns: "packages/patterns",
  runner: "packages/runner",
  "runtime-client": "packages/runtime-client",
  shell: "packages/shell",
};

/**
 * The lists themselves. Kept to what stage F's live ON-arm runs actually
 * surfaced: with the serving loop landed the ON arm genuinely SERVES,
 * and CI's ON arm is exactly the plan's mid-Phase-1 local flag flip —
 * server and still-deriving clients CAS-storming, "expected, local-only,
 * fine" (L14), and never a shipped state. Entries name their unskipping
 * phase — never silent filtering anywhere else.
 *
 * History: stage G (2026-08-06) re-justified the two-browsers CFC-gate
 * entry this file had held since stage F and added no skips of its own;
 * Phase 2 RETIRED that entry — the client derivation-commit path is
 * removed by construction, dissolving the two-deriver CAS storm the
 * entry named as its unskipping condition — and ADDED the
 * sx2-serving-loop reproducer of the demand-cycle starvation fork at
 * `phase-2-followup`. Stage P2-F (2026-08-13) RETIRED that entry too:
 * the demand-cycle terminal state with commit-triggered re-arm closed
 * the fork (never-loadable roots park instead of churning per cycle;
 * the load pass runs under the flush deadline), so the surface runs —
 * carrying the in-CI amplification-ratio gate and the pattern-updater
 * CHECK-half witness (verification-coverage.md's closed OW19 row).
 * Every list is EMPTY but for TWO `phase-7` entries: one `patterns`
 * — topics-navigation (Phase 4's mixed-posture entry, re-justified by
 * Phase 7 — the ON shell build now runs in the ON lanes, the inherited
 * red did not lift) — and one `runner` entry,
 * `pattern-and-data-persistence`, red once the runner integration
 * clients DECLARE the ON posture (the lane was mixed before;
 * verification-coverage.md OW33) — plus two STEP-level
 * `runtime-client` entries in `integration/client.test.ts` (the CT-1606
 * PerUser header render, 3/3 red; the single-navigateTo dispatch, 1/3
 * red) whose file otherwise runs ON. The ON arm otherwise runs the full
 * suites; the flip PR lands only once this list is empty again.
 *
 * `lunch-poll-vote` LIFTED by stage-C W3.1 (2026-08-19, tip
 * f250feacd): the gate's blocker — the swatch stall — was root-caused
 * (a diverged speculation layer with no reachable retirement on a
 * quiet space; stage-c/swatch-stall-rootcause.md) and its class fix
 * S1 (the drain-settle quiescence advance, RULED 2026-08-19,
 * protocol.md §4) landed with red-first pins. Lift evidence: 6/6
 * GREEN fresh-store on the ON-built binary at the tip (sha256
 * 53a712cede690b6e…, `No default model available` per run, loads
 * 2.3–3.7, gtimeout 520 s) — totals 3 467–4 334 ms; the stalled step
 * ("both voters' swatches visible") walled at 1 ms in EVERY run — a
 * normal arrival, no 28-s recovery, no timeout; joins honest
 * (confirmed roster, 254–256 ms); events appended/processed 11/12
 * with the one purged LT1 leftover ×4 and 11/11 ×2 (the clicks
 * coalesced — no purge); consequence multiplicity {1:16} in ALL SIX
 * stores (the (α) exactly-once invariant); settleAdvances 10–13 per
 * run (the S1 advance live at quiescence). The earlier entry text
 * (the W2 cascade-echo residual and the OW35 history it carried) is
 * preserved in git history and the register's W2.1/OW43 rows.
 * The history it kept: added by the Phase 7 fixer on the independent
 * review (2026-08-16) for the client-side scheduler-non-settling
 * loop (OW32) whose mechanism fan-out stage B fixed; re-justified by
 * stage-C W3 (2026-08-19) after OW35's close for the W2 cascade-echo
 * residual; its sibling `cfc-group-chat-demo-two-browsers` was
 * un-skipped by fan-out stage B (2026-08-17, 3/3 green).
 */
/**
 * The two-browser gates' Phase-7 reason (the client-side
 * `scheduler-non-settling` loop, verification-coverage.md OW32) RETIRED
 * with fan-out stage B (2026-08-17): the loop's cause — the demand
 * registry dropping identity for space-scoped roots, so every per-user
 * node ran once as the service and the client's speculated per-user
 * instances retired to nothing — is fixed by the per-demander run supply
 * (stage A's arrival gate stays as the backstop). Its text lives in the
 * OW32 row's history; the one remaining two-browser entry below carries
 * that gate's own residual.
 *
 * FIRST ON-LANE CI GATE (2026-08-21, run 32447348664 — the stack's
 * first-ever CI execution, on the land-off PR #6096): the ON pattern
 * lanes found SEVEN real ON red surfaces (every one reproduced locally
 * on the ON-built binary; the OFF lanes untouched; the lunch and chat
 * ON gates PASSED in CI). Root-caused before any entry was added:
 * NO DEMAND HOLE anywhere — the (d′) demand machinery held on every
 * surface it could be observed; each red is a WRITE-PATH defect under
 * ON (a write refused/lost/mislabeled or an action killed at
 * commit-prep), and two of the seven converge on the already-owed
 * OW31/§2b write-authority carriage build. Reports:
 * docs/history/plans/server-execution-v2/stage-c/first-on-ci-gate.md
 * (the gate record + triage table) and
 * docs/history/plans/server-execution-v2/stage-c/on-render-stall-rootcause.md
 * (the three render-stall surfaces, store/log/live-run evidence).
 * The landing posture is skip-and-land: the surfaces below carry honest
 * ON-skip entries with owed register rows (verification-coverage.md §3,
 * OW45–OW53), and they gate the FLIP — whose bar is this list EMPTY —
 * not the land. A ninth family member, cfc-group-chat-demo-multi-runtime,
 * is NOT listed: its CI red was the harness's mixed posture (the
 * self-hosted OFF-arm standalone server refusing ON clients' event
 * appends), fixed by resolving the posture in the harness itself —
 * all 7 steps green on the ON binary with the fix.
 */

export const SERVER_EXECUTION_ON_SKIPS: Record<
  ServerExecutionSuite,
  ServerExecutionOnSkip[]
> = {
  // Phase 2 retired the entry this file held since stage F (the
  // two-browsers CFC gate): the client derivation-commit path is
  // removed by construction, the two-deriver interim's CAS storm with
  // it — the exact unskipping condition the entry named. That gate now
  // runs (and passes) ON.
  patterns: [
    {
      file: "integration/topics-navigation.test.ts",
      phase: "phase-7",
      reason: "Phase 7 (2026-08-15; lane roles re-tensed 2026-08-16 — the " +
        "flip landed DARK, so this runs in the explicit-true ON lanes on " +
        "the ON-built binary, not in the default lanes): the ON shell " +
        "build now RUNS in CI (`build-toolshed-on` bakes the shell ON for " +
        "the ON lanes), which " +
        "discharges the first of this entry's two lifting conditions — " +
        "the second (the inherited red) does NOT lift: under the full " +
        "ON posture the file fails FAST at the " +
        "controller's prop set (`updated result does not match its " +
        "write destination: missing required property myName`, " +
        "PiecePropIo.set → validateWriteDestination), reproduced on the " +
        "Phase-7 tree 2026-08-15; a browser-ON/controller-ON red owed to " +
        "the flip-follow-up triage. Original entry: " +
        "MIXED-POSTURE honesty (Phase 4 fixer, 2026-08-11; the " +
        "workflow contract's list-the-affected-tests clause): the " +
        "ON-arm CI lane ships the binary's OFF-built browser shell, " +
        "so its green run of this file exercised an OFF-shell + " +
        "ON-server posture that asserts nothing about the browser-ON " +
        "behavior Phase 4 added — while under the FULL flag-ON " +
        "posture (shell define baked ON, the local harness's " +
        "start-local-dev env inheritance) the file is RED, reproduced " +
        "verbatim on the unmodified Phase-3 base (5-minute " +
        "'Navigation target' render timeout — the base-inherited " +
        "browser-ON red family the P3 triage tracks, leg C's " +
        "speculation-basis wedge pending its owner ruling). Skipped " +
        "rather than green-by-vacuity; lifts when the ON shell build " +
        "lands in CI (verification-coverage.md OW25) AND the " +
        "inherited red is fixed.",
    },
    // ---- First ON-lane CI gate entries (2026-08-21; skip-and-land) ----
    {
      file: "integration/default-app.test.ts",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21, run 32447348664; " +
        "skip-and-land — gates the FLIP, not the land): the browser " +
        "console gate (integration/shell-utils.ts afterEach) trips on a " +
        "deterministic `TypeError: Cannot read properties of undefined " +
        "(reading 'split')` at `splitDefinitions` " +
        "(api/patterns/notes/reference-block.ts:62) inside note.tsx lift " +
        "callbacks — an ON READ-SEMANTICS seam: under the ON posture the " +
        "lift's input arrives undefined where the OFF arm always supplies " +
        "it (the same console error W4 §6.2 recorded on the note workload; " +
        "fatal here because the console gate fails the test). Reproduced " +
        "locally ON; OFF green. NOT a demand hole. Evidence: " +
        "docs/history/plans/server-execution-v2/stage-c/first-on-ci-gate.md. " +
        "Lifts when verification-coverage.md OW51 closes and the file " +
        "greens ON; the flip PR needs this list EMPTY.",
    },
    {
      file: "integration/cfc-group-chat-demo.test.ts",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21; skip-and-land — gates " +
        "the FLIP, not the land): TWO write-path defects, one per failure " +
        "point, NEITHER a demand hole (the served derivation chain was " +
        "clean end-to-end: 33–41 derived commits, healthy demand " +
        "counters). CI shape (Alice's authorship check): served " +
        "events-down rows carry the SERVICE identity — authored-by/" +
        "represents-principal name the service signer, not Alice — so CFC " +
        "authorship verification stays 'unverified' forever; this IS the " +
        "owed OW31/§2b acting-identity carriage build (post-merge, " +
        "pre-flip), now with a CI surface as its lift evidence. Local " +
        "shape (Bob's send click): Bob's messageDraft $value binding " +
        "write into the serve-owned user-scope instance doc NEVER reaches " +
        "the store (0/4 runs incl. a 300 s probe; his session committed " +
        "12 OTHER writes meanwhile), so the served sendDisabled correctly " +
        "never flips — the client own-write durability seam, " +
        "verification-coverage.md OW47 (seats S-E/S-F/S-G). Mechanism + " +
        "store/log evidence: docs/history/plans/server-execution-v2/" +
        "stage-c/on-render-stall-rootcause.md §2 (and " +
        "first-on-ci-gate.md). Lifts when OW31's build AND OW47 close and " +
        "the file greens ON; the flip PR needs this list EMPTY.",
    },
    {
      file: "integration/profile-embed.test.ts",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21; skip-and-land — gates " +
        "the FLIP, not the land), re-scoped by the optimize-on-main " +
        "served-wish seat (ow48-50-wish-path-report.md): ONE killer, not " +
        "two. The remaining blocker is OW49 — main's " +
        "`assertNoDivergentIfcBranches` (runner cfc/schema-merge.ts, " +
        "#3263) refuses the wish builtin's own /result declaration " +
        "`anyOf[{type:\"undefined\"}, <requested schema>]` whenever the " +
        "requested schema carries ifc (the profile consumer view). Under " +
        "ON the serving loop persists that envelope first, and the " +
        "browser's raw:wish, writing a changed /result link against it, " +
        "is refused in commit-prep — reproduced on a clean local env " +
        "(fresh store, self-referential API_URL) and at unit level " +
        "(runner test/cfc-prepare-crash-surfacing.test.ts). A CFC-owner " +
        "merge-rule call (verification-coverage.md OW49); NOT a demand " +
        "hole. Gate record: docs/history/plans/server-execution-v2/" +
        "stage-c/first-on-ci-gate.md; seat evidence: " +
        "docs/history/plans/server-execution-v2/optimize/" +
        "ow48-50-wish-path-report.md. " +
        "OW48 (the #6098 TransformerError shape) was REFUTED as " +
        "environment contamination — the investigation's serving " +
        "runtimes fetched system patterns from a stale localhost:8000 " +
        "toolshed (env.API_URL default) serving pre-#6019 sources; " +
        "current sources compile green under every posture. OW50's " +
        "failure surfacing is BUILT: the killed wish now shows `error` " +
        "+ an error UI in its state instead of silently never mounting. " +
        "Lifts when OW49 closes and the file greens ON; the flip PR " +
        "needs this list EMPTY.",
    },
    {
      file: "integration/home-profile-reload-durability.test.ts",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21; skip-and-land — gates " +
        "the FLIP, not the land): under ON the created profile piece's " +
        "PROGRAM (code + CFC labelMap + schema docs) is only ever written " +
        "by the client's own post-arrival commit; the reload kills the " +
        "trailing create's program commit, and the server's fallback — " +
        "`compile-cache/writeback` into the profile space — is REFUSED as " +
        "a foreign-space write with no §2b delegated carriage " +
        "(seal-space-commit-failed, 17 refusals per space observed), so " +
        "the space's serving loop parks the structure load forever, " +
        "SILENTLY, and the name renders the #id placeholder. NOT a demand " +
        "hole — the identical demand derived the name wherever the " +
        "program write survived (72 basis rows on Grace's space; 0 on the " +
        "broken two). The carriage half is the owed OW31/§2b build " +
        "(S-A); the client barriers and heal-on-read are " +
        "verification-coverage.md OW45 (S-B/S-C); the silent forever-park " +
        "is OW46 (S-D). Mechanism + store/log evidence: docs/history/" +
        "plans/server-execution-v2/stage-c/on-render-stall-rootcause.md " +
        "§1 (and first-on-ci-gate.md). Lifts when OW31's build AND OW45 " +
        "close and the file greens ON; the flip PR needs this list EMPTY.",
    },
    {
      file: "integration/sqlite-db-owner-multi-runtime.test.ts",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21; skip-and-land — gates " +
        "the FLIP, not the land): red under the TRUE ON topology (the " +
        "harness posture fix routes ON runs at the lane's toolshed) with " +
        "a semantic assert — `bob's runtime must not re-mint itself as " +
        "the db owner`: a second user's runtime re-mints the sqlite db " +
        "handle owner under ON, the served-execution half of the sqlite " +
        "identity pair (verification-coverage.md OW53; its sibling below " +
        "carries the read-clearance half). NOT a demand hole. Evidence: " +
        "docs/history/plans/server-execution-v2/stage-c/" +
        "first-on-ci-gate.md. Lifts when OW53 closes and the file greens " +
        "ON; the flip PR needs this list EMPTY.",
    },
    {
      file: "integration/sqlite-read-clearance-multi-runtime.test.ts",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21; skip-and-land — gates " +
        "the FLIP, not the land): red under the TRUE ON topology with " +
        "semantic asserts — `baseline request hash stays reader-blind` " +
        "fails (the cleared-read request hash becomes keyed by READER " +
        "under ON) and `the cleared result doc carries ONLY the declared " +
        "surface` fails: the sqlite read-time clearance identity model " +
        "diverges under served execution — the read-clearance half of " +
        "the sqlite identity pair (verification-coverage.md OW53). NOT a " +
        "demand hole. Evidence: docs/history/plans/server-execution-v2/" +
        "stage-c/first-on-ci-gate.md. Lifts when OW53 closes and the " +
        "file greens ON; the flip PR needs this list EMPTY.",
    },
    // STEP-LEVEL entries: on the fixed (true-ON) harness topology each of
    // these files is green but for ONE step, so the file keeps running ON
    // and only the red step is guarded in-file (bound to these entries,
    // exactly like the runtime-client pair).
    {
      file: "integration/cellset-lww.test.ts",
      step: "end-to-end: a typed name survives the own-write race through save",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21; skip-and-land — gates " +
        "the FLIP, not the land): under the TRUE ON topology the other 3 " +
        "steps are green; this end-to-end step stays red — the user's own " +
        "typed-name write is DROPPED when its transaction is refused " +
        "terminally (`speculative-basis-refused`): a non-re-derivable " +
        "USER write refused/withdrawn is silently lost, because the " +
        "'its own reads re-run it when fresh state lands' premise of " +
        "serving-loop.md §3d does not hold for INPUTS — the clean " +
        "reproducer of the client own-write durability seam " +
        "(verification-coverage.md OW47, seats S-E/S-F; same cluster as " +
        "cfc-group-chat-demo's local shape). NOT a demand hole. " +
        "Evidence: docs/history/plans/server-execution-v2/stage-c/" +
        "first-on-ci-gate.md (mechanism family: " +
        "on-render-stall-rootcause.md §2b). Lifts when OW47 closes and " +
        "the step greens ON; the flip PR needs this list EMPTY.",
    },
    {
      file: "integration/convergence-storm.test.ts",
      step: "a non-writing session sees every concurrently-posted message",
      phase: "phase-7",
      reason: "First ON-lane CI gate (2026-08-21; skip-and-land — gates " +
        "the FLIP, not the land): under the TRUE ON topology the 3 " +
        "element-schema tests are green; this storm step is red with a " +
        "REAL ON loss — 2×20 pipelined posts (idle:false), observer " +
        "landed=23/40 (was 0/40 under the pre-fix mixed posture, which " +
        "refused every append): a write-path loss at storm depth; WHERE " +
        "the 17 die (append admission, queue, dispatch, or consequence " +
        "commit under pipelined contention) is UNTRIAGED " +
        "(verification-coverage.md OW52). NOT a demand hole — what lands " +
        "is served and delivered to the non-writing observer. Evidence: " +
        "docs/history/plans/server-execution-v2/" +
        "stage-c/first-on-ci-gate.md. Lifts when OW52 closes and the " +
        "step greens ON 5/5; the flip PR needs this list EMPTY.",
    },
  ],
  runner: [
    {
      file: "integration/pattern-and-data-persistence.test.ts",
      phase: "phase-7",
      reason: "Phase 7 (2026-08-16, P7 fixer on the independent review's " +
        "finding 7): the runner integration tests that talk to the lane's " +
        "toolshed now DECLARE the posture from the env, so under the ON lane " +
        "this Deno client really runs the ON client arm — and this file is " +
        "RED there (reproduced locally, uniform ON: 13/14 green, this one " +
        "red; it was 'green ON' only while the lane ran a MIXED posture, an " +
        "OFF client against an ON server). Mechanism as observed: Phase 3 " +
        "starts a NEW piece, `pull()`s its result cell and reads " +
        "`getAsQueryResult().sum` — 15 under the derive-and-commit client " +
        "(OFF), `undefined` under ON. The test holds no sink on the result " +
        "(the sink is the demand — serving-loop.md §1: pull-based laziness), " +
        "so nothing served the derivation, and the ON client's OWN " +
        "speculative run did not surface the value through this read path " +
        "either — UNTRIAGED whether the Deno-client speculation overlay " +
        "should have (verification-coverage.md OW33; the same family shows " +
        "as `derive_array_leak`'s own 'Counter value is 0, expected 50' " +
        "warning under ON — green only because that test asserts memory). " +
        "The remaining runner integration files that serve toolshed's " +
        "`app.ts` in-process (no ExecutorHost) are single-process harnesses, " +
        "OFF by construction in either lane. Skipped rather than red-by-" +
        "design; lifts when OW33 is triaged and this file greens under the " +
        "uniform ON posture; the flip PR needs this list EMPTY.",
    },
  ],
  "runtime-client": [
    // STEP-LEVEL entries (the suite is ONE file with 45 steps; dropping the
    // file would make the runtime-client ON lane vacuous). The rest of
    // `client.test.ts` runs ON — the worker DECLARES the posture from the
    // env since the P7 fixer (finding 7); these two steps are red under the
    // uniform ON posture, reproduced 3/3 and 1/3 respectively against a
    // local ON toolshed (2026-08-16).
    {
      file: "integration/client.test.ts",
      step:
        "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
      phase: "phase-7",
      reason: "Phase 7 (2026-08-16, P7 fixer on the independent review's " +
        "finding 7): with the worker declaring the ON posture this step " +
        "never reaches its FIRST render within 15 s (3/3 red under uniform " +
        "ON; green under the mixed posture the lane ran before) — a page " +
        "whose header renders a `computed` over a `PerUser<myName>` input " +
        "(the SAME PerUser shape topics-navigation fails on under the full " +
        "ON posture). Mechanism UNATTRIBUTED — the Deno-worker client's " +
        "per-user derivation neither speculates into the render nor " +
        "arrives served in time; folded into verification-coverage.md OW33 " +
        "(the ON-posture Deno-client family) beside topics-navigation's " +
        "inherited red. Skipped at STEP granularity so the other 43 steps " +
        "keep running ON; lifts when OW33's triage greens it 5/5; the flip " +
        "PR needs this list EMPTY.",
    },
    {
      file: "integration/client.test.ts",
      step:
        "dispatches one navigateTo when a rendered handler changes local state",
      phase: "phase-7",
      reason: "Phase 7 (2026-08-16, P7 fixer on the independent review's " +
        "finding 7): under the uniform ON posture this step is FLAKY (1/3 " +
        "red: expected ONE navigateTo dispatch, observed TWO — the " +
        "double-dispatch class the F10 handler-fork contract exists to " +
        "prevent, here on a Deno-worker client whose handler fire commits " +
        "the event while the served consequence also navigates). " +
        "UNATTRIBUTED; folded into verification-coverage.md OW33. Skipped " +
        "at STEP granularity (the other steps keep running ON) rather than " +
        "left to flake the lane; lifts when OW33's triage greens it 10/10; " +
        "the flip PR needs this list EMPTY.",
    },
  ],
  shell: [],
};

export const isServerExecutionSuite = (
  value: string,
): value is ServerExecutionSuite => value in SUITE_PACKAGE_DIR;

/**
 * The `--ignore=` flag for a suite's `deno test`, or "" with no skips.
 *
 * BINDS ONLY WHEN DENO DISCOVERS THE FILES ITSELF (Phase 7 fixer,
 * 2026-08-16 — found while landing the two-browser entries): `deno test
 * --ignore=<file>` filters DISCOVERED modules (a directory argument, or a
 * glob Deno expands because it reached deno QUOTED), and silently ignores
 * nothing when the same file arrives as an EXPLICIT positional argument —
 * which is what a shell-expanded `./integration/*.test.ts` and the pattern
 * shards' `"${TEST_FILES[@]}"` both are. So the package `integration`
 * tasks (runner, runtime-client, shell) quote their glob, and the pattern
 * shards go through {@link serverExecutionOnFilterFiles} (`--filter`)
 * instead of this flag; the pins in the test file spawn deno on both
 * shapes. Before this fix every "skipped" entry since Phase 4 (topics-
 * navigation) actually RAN — unnoticed because the ON lanes ran a mixed
 * posture under which it passed.
 */
export const serverExecutionOnIgnoreArg = (
  suite: ServerExecutionSuite,
): string => {
  const skips = SERVER_EXECUTION_ON_SKIPS[suite].filter((skip) =>
    skip.step === undefined
  );
  if (skips.length === 0) return "";
  return `--ignore=${skips.map((skip) => skip.file).join(",")}`;
};

/**
 * The step-level guard a test FILE calls (see `ServerExecutionOnSkip.step`):
 * the entry for `step` in `file`, or undefined when the ON arm runs it.
 * Callers pass `ignore: serverExecutionOnStepSkip(...) !== undefined` only
 * when the process actually runs the ON posture (they read
 * EXPERIMENTAL_SERVER_EXECUTION themselves — the OFF arm never skips), and
 * log the entry's reason when they skip, so the skip is never silent.
 */
export const serverExecutionOnStepSkip = (
  suite: ServerExecutionSuite,
  file: string,
  step: string,
): ServerExecutionOnSkip | undefined =>
  SERVER_EXECUTION_ON_SKIPS[suite].find((skip) =>
    skip.file === file && skip.step === step
  );

/** A candidate test path as the shard selector or a shell prints it
 * (`./integration/x.test.ts`, `integration/x.test.ts`), normalized to the
 * skip entries' package-relative form. */
const normalizeCandidate = (file: string): string => file.replace(/^\.\//, "");

/**
 * The EXPLICIT-FILE shape (the pattern shards): the candidate files minus
 * the suite's skip entries, in the input order, plus the entries that
 * were actually dropped from THIS list (so the run step can print what it
 * skipped here, not just the whole list). Files are compared after
 * normalizing a leading `./`.
 */
export const serverExecutionOnFilterFiles = (
  suite: ServerExecutionSuite,
  candidates: readonly string[],
): { files: string[]; skipped: ServerExecutionOnSkip[] } => {
  const skips = SERVER_EXECUTION_ON_SKIPS[suite].filter((skip) =>
    skip.step === undefined
  );
  const byFile = new Map(skips.map((skip) => [skip.file, skip]));
  const files: string[] = [];
  const skipped: ServerExecutionOnSkip[] = [];
  for (const candidate of candidates) {
    const skip = byFile.get(normalizeCandidate(candidate));
    if (skip === undefined) files.push(candidate);
    else if (!skipped.includes(skip)) skipped.push(skip);
  }
  return { files, skipped };
};

/** Human-readable report of a suite's skips, one line per entry. */
export const serverExecutionOnSkipReport = (
  suite: ServerExecutionSuite,
): string => {
  const skips = SERVER_EXECUTION_ON_SKIPS[suite];
  if (skips.length === 0) {
    return `[server-execution ON arm] ${suite}: no skips — full suite runs.`;
  }
  const lines = skips.map((skip) =>
    skip.step === undefined
      ? `[server-execution ON arm] ${suite}: SKIP ${skip.file} (until ${skip.phase}) — ${skip.reason}`
      : `[server-execution ON arm] ${suite}: SKIP-STEP ${skip.file} :: ${skip.step} (until ${skip.phase}; the rest of the file runs) — ${skip.reason}`
  );
  return lines.join("\n");
};

/** Every listed file must exist; a vanished file is a stale entry. */
export const validateServerExecutionOnSkips = async (
  repoRoot: URL,
  skipLists: Record<
    ServerExecutionSuite,
    ServerExecutionOnSkip[]
  > = SERVER_EXECUTION_ON_SKIPS,
): Promise<string[]> => {
  const problems: string[] = [];
  for (
    const [suite, skips] of Object.entries(skipLists) as [
      ServerExecutionSuite,
      ServerExecutionOnSkip[],
    ][]
  ) {
    const seen = new Set<string>();
    for (const skip of skips) {
      const key = skip.step === undefined
        ? skip.file
        : `${skip.file}\0${skip.step}`;
      if (seen.has(key)) {
        problems.push(
          `${suite}: duplicate skip entry for ${skip.file}` +
            (skip.step === undefined ? "" : ` :: ${skip.step}`),
        );
      }
      seen.add(key);
      const path = new URL(
        `${SUITE_PACKAGE_DIR[suite]}/${skip.file}`,
        repoRoot,
      );
      let contents: string | undefined;
      try {
        contents = await Deno.readTextFile(path);
      } catch {
        problems.push(
          `${suite}: skip entry names a missing file: ${skip.file}`,
        );
      }
      // A step entry must be BOUND: the file names the step and calls the
      // guard, else the entry is decoration and the step silently runs (or
      // a renamed step silently unskips).
      if (skip.step !== undefined && contents !== undefined) {
        if (!contents.includes(skip.step)) {
          problems.push(
            `${suite}: step skip entry names a step ${skip.file} does not ` +
              `contain: ${JSON.stringify(skip.step)}`,
          );
        }
        if (!contents.includes("serverExecutionOnStepSkip(")) {
          problems.push(
            `${suite}: ${skip.file} carries a step skip entry but never ` +
              "calls serverExecutionOnStepSkip — the entry would be decoration",
          );
        }
      }
    }
  }
  return problems;
};

/**
 * CLI body, split from the `import.meta.main` wrapper so tests can drive it
 * in-process (the same coverage-driven split as `tasks/test.ts`). The skip
 * report goes to `io.error` (stderr) so an `$( )` capture in a CI step picks
 * up only the payload from `io.log` (stdout); the step shows both.
 *
 * Two shapes:
 * - `<suite>` — prints the `--ignore=` flag (for a `deno test` that
 *   DISCOVERS its files: the package `integration` tasks' quoted glob);
 * - `<suite> --filter <file>...` — prints the candidate files minus the
 *   skips, one per line (for a `deno test` fed EXPLICIT files: the
 *   pattern shards), reporting on stderr which entries this list dropped.
 */
export const main = async (
  args: string[],
  io: { log: (line: string) => void; error: (line: string) => void } = {
    log: console.log,
    error: console.error,
  },
  repoRoot: URL = new URL("../", import.meta.url),
): Promise<number> => {
  const suite = args[0] ?? "";
  if (!isServerExecutionSuite(suite)) {
    io.error(
      `Unknown suite ${JSON.stringify(suite)}; expected one of: ${
        Object.keys(SUITE_PACKAGE_DIR).join(", ")
      }`,
    );
    return 1;
  }
  const problems = await validateServerExecutionOnSkips(repoRoot);
  if (problems.length > 0) {
    io.error(problems.join("\n"));
    return 1;
  }
  io.error(serverExecutionOnSkipReport(suite));
  if (args[1] === "--filter") {
    const { files, skipped } = serverExecutionOnFilterFiles(
      suite,
      args.slice(2),
    );
    for (const skip of skipped) {
      io.error(
        `[server-execution ON arm] ${suite}: DROPPED ${skip.file} from this ` +
          `file list (until ${skip.phase})`,
      );
    }
    if (skipped.length === 0) {
      io.error(
        `[server-execution ON arm] ${suite}: no listed skip is in this ` +
          "file list — every candidate runs.",
      );
    }
    for (const file of files) io.log(file);
    return 0;
  }
  if (args.length > 1) {
    io.error(
      `Unexpected arguments ${JSON.stringify(args.slice(1))}; expected ` +
        "<suite> or <suite> --filter <file>...",
    );
    return 1;
  }
  const arg = serverExecutionOnIgnoreArg(suite);
  if (arg !== "") io.log(arg);
  return 0;
};

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
