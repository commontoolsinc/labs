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
 * carrying the in-CI amplification-ratio gate and the witness that a
 * serving tenure settles without following any piece's source origin
 * (verification-coverage.md's closed OW19 row).
 * The OW33-family entries this paragraph tracked have moved (OW33
 * triage, 2026-08-22): the two STEP-level `runtime-client` entries and
 * the `patterns` topics-navigation entry are LIFTED (12/12 and 10/10
 * green at the true ON topology — see each list's comment; the topics
 * lift barriers the test's fid capture and moves the echo-drop smell
 * to verification-coverage.md OW60), and the surviving `runner` entry
 * (`pattern-and-data-persistence`) carries a ROOT-CAUSED reason
 * superseding its UNTRIAGED 2026-08-16 note — the speculation
 * overlay's arrival-witness hole
 * (docs/history/plans/server-execution-v2/optimize/
 * ow33-triage-report.md). The ON arm otherwise runs the full
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
  // topics-navigation LIFTED by the OW33 triage's review pass
  // (2026-08-22, main 51350077e): the entry's recorded fail-fast red
  // (`missing required property myName` at PiecePropIo.set →
  // validateWriteDestination) did NOT reproduce in 11 true-ON runs, and
  // the residual 2/10 flake was a TEST-POSTURE defect — the beforeAll's
  // unbarriered `topicAt` fid capture reading a pre-arrival `topics`
  // when the client's echo run is dropped (the OW60 echo-drop smell,
  // verification-coverage.md — the board itself was always correct
  // server-side). The capture is now barriered on both created topics
  // being readable (waitForCellValue, the waiting-in-tests non-browser
  // shape). Lift evidence: 10/10 green on the ON-built binary
  // (sha256 68331b3f…, fresh store, posture probed per run) WITH the
  // echo-drop occurring in 2 of the 10 runs and absorbed by the
  // barrier — the exact former 2/10 red mechanism, no longer failing.
  // The product smell the flake used to witness stays tracked as
  // verification-coverage.md OW60, not as a flaky test.
  patterns: [
    // default-app's reload STEP ("should persist and reload every rapidly
    // created notebook note") LIFTED 2026-08-28, and its in-file guard removed
    // with it. The entry's own CHARGE stopped reproducing in either arm: the
    // NAVIGATION half fixed by the L2 ruled PUNT plus the step's id-bound reads
    // (#6448), the a04 WRITE-side mark-without-effects residue by #6459's
    // mark/effects atomicity. Lift evidence, both halves of the ruled
    // local-plus-CI-probe bar (RULED 2026-08-27):
    // (1) LOCAL 10/10 quiet-and-loaded at main 1fc841b6e on one ON-built binary
    //     (sha256 a93047a461c0c4d8…, re-verified per run), fresh store + own
    //     97xx port + ON posture probe per run, ensure defaulting ON, toolshed
    //     self-sourced, LLM masked, gtimeout 600 never approached — 13-14s wall
    //     per run against 313-315s for every red the earlier 2026-08-27
    //     campaign recorded, with pattern-load-error, pattern-swap-setup-error,
    //     deferred-start-catchup, session-remount, load-park,
    //     piece-start-commit-failed, structure-load-stuck and
    //     handlerNotRunDeferrals ALL ZERO (events.appended 14 =
    //     events.processed 14 in all ten).
    // (2) The DIRECT CI UNSKIP PROBE (run 33138358110, ON shard 5, job
    //     98743591519, head 95f313835) ran this exact step with no listed skip
    //     and it PASSED — ok (18s), the whole default-app file green, the
    //     shard's published toolshed log clean across the file's window (4
    //     event-view-lag, nothing else).
    // Shard 5's red was a CO-RESIDENT file, cfc-group-chat-demo.test.ts:133 —
    // not skip-listed, untouched by the probe diff, and 4/6 RED locally at the
    // same head running ALONE. The owner RULED 2026-08-28, over the
    // coordinator's recommendation that the probe proves the UNSKIPPED SURFACE
    // and co-resident debt carries its own accountability: "agreed with your
    // recommendations, proceed". Under that surface reading this entry's bar
    // was fully met by the evidence above. Full chain: verification-coverage.md
    // OW45 (the PHASE 3 block and the LIFT block that follows it).
    {
      // RESTORED (again) 2026-08-28 after the geometry-3 close PR's own
      // direct-CI unskip probe — PROBE 5 of the arc, run 33198257149,
      // ON shard 7 job 98941298566 — went RED at the probed surface,
      // and the red is the PRE-DECLARED GEOMETRY 3b on its exact
      // signature: ONE closure-replication-failed (entry=Jlzs..., the
      // same profile-home module, parent -> profile, "source closure
      // unavailable in origin space", 18:16:15.616) with ZERO
      // closure-replication-await-inflight lines — the once-await's
      // announcement, which prints whenever either compile registry is
      // non-empty at the dry consult (pattern-manager logger level
      // "info" admits warn; verified in logger.ts) — so BOTH registries
      // were EMPTY: the supplier compile had NOT STARTED at consult
      // time. Fallback counters 0 (the module-keyed map correctly dry:
      // no persist had completed anywhere), then 80 structure-load-stuck
      // over 40 pattern-unloadable roots 18:16:50-18:20:50, "Unknown
      // profile #AykQuk", :271 at the 300000ms bound; 11 co-residents
      // green. What this PR CLOSED red-first (kept; pinned in
      // packages/runner/test/pattern-replication-sibling-race.test.ts,
      // 5 steps, every mechanism independently mutation-killed):
      // geometry 3 — the supplier compile MID-FLIGHT at consult: on a
      // dry origin AND dry map the replication awaits a snapshot of
      // BOTH in-flight compile registries once, re-observes
      // pendingCacheWriteBacks fresh, and re-consults; an empty
      // snapshot keeps the byte-identical one-shot throw. Geometries
      // 1+2 (#6484): sibling-await + module-keyed fallback origins.
      // The residue is now exactly ONE geometry: 3b, the
      // not-yet-started supplier compile, invisible to any once-await
      // by construction. The full close — event-driven re-supply (on
      // each recordPersistedClosureSpaces for identity I, re-issue
      // failed replications wanting I) — TOUCHES THE ONE-SHOT CONTRACT
      // and is recorded in the register as an OWNER-COURT fork; that
      // fork (or a deeper supply redesign, e.g. compiling the home-env
      // into the parent space before serving profile creation) is this
      // entry's lift condition, plus the ruled local-plus-CI-probe bar.
      // Local record at the close head: campaigns I and J 8/8 each
      // (fresh store + posture probe per run, ensure defaulting ON,
      // toolshed self-sourced, LLM masked; structureLoadStuck 0,
      // closure-replication-failed 0, await-inflight 0 — the retry is
      // dormant locally; the park is a CI boot ORDER). Full chain:
      // verification-coverage.md OW45's lunch blocks (GEOMETRY-3
      // CLOSE, LIFT-ATTEMPT, PROBE 5 / 3b CONFIRMED).
      file: "integration/lunch-poll-vote.test.ts",
      phase: "phase-7",
      reason: "OW45 arm B, the structure-load forever-park: the profile " +
        "space's program closure has NO reliable server-side supplier " +
        "when the create-profile event beats every persist of the " +
        "profile-home module. FOUR supplier geometries now mapped on " +
        "five direct-CI probes (#6484's runs 33160430927, 33164596936, " +
        "33165960083; the geometry-3 close PR's run 33198257149; the " +
        "arc's first probe 33138358110 ran pre-PR): the in-flight " +
        "sibling replication (FIXED, sibling-await), the by-ORDER " +
        "closure-less parent (FIXED, module-keyed fallback origins), " +
        "the MID-FLIGHT supplier compile (FIXED, the once-await over " +
        "both in-flight compile registries with re-consult — the " +
        "geometry-3 close, red-first), and GEOMETRY 3B: the supplier " +
        "compile NOT YET STARTED at consult time — CONFIRMED live by " +
        "probe 5's artifact (one closure-replication-failed with ZERO " +
        "closure-replication-await-inflight lines = both registries " +
        "empty at the dry consult; fallback counters 0; 80 " +
        "structure-load-stuck, 40 roots; 'Unknown profile #AykQuk'; " +
        ":271 at 300000ms; co-residents green). A once-await cannot " +
        "see a compile that has not begun; the full close " +
        "(event-driven re-issue on persist record) touches the " +
        "one-shot contract and sits with the owner (the register's 3b " +
        "fork). Local 46/46 GREEN across campaigns F/G/H/I/J + smokes " +
        "at the fix heads (fresh store + posture probe per run, ensure " +
        "defaulting ON, self-sourced, LLM masked): the parent's own " +
        "sidecar compile always persists first locally — the park is " +
        "a CI boot ORDER, not a race or a load artifact. Lifts on the " +
        "owner-ruled 3b close (or a deeper supply redesign) plus the " +
        "ruled local-plus-CI-probe bar.",
    },
    // The sqlite identity pair's two FILE entries were LIFTED (OW53
    // CLOSED, 2026-08-22): the sqlite builtins consumed the RUNTIME's
    // ambient identity — the SERVICE, on a serving runtime — where the
    // ruled model carries the RUN's acting principal (serving-loop.md
    // §3c; protocol.md §1). The db-owner mint, the cleared-read hash
    // keying, and the effect flush's reader and writeback identity now
    // consume the run-carried principal (client/OFF byte-identical), so
    // `sqlite-db-owner-multi-runtime` and
    // `sqlite-read-clearance-multi-runtime` both green under the true ON
    // topology (fresh-store gate 5/5 each; verification-coverage.md OW53
    // carries the traces and the lift evidence).
  ],
  // pattern-and-data-persistence LIFTED (the arrival-witness predicate,
  // RULED 2026-08-22 — candidate (B) of the OW33 fork memo, built with
  // red-first pins for both observed arms): the entry's root cause was
  // the speculation overlay's ARRIVAL GATE witnessing arrival as
  // `confirmedSeq(writtenDoc) >= floor`, class-blind — a first-run
  // speculation's computed docs carry an AUTHORED setup cover at
  // exactly the floor seq (the client's own phase-3 setup for the new
  // instance; a prior session's for the resumed one), so the entry
  // retired 40-260 ms before the served value landed and the bare read
  // saw undefined (a rotating ~4/8 flake). The ruled predicate: a
  // cover witnesses STRICTLY ABOVE the floor (any class), or AT the
  // floor only when derived-class; unknown class at the floor fails
  // closed toward the standing echo. Lift evidence: 10/10 green at the
  // true ON topology (ON-built binary sha256 d3ef4a47f4354977…, fresh
  // store per run, posture probed per run — shellServerExecutionDefine
  // "true" + servingLoop present; loads 4.2-6.5; per-run stores show
  // the loop serving, e.g. 13 derived commits in run 7). The register
  // row (verification-coverage.md OW33) and the fork memo carry the
  // ruling and the build.
  runner: [],
  // The two STEP-level entries this list held (the CT-1606 PerUser header
  // render, 3/3 red 2026-08-16; the single-navigateTo dispatch, 1/3 red)
  // were LIFTED by the OW33 triage (2026-08-22, main 51350077e): both
  // steps are GREEN at the true ON topology — ON-built binary
  // (sha256 68331b3f…), fresh store, posture probed per run
  // (`shellServerExecutionDefine === "true"`, `servingLoop` present) —
  // 10/10 full-suite runs with both steps executing (45 steps, 0 failed,
  // every run), plus 2 earlier source-toolshed ON runs (12/12 total).
  // The reds healed with the stack landed since the entries were written
  // (fan-out stage B's per-demander run supply, the OW51 unresolved-input
  // semantics, stage-C's arrival/retirement tuning, OW34 attribution).
  // Evidence: docs/history/plans/server-execution-v2/optimize/
  // ow33-triage-report.md. The in-file `onArmStepSkip` guard stays — it
  // is the binding mechanism for any future step entry and is inert while
  // no entry names it.
  "runtime-client": [],
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
