# Scheduler v2 implementation — progress log

> Maintained by the implementing agent (rule G7 in `00-README.md`).
> One line per completed step; deviations, STOP events, and required
> recordings (bench numbers, red-test outputs, enumerated grep results)
> in full under the step's heading. The reviewer reads this file first.

Format:

```
## <work order>/<step>
- [x] <commit sha> — <one-line summary>
- Deviations: <none | description>
- Recordings: <bench numbers / red output excerpts / site lists, as the
  step requires>
```

## Baseline (fill in before work order 01)

- Branch + base commit: `scheduler-v2/01-phase0` from
  `origin/main` at `cd1da3d4edaf3679da18dbbb1709e02716be35cc`.
- Full runner suite result (`cd packages/runner && deno task test`):
  passed, `588 passed (3074 steps)`, `0 failed`, `0 ignored (10 steps)`,
  `2m8s`.
- Bench baseline (commands from 05/step-0, plus
  `scheduler-event-preflight.bench.ts`, `scheduler-materializer-fanout.bench.ts`,
  `scheduler-persistent-state.bench.ts`, `scheduler-pull-seeds.bench.ts`):
  - `test/scheduler.bench.ts`:
    - `Scheduler - 100 computations, shared entity reads`: 37.4 ms
    - `Scheduler - wide graph (1 source, 100 readers)`: 34.9 ms
    - `Scheduler - 100 entities, sparse deps`: 20.6 ms
    - `Scheduler - deep chain (50 levels)`: 20.6 ms
    - `Scheduler - diamond pattern (10 diamonds)`: 14.6 ms
    - `Scheduler - repeated dirty marking`: 13.1 ms
    - `Scheduler - subscribe/unsubscribe cycle (100x)`: 5.8 ms
    - `Scheduler - pull with resubscribe (50 pulls)`: 276.1 ms
    - `Overhead - setup/teardown only`: 4.0 ms
    - `Overhead - create 100 cells (getCell + set)`: 16.8 ms
    - `Overhead - 100x getCell only (no set)`: 3.8 ms
    - `Overhead - 100x set on existing cells`: 16.6 ms
    - `Overhead - runtime.idle() empty`: 3.9 ms
    - `Overhead - commit after 100 sets`: 16.7 ms
    - `Overhead - empty commit`: 3.8 ms
    - `Overhead - 100 raw tx.write + commit`: 8.5 ms
    - `Utility - sortAndCompactPaths (100 paths)`: 21.9 us
    - `Utility - sortAndCompactPaths (1000 paths)`: 285.7 us
    - `Utility - addressesToPathByEntity (100 paths)`: 12.0 us
    - `Utility - addressesToPathByEntity (1000 paths)`: 125.9 us
    - `Scheduler - bare subscribe (100x)`: 3.6 ms
    - `Scheduler - subscribe 100 actions reading same entity`: 3.8 ms
    - `Scheduler - resubscribe cycle (100x)`: 4.1 ms
  - `test/scheduler-demand-roots.bench.ts`:
    - `Scheduler demand roots - effect demand root`: 145.5 ms
    - `Scheduler demand roots - event demand root`: 127.4 ms
    - `Scheduler demand roots - mixed effect and event roots`: 171.8 ms
    - `Scheduler demand roots - parent clears generated children`: 77.2 ms
  - `test/scheduler-stale-propagation.bench.ts`:
    - `Scheduler stale propagation - chain`: 94.8 ms
    - `Scheduler stale propagation - diamond`: 94.3 ms
    - `Scheduler stale propagation - wide fanout`: 238.7 ms
    - `Scheduler stale propagation - dynamic deps`: 71.0 ms
    - `Scheduler stale propagation - unchanged recompute`: 70.1 ms
  - `test/scheduler-event-preflight.bench.ts`:
    - `Scheduler event preflight - clean event over broad graph`: 282.2 ms
    - `Scheduler event preflight - event waits on transitive stale writer`:
      20.3 ms
    - `Scheduler event preflight - note-shaped 30x7 clean events`: 970.2 ms
    - `Scheduler event preflight - deep read-populated handler`: 592.0 ms
  - `test/scheduler-materializer-fanout.bench.ts`:
    - `Scheduler materializer fanout - broad side write with 100 readers`:
      25.2 ms
    - `Scheduler materializer fanout - broad side write with 1000 readers`:
      84.5 ms
    - `Scheduler materializer fanout - static declared write control`:
      11.5 ms
  - `test/scheduler-persistent-state.bench.ts`:
    - `Scheduler persistent state - clean rehydrate 100 actions`: 4.2 ms
    - `Scheduler persistent state - targeted dirty rehydrate 100 actions`:
      4.6 ms
    - `Scheduler persistent state - clean rehydrate 1000 actions`: 9.9 ms
    - `Scheduler persistent state - targeted dirty rehydrate 1000 actions`:
      9.4 ms
  - `test/scheduler-pull-seeds.bench.ts`:
    - `Scheduler pull - shared dirty dependency fanout (50 effects, 20 reschedules)`:
      78.1 ms
    - `Scheduler pull - shared dirty dependency fanout (200 effects, 10 reschedules)`:
      110.7 ms
    - `Scheduler pull - shared clean dependency collect (200 effects, 20 scans)`:
      85.8 ms
    - `Scheduler pull - shared dirty dependency collect (200 effects, 20 scans)`:
      85.0 ms
- `reload-rehydration.test.ts` rehydrate-miss counts: focused run passed;
  the test asserts `rehydrate/ok > 0` and
  `rehydrate/miss/no-snapshot = 0`.

## 01/step-1

- [x] 5e70065ac — remove push-mode usage from tests, helpers, and benches
- Deviations: STOP events below; applied reviewer-approved effect ports and
  event-reader duplicate-count adjustment.
- Recordings: authoritative pre-edit grep:

```text
$ cd packages/runner
$ grep -rn "enablePullMode\|disablePullMode\|isPullModeEnabled\|pullMode" test/
test/scheduler-pull.test.ts:44:    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);
test/scheduler-pull.test.ts:48:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:88:  it("should have unchanged behavior with pullMode = false", async () => {
test/scheduler-pull.test.ts:90:    runtime.scheduler.disablePullMode();
test/scheduler-pull.test.ts:91:    expect(runtime.scheduler.isPullModeEnabled()).toBe(false);
test/scheduler-pull.test.ts:140:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:141:    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);
test/scheduler-pull.test.ts:206:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:207:    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);
test/scheduler-pull.test.ts:250:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:251:    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);
test/scheduler-pull.test.ts:330:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:331:    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);
test/scheduler-pull.test.ts:430:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:431:    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);
test/scheduler-pull.test.ts:522:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:605:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:691:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:749:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:850:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:912:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:960:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1022:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1155:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1260:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1377:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1414:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1500:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1576:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1677:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1764:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:1864:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:2001:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:2096:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:2162:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:2239:    runtime.scheduler.enablePullMode();
test/scheduler-pull.test.ts:2240:    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);
test/scheduler-pull.test.ts:2242:    runtime.scheduler.disablePullMode();
test/scheduler-pull.test.ts:2243:    expect(runtime.scheduler.isPullModeEnabled()).toBe(false);
test/scheduler-timing.test.ts:99:    runtime.scheduler.enablePullMode();
test/scheduler-timing.test.ts:187:    runtime.scheduler.enablePullMode();
test/scheduler-timing.test.ts:382:    runtime.scheduler.enablePullMode();
test/scheduler-timing.test.ts:454:    runtime.scheduler.enablePullMode();
test/scheduler-timing.test.ts:667:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:248:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:316:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:355:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:406:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:466:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:516:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:555:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:609:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:704:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:761:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:815:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:882:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:948:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:1014:    runtime.scheduler.enablePullMode();
test/scheduler-effects.test.ts:1055:    runtime.scheduler.disablePullMode();
test/patterns-derive-return-pattern.test.ts:246:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:31:      { pullMode: "disabled" },
test/scheduler-convergence.test.ts:126:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:227:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:290:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:392:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:439:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:502:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:664:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:720:    runtime.scheduler.enablePullMode();
test/scheduler-convergence.test.ts:819:    runtime.scheduler.enablePullMode();
test/patterns-lift.test.ts:432:    runtime.scheduler.enablePullMode();
test/default-app-note-create.bench.ts:107:  pullMode: boolean,
test/default-app-note-create.bench.ts:110:  const env = createSchedulerBenchEnv(pullMode);
test/default-app-note-create.bench.ts:222:for (const pullMode of [true, false]) {
test/default-app-note-create.bench.ts:223:  const mode = pullMode ? "pull" : "push";
test/default-app-note-create.bench.ts:227:      pullMode,
test/oncommit-race.test.ts:29:    runtime.scheduler.disablePullMode();
test/scheduler-events.test.ts:56:      { pullMode: "disabled" },
test/scheduler-events.test.ts:285:    runtime.scheduler.enablePullMode();
test/scheduler-events.test.ts:431:    runtime.scheduler.enablePullMode();
test/scheduler-events.test.ts:482:    runtime.scheduler.enablePullMode();
test/scheduler-events.test.ts:556:    runtime.scheduler.enablePullMode();
test/scheduler.bench.ts:31:  runtime.scheduler.disablePullMode();
test/scheduler.bench.ts:500:    runtime.scheduler.enablePullMode();
test/navigate-handler.test.ts:13:  pullMode: boolean,
test/navigate-handler.test.ts:29:    if (pullMode) runtime.scheduler.enablePullMode();
test/navigate-handler.test.ts:30:    else runtime.scheduler.disablePullMode();
test/navigate-handler.test.ts:82:          pullMode,
test/navigate-handler.test.ts:105:for (const pullMode of [false, true]) {
test/navigate-handler.test.ts:106:  const mode = pullMode ? "pull" : "push";
test/navigate-handler.test.ts:111:      await runNavigateHandlerTest(pullMode, false);
test/navigate-handler.test.ts:118:      await runNavigateHandlerTest(pullMode, true);
test/scheduler-bench-helpers.ts:91:export function createSchedulerBenchEnv(pullMode = true): SchedulerBenchEnv {
test/scheduler-bench-helpers.ts:100:  if (pullMode) {
test/scheduler-bench-helpers.ts:101:    runtime.scheduler.enablePullMode();
test/scheduler-bench-helpers.ts:103:    runtime.scheduler.disablePullMode();
test/wish-mentionable-schema.bench.ts:85:  runtime.scheduler.enablePullMode();
test/scheduler-observations.test.ts:210:      pullMode: "enabled",
test/scheduler-observations.test.ts:258:      pullMode: "enabled",
test/scheduler-observations.test.ts:352:      pullMode: "enabled",
test/scheduler-observations.test.ts:396:      pullMode: "enabled",
test/scheduler-observations.test.ts:440:      pullMode: "enabled",
test/scheduler-observations.test.ts:466:      pullMode: "enabled",
test/scheduler-observations.test.ts:548:      pullMode: "enabled",
test/scheduler-observations.test.ts:633:      pullMode: "enabled",
test/scheduler-observations.test.ts:675:      pullMode: "enabled",
test/scheduler-observations.test.ts:742:      pullMode: "enabled",
test/scheduler-observations.test.ts:804:      pullMode: "enabled",
test/scheduler-observations.test.ts:910:      pullMode: "enabled",
test/scheduler-observations.test.ts:1007:      pullMode: "enabled",
test/scheduler-observations.test.ts:1168:      pullMode: "enabled",
test/scheduler-observations.test.ts:1299:      pullMode: "enabled",
test/scheduler-observations.test.ts:1379:      pullMode: "enabled",
test/scheduler-observations.test.ts:1457:      pullMode: "enabled",
test/scheduler-observations.test.ts:1534:      pullMode: "enabled",
test/scheduler-observations.test.ts:1600:      pullMode: "enabled",
test/scheduler-observations.test.ts:1645:      pullMode: "enabled",
test/scheduler-pull-handlers.test.ts:34:      { pullMode: "enabled" },
test/scheduler-pull-handlers.test.ts:173:        pullMode: "enabled",
test/scheduler-pull-handlers.test.ts:595:    runtime.scheduler.enablePullMode();
test/scheduler-pull-handlers.test.ts:689:    runtime.scheduler.enablePullMode();
test/scheduler-pull-handlers.test.ts:797:    runtime.scheduler.enablePullMode();
test/scheduler-pull-handlers.test.ts:859:    runtime.scheduler.enablePullMode();
test/scheduler-pull-handlers.test.ts:913:    runtime.scheduler.enablePullMode();
test/push-pull-patterns.bench.ts:342:function createEnv(pullMode: boolean): BenchEnv {
test/push-pull-patterns.bench.ts:351:  if (pullMode) runtime.scheduler.enablePullMode();
test/push-pull-patterns.bench.ts:352:  else runtime.scheduler.disablePullMode();
test/push-pull-patterns.bench.ts:805:    pullMode: boolean;
test/push-pull-patterns.bench.ts:812:  const env = createEnv(options.pullMode);
test/push-pull-patterns.bench.ts:841:    pullMode: boolean;
test/push-pull-patterns.bench.ts:848:  const env = createEnv(options.pullMode);
test/push-pull-patterns.bench.ts:883:    pullMode: boolean;
test/push-pull-patterns.bench.ts:890:  const env = createEnv(options.pullMode);
test/push-pull-patterns.bench.ts:941:for (const pullMode of [false, true]) {
test/push-pull-patterns.bench.ts:942:  const mode = pullMode ? "pull" : "push";
test/push-pull-patterns.bench.ts:946:    benchOptions("pattern-map-pull", !pullMode),
test/push-pull-patterns.bench.ts:949:        pullMode,
test/push-pull-patterns.bench.ts:959:    benchOptions("pattern-filter-pull", !pullMode),
test/push-pull-patterns.bench.ts:962:        pullMode,
test/push-pull-patterns.bench.ts:972:    benchOptions("pattern-flatmap-pull", !pullMode),
test/push-pull-patterns.bench.ts:975:        pullMode,
test/push-pull-patterns.bench.ts:985:    benchOptions("pattern-map-sink", !pullMode),
test/push-pull-patterns.bench.ts:988:        pullMode,
test/push-pull-patterns.bench.ts:998:    benchOptions("pattern-map-object-pull", !pullMode),
test/push-pull-patterns.bench.ts:1001:        pullMode,
test/push-pull-patterns.bench.ts:1011:    benchOptions("pattern-filter-object-pull", !pullMode),
test/push-pull-patterns.bench.ts:1014:        pullMode,
test/push-pull-patterns.bench.ts:1024:    benchOptions("pattern-flatmap-object-pull", !pullMode),
test/push-pull-patterns.bench.ts:1027:        pullMode,
test/push-pull-patterns.bench.ts:1037:    benchOptions("pattern-map-object-sink", !pullMode),
test/push-pull-patterns.bench.ts:1040:        pullMode,
test/push-pull-patterns.bench.ts:1050:    benchOptions("pattern-fanout-pull-sparse", !pullMode),
test/push-pull-patterns.bench.ts:1053:        pullMode,
test/push-pull-patterns.bench.ts:1063:    benchOptions("pattern-fanout-pull-wide", !pullMode),
test/push-pull-patterns.bench.ts:1066:        pullMode,
test/push-pull-patterns.bench.ts:1076:    benchOptions("pattern-fanout-sinks", !pullMode),
test/push-pull-patterns.bench.ts:1079:        pullMode,
test/push-pull-patterns.bench.ts:1089:    benchOptions("pattern-fanout-mixed", !pullMode),
test/push-pull-patterns.bench.ts:1092:        pullMode,
test/scheduler-pull-seeds.bench.ts:48:  runtime.scheduler.enablePullMode();
test/scheduler-pull-references.test.ts:30:      { pullMode: "enabled" },
test/scheduler-retries.test.ts:29:      { pullMode: "disabled" },
test/scheduler-core.test.ts:61:      { pullMode: "disabled" },
test/scheduler-core.test.ts:281:    runtime.scheduler.enablePullMode();
test/scheduler-core.test.ts:373:    runtime.scheduler.enablePullMode();
test/scheduler-core.test.ts:452:    runtime.scheduler.enablePullMode();
test/patterns-handlers.test.ts:211:    runtime.scheduler.enablePullMode();
test/scheduler-throttle.test.ts:188:    runtime.scheduler.enablePullMode();
test/scheduler-throttle.test.ts:244:    runtime.scheduler.enablePullMode();
test/scheduler-throttle.test.ts:310:    runtime.scheduler.enablePullMode();
test/cell-callbacks.test.ts:1353:      runtime.scheduler.enablePullMode();
test/cell-callbacks.test.ts:1374:      runtime.scheduler.disablePullMode();
test/cell-callbacks.test.ts:1414:      runtime.scheduler.enablePullMode();
test/cell-callbacks.test.ts:1486:      runtime.scheduler.disablePullMode();
test/scheduler-test-utils.ts:58:    pullMode?: SchedulerPullMode;
test/scheduler-test-utils.ts:75:  if (options.pullMode === "enabled") {
test/scheduler-test-utils.ts:76:    runtime.scheduler.enablePullMode();
test/scheduler-test-utils.ts:77:  } else if (options.pullMode === "disabled") {
test/scheduler-test-utils.ts:78:    runtime.scheduler.disablePullMode();
test/memory-v2-pull-reactivity.test.ts:78:    runtime.scheduler.enablePullMode();
test/memory-v2-pull-reactivity.test.ts:142:    runtime.scheduler.enablePullMode();
test/scheduler-pull-array.test.ts:43:      { pullMode: "enabled" },
test/scheduler-pull-array.test.ts:90:    runtime.scheduler.enablePullMode();
test/storage.bench.ts:36:  runtime.scheduler.disablePullMode();
test/wish-shared-hashtag.test.ts:72:    runtime.scheduler.enablePullMode();
test/wish-shared-hashtag.test.ts:151:    runtime.scheduler.enablePullMode();
test/scheduler-ordering.test.ts:408:    runtime.scheduler.enablePullMode();
test/scheduler-ordering.test.ts:446:    runtime.scheduler.enablePullMode();
test/scheduler-ordering.test.ts:495:    runtime.scheduler.enablePullMode();
test/scheduler-ordering.test.ts:561:      { pullMode: "disabled" },
```

- Step-1 edit verification:
  - `grep -rn "enablePullMode\|disablePullMode\|isPullModeEnabled\|pullMode" test/`:
    no matches.
  - `deno fmt <touched test/bench files>`: passed.
  - `deno check <touched test/bench files>`: passed after making the
    `push-pull-patterns.bench.ts` local `benchOptions` helper default its
    `baseline` argument.
  - `cd packages/runner && deno task test`: failed, STOP per work-order
    rule D for push-pinned tests that went red after the pin was removed.
    Summary: `583 passed (3053 steps)`, `3 failed (18 steps)`,
    `0 ignored (10 steps)`, `2m0s`.
- STOP event:
  - `test/scheduler-convergence.test.ts` / `cycle-aware convergence` failed
    under pull mode:
    - `should track action execution time`
    - `should accumulate action stats across multiple runs`
    - `should record stats even when action throws`
    - `should correctly calculate average time`
  - `test/scheduler-core.test.ts` / `scheduler` failed under pull mode:
    - `should run actions when cells change`
    - `records push-mode settle work-set size before actions mutate pending`
    - `normalizes non-Error action throws before error handlers`
    - `should remove actions`
    - `should run actions in topological order`
    - `should stop eventually when encountering infinite loops`
    - `should not loop on r/w changes on its own output`
    - `should not create dependencies when using getRaw with ignoreReadForScheduling`
    - `should react to stored CFC metadata updates read through verifier helpers`
    - `should react to direct reads of stored CFC metadata when the cfc field changes`
    - `should track read without load for scheduling and still trigger on writes`
    - `non-recursive read through link chain does not re-trigger on value update`
    - `cell.get on docA inside action does not add recursive scheduling deps for docC`
  - `test/scheduler-events.test.ts` / `event handling` failed under pull
    mode:
    - `should trigger recomputation of dependent cells`
  - Representative assertion shape from the failures: expected one action/run
    but observed zero (`Actual 0 / Expected 1`) after the push-mode pin was
    removed. No local fix was attempted; reviewer needs to decide delete vs
    port for these push-only semantics.

## REVIEWER VERDICT — 01/step-1 STOP (rule D.2 red tests)

Diagnosis confirmed by reading the tests: every red test subscribes a
BARE COMPUTATION (immediate/empty log, no `isEffect`) and expects it to
run unprompted — push-era semantics. Under pull these are dormant by
design (spec I2). The tests' subjects (stats, triggering, ordering, CFC
metadata reactivity, loop protection) are all mode-independent; the
registration style is what's outdated. Rulings:

1. DELETE exactly one test:
   `scheduler-core.test.ts` → "records push-mode settle work-set size
   before actions mutate pending" (push-named, asserts push settle-stats
   internals; no pull equivalent exists by construction).

2. PORT everything else by registering the observed action(s) as
   effects: add `{ isEffect: true }` to the `subscribe(...)` options
   (merge into the existing options object where one exists, e.g. the
   events test passes `{}` at scheduler-events.test.ts:716). For
   multi-action tests (topological order, infinite loop, self-output
   loop) mark ALL subscribed actions as effects. Run-count assertions
   should hold unchanged: push ran a subscribed action once at
   subscribe; a pull effect is also scheduled once at subscribe.

3. Two allowances, each requiring a PROGRESS.md note if used:
   - "should stop eventually when encountering infinite loops": if the
     terminal run-count differs under pull's cycle handling, adjust the
     numeric bound to the observed pull bound — the subject is "stops
     eventually", not the exact count.
   - If any ported test trips effect auto-debounce (only possible if an
     action averages >50ms over 3+ runs), set `noDebounce: true` in that
     subscription rather than restructuring the test.

4. Do NOT add demand via extra `sink()`/`pull()` plumbing where
   `isEffect: true` suffices — smallest faithful port wins.

5. No new code comments in the test files (G4); rationale lives here
   and in the commit message.

Then: finish step 1 (full suite green), commit per the step's message,
and continue the work order without further stops for this class — this
verdict covers all remaining D.2 reds of the same bare-subscribe shape.
If a red of a DIFFERENT shape appears, STOP as usual.

## IMPLEMENTER STOP — 01/step-1 reviewer verdict follow-up

Applied the verdict narrowly:

- Deleted exactly one test: `scheduler-core.test.ts` / "records push-mode
  settle work-set size before actions mutate pending".
- Added `{ isEffect: true }` to the listed bare-subscribe red tests in
  `scheduler-convergence.test.ts`, `scheduler-core.test.ts`, and
  `scheduler-events.test.ts`; for the multi-action core tests, all subscribed
  actions were marked as effects.
- `deno fmt packages/runner/test/scheduler-convergence.test.ts
  packages/runner/test/scheduler-core.test.ts
  packages/runner/test/scheduler-events.test.ts`: passed.
- `deno check packages/runner/test/scheduler-convergence.test.ts
  packages/runner/test/scheduler-core.test.ts
  packages/runner/test/scheduler-events.test.ts`: passed.

Focused rerun:

```bash
cd packages/runner
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git test/scheduler-events.test.ts
```

Result: `test/scheduler-events.test.ts` still fails in "should trigger
recomputation of dependent cells", but now in the opposite direction from the
original push-pin failure. The reviewer verdict said run-count assertions
should hold unchanged; they do not for this event/effect path.

Current failure excerpt:

```text
event handling ... should trigger recomputation of dependent cells ... FAILED

error: AssertionError: Values are not strictly equal.

    [Diff] Actual / Expected

-   3
+   2

at test/scheduler-events.test.ts:732:25

FAILED | 0 passed (13 steps) | 1 failed (1 step) (303ms)
```

No assertion adjustment was kept because that was not one of the reviewer
allowances. Current tree reflects the approved edit shape for this test:
`runtime.scheduler.subscribe(..., { isEffect: true })` and the original
`await eventResultCell.pull()` waits remain.

## REVIEWER VERDICT — 01/step-1 follow-up STOP (events count 3 vs 2)

Correct stop; the deviation is real and DIAGNOSED, not noise. Root
cause, verified in code: pull mode double-schedules event-reader
effects — the synchronous commit notification schedules the effect once
(run happens), then the commit promise's ack callback fires
`onEventCommitWrites` (`events.ts:516-518`) → `markReadersDirtyForChangedWrites`
→ schedules the same effect AGAIN (second run). Push mode gated this
second channel off, which is why the push pin hid it. This is exactly
the duplicate propagation channel documented in the spec (inventory §4,
channel #2) and deleted in phase 3c.ii — this test just became its
empirical witness.

Ruling:

1. Adjust THIS test's `actionCount` assertions to the observed
   pull-mode values: expected 3 after the first event and 5 after the
   second (1 initial + 2 per event). Run the file to confirm those are
   stable before committing; if observed values differ from 3/5, STOP
   again with the numbers.
2. G4 exception granted — add exactly this comment above the first
   adjusted assertion:

   // Pull mode currently runs event-reader effects twice per event
   // commit: once from the synchronous commit notification and once
   // from the post-ack onEventCommitWrites path (scheduler-v2
   // inventory §4, channel #2). These counts drop back to 2/3 when
   // phase 3c.ii deletes the duplicate channel — tighten them then.

3. `lastEventSeen` and `eventCount` assertions stay as-is.
4. This closes the step-1 reds. Finish step 1 (full suite green),
   commit, continue the work order. Same-shape +1-per-event count
   adjustments in OTHER event-reader tests, if any appear, are covered
   by this verdict (same comment, PROGRESS note); anything else stops.

## IMPLEMENTER RESOLUTION — 01/step-1 final

Applied the follow-up verdict:

- `scheduler-events.test.ts` / "should trigger recomputation of dependent
  cells" now expects `actionCount` 3 after the first event and 5 after the
  second, with the reviewer-approved comment.
- Focused event-file rerun passed:
  `ENV=test deno test --allow-ffi --allow-env --allow-read
  --allow-write=/tmp,/var/folders --allow-run=git
  test/scheduler-events.test.ts` → `1 passed (14 steps)`, `0 failed`,
  `309ms`.
- Full runner suite passed:
  `cd packages/runner && deno task test` → `586 passed (3070 steps)`,
  `0 failed`, `0 ignored (10 steps)`, `2m4s`.
- Step exit grep passed:
  `grep -rn "enablePullMode\|disablePullMode\|isPullModeEnabled\|pullMode"
  test/` → no matches.

## IMPLEMENTER STOP — 01/steps-2-3 instruction conflict

Started the sanctioned combined steps 2+3 and collapsed `scheduler.ts` mode
branches to the pull path. Before deleting the push modules or committing,
the Step 3 grep contract conflicts with Step 3.17:

- Step 3.17 explicitly says `createGraphSnapshotState()` should use the
  literal `pullMode: true` property, and not remove `pullMode` from the graph
  snapshot telemetry shape.
- The Step 3 grep contract says:
  `grep -n "pullMode\|PushScheduler\|push-" src/scheduler.ts`
  expected no matches.

Current grep output:

```text
$ grep -n "pullMode\|PushScheduler\|push-" packages/runner/src/scheduler.ts
2275:      pullMode: true,
```

No workaround was attempted. The remaining match is the exact property Step
3.17 requires. Push modules have not been deleted yet in this working tree.

## REVIEWER VERDICT — 01/steps-2-3 grep-contract conflict

Correct stop; the work order contradicts itself and the GREP CONTRACT is
the wrong side. Step 3.17 (keep the snapshot's `pullMode: true` literal
and the telemetry type field) stands — the field is a frozen reporting
surface for external snapshot consumers; removing it is out of phase-0
scope. Precedence rule from here on: a reviewer verdict in this file
overrides conflicting work-order text.

Corrected contracts:

1. Step-3 grep: `grep -n "pullMode\|PushScheduler\|push-" src/scheduler.ts`
   → expected EXACTLY ONE match: the `pullMode: true` literal in
   `createGraphSnapshotState()` (your current output is already
   correct). Zero matches for `PushScheduler` and `push-` once the push
   modules are deleted.
2. Exit-checklist grep: `grep -rn "pullMode\|enablePullMode\|disablePullMode\|isPullModeEnabled" src/ test/`
   → expected residual matches are ONLY the frozen snapshot field:
   - `src/scheduler.ts`: the `pullMode: true` literal;
   - `src/scheduler/graph-snapshot.ts`: the state-interface member and
     its read in the snapshot builder;
   - `src/telemetry.ts`: the `SchedulerGraphSnapshot` type's `pullMode`
     field (and doc comments on those lines).
   `enablePullMode` / `disablePullMode` / `isPullModeEnabled` /
   `PushScheduler` / `push-` must be zero everywhere. Anything else:
   STOP.
3. Amend the work order in YOUR branch so the text matches this ruling —
   edit `docs/specs/scheduler-v2/implementation/01-phase0-remove-push-mode.md`
   (the step-3 grep contract and the exit checklist) as its own commit
   BEFORE the steps-2+3 commit, message:
   `docs(specs): scheduler-v2 WO01 — graph-snapshot pullMode survives phase 0`
4. Then proceed: delete the push modules, finish steps 2+3 as one commit
   per the sanctioned merge, and continue the work order.

Implementer resolution: updated the work order's Step 3 grep contract and exit
checklist to preserve the frozen graph-snapshot `pullMode` field as the only
residual mode term.

## IMPLEMENTER STOP — 01/steps-2-3 verification blocked by step-4 callers

Applied the corrected Step 3 contract and deleted the five Step 2 push modules.
The corrected Step 3 grep is satisfied:

```text
$ grep -n "pullMode\|PushScheduler\|push-" packages/runner/src/scheduler.ts
2275:      pullMode: true,
```

`ls packages/runner/src/scheduler/ | grep push` is empty.

However, the required Step 3 verification command fails because removing
`Scheduler.isPullModeEnabled()` exposes the Step 4 runner call sites before
Step 4 is allowed to run:

```text
$ deno check packages/runner/src/scheduler.ts
Check packages/runner/src/scheduler.ts
TS2339 [ERROR]: Property 'isPullModeEnabled' does not exist on type 'Scheduler'.
    if (!this.runtime.scheduler.isPullModeEnabled()) {
                                ~~~~~~~~~~~~~~~~~
    at file:///.../packages/runner/src/runner.ts:2589:33

TS2339 [ERROR]: Property 'isPullModeEnabled' does not exist on type 'Scheduler'.
    if (!this.runtime.scheduler.isPullModeEnabled() || !pattern) {
                                ~~~~~~~~~~~~~~~~~
    at file:///.../packages/runner/src/runner.ts:2700:33

TS2339 [ERROR]: Property 'isPullModeEnabled' does not exist on type 'Scheduler'.
    if (!this.runtime.scheduler.isPullModeEnabled()) {
                                ~~~~~~~~~~~~~~~~~
    at file:///.../packages/runner/src/runner.ts:2715:33

TS2339 [ERROR]: Property 'isPullModeEnabled' does not exist on type 'Scheduler'.
    if (!this.runtime.scheduler.isPullModeEnabled()) {
                                ~~~~~~~~~~~~~~~~~
    at file:///.../packages/runner/src/runner.ts:2728:33
```

Confirmed grep:

```text
$ grep -rn "isPullModeEnabled" packages/runner/src packages/runner/test --include="*.ts"
packages/runner/src/runner.ts:2589:    if (!this.runtime.scheduler.isPullModeEnabled()) {
packages/runner/src/runner.ts:2700:    if (!this.runtime.scheduler.isPullModeEnabled() || !pattern) {
packages/runner/src/runner.ts:2715:    if (!this.runtime.scheduler.isPullModeEnabled()) {
packages/runner/src/runner.ts:2728:    if (!this.runtime.scheduler.isPullModeEnabled()) {
```

These are exactly the Step 4 sites, but Step 3 requires a green
`deno check src/scheduler.ts` before the Step 2+3 commit. No Step 4 edits were
made and no workaround shim was added.

## REVIEWER VERDICT — 01/steps-2-3 compile coupling with step-4 call sites

Correct stop; another work-order sequencing flaw. Deleting the public
mode API from `scheduler.ts` breaks `runner.ts` compilation, so the
step-2/3 verification can never pass without the step-4 call-site
edits — they are one atomic compile unit. The sanctioned merge widens:

1. Fold INTO the steps-2+3 commit exactly the four `runner.ts`
   call-site edits from step 4 (your grep's four sites), applied as
   step 4 already specifies them:
   - `handleJavaScriptHandlerResult` (~2589): delete the entire
     `if (!isPullModeEnabled()) { ... }` push branch, keeping only
     `addCancel(() => this.stop(resultCell));` (the lost
     on-commit-error cleanup note in the work order still applies — no
     substitute here, it comes in work order 03).
   - `patternNeedsOneShotPull` (~2700): condition becomes
     `if (!pattern)`.
   - `pullCellOnceAfterSuccessfulCommit` (~2715) and
     `pullCellOnceInPullMode` (~2728): delete each guard, keep bodies.
   No other `runner.ts` changes in this commit.
2. Verification for the merged commit: `deno check src/scheduler.ts
   src/runner.ts`, then the FULL runner suite, then the corrected
   step-3 grep (one `pullMode: true` match) and
   `ls src/scheduler | grep push` empty.
3. Commit message stays the steps-2+3 one:
   `refactor(runner): remove push scheduler mode and pullMode branches (scheduler-v2 phase 0)`.
4. Step 4's REMAINING scope (its own commit, original message): the
   `scheduler.mode.change` telemetry type removal, the repo-wide
   `isPullModeEnabled` grep (now expected zero everywhere), and the
   cross-package `mode.change` grep.
5. As before, amend the work order in your branch to record the wider
   merge — own docs commit before the code commit, message:
   `docs(specs): scheduler-v2 WO01 — steps 2-4 runner call sites are one compile unit`.
6. Then continue (step 4 remainder, step 5 docs, exit checklist with
   the corrected residual-match list).

Implementer resolution: updated the work order to fold exactly the four
`src/runner.ts` mode-API call-site edits into the steps 2+3 compile-unit
commit, leaving Step 4's own commit for `scheduler.mode.change` telemetry type
removal and repo-wide greps.

## IMPLEMENTER STOP — 01/steps-2-3 deleted push module imported by test

Applied the widened compile-unit edits exactly:

- Removed the four `src/runner.ts` `isPullModeEnabled` call sites.
- `deno fmt packages/runner/src/scheduler.ts packages/runner/src/runner.ts`:
  passed.
- `grep -rn "isPullModeEnabled" packages/runner/src packages/runner/test --include="*.ts"`:
  no matches.
- Corrected Step 3 grep remains exactly the allowed snapshot match:
  `packages/runner/src/scheduler.ts:2275:      pullMode: true,`.
- `deno check src/scheduler.ts src/runner.ts` from `packages/runner`:
  passed.

The full runner suite then failed during type-check because
`test/scheduler-cfc-trigger-reads.test.ts` imports the deleted push module:

```text
$ cd packages/runner && deno task test
Task test ENV=test deno test --allow-ffi --allow-env --allow-read --allow-write=/tmp,/var/folders --allow-run=git test/*.test.ts
...
TS2307 [ERROR]: Cannot find module 'file:///.../packages/runner/src/scheduler/push-notifications.ts'.
    at file:///.../packages/runner/test/scheduler-cfc-trigger-reads.test.ts:11:48

error: Type checking failed.
```

Confirmed direct push-module references:

```text
$ grep -rn "scheduler/push-\|processPush\|PushScheduler\|push-notifications" packages/runner/src packages/runner/test --include="*.ts"
packages/runner/test/scheduler-cfc-trigger-reads.test.ts:11:import { processPushStorageNotification } from "../src/scheduler/push-notifications.ts";
packages/runner/test/scheduler-cfc-trigger-reads.test.ts:156:      ["push", processPushStorageNotification],
```

No test edit was attempted because `scheduler-cfc-trigger-reads.test.ts` was
not listed in the widened steps-2+3 scope.

## REVIEWER VERDICT — 01/steps-2-3 cfc-trigger-reads push arm

Correct stop. The file escaped the step-1 sweep because it imports the
push notification processor directly instead of using mode APIs — your
grep confirms it is the only such file. It is squarely phase-0 scope: a
push/pull parameterization of CFC trigger-read recording, and the push
arm is exactly the comparison class rule D.1 deletes. The pull arm is
real coverage and must survive unchanged.

1. Fold into the steps-2+3 compile-unit commit (same justification as
   the runner.ts sites — the suite cannot type-check without it) this
   single test-file edit:
   - delete the `processPushStorageNotification` import (line 11);
   - delete the `["push", processPushStorageNotification]` entry from
     the parameterization (line 156) and any assertions/branches that
     exist only for the push mode string;
   - smallest edit wins: keep the loop/parameterization structure even
     if it now has one entry; do not restructure the test.
2. Post-edit contract (add to the compile-unit verification):
   `grep -rn "scheduler/push-\|processPush\|PushScheduler" src/ test/`
   → zero matches.
3. Run the file alone first
   (`... deno test ... test/scheduler-cfc-trigger-reads.test.ts` — G3's
   known `--no-check` note applies to scheduler-events only, not here),
   then the full suite. The pull arm's assertions must pass UNCHANGED —
   if any pull-arm assertion goes red, STOP: that would be a real
   regression signal, not a porting question.
4. Amend the work order in-branch as before, own docs commit first:
   `docs(specs): scheduler-v2 WO01 — cfc-trigger-reads push arm is part of the compile unit`.
5. Then commit the compile unit and continue (step 4 remainder, step 5,
   exit checklist).

Implementer resolution: updated the work order to fold the
`scheduler-cfc-trigger-reads.test.ts` direct push-notification import and push
parameterization arm into the steps 2+3 compile-unit commit, with a focused
test run and direct push-module grep in that commit's verification.

## IMPLEMENTER RESOLUTION — 01/steps-2-3 final

- [x] 30ea32193 — remove push scheduler mode and pullMode branches
- Deviations: per reviewer verdicts, this single compile-unit commit includes
  the Step 2 push-module deletions, Step 3 `scheduler.ts` mode collapse, the
  four `src/runner.ts` mode-API call-site edits, and the
  `scheduler-cfc-trigger-reads.test.ts` direct push-notification arm removal.
- Recordings:
  - `deno fmt packages/runner/test/scheduler-cfc-trigger-reads.test.ts
    packages/runner/src/scheduler.ts packages/runner/src/runner.ts`: passed
    (`Checked 3 files`).
  - `ENV=test deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-cfc-trigger-reads.test.ts`: passed,
    `4 passed (8 steps)`, `0 failed`, `21ms`.
  - `deno check src/scheduler.ts src/runner.ts`: passed.
  - `cd packages/runner && deno task test`: passed,
    `586 passed (3067 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m2s`.
  - Corrected Step 3 grep:
    `grep -n "pullMode\|PushScheduler\|push-" src/scheduler.ts` → exactly
    one allowed match:
    `2275:      pullMode: true,`.
  - `ls src/scheduler | grep push`: no matches.
  - `grep -rn "scheduler/push-\|processPush\|PushScheduler" src/ test/`: no
    matches.

## IMPLEMENTER STOP — 01/step-4 mode.change grep contract

Before editing `src/telemetry.ts`, ran the required Step 4 inventories.
`isPullModeEnabled` has no remaining callers:

```text
$ cd packages/runner
$ grep -rn "isPullModeEnabled" ../../packages --include="*.ts"
<no matches>
```

However, the Step 4 `mode.change` grep does not match the work order's
"type definition only" expectation:

```text
$ grep -rn "mode.change" ../../packages --include="*.ts"
../../packages/shell/src/lib/debugger-controller.ts:293:        //   latestMarker?.type === "scheduler.mode.change" ||
../../packages/runner/test/fetch-data-mutex.test.ts:386:  it("should handle mode changes (text vs json)", async () => {
../../packages/runner/src/telemetry.ts:231:  type: "scheduler.mode.change";
```

No Step 4 code edit was made. The shell match is a commented
`scheduler.mode.change` consumer outside Step 4's named file, and the
`fetch-data-mutex.test.ts` match is an unrelated false positive caused by the
unescaped `.` in the required grep pattern. Per G6, stopped for reviewer
direction instead of deleting or widening scope.

## REVIEWER VERDICT — 01/step-4 mode.change grep

Three rulings, then step 4 proceeds:

1. `src/telemetry.ts:231` — delete the `scheduler.mode.change` type
   member as step 4 already specifies.
2. `test/fetch-data-mutex.test.ts:386` — false positive from the
   unescaped dot in MY grep pattern ("mode changes (text vs json)").
   No edit. The contract grep is corrected to
   `grep -rn "scheduler\.mode\.change" ../../packages --include="*.ts"`.
3. `shell/src/lib/debugger-controller.ts:293` — G4 exception granted
   for exactly one line: delete the commented
   `//   latestMarker?.type === "scheduler.mode.change" ||` line from
   the dead auto-refresh block. It references a type that will no
   longer exist; the surrounding commented example stays coherent with
   the four remaining marker types. Do not touch anything else in the
   file. Include in the step-4 commit.

Corrected step-4 contract after edits: the escaped grep above → zero
matches repo-wide.

Then: amend the work order in-branch (escaped grep + the shell comment
in scope), own docs commit first —
`docs(specs): scheduler-v2 WO01 — escape the mode.change grep; shell stale comment in scope`
— then the step-4 commit (original message), step 5 docs touch-up, exit
checklist, and the 00-README phase-end protocol: push
`scheduler-v2/01-phase0`, open the stacked PR (base `main` — the spec
PR is merged), include the PROGRESS excerpt, and continue immediately
into work order 02 on `scheduler-v2/02-e0`.

Implementer resolution: updated the work order's Step 4 text to use the
escaped `scheduler\.mode\.change` grep and to include exactly the stale shell
comment line in the Step 4 code-commit scope.

## IMPLEMENTER RESOLUTION — 01/step-4 final

- [x] 2d9053c46 — drop push-mode branches from runner and telemetry
- Deviations: per reviewer verdict, the Step 4 code commit also deletes the
  single stale `scheduler.mode.change` commented line in
  `packages/shell/src/lib/debugger-controller.ts`.
- Recordings:
  - `grep -rn "isPullModeEnabled" ../../packages --include="*.ts"`: no
    matches.
  - `deno fmt packages/runner/src/telemetry.ts
    packages/shell/src/lib/debugger-controller.ts`: passed
    (`Checked 2 files`).
  - `deno check src/runner.ts src/telemetry.ts`: passed.
  - `deno check packages/shell/src/lib/debugger-controller.ts`: passed.
  - `grep -rn "scheduler\.mode\.change" ../../packages --include="*.ts"`: no
    matches.
  - Telemetry type import scan found no `packages/html` or `packages/ui`
    imports requiring additional package checks; only runner and shell telemetry
    uses matched.
  - `cd packages/runner && deno task test`: passed,
    `586 passed (3067 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m3s`.

## IMPLEMENTER RESOLUTION — 01/step-5 final

- [x] 46c31b308 — pull-based scheduler docs reflect push-mode removal
- Deviations: none.
- Recordings:
  - Updated the header sentence to state push mode has been removed and point
    forward-looking design readers at `docs/specs/scheduler-v2/`.
  - Deleted the "Mode Control" subsection under "Current Behavior Reference".
  - Deleted the mode-control API entries and the diagnostic
    `scheduler.isPullModeEnabled()` listing.
  - `grep -n "enablePullMode\|disablePullMode\|isPullModeEnabled"
    docs/specs/pull-based-scheduler/README.md`: no matches.
  - `grep -n "### Mode Control"
    docs/specs/pull-based-scheduler/README.md`: no matches.

## 01/phase-end self-check

- Full runner suite:
  `cd packages/runner && deno task test` → `586 passed (3067 steps)`,
  `0 failed`, `0 ignored (10 steps)`, `2m3s`.
- Exit checklist greps:
  - `ls src/scheduler/ | grep push`: no matches.
  - `grep -rn "pullMode\|enablePullMode\|disablePullMode\|isPullModeEnabled"
    src/ test/`: exactly the allowed frozen graph snapshot residuals:
    `src/scheduler.ts:2275`, `src/scheduler/graph-snapshot.ts:14`,
    `src/scheduler/graph-snapshot.ts:208`, `src/telemetry.ts:59`.
  - `grep -rn "enablePullMode\|disablePullMode\|isPullModeEnabled\|pullMode"
    test/scheduler-pull.test.ts`: no matches.
  - `grep -rn "schedulerRuntimeFingerprint" src/ test/` shows
    `schedulerRuntimeFingerprint("pull")` call sites and the unchanged
    implementation `return \`runner:scheduler:${mode}\`;`.
- Diff shape: `git diff --summary origin/main...HEAD` shows only the five
  deleted push scheduler modules; no added files or renames. Overall diff is
  delete-dominated.
- Benchmark smoke:
  `cd packages/runner && deno task bench` started successfully and completed
  multiple benchmark files (`cell-immutable.bench.ts`,
  `cell-read-path.bench.ts`, `cell-set-array-shape.bench.ts`,
  `cell-set-nested-array-docs.bench.ts`, `cell-set-shape.bench.ts`) before
  manual interruption during `cell-set.bench.ts` per the work-order allowance.

## REVIEWER RESOLUTION — PR #4087 process amendments

- [x] ecde3d4cb — lint added to G3 and WO01 gains the repo-wide mode-API exit
  grep.
- Deviations: none.
- Recordings:
  - `00-README.md`: G3 now requires `deno lint <touched files>`.
  - `01-phase0-remove-push-mode.md`: exit checklist now includes
    `git grep -n "enablePullMode\|disablePullMode\|isPullModeEnabled" -- ':!docs'`
    with expected zero matches.

## REVIEWER RESOLUTION — PR #4087 CI fix

- [x] pending — phase-0 leftovers outside the runner sweep
- Deviations: the new repo-wide mode-API closing contract also found the
  runtime-client `setPullMode` protocol surface. Removed it end-to-end because
  it was the same obsolete mode-control API and was required for the closing
  grep to reach zero.
- Recordings:
  - Runner inventory:

```text
$ grep -rn "internalVerifierRead\|schedulerRehydration\|handleJavaScriptHandlerResult" packages/runner/src/runner.ts
packages/runner/src/runner.ts:69:import { internalVerifierRead } from "./storage/reactivity-log.ts";
packages/runner/src/runner.ts:505:  schedulerRehydration: SchedulerRehydrationSubscriptionOptions;
packages/runner/src/runner.ts:1159:      const schedulerRehydration = options.rehydrateSchedulerFromStorage ===
packages/runner/src/runner.ts:1162:        : this.schedulerRehydrationOptions(
packages/runner/src/runner.ts:1177:            schedulerRehydration,
packages/runner/src/runner.ts:1743:  private schedulerRehydrationOptions(
packages/runner/src/runner.ts:1871:    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
packages/runner/src/runner.ts:1893:            schedulerRehydration,
packages/runner/src/runner.ts:1908:            schedulerRehydration,
packages/runner/src/runner.ts:1921:            schedulerRehydration,
packages/runner/src/runner.ts:1945:            schedulerRehydration,
packages/runner/src/runner.ts:2491:  private handleJavaScriptHandlerResult(
packages/runner/src/runner.ts:2499:    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
packages/runner/src/runner.ts:2830:      schedulerRehydration,
packages/runner/src/runner.ts:2940:            return this.handleJavaScriptHandlerResult(
packages/runner/src/runner.ts:2948:              schedulerRehydration,
packages/runner/src/runner.ts:3106:      schedulerRehydration,
packages/runner/src/runner.ts:3372:        ...schedulerRehydration,
packages/runner/src/runner.ts:3386:    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
packages/runner/src/runner.ts:3405:      schedulerRehydration,
packages/runner/src/runner.ts:3582:    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
packages/runner/src/runner.ts:3723:          ...(schedulerRehydration.rehydrateFromStorage?.awaitSync
packages/runner/src/runner.ts:3862:        ...schedulerRehydration,
packages/runner/src/runner.ts:3910:    schedulerRehydration: SchedulerRehydrationSubscriptionOptions = {},
packages/runner/src/runner.ts:4048:      awaitSyncBeforeInitialRun: schedulerRehydration.rehydrateFromStorage
```

  - CLI scheduler-mode inventory:

```text
$ grep -rn "schedulerMode\|scheduler-mode" packages/cli
packages/cli/lib/test-runner.ts:220:  schedulerMode?: "default" | "push" | "pull";
packages/cli/lib/test-runner.ts:884:  if (options.schedulerMode === "push") {
packages/cli/lib/test-runner.ts:886:  } else if (options.schedulerMode === "pull") {
packages/cli/commands/test.ts:7:const schedulerModes = ["default", "push", "pull"] as const;
packages/cli/commands/test.ts:62:    "--scheduler-mode <mode:string>",
packages/cli/commands/test.ts:139:    const schedulerMode = schedulerModes.find((mode) =>
packages/cli/commands/test.ts:140:      mode === options.schedulerMode
packages/cli/commands/test.ts:142:    if (!schedulerMode) {
packages/cli/commands/test.ts:144:        "Error: --scheduler-mode must be one of: default, push, pull",
packages/cli/commands/test.ts:157:      schedulerMode,
```

  - Runtime-client mode-control inventory from the repo-wide closing grep:

```text
$ grep -rn "SetPullMode\|setPullMode\|pullMode" packages/runtime-client --include="*.ts"
packages/runtime-client/backends/runtime-processor.ts:89:  type SetPullModeRequest,
packages/runtime-client/backends/runtime-processor.ts:911:  setPullMode(request: SetPullModeRequest): void {
packages/runtime-client/backends/runtime-processor.ts:912:    if (request.pullMode) {
packages/runtime-client/backends/runtime-processor.ts:1208:      case RequestType.SetPullMode:
packages/runtime-client/backends/runtime-processor.ts:1209:        return this.setPullMode(request);
packages/runtime-client/protocol/types.ts:55:  SetPullMode = "runtime:setPullMode",
packages/runtime-client/protocol/types.ts:255:export interface SetPullModeRequest extends BaseRequest {
packages/runtime-client/protocol/types.ts:256:  type: RequestType.SetPullMode;
packages/runtime-client/protocol/types.ts:257:  pullMode: boolean;
packages/runtime-client/protocol/types.ts:623:  | SetPullModeRequest
packages/runtime-client/protocol/types.ts:835:  [RequestType.SetPullMode]: {
packages/runtime-client/protocol/types.ts:836:    request: SetPullModeRequest;
packages/runtime-client/runtime-client.ts:319:  async setPullMode(pullMode: boolean): Promise<void> {
packages/runtime-client/runtime-client.ts:320:    await this.#conn.request<RequestType.SetPullMode>({
packages/runtime-client/runtime-client.ts:321:      type: RequestType.SetPullMode,
packages/runtime-client/runtime-client.ts:322:      pullMode,
```

  - `deno fmt packages/runner/src/runner.ts
    packages/piece/test/pull-materialization.test.ts
    packages/cli/lib/test-runner.ts packages/cli/commands/test.ts
    packages/runtime-client/backends/runtime-processor.ts
    packages/runtime-client/protocol/types.ts
    packages/runtime-client/runtime-client.ts`: passed (`Checked 7 files`).
  - `deno lint` on the same seven files: passed (`Checked 7 files`).
  - `deno check` on the same seven files: passed.
  - `grep -rn "schedulerMode\|scheduler-mode" packages/cli`: no matches.
  - `grep -rn "SetPullMode\|setPullMode\|pullMode" packages/runtime-client --include="*.ts"`:
    no matches.
  - `git grep -n "enablePullMode\|disablePullMode\|isPullModeEnabled" -- ':!docs'`:
    no matches.
  - `cd packages/piece && deno task test`: passed, `10 passed (46 steps)`,
    `0 failed`, `3s`.
  - `cd packages/cli && deno task test`: passed, `44 passed (195 steps)`,
    `0 failed`, `1 ignored`, `18s`.
  - `cd packages/runtime-client && deno task test`: passed,
    `15 passed (61 steps)`, `0 failed`, `628ms`.

## 02/step-1

- [x] 722bd082f — event-id minting helper
- Deviations: none.
- Recordings:
  - `deno fmt packages/runner/src/scheduler/event-identity.ts`: passed
    (`Checked 1 file`).
  - `deno check src/scheduler/event-identity.ts`: passed.

## IMPLEMENTER STOP — 02/step-2 transaction-field sequencing

Applied the Step 2 event-id threading edits through `QueuedEvent`,
`Scheduler.queueEvent`, `queueSchedulerEvent`, the event requeue sites, and
the `Cell.set` stream-send origin option. Formatting passed:

```text
$ deno fmt packages/runner/src/scheduler/types.ts \
  packages/runner/src/scheduler.ts \
  packages/runner/src/scheduler/events.ts packages/runner/src/cell.ts
Checked 4 files
```

The Step 2 instruction also says to set `tx.dispatchedEventId =
queuedEvent.id` in `dispatchQueuedEvent`, but the field is introduced only in
Step 3. The Step 2 compile check therefore fails before the Step 2 test file
can be added or the full suite can run:

```text
$ cd packages/runner
$ deno check src/scheduler.ts src/scheduler/events.ts src/scheduler/types.ts src/cell.ts
Check src/scheduler.ts
Check src/scheduler/events.ts
Check src/scheduler/types.ts
Check src/cell.ts
TS2339 [ERROR]: Property 'dispatchedEventId' does not exist on type 'IExtendedStorageTransaction'.
  tx.dispatchedEventId = queuedEvent.id;
     ~~~~~~~~~~~~~~~~~
    at file:///.../packages/runner/src/scheduler/events.ts:456:6

error: Type checking failed.
```

No Step 3 transaction-interface edit was pulled forward, and no workaround cast
was added.

## REVIEWER VERDICT — 02/step-2 field-before-declaration

Correct stop; work-order sequencing flaw (step 2 uses
`tx.dispatchedEventId`, step 3 declares it). Resolution: execute step 3
BEFORE step 2 — it is small and standalone. Order becomes 1 → 3 → 2 → 4.

1. Do step 3 now exactly as written (interface field on
   `IExtendedStorageTransaction` with its doc comment; plain optional
   property on any concrete class deno check requires), commit with
   step 3's message.
2. Then finish step 2 (your current tree) including its test file and
   full-suite verification, commit with step 2's message.
3. Amend the work order in-branch to note the execution reorder — own
   docs commit before the step-3 commit:
   `docs(specs): scheduler-v2 WO02 — step 3 precedes step 2 (field before use)`.
4. Continue with step 4.

Implementer resolution: updated work order 02 to record the execution
correction: Step 3 precedes Step 2 because Step 2 assigns the transaction field
that Step 3 declares.

## 02/step-3

- [x] e28a7782e — dispatchedEventId transaction field
- Deviations: executed before Step 2 per reviewer verdict; no concrete class
  property was required.
- Recordings:
  - `deno fmt packages/runner/src/storage/interface.ts`: passed
    (`Checked 1 file`).
  - `deno check src/storage/interface.ts
    src/storage/extended-storage-transaction.ts`: passed.

## 02/step-2

- [x] pending — thread event ids and origin tx through the event queue
- Deviations: executed after Step 3 per reviewer verdict. Caller sweep included
  non-test benchmark callers; none forwards events between schedulers.
- Recordings:
  - `deno fmt packages/runner/src/scheduler/types.ts
    packages/runner/src/scheduler.ts packages/runner/src/scheduler/events.ts
    packages/runner/src/cell.ts
    packages/runner/test/scheduler-event-identity.test.ts`: passed
    (`Checked 5 files`).
  - `deno check src/scheduler.ts src/scheduler/events.ts
    src/scheduler/types.ts src/cell.ts
    test/scheduler-event-identity.test.ts`: passed.
  - `ENV=test deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-identity.test.ts`: passed, `1 passed (4 steps)`,
    `0 failed`.
  - Caller sweep:

```text
$ cd packages/runner
$ grep -rn "queueEvent(" ../../packages --include="*.ts" | grep -v "\.test\.ts"
../../packages/runner/test/scheduler-demand-roots.bench.ts:197:          graph.env.runtime.scheduler.queueEvent(
../../packages/runner/test/scheduler-demand-roots.bench.ts:253:          graph.env.runtime.scheduler.queueEvent(
../../packages/runner/test/default-app-note-create.bench.ts:214:  env.runtime.scheduler.queueEvent(link, { kind: "create" });
../../packages/runner/test/default-app-note-create.bench.ts:216:    env.runtime.scheduler.queueEvent(link, { kind: "remove" });
../../packages/runner/test/scheduler-event-preflight.bench.ts:184:        graph.env.runtime.scheduler.queueEvent(
../../packages/runner/test/scheduler-event-preflight.bench.ts:212:        graph.env.runtime.scheduler.queueEvent(
../../packages/runner/test/scheduler-event-preflight.bench.ts:274:            graph.env.runtime.scheduler.queueEvent(
../../packages/runner/test/scheduler-event-preflight.bench.ts:406:        runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
../../packages/runner/src/scheduler.ts:944:  queueEvent(
../../packages/runner/src/scheduler.ts:2114:        this.queueEvent(
../../packages/runner/src/scheduler/events.ts:161:        state.queueEvent(
../../packages/runner/src/cell.ts:1167:      this.runtime.scheduler.queueEvent(
```

  - `cd packages/runner && deno task test`: passed,
    `587 passed (3071 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m3s`.

## REVIEWER VERDICT — PR #4087 CI failures (review feedback, stacked-PR protocol)

PR #4087's diff and exit contracts verified good (I re-ran the greps at
the PR head independently). CI surfaced four misses that were OUTSIDE
every sweep the work order ordered — two are work-order gaps, none are
judgment errors of yours. Handle per the stacked-PR protocol: finish
your current WO02 stop-7 sequence first (docs reorder commit, step-3
commit, step-2 commit — clean tree), THEN fix on
`scheduler-v2/01-phase0`, push, merge 01 forward into 02, continue.

Fixes on the 01 branch, one commit
(`fix(runner,cli,piece): phase-0 leftovers outside the runner sweep`):

1. `packages/runner/src/runner.ts` lint (the Check job): remove the
   now-unused `internalVerifierRead` import (line 69 — confirm single
   use first) and remove the now-unused `schedulerRehydration`
   PARAMETER from `handleJavaScriptHandlerResult`'s signature and its
   single call site (grep to confirm exactly one caller).
2. `packages/piece/test/pull-materialization.test.ts:138`: delete the
   `enablePullMode()` line (rule E no-op).
3. `packages/cli`: the cf test runner exposes a `schedulerMode` option
   whose "push" arm calls the deleted API (test-runner.ts:884-888).
   Remove the option END-TO-END: run the untruncated inventory
   `grep -rn "schedulerMode\|scheduler-mode" packages/cli` and delete
   the option type, the if/else branch, the CLI flag parsing/help, and
   any multi-user-runner passthrough it shows. Pull is the only
   behavior. STOP only if the inventory shows a use that is not mode
   selection.
4. Closing contract for the commit:
   `git grep -n "enablePullMode\|disablePullMode\|isPullModeEnabled" -- ':!docs'`
   → zero matches.

Verification for the commit: `deno lint` + `deno check` on every
touched file; run `packages/piece` tests and the cli test-runner's own
test task; runner suite unchanged (not required again). Push 01 —
PR #4087 reruns; Check / Test / runtime-client / Pattern-Reload /
Pattern-Integration should clear. Pattern Unit Tests 3/5+4/5 may still
fail: known PRE-EXISTING main breakage (profile-create.tsx :8000
connection refused) — record, do not chase.

Process amendments (docs commit on 01, before the fix commit):
- 00-README G3 gains `deno lint <touched files>` alongside fmt/check.
- WO01 exit checklist gains the repo-wide mode-API grep from item 4
  (scoped `':!docs'`).
Message: `docs(specs): scheduler-v2 — lint in G3; repo-wide mode-API exit grep`.

Then `git merge scheduler-v2/01-phase0` into `scheduler-v2/02-e0`
(merge, never rebase), push both, and continue WO02 step 4.

## 02/step-4

- [x] d7ac43b43 — permanent-rejection taxonomy; retry paths skip precondition
  failures
- Deviations: `deno check` exposed that `PushError` in
  `src/storage/interface.ts` also needed `IPreconditionFailedError`, because
  v2 storage `send()` returns `commitOperations(...)` whose error surface is
  `StorageTransactionRejected`. Added it in the same named file; no extra
  implementation file was touched.
- Recordings:
  - Initial `deno check src/storage/interface.ts src/storage/rejection.ts
    src/scheduler/events.ts src/scheduler/action-run.ts
    test/scheduler-rejection-taxonomy.test.ts`: failed with
    `Type 'IPreconditionFailedError' is not assignable to type 'PushError'`
    at `src/storage/v2.ts:1068:5`.
  - `deno fmt packages/runner/src/storage/interface.ts
    packages/runner/src/storage/rejection.ts
    packages/runner/src/scheduler/events.ts
    packages/runner/src/scheduler/action-run.ts
    packages/runner/test/scheduler-rejection-taxonomy.test.ts`: passed
    (`Checked 5 files`).
  - `deno lint` on the same five files: passed (`Checked 5 files`).
  - `deno check src/storage/interface.ts src/storage/rejection.ts
    src/scheduler/events.ts src/scheduler/action-run.ts
    test/scheduler-rejection-taxonomy.test.ts`: passed.
  - `ENV=test deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-rejection-taxonomy.test.ts`: passed,
    `1 passed (3 steps)`, `0 failed`.
  - `cd packages/runner && deno task test`: passed,
    `588 passed (3074 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m3s`.

## 02/phase-end self-check

- Full runner suite:
  `cd packages/runner && deno task test` → `588 passed (3074 steps)`,
  `0 failed`, `0 ignored (10 steps)`, `2m3s`.
- Benchmarks: work order 02 lists no phase-specific benchmarks; no benchmark
  command was run.
- Exit checklist greps and inspections:
  - `grep -rn "eventQueue\.push\|eventQueue\.unshift"
    packages/runner/src/scheduler/events.ts`:

```text
packages/runner/src/scheduler/events.ts:141:      state.eventQueue.push({
packages/runner/src/scheduler/events.ts:485:        state.eventQueue.unshift({
packages/runner/src/scheduler/events.ts:557:        state.eventQueue.unshift({
```

  - Code inspection of those three sites shows the push includes `id` and
    `originTx`, and both unshift requeues preserve `id: queuedEvent.id` and
    `originTx: queuedEvent.originTx`.
  - `grep -rn "isPermanentRejection" packages/runner/src --include="*.ts"`:

```text
packages/runner/src/scheduler/action-run.ts:11:import { isPermanentRejection } from "../storage/rejection.ts";
packages/runner/src/scheduler/action-run.ts:165:        retries < MAX_RETRIES_FOR_REACTIVE && !isPermanentRejection(error)
packages/runner/src/scheduler/events.ts:14:import { isPermanentRejection } from "../storage/rejection.ts";
packages/runner/src/scheduler/events.ts:550:        !isPermanentRejection(result.error)
packages/runner/src/scheduler/events.ts:578:            permanent: isPermanentRejection(result.error),
packages/runner/src/storage/rejection.ts:6:export function isPermanentRejection(
```

  - `git diff --name-only scheduler-v2/01-phase0...HEAD -- packages/memory`:
    no matches.
  - New test/helper files present:
    `packages/runner/test/scheduler-event-identity.test.ts`,
    `packages/runner/test/scheduler-rejection-taxonomy.test.ts`,
    `packages/runner/src/storage/rejection.ts`.

## 03/step-1

- [x] 72ad97869 — record per-space commit localSeq on source transactions
- Deviations: selected `test/memory-v2-transaction-commit-rejection.test.ts`
  as the storage transaction test from the work-order inventory.
- Recordings:
  - `deno fmt packages/runner/src/storage/commit-identity.ts
    packages/runner/src/storage/v2.ts`: passed (`Checked 2 files`).
  - `deno lint packages/runner/src/storage/commit-identity.ts
    packages/runner/src/storage/v2.ts`: passed (`Checked 2 files`).
  - `deno check src/storage/v2.ts`: passed.
  - `ENV=test deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-retries.test.ts`: passed, `1 passed (2 steps)`,
    `0 failed`.
  - `ENV=test deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders --allow-run=git
    test/memory-v2-transaction-commit-rejection.test.ts`: passed,
    `1 passed`, `0 failed`.

## 03/step-2

- [x] fa9711c19 — commit precondition plumbing behind `commitPreconditions`
  flag
- Deviations: updated the narrow memory/runtime flag tests because the new
  protocol flag makes their exact object assertions stale. Implemented the
  source-readable precondition metadata on the native v2 transaction as well as
  the extended wrapper, matching the existing scheduler-observation handoff
  path into `commitNative`.
- Recordings:
  - `grep -rn "ClientCommit" ../../packages/memory
    ../../packages/runner/src/storage --include="*.ts" |
    grep -i "interface\|type\|="` located `ClientCommit` in
    `packages/memory/v2.ts`.
  - `deno fmt packages/memory/v2.ts packages/memory/test/v2-test.ts
    packages/runner/src/runtime.ts packages/runner/src/storage/interface.ts
    packages/runner/src/storage/extended-storage-transaction.ts
    packages/runner/src/storage/v2-transaction.ts
    packages/runner/src/storage/v2.ts
    packages/runner/test/experimental-options.test.ts`: passed
    (`Checked 8 files`).
  - `deno lint` on the same eight files: passed (`Checked 8 files`).
  - `deno check` on the same eight files: passed.
  - `cd packages/memory && deno test test/v2-test.ts`: passed,
    `7 passed (13 steps)`, `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/experimental-options.test.ts`: passed, `1 passed (12 steps)`,
    `0 failed`.
  - `cd packages/runner && deno task test`: passed,
    `588 passed (3075 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m4s`.

## IMPLEMENTER STOP — 03/step-3 precondition error wire route

Step 3 requires a precondition rejection whose wire shape reaches the client as
`{ name: "PreconditionFailedError", precondition: "origin-committed",
message: ... }`, and explicitly says to STOP if the existing route normalizes
error names.

Findings:

- `packages/memory/v2/engine.ts` `applyCommitTransaction` has the same-session
  identity needed for the check: it computes `sessionKey =
  resolveCommitSessionKey(sessionId, principal)` before read validation.
- Existing stale-read conflict rejection throws `Engine.ConflictError` from
  `validateConfirmedReads` / `resolvePendingReads`.
- `packages/memory/v2/server.ts` `MemoryServer.transact` catches engine errors
  and normalizes names through `toError(...)`:
  `Engine.ConflictError` → `"ConflictError"`, `Engine.ProtocolError` →
  `"ProtocolError"`, all other errors → `"TransactionError"`.
- `packages/memory/v2.ts` `V2Error` currently has only `{ name, message }`.
  There is no `precondition` field on the wire error type.
- `packages/memory/v2/client.ts` `Client.request` reconstructs an `Error` from
  `response.error.message` and `response.error.name` only.

Therefore, adding an engine-side `PreconditionFailedError` now would reach the
runner as `TransactionError`, and its `precondition: "origin-committed"`
metadata would be dropped. No Step 3 implementation or test edits were applied.
Need reviewer direction: extend the v2 wire error surface and server/client
mapping for `PreconditionFailedError`, or encode the precondition failure
through an existing normalized route.

## REVIEWER VERDICT — 03/step-3 precondition error wire route

Excellent trace; the route is exactly the normalize-and-drop case the
step anticipated. Ruling: EXTEND THE WIRE SURFACE — the taxonomy is a
real new error class (E0's whole point, and E2 receipts need the same
route). Do NOT encode through ConflictError or TransactionError: name
is what `isPermanentRejection` keys on, and ConflictError means
retryable — overloading either poisons the taxonomy.

Concrete route, end to end:

1. Engine (`packages/memory/v2/engine.ts` or wherever
   `Engine.ConflictError` is defined — same module): add a sibling
   error class `PreconditionFailedError` with
   `name = "PreconditionFailedError"` and a
   `precondition: "origin-committed" | "receipt-exists"` field. Throw
   it from the `applyCommitTransaction` origin-committed check (using
   the `sessionKey` you located).
2. Server (`packages/memory/v2/server.ts` `toError`): add the branch
   mapping `Engine.PreconditionFailedError` →
   `{ name: "PreconditionFailedError", message, precondition }` —
   BEFORE the catch-all TransactionError arm.
3. Wire type (`packages/memory/v2.ts` `V2Error`): add optional
   `precondition?: string`. JSON-additive; old peers ignore it.
4. Client (`packages/memory/v2/client.ts` `Client.request`): when
   reconstructing the Error, copy `response.error.precondition` onto
   the object as a plain property when present. Name/message handling
   otherwise unchanged.
5. Runner: NO changes — `IPreconditionFailedError` and
   `isPermanentRejection` (name-keyed) already match this shape.
6. Compat: no flag gating on the ERROR path. Safety comes from the
   ATTACH side already being gated on the negotiated
   `commitPreconditions` flag — an old client never attaches
   preconditions, so it can never receive this error.
7. Tests: in `v2-commit-preconditions.test.ts`, assert the
   CLIENT-VISIBLE shape (name + precondition survive the full
   server→client round trip) if the harness runs through server+client;
   if the existing engine tests hit the engine directly, add one
   focused `toError` mapping test for the server instead, plus keep the
   engine-level assertions.
8. Amend WO03 step 3 in-branch with this route — own docs commit first:
   `docs(specs): scheduler-v2 WO03 — precondition error wire route`.

Then continue step 3 as written.

## REVIEWER RESOLUTION — 03/step-3 precondition error wire route docs

- [x] 5f180b852 — documented the reviewer-approved
  `PreconditionFailedError` wire route in WO03 Step 3 before implementation.
- Deviations: none.

## 03/step-3

- [x] 8406bda91 — origin-committed commit precondition
- Deviations: implemented the reviewer verdict by adding the
  `PreconditionFailedError` route through the memory server/client wire path;
  no runner changes were needed. The new test file uses the memory
  server/client path, so its direct test run needs the same env/read/write/ffi
  permissions as other server-backed memory tests.
- Recordings:
  - `deno fmt packages/memory/v2/engine.ts packages/memory/v2/server.ts
    packages/memory/v2/client.ts packages/memory/v2.ts
    packages/memory/test/v2-commit-preconditions.test.ts`: passed
    (`Checked 5 files`).
  - `deno lint` on the same five files: passed (`Checked 5 files`).
  - `deno check` on the same five files: passed.
  - `cd packages/memory && deno test test/v2-commit-preconditions.test.ts`:
    failed before execution because importing the server/client path requires
    env access for `TSC_WATCHFILE`.
  - `cd packages/memory && deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders test/v2-commit-preconditions.test.ts`:
    passed, `4 passed`, `0 failed`, `26ms`.

## 03/step-4

- [x] 7891f157 — speculation lineage registry
- Deviations: none. Verified the work-order caveat in
  `extended-storage-transaction.ts`: `commit()` always attaches the storage
  commit promise to `runCommitCallbacks(result)`, including read-only/no-op
  commits that still call `this.tx.commit()`, and `rejectCommitBeforeStorage`
  also invokes `runCommitCallbacks(result)` for pre-storage CFC rejection.
- Recordings:
  - `deno fmt packages/runner/src/scheduler/lineage.ts
    packages/runner/test/scheduler-lineage.test.ts`: passed (`Checked 2
    files`).
  - `deno lint` on the same two files: passed (`Checked 2 files`).
  - `deno check packages/runner/src/scheduler/lineage.ts
    packages/runner/test/scheduler-lineage.test.ts`: passed.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-lineage.test.ts`: passed, `1 passed (6 steps)`,
    `0 failed`.

## 03/step-5

- [x] b443cef48 — lineage gating for handler-sent events
- Deviations: no shared conflict-forcing helper exists in
  `test/scheduler-retries.test.ts`; existing scheduler retry fixtures force
  aborts directly. For the same-space red fixture, patched the emulated memory
  server's next `transact()` after setup to return `ConflictError`, which
  rejects after the client has built the origin commit/localSeq. The event
  fixture calls `scheduler.queueEvent(..., { originTx })` at the same scheduler
  boundary used by stream `Cell.set()` so the test stays focused on lineage
  behavior. The handler-result piece-stop assertion is left for 03/step-6,
  where the work order wires `runner.ts`.
- Red-first recordings:
  - Initial `cd packages/runner && ENV=test deno test --allow-ffi
    --allow-env --allow-read --allow-write=/tmp,/var/folders
    --allow-run=git test/scheduler-event-lineage.test.ts`: failed as
    expected:
    - same-space retry expected one committed descendant, actual `2`;
    - permanent origin failure expected `[]`, actual two committed
      descendants;
    - both cross-space tests expected `idle()` to remain `pending`, actual
      `resolved`.
- Recordings:
  - `deno fmt packages/runner/src/scheduler.ts
    packages/runner/src/scheduler/events.ts
    packages/runner/src/scheduler/pull-events.ts
    packages/runner/src/scheduler/continuation.ts
    packages/runner/src/scheduler/pull-continuation.ts
    packages/runner/test/scheduler-event-lineage.test.ts
    packages/runner/test/scheduler-event-identity.test.ts`: passed
    (`Checked 7 files`).
  - `deno lint` on the same seven files: passed (`Checked 7 files`).
  - `deno check` on the same seven files: passed.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-lineage.test.ts`: passed, `1 passed (4 steps)`,
    `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-identity.test.ts`: passed, `1 passed (4 steps)`,
    `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-events.test.ts`: passed, `1 passed (14 steps)`,
    `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-pull-handlers.test.ts`: passed, `1 passed (11 steps)`,
    `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-lineage.test.ts`: passed, `1 passed (6 steps)`,
    `0 failed`.

## IMPLEMENTER STOP — 03/step-6 full runner suite blocked by stale-origin lineage

Step 6's focused implementation was applied locally but NOT committed. The
piece-stop fixture was red/green as required:

- Red before implementation:
  `runtime.runner.cancels.size` expected the pre-send baseline `1`, actual
  `13`, after the handler exhausted retries.
- Green after adding the non-deferred `recordPieceStop(...)` hook and the two
  action-run WATCH comments:
  `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
  --allow-read --allow-write=/tmp,/var/folders --allow-run=git
  test/scheduler-event-lineage.test.ts` passed, `1 passed (5 steps)`,
  `0 failed`.
- File verification passed:
  `deno fmt`, `deno lint`, and `deno check` on
  `packages/runner/src/runner.ts`,
  `packages/runner/src/scheduler/action-run.ts`, and
  `packages/runner/test/scheduler-event-lineage.test.ts`.

Full runner suite then failed twice despite all visible tests passing:

```text
$ cd packages/runner && deno task test
ok | 586 passed (3063 steps) | 0 failed | 0 ignored (10 steps) (2m19s)
error: Promise resolution is still pending but the event loop has already resolved
```

Isolated failing tests:

```text
$ cd packages/runner && ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git test/llm-dialog-outbox.test.ts
running 1 test from ./test/llm-dialog-outbox.test.ts
llmDialog outbox mechanism ...
  enqueues llmDialog work behind the post-commit outbox ...
ok | 0 passed | 0 failed (5s)
error: Promise resolution is still pending but the event loop has already resolved

$ cd packages/runner && ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git test/llm-dialog.test.ts
running 1 test from ./test/llm-dialog.test.ts
llmDialog ...
  should support a multi-turn conversation via addMessage ...
ok | 0 passed | 0 failed (5s)
error: Promise resolution is still pending but the event loop has already resolved
```

The same isolated failures reproduce at Step 5's committed SHA `b443cef48`
in a detached comparison worktree, so this is not caused by the Step 6
`runner.ts` compensation hook.

Temporary diagnostics (reverted; not left in the worktree) showed the
`llm-dialog-outbox` test reaches `addMessage.send(...)`, and the scheduler
queue contains a head event with `originTx !== undefined` for the already
committed setup transaction. Inference: Step 5's
`queueSchedulerEvent -> recordLineageEvent` can create a fresh pending lineage
record after the origin transaction has already committed, so the commit
callback that would confirm/release the origin will never fire and the head
event parks forever.

Need reviewer direction: allow a follow-up/fixup touching
`packages/runner/src/scheduler/lineage.ts` (and likely a narrow regression
fixture) so already-settled origins are treated as confirmed/failed instead of
registered as pending, or provide a different ruling.

## REVIEWER VERDICT — 03/step-6 stale-origin lineage hang

Your inference is confirmed as the root cause, and it is a bug in MY
reference implementation: `recordFor()` assumes the origin is in flight.
An event sent with an ALREADY-SETTLED origin tx (normal for sends from
test/framework code whose cells are bound to committed transactions)
creates a record frozen at "pending" — `addCommitCallback` never fires
for settled transactions — so the head gate parks forever. An
already-settled successful origin is semantically NO speculation: it
must behave as confirmed on arrival.

Authorized fixup, on the 03 branch:

1. `src/scheduler/lineage.ts` — in `recordFor(origin)`, before creating
   the record, inspect `origin.status()`. Use the transaction's actual
   status vocabulary (read the `IStorageTransactionStatus` type and the
   existing `status().status === "ready"` checks for the open-state
   name):
   - settled successfully → create the record with status "confirmed"
     and DO NOT register a commit callback;
   - settled failed/aborted → status "failed", no callback (and no
     cancellation sweep — there is nothing speculative to cancel from a
     pre-settled failure; the head gate handles the queued event);
   - open/in-flight → register the callback exactly as today.
2. Head gate: the "failed origin at head" branch I marked unreachable
   is now reachable (failed-before-record origins are never removed by
   a callback). Replace the assert with: shift + drop the event +
   `release()` + log debug. A FAILED settled origin must not dispatch
   its event (I10).
3. Red-first regression fixtures:
   - unit (`scheduler-lineage.test.ts`): `recordFor` on a
     committed-settled tx → originStatus "confirmed", no callback
     registered; on an aborted tx → "failed".
   - integration (`scheduler-event-lineage.test.ts`): send to a stream
     via a cell bound to an ALREADY-COMMITTED tx → event dispatches,
     `idle()` resolves; same with an aborted tx → event dropped,
     `idle()` resolves. Paste the red (hang→timeout or assertion) for
     the committed case from the pre-fix tree.
   - the two llm-dialog tests are the integration witnesses: both must
     pass untouched.
4. Commit: `fix(runner): lineage treats already-settled origins as settled (scheduler-v2 E1)`
   — separate from the step-6 commit; land it FIRST, then re-run and
   commit step 6 as planned.
5. Amend WO03's reference code block + unit-test list in-branch to
   match — docs commit before the fix commit:
   `docs(specs): scheduler-v2 WO03 — settled-origin lineage records`.
6. Note for phase-end: this case also justifies a one-line addition to
   the step-4 "caveat to verify" — record in PROGRESS that
   `addCommitCallback` does NOT fire for already-settled transactions
   (you have now verified it empirically).

Your red/green discipline and the detached-worktree bisect were exactly
right; the step-6 runner.ts hook itself is approved as-is once the suite
is green on top of the fix.

## REVIEWER RESOLUTION — 03/step-6 stale-origin lineage docs

- [x] 024dfb38f — documented the reviewer-approved settled-origin lineage
  record behavior in WO03 before implementation.
- Deviations: none.

## REVIEWER RESOLUTION — 03/step-6 stale-origin lineage fix

- [x] e9a27d0a4 — lineage now initializes records from already-settled origin
  transaction status before registering commit callbacks.
- Deviations: none. Verified the missing caveat from 03/step-4 empirically:
  `addCommitCallback` does not fire retroactively for already-settled
  transactions, so record creation must inspect `origin.status()`.
- Red-first recordings:
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-lineage.test.ts`: failed as expected before the fix:
    already-committed origin actual `pending`, expected `confirmed`; already
    failed origin actual `pending`, expected `failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-lineage.test.ts`: failed as expected before the fix
    on the already-committed origin fixture:
    `error: Promise resolution is still pending but the event loop has already resolved`.
- Recordings:
  - `deno fmt packages/runner/src/scheduler/lineage.ts
    packages/runner/src/scheduler/pull-events.ts
    packages/runner/test/scheduler-lineage.test.ts
    packages/runner/test/scheduler-event-lineage.test.ts`: passed
    (`Checked 4 files`).
  - `deno lint` on the same four files: passed (`Checked 4 files`).
  - `deno check` on the same four files: passed.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-lineage.test.ts`: passed, `1 passed (8 steps)`,
    `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-lineage.test.ts`: passed, `1 passed (6 steps)`,
    `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/llm-dialog-outbox.test.ts`: passed, `1 passed (1 step)`,
    `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/llm-dialog.test.ts`: passed, `1 passed (17 steps)`, `0 failed`.

## 03/step-6

- [x] 7a50fba4b — handler-launched piece registrations are stopped when the
  launching handler transaction fails permanently.
- Deviations: restored the reviewer-approved Step 6 work after the
  settled-origin fixup; stash conflict resolution in
  `scheduler-event-lineage.test.ts` kept both settled-origin fixtures and the
  Step 6 piece-stop fixture.
- Red-first recordings:
  - Before the Step 6 hook, `runtime.runner.cancels.size` expected the pre-send
    baseline `1`, actual `13`, after the handler exhausted retries.
- Recordings:
  - `deno fmt packages/runner/src/runner.ts
    packages/runner/src/scheduler/action-run.ts
    packages/runner/test/scheduler-event-lineage.test.ts`: passed
    (`Checked 3 files`).
  - `deno lint` on the same three files: passed (`Checked 3 files`).
  - `deno check` on the same three files: passed.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-lineage.test.ts`: passed, `1 passed (7 steps)`,
    `0 failed`.
  - `cd packages/runner && deno task test`: passed,
    `590 passed (3090 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m4s`.

## 03/phase-end

- [x] 6ebfbff2d — WO03 exit checklist self-check complete.
- Benchmarks: none listed in WO03.
- Recordings:
  - `cd packages/runner && deno task test`: passed,
    `590 passed (3090 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m4s`.
  - `cd packages/memory && deno task test`: passed, `211 passed
    (95 steps)`, `0 failed`.
- Exit checklist:
  - All event-lineage fixtures green:
    `test/scheduler-event-lineage.test.ts` passed, `1 passed (7 steps)`,
    `0 failed`; duplication fixture red-first output is recorded under
    03/step-5.
  - Preconditions inspection passed: `dispatchQueuedEvent` attaches
    `origin-committed` only when `originLocalSeq !== undefined`, lineage
    status is `"pending"`, and
    `runtime.experimental.commitPreconditions === true`.
  - Cross-space park inspection passed: `pull-events.ts` only examines the
    head event, parks by returning before preflight, `idle()` waits on
    `hasPendingLineageHeadEvent()`, and `continuation.ts` documents that the
    wake source is the lineage commit callback rather than a timer.
  - Renderer/ingress events inspection passed: `queueSchedulerEvent` takes no
    lineage branch unless `args.originTx !== undefined`.
  - Engine tests green; flag PR for memory-owner review because WO03 touches
    `packages/memory`.
  - FIFO inspection passed: surviving events are appended with
    `eventQueue.push`, processing remains head-only, retry uses the existing
    `unshift` path for the same event id, and lineage failure only removes
    failed descendants or shifts a failed head without reordering survivors.

## REVIEWER RESOLUTION — PR #4090 review findings

- [x] pending — engine precondition reachability + lineage retry
  re-registration + fail-closed precondition plumbing.
- Findings addressed (Codex/cubic review on PR #4090), red-first fixtures
  recorded for each:
  1. Engine empty-commit guard rejected precondition-only commits
     (`operations: []` from a descendant with only no-op writes) before
     `validateCommitPreconditions` could run, and the observation-only
     fast paths returned before validation. Preconditions now make a
     commit non-empty and validate ahead of every commit shape; malformed
     entries surface as deterministic `ProtocolError`
     (`packages/memory/test/v2-commit-preconditions.test.ts`).
  2. Retry requeues (`RetryImmediately`, non-permanent commit failure)
     created fresh `QueuedEvent` objects the lineage registry never saw, so
     an origin failing while the retry was queued could not remove it and
     the post-settlement `originStatus()` fallback let it run. Requeues now
     re-record with the registry
     (`test/scheduler-event-lineage.test.ts` "keeps retried same-space
     follow-ups lineage-gated").
  3. `V2StorageTransaction.addCommitPrecondition` did not claim a write
     space, so a precondition-only transaction resolved ok without sending
     a commit; it now claims the space like `recordSqliteWrite`. Both
     transaction wrappers now throw instead of silently dropping
     preconditions on storage that cannot enforce them
     (`test/storage-commit-preconditions.test.ts`).
- Deviations: none.

## 04/step-1

- [x] 364e86ad4 — one handler per event link; replacement warns and the last
  registration wins.
- Deviations: used `scheduler-events.test.ts` because the file now type-checks
  cleanly; asserted the warn through `getLoggerCountsBreakdown`.
- Red-first recordings:
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-events.test.ts`: failed as expected before the fix:
    replacement fixture expected first handler count `0`, actual `1`.
- Recordings:
  - `deno fmt packages/runner/src/scheduler/events.ts
    packages/runner/test/scheduler-events.test.ts`: passed
    (`Checked 2 files`).
  - `deno lint` on the same two files: passed (`Checked 2 files`).
  - `deno check` on the same two files: passed.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-events.test.ts`: passed, `1 passed (15 steps)`,
    `0 failed`.
  - `cd packages/runner && deno task test`: passed,
    `590 passed (3091 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m5s`.

## 04/step-2

- [x] 729618409 — handler-frame causes derive from the durable event id, falling
  back to `crypto.randomUUID()` only for non-dispatch invocations.
- Deviations: none.
- Recordings:
  - No baked per-attempt-id failures observed.
  - `deno fmt packages/runner/src/runner.ts`: passed (`Checked 1 file`).
  - `deno lint packages/runner/src/runner.ts`: passed (`Checked 1 file`).
  - `deno check packages/runner/src/runner.ts`: passed.
  - `cd packages/runner && deno task test`: passed,
    `590 passed (3091 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m5s`.
  - `cd packages/patterns && deno task test`: passed; package test task is
    currently a stub (`No tests defined.`).

## 04/step-3

- [x] 1b0395f1b — memory v2 create-only `set` operations reject when the target
  entity head already exists.
- Deviations: added an extra deleted-head fixture because the engine `head`
  table is upserted by `delete`; tombstoned heads therefore count as existing
  under the same head-exists semantics used here.
- Red-first recordings:
  - `cd packages/memory && deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders test/v2-commit-preconditions.test.ts`:
    failed as expected before the engine check, `6 passed`, `2 failed`;
    duplicate create-only and deleted-head create-only fixtures both failed
    with `AssertionError: Expected function to throw.`
- Recordings:
  - `deno fmt packages/memory/v2.ts packages/memory/v2/engine.ts
    packages/memory/test/v2-commit-preconditions.test.ts`: passed
    (`Checked 3 files`).
  - `deno lint` on the same three files: passed (`Checked 3 files`).
  - `deno check` on the same three files: passed.
  - `cd packages/memory && deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders test/v2-commit-preconditions.test.ts`:
    passed, `8 passed`, `0 failed`.
  - `cd packages/memory && deno task test`: passed, `211 passed
    (95 steps)`, `0 failed`.

## 04/step-4

- [x] ee9b3c89e — every event handling result cell is marked as a create-only
  receipt when the commit-preconditions protocol flag is enabled.
- Deviations: none. Preserved existing cross-space handler-result
  materialization: launched result cells still live in the resolved result
  space; receipt-only no-launch handlers create `{}` in `processCell.space`.
- Recordings:
  - Constraint grep:

```text
$ grep -n "handleJavaScriptHandlerResult" packages/runner/src/runner.ts
2502:  private handleJavaScriptHandlerResult(
2981:            return this.handleJavaScriptHandlerResult(
```

  - `crypto.randomUUID()` fallback grep:

```text
$ rg -n "crypto\.randomUUID\(\)" packages/runner/src/runner.ts
2884:        $event: tx.dispatchedEventId ?? crypto.randomUUID(),
```

  - Receipt mark site grep:

```text
$ rg -n "markCreateOnly" packages/runner/src
packages/runner/src/runner.ts:1460:    markCreateOnlyResult: boolean = false,
packages/runner/src/runner.ts:1476:        if (markCreateOnlyResult) {
packages/runner/src/runner.ts:1477:          startTx.markCreateOnly?.(
packages/runner/src/runner.ts:1517:    markCreateOnlyResult = false,
packages/runner/src/runner.ts:1531:        if (markCreateOnlyResult) {
packages/runner/src/runner.ts:1532:          startTx.markCreateOnly?.(
packages/runner/src/runner.ts:2528:        tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
packages/runner/src/runner.ts:2611:      tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
packages/runner/src/runner.ts:2675:    markCreateOnlyResult = false,
packages/runner/src/runner.ts:2696:        markCreateOnlyResult,
packages/runner/src/storage/extended-storage-transaction.ts:563:  markCreateOnly(
packages/runner/src/storage/extended-storage-transaction.ts:566:    this.assertWritable("markCreateOnly");
packages/runner/src/storage/extended-storage-transaction.ts:573:    this.tx.markCreateOnly?.(link);
packages/runner/src/storage/extended-storage-transaction.ts:1109:  markCreateOnly(
packages/runner/src/storage/extended-storage-transaction.ts:1112:    this.wrapped.markCreateOnly?.(link);
packages/runner/src/storage/interface.ts:587:  markCreateOnly?(
packages/runner/src/storage/interface.ts:764:  markCreateOnly?(
packages/runner/src/storage/v2-transaction.ts:862:  markCreateOnly(
packages/runner/src/storage/v2-transaction.ts:865:    this.assertWritable("markCreateOnly()");
```

  - `deno fmt packages/runner/src/storage/interface.ts
    packages/runner/src/storage/extended-storage-transaction.ts
    packages/runner/src/storage/v2-transaction.ts
    packages/runner/src/storage/v2.ts packages/runner/src/runner.ts
    packages/runner/src/scheduler/events.ts packages/runner/src/telemetry.ts`:
    passed (`Checked 7 files`).
  - `deno lint` on the same seven files: passed (`Checked 7 files`).
  - `deno check` on the same seven files: passed.
  - `cd packages/runner && deno task test` with default
    `commitPreconditions` off: passed, `590 passed (3091 steps)`,
    `0 failed`, `0 ignored (10 steps)`, `2m5s`.
  - `cd packages/runner && deno task test` with a temporary
    `scheduler-test-utils.ts` default of `commitPreconditions: true`: passed,
    `590 passed (3091 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m5s`.
    The helper toggle was reverted before commit.

## MEMORY-OWNER REVIEW — PR #4090 engine changes: APPROVED + two E2 rulings

Engine review of the origin-committed precondition (acting memory
owner):

- APPROVED. Check placement is inside the engine's SQLite transaction,
  before read validation; `SELECT_PENDING_RESOLUTION` row-presence is
  valid committed-evidence because rejected commits throw BEFORE the
  commit-row insert (rolled back), and it is the exact statement/
  semantics pending-read resolution already trusts — the precondition
  inherits the session/localSeq continuity the system already depends
  on, so no new reconnect failure mode. ProtocolError on unknown kinds
  is the right strict posture. Client round-trip test shape verified.

Two rulings WO04 (E2) must apply — do not stop for these:

1. **Tombstones count as existing.** For the create-only receipt
   precondition, "head exists" includes DELETED/tombstoned heads: a
   receipt that was created and later deleted still witnesses that the
   event was handled (I11 is exactly-once EVER, not exactly-once-while-
   retained). Use the same head/delete-aware existence notion the
   set/delete conflict detection uses (`selectSetDeleteConflict`
   neighborhood), and add an engine test: create → delete → create-only
   commit for the same entity → `PreconditionFailedError`
   ("receipt-exists"). Retention/GC interplay is spec open question 2 —
   out of scope.
2. **Version the precondition capability.** The engine throws
   ProtocolError on unknown precondition kinds, so an E2 client sending
   `receipt-exists` to an E1-only server that advertises
   `commitPreconditions` would loop on a retryable error. In WO04:
   change the handshake flag to a LEVEL — servers advertise
   `commitPreconditions: 2` once receipt-exists ships (E1-only code
   advertises 1, or keep boolean=origin-committed-only); the client
   attaches `origin-committed` at level ≥1 and `receipt-exists` /
   `createOnly` ops at level ≥2. Since E1 has not deployed anywhere
   yet, you may instead simply ship E1+E2 with the boolean flag meaning
   BOTH — but then the E1 commit range must never be deployed alone:
   record whichever you implement; the level scheme is preferred.

## IMPLEMENTER STOP — 04/step-5 receipt fixtures expose runner receipt gap

Step 5 fixture work is uncommitted in
`packages/runner/test/scheduler-event-receipts.test.ts`. The focused fixture
currently demonstrates that the Step 4 runner implementation does not yet
enforce receipt exactly-once for handler frames with opaque refs or already
materialized launched results:

```text
$ cd packages/runner && ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  test/scheduler-event-receipts.test.ts
Check test/scheduler-event-receipts.test.ts
running 1 test from ./test/scheduler-event-receipts.test.ts
scheduler event receipts ...
  deduplicates redelivered events by create-only receipt ... FAILED
  deduplicates redelivered pattern launches by receipt ... FAILED
  retries transient conflicts with the same receipt id ... FAILED
  creates a receipt document for handlers that launch nothing ... ok
  allows redelivered events to commit twice while receipts are disabled ... FAILED
FAILED | 0 passed (1 step) | 1 failed (4 steps)
```

Key failure excerpts:

```text
deduplicates redelivered events by create-only receipt:
expected effectsTotal 1, actual 2

deduplicates redelivered pattern launches by receipt:
expected a scheduler.event.commit marker with permanentRejection
"receipt-exists", actual false
```

Inference: the no-props/no-launch receipt-only path is green because it writes
`{}` directly, but stateful handlers and duplicate pattern launches go through
the launching/materialization branch. In duplicate cases that branch can avoid a
fresh `set` on the existing result cell, so `markCreateOnly` has no matching
commit operation to tag and no `receipt-exists` precondition reaches memory.

Fixing this appears to require touching `packages/runner/src/runner.ts` or the
runner storage receipt-marking path to force a create-only receipt operation for
already-materialized result cells. Work order 04 step 5 names only
`test/scheduler-event-receipts.test.ts`, so per 00-README G4 I am stopping for
reviewer direction rather than widening the step.

Additional memory-owner rulings above are acknowledged: tombstones already
count as existing in 04/step-3, and the current implementation records the
transitional boolean `commitPreconditions` flag as E1+E2 together rather than
introducing a numeric level in this unmerged stack.

## REVIEWER RESOLUTION — 04/step-5 entity-absent docs amendment

- [x] 67a160c2c — documented the reviewer-approved replacement of op-level
  `createOnly` receipts with commit-level `entity-absent` preconditions.
- Deviations: none. Progress also backfills 04/step-4 to `ee9b3c89e`.

## REVIEWER + MEMORY-OWNER VERDICT — 04/step-5 receipt gap (design correction)

Your inference is right and the flaw is in MY step-4 design: tagging
`createOnly` on a SET OPERATION makes the witness disappear whenever the
duplicate handling's writes are elided as no-ops — and in the limit a
fully-elided transaction short-circuits client-side without reaching the
engine at all. The receipt must be a COMMIT-LEVEL precondition,
independent of operations. Authorized redesign (touches runner storage +
memory engine; G4 scope granted):

1. **New precondition kind** alongside origin-committed:
   `{ kind: "entity-absent", id, scope? }` — evaluated in
   `validateCommitPreconditions`, scope resolved exactly as head lookups
   resolve it; "exists" INCLUDES tombstoned heads (standing ruling — use
   the `selectSetDeleteConflict`-style delete-aware lookup); violation →
   `PreconditionFailedError("receipt-exists", ...)`.
2. **Drop the op-level `createOnly` flag** (revert that part of
   1b0395f1b's surface) — one mechanism, not two. Engine tests retarget
   to the precondition, keeping the tombstone case
   (create → delete → entity-absent commit → receipt-exists).
3. **Client plumbing** (`markCreateOnly` keeps its name/signature):
   marked entities emit an `entity-absent` precondition for their space
   in `commitOperations`, regardless of what operations survive
   elision.
4. **Kill the zero-op escape**: a transaction carrying preconditions
   must NOT take the no-op short-circuit — locate the early-return in
   `commitOperations` (the path that returns ok without calling the
   engine when no semantic ops exist) and exempt precondition-bearing
   commits. Engine side: accept ops-empty commits when
   `preconditions` is non-empty (mirror how observation-only commits
   relaxed the zero-op rule), writing the commit row for localSeq
   continuity. Engine test: precondition-only commit, both pass and
   receipt-exists outcomes.
5. **Fixture to add** (the corner that motivates 4): an IDEMPOTENT
   handler (all writes elided on redelivery) — duplicate delivery must
   still be rejected receipt-exists, not silently "succeed" locally.
6. Sequence: docs amendment to WO04 step 3/4 describing the
   entity-absent design
   (`docs(specs): scheduler-v2 WO04 — receipt is a commit-level entity-absent precondition`),
   then `feat(memory): entity-absent commit precondition replaces op-level createOnly`,
   then the runner plumbing commit, then step 5's fixtures (all green)
   as planned.

Flag acknowledgment ACCEPTED: transitional boolean = E1+E2 ship
together; constraint recorded — `commitPreconditions` stays default-off
until the 04 PR merges (already true; experimental flags default off).

Memory-owner note for the engine commit: keep the entity-absent lookup
inside the same transaction scope as the other validations, and reuse
the existing scope-key resolution helpers rather than re-deriving scope
semantics.

## REVIEWER RESOLUTION — 04/step-5 entity-absent memory engine

- [x] 83d0c2d22 — memory now uses commit-level `entity-absent` preconditions
  instead of op-level `createOnly`, including precondition-only commits.
- Deviations: widened the runner storage interface precondition type to the
  memory `CommitPrecondition` union in this commit so the workspace
  type-checks; runner emission logic remains for the next reviewer-requested
  commit.
- Recordings:
  - `deno fmt packages/memory/v2.ts packages/memory/v2/engine.ts
    packages/memory/test/v2-commit-preconditions.test.ts
    packages/runner/src/storage/interface.ts`: passed (`Checked 4 files`).
  - `deno lint` on the same four files: passed (`Checked 4 files`).
  - `deno check` on the same four files: passed.
  - `cd packages/memory && deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders test/v2-commit-preconditions.test.ts`:
    passed, `10 passed`, `0 failed`.
  - `cd packages/memory && deno task test`: passed, `211 passed
    (95 steps)`, `0 failed`.

## REVIEWER RESOLUTION — 04/step-5 entity-absent runner plumbing

- [x] c6e33b303 — runner storage now turns `markCreateOnly` into commit-level
  `entity-absent` preconditions independent of surviving operations.
- Deviations: includes memory server/client error mapping so
  `PreconditionFailedError("receipt-exists")` survives the remote storage
  round trip and reaches runner scheduling as a permanent rejection. Drops the
  op-level `createOnly` surface from runner native commit operations.
- Recordings:
  - `deno fmt packages/runner/src/storage/interface.ts
    packages/runner/src/storage/v2-transaction.ts
    packages/runner/src/storage/v2.ts packages/memory/v2/server.ts
    packages/memory/test/v2-commit-preconditions.test.ts
    packages/runner/test/scheduler-event-receipts.test.ts`: passed
    (`Checked 6 files`).
  - `deno lint` on the same six files: passed (`Checked 6 files`).
  - `deno check` on the same six files: passed.
  - `deno test --allow-ffi --allow-env --allow-read
    --allow-write=/tmp,/var/folders
    packages/memory/test/v2-commit-preconditions.test.ts`: passed,
    `11 passed`, `0 failed`.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-receipts.test.ts`: passed, `1 passed (6 steps)`,
    `0 failed`.

## 04/step-5

- [x] 5fdd5375a — receipt exactly-once fixtures cover redelivery, launches,
  transient retry, precondition-only idempotent redelivery, receipt-only
  handling, and flag-off transitional behavior.
- Deviations: includes the reviewer-requested idempotent handler fixture where
  duplicate delivery's semantic writes are elided, leaving the receipt
  precondition as the only surviving commit guard. Red output for the
  fixture-first cases is recorded above in the IMPLEMENTER STOP section.
- Recordings:
  - `deno fmt packages/runner/test/scheduler-event-receipts.test.ts`: passed
    (`Checked 1 file`).
  - `deno lint packages/runner/test/scheduler-event-receipts.test.ts`: passed
    (`Checked 1 file`).
  - `deno check packages/runner/test/scheduler-event-receipts.test.ts`: passed.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-event-receipts.test.ts`: passed, `1 passed (6 steps)`,
    `0 failed`.

## 04/phase-end self-check

- [x] a49811102 — work order 04 phase-end verification recorded.
- Deviations: work order 04 lists no phase-specific benchmarks beyond the
  full suites and exit-checklist greps. The flag-on runner pass used a
  temporary local edit to `packages/runner/test/scheduler-test-utils.ts` to
  default `commitPreconditions: true`; that edit was reverted before this
  record was written, and `git status --short` was clean.
- Recordings:
  - `cd packages/memory && deno task test`: passed, `211 passed
    (95 steps)`, `0 failed`.
  - `cd packages/runner && deno task test` with default
    `commitPreconditions` off: passed, `591 passed (3097 steps)`,
    `0 failed`, `0 ignored (10 steps)`, `2m5s`.
  - `cd packages/runner && deno task test` with a temporary
    `scheduler-test-utils.ts` default of `commitPreconditions: true`: passed,
    `591 passed (3097 steps)`, `0 failed`, `0 ignored (10 steps)`, `2m5s`.
    The helper toggle was reverted before recording.
  - `grep -n "handleJavaScriptHandlerResult" packages/runner/src/runner.ts`:

```text
2502:  private handleJavaScriptHandlerResult(
2981:            return this.handleJavaScriptHandlerResult(
```

  - `rg -n "crypto\.randomUUID\(\)" packages/runner/src/runner.ts`:

```text
2884:        $event: tx.dispatchedEventId ?? crypto.randomUUID(),
```

  - `rg -n "markCreateOnly" packages/runner/src`:

```text
packages/runner/src/runner.ts:1460:    markCreateOnlyResult: boolean = false,
packages/runner/src/runner.ts:1476:        if (markCreateOnlyResult) {
packages/runner/src/runner.ts:1477:          startTx.markCreateOnly?.(
packages/runner/src/runner.ts:1517:    markCreateOnlyResult = false,
packages/runner/src/runner.ts:1531:        if (markCreateOnlyResult) {
packages/runner/src/runner.ts:1532:          startTx.markCreateOnly?.(
packages/runner/src/runner.ts:2528:        tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
packages/runner/src/runner.ts:2611:      tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
packages/runner/src/runner.ts:2675:    markCreateOnlyResult = false,
packages/runner/src/runner.ts:2696:        markCreateOnlyResult,
packages/runner/src/storage/v2-transaction.ts:865:  markCreateOnly(
packages/runner/src/storage/v2-transaction.ts:868:    this.assertWritable("markCreateOnly()");
packages/runner/src/storage/extended-storage-transaction.ts:563:  markCreateOnly(
packages/runner/src/storage/extended-storage-transaction.ts:566:    this.assertWritable("markCreateOnly");
packages/runner/src/storage/extended-storage-transaction.ts:573:    this.tx.markCreateOnly?.(link);
packages/runner/src/storage/extended-storage-transaction.ts:1109:  markCreateOnly(
packages/runner/src/storage/extended-storage-transaction.ts:1112:    this.wrapped.markCreateOnly?.(link);
packages/runner/src/storage/interface.ts:587:  markCreateOnly?(
packages/runner/src/storage/interface.ts:764:  markCreateOnly?(
```

  - `rg -n "event-handler-replaced|Exactly one handler per event|event-lost-race|permanentRejection|isPermanentRejection|receipt-exists" packages/runner/src/scheduler/events.ts packages/runner/src/telemetry.ts packages/runner/src/storage/rejection.ts`:

```text
packages/runner/src/storage/rejection.ts:4: * for `receipt-exists` a retry would double-handle an event.
packages/runner/src/storage/rejection.ts:6:export function isPermanentRejection(
packages/runner/src/telemetry.ts:170:  permanentRejection?: "origin-committed" | "receipt-exists";
packages/runner/src/scheduler/events.ts:16:import { isPermanentRejection } from "../storage/rejection.ts";
packages/runner/src/scheduler/events.ts:162:      // Exactly one handler per event (spec scheduler-v2 decision 12).
packages/runner/src/scheduler/events.ts:210:    logger.warn("event-handler-replaced", () => [
packages/runner/src/scheduler/events.ts:594:      const permanentRejection =
packages/runner/src/scheduler/events.ts:595:        result.error && isPermanentRejection(result.error)
packages/runner/src/scheduler/events.ts:613:        ...(permanentRejection !== undefined ? { permanentRejection } : {}),
packages/runner/src/scheduler/events.ts:617:        !isPermanentRejection(result.error)
packages/runner/src/scheduler/events.ts:639:        if (permanentRejection === "receipt-exists") {
packages/runner/src/scheduler/events.ts:641:            "event-lost-race",
packages/runner/src/scheduler/events.ts:654:            permanent: isPermanentRejection(result.error),
```

  - `rg -n "entity-absent|PreconditionFailedError|receipt-exists" packages/memory/v2.ts packages/memory/v2/engine.ts packages/memory/v2/server.ts packages/runner/src/storage/interface.ts packages/runner/src/storage/v2-transaction.ts packages/runner/src/storage/v2.ts`: entity-absent precondition type, engine validation,
    memory server typed-error mapping, runner native precondition emission, and
    runner permanent rejection mapping all present.
  - `rg -n "createOnly" packages/memory packages/runner/src packages/runner/test/scheduler-event-receipts.test.ts`: no op-level
    `createOnly` operation surface remains; remaining matches are
    `markCreateOnly` API/helper names and local mark maps.

## REVIEWER RESOLUTION — PR #4096 review findings

- [x] pending — deferred-navigate receipt placement + rejection-normalization
  hardening.
- Findings addressed (Codex/cubic review on PR #4096), red-first where
  applicable:
  1. `setupDeferredHandlerResultPattern` created the result-cell head in the
     handler transaction (`setupInternal`) but the create-only receipt mark
     rode the deferred start transaction — the first delivery's deferred
     start saw an existing head and died as `receipt-exists`, while
     redeliveries went unguarded. The mark now rides the handler transaction
     that performs the create; `startAfterSuccessfulCommit` loses its unused
     `markCreateOnlyResult` parameter
     (`test/scheduler-event-receipts.test.ts` "navigateTo handler results
     navigate once and deduplicate redelivery", red-first: first delivery
     never navigated).
  2. `toRejectedError` accessed `.precondition` without optional chaining;
     a primitive/null rejection would throw while normalizing a commit
     failure and mask the real error.
- Rebase note: main now validates preconditions ahead of every commit shape
  (#4090 resolution); the entity-absent precondition made re-validation on
  commit replays unsafe, so the generic same-session replay check is hoisted
  ABOVE precondition validation (still before the observation fast paths,
  which keep their own replay table and never hit the generic check).
- Deviations: none.

## 05/step-0

- [x] no commit — phase 1 benchmark baseline captured before static write
  surface changes.
- Deviations: none.
- Recordings:
  - `cd packages/runner && deno bench --allow-read --allow-write
    --allow-net --allow-ffi --allow-env --no-check test/scheduler.bench.ts
    test/scheduler-demand-roots.bench.ts
    test/scheduler-stale-propagation.bench.ts`: passed.
  - `test/scheduler.bench.ts`:
    - `Scheduler - 100 computations, shared entity reads`: 19.4 ms
    - `Scheduler - wide graph (1 source, 100 readers)`: 17.9 ms
    - `Scheduler - 100 entities, sparse deps`: 17.3 ms
    - `Scheduler - deep chain (50 levels)`: 11.5 ms
    - `Scheduler - diamond pattern (10 diamonds)`: 9.6 ms
    - `Scheduler - repeated dirty marking`: 7.7 ms
    - `Scheduler - subscribe/unsubscribe cycle (100x)`: 5.8 ms
    - `Scheduler - pull with resubscribe (50 pulls)`: 291.3 ms
    - `Overhead - setup/teardown only`: 1.3 ms
    - `Overhead - create 100 cells (getCell + set)`: 15.4 ms
    - `Overhead - 100x getCell only (no set)`: 1.6 ms
    - `Overhead - 100x set on existing cells`: 15.7 ms
    - `Overhead - runtime.idle() empty`: 1.3 ms
    - `Overhead - commit after 100 sets`: 15.9 ms
    - `Overhead - empty commit`: 1.3 ms
    - `Overhead - 100 raw tx.write + commit`: 7.1 ms
    - `Utility - sortAndCompactPaths (100 paths)`: 21.7 us
    - `Utility - sortAndCompactPaths (1000 paths)`: 280.5 us
    - `Utility - addressesToPathByEntity (100 paths)`: 14.9 us
    - `Utility - addressesToPathByEntity (1000 paths)`: 150.3 us
    - `Scheduler - bare subscribe (100x)`: 1.7 ms
    - `Scheduler - subscribe 100 actions reading same entity`: 1.7 ms
    - `Scheduler - resubscribe cycle (100x)`: 1.4 ms
  - `test/scheduler-demand-roots.bench.ts`:
    - `Scheduler demand roots - effect demand root`: 147.1 ms
    - `Scheduler demand roots - event demand root`: 131.8 ms
    - `Scheduler demand roots - mixed effect and event roots`: 169.0 ms
    - `Scheduler demand roots - parent clears generated children`: 81.3 ms
  - `test/scheduler-stale-propagation.bench.ts`:
    - `Scheduler stale propagation - chain`: 105.5 ms
    - `Scheduler stale propagation - diamond`: 94.7 ms
    - `Scheduler stale propagation - wide fanout`: 244.0 ms
    - `Scheduler stale propagation - dynamic deps`: 82.9 ms
    - `Scheduler stale propagation - unchanged recompute`: 74.7 ms

## 05/step-1

- [x] ca77bc16e — static write surface demand fixtures added.
- Deviations: both fixtures already pass on current code, so they pin existing
  behavior; no behavior-change red case was observed.
- Recordings:
  - `deno fmt packages/runner/test/scheduler-static-writes.test.ts`: passed
    (`Checked 1 file`).
  - `deno lint packages/runner/test/scheduler-static-writes.test.ts`: passed
    (`Checked 1 file`).
  - `deno check packages/runner/test/scheduler-static-writes.test.ts`: passed.
  - `cd packages/runner && ENV=test deno test --allow-ffi --allow-env
    --allow-read --allow-write=/tmp,/var/folders --allow-run=git
    test/scheduler-static-writes.test.ts`: passed, `1 passed (2 steps)`,
    `0 failed`.

## IMPLEMENTER STOP — 05/step-3 static write surface sweep

Stopped after implementing the step 2/3 static-surface rewrite locally because
the full runner suite produced failures outside the three work-order-named
rewrite files. Continuing would require either changing public scheduler API
compatibility for direct `subscribe(..., ReactivityLog)` callers, or widening
test rewrites beyond the allowed files.

Local changes currently include:

- `pull-subscriptions.ts`: unconditional static surface registration from
  action annotations before `immediateLog` setup.
- `dependency-updates.ts`: scheduling writes are derived only from the
  annotated static surface, never `log.writes`.
- `scheduling-writes.ts`: deleted dynamic write discovery helpers and
  historical might-write mode; `SchedulerWriteIndex` now stores the current
  static surface.
- `dependency-graph.ts`/`subscriptions.ts`/`scheduler.ts`: added static
  registration-time dependent edge attachment so existing readers can see a
  newly registered static writer without resurrecting dynamic write-growth
  diffing.
- `action-run.ts`: persisted observations keep both write fields populated
  from the static surface.
- `runtime.ts` and experimental-option tests: removed
  `schedulerHistoricalMightWrite`.
- Named test rewrites in `scheduler-ordering.test.ts`,
  `scheduler-observations.test.ts`, and `scheduler-effects.test.ts` assert
  static surfaces instead of v1 write-set learning. The step-1 fixture was
  also corrected to express declared writes through `action.writes`, because
  v2 ignores direct `log.writes` as scheduler surface.

Verification before the full-suite STOP:

- `deno fmt packages/runner/src/scheduler/pull-subscriptions.ts
  packages/runner/src/scheduler/dependency-updates.ts
  packages/runner/src/scheduler/scheduling-writes.ts
  packages/runner/src/scheduler/dependency-graph.ts
  packages/runner/src/scheduler/action-run.ts
  packages/runner/src/scheduler/subscriptions.ts packages/runner/src/scheduler.ts
  packages/runner/src/runtime.ts packages/runner/test/experimental-options.test.ts
  packages/runner/test/scheduler-ordering.test.ts
  packages/runner/test/scheduler-observations.test.ts
  packages/runner/test/scheduler-effects.test.ts
  packages/runner/test/scheduler-static-writes.test.ts`: passed
  (`Checked 13 files`).
- `deno lint` on the same 13 files: passed (`Checked 13 files`).
- `deno check` on the same 13 files: passed.
- `grep -rn "backfillDependentsForNewWrites\|pruneDependentsForCurrentWrites"
  packages/runner/src/`: no matches.
- `grep -rn "schedulerHistoricalMightWrite\|historicalMightWrite" packages
  --include="*.ts"`: no matches.
- `grep -rn
  "buildKnownSchedulingWrites\|historicalMightWrite\|diffSchedulingWrites\|pruneStructuralAncestorWrites"
  packages/runner/src`: no matches.
- Focused tests passed:
  - `test/scheduler-static-writes.test.ts`: `1 passed (2 steps)`.
  - `test/scheduler-ordering.test.ts`: `2 passed (17 steps)`.
  - `test/scheduler-observations.test.ts`: `1 passed (22 steps)`.
  - `test/scheduler-effects.test.ts`: `1 passed (20 steps)`.
  - `test/experimental-options.test.ts`: `1 passed (11 steps)`.

Full suite failure:

- `cd packages/runner && deno task test`: failed, `580 passed
  (3032 steps)`, `12 failed (63 steps)`, `0 ignored (10 steps)`, `2m5s`.
- Failure groups:
  - `test/cell-callbacks.test.ts`: persistent effect after `pull()` cleanup.
  - `test/memory-v2-pull-reactivity.test.ts`: 2 pull reactivity failures.
  - `test/scheduler-convergence.test.ts`: 6 convergence/cycle/stat failures.
  - `test/scheduler-core.test.ts`: 5 scheduler core/trace/cancel failures.
  - `test/scheduler-events.test.ts`: 2 event recomputation/in-flight demand
    failures.
  - `test/scheduler-pull-array.test.ts`: 7 array/demand/navigation failures.
  - `test/scheduler-pull-handlers.test.ts`: 7 handler dependency pulling
    failures.
  - `test/scheduler-pull-references.test.ts`: reference propagation failure.
  - `test/scheduler-pull.test.ts`: broad pull scheduling/staleness failures,
    including the explicit legacy assertion
    `should preserve writes when collecting dependencies from ReactivityLog`.
  - `test/scheduler-retries.test.ts`: retry dependency preservation failure.
  - `test/scheduler-throttle.test.ts`: 4 throttle/staleness failures.
  - `test/scheduler-timing.test.ts`: 7 debounce/auto-debounce/cycle-debounce
    failures.

Reviewer question: should the scheduler keep a compatibility path where a
direct `ReactivityLog` passed to `subscribe`/`resubscribe` seeds a static
surface for unannotated actions, or should the work order explicitly authorize
widening rewrites/annotations across the additional direct-scheduler tests?

## REVIEWER VERDICT — 05/step-3 subscribe-time logs are declarations

Keep the compatibility path — and not as a concession: it is the
P4-correct reading. A `ReactivityLog` passed to `subscribe(...)` is a
REGISTRATION-TIME declaration (the caller saying "this action reads X,
writes Y"), the same rank as runner annotations. What P4 forbids is the
surface changing from RUN logs. Do NOT widen test rewrites beyond the
three named files.

The rule:

1. Surface resolution at REGISTRATION, in priority order:
   annotated `action.writes` (non-empty) → else `immediateLog.writes`
   (subscribe-with-log path) → else empty. Applied once.
2. `resubscribe(action, runLog)` NEVER touches the surface — for
   annotated and unannotated actions alike. This is the only intended
   v1→v2 semantic change, and the three named files' rewrites already
   express it.
3. Architectural placement: move surface registration OUT of
   `setSchedulerDependencies` entirely — registration sites own it
   (`subscribePullSchedulerAction` for both the annotation and
   immediate-log cases; the rehydration path keeps using the annotation
   as you already have it). `setSchedulerDependencies` becomes
   reads/edges only and never writes to the write index. This matches
   the v2 component split (registration owns the surface) and makes the
   resubscribe path structurally unable to clobber it.
4. Populate-callback subscribers with no log and no annotation (e.g.
   `cell.pull()`'s ephemeral effect) keep an empty surface — correct,
   they are effects.

Expected effect: the direct-subscribe test population (the 12 failing
files) declares writes in their initial logs, so their surfaces, writer
edges, demand, and ordering come back without any test edits —
including the explicitly-legacy
`should preserve writes when collecting dependencies from ReactivityLog`
(subscribe-time, so it must pass unchanged) and the retry-preservation
test (retry resubscribes with the captured log; surface stays the
registration-time one).

After implementing: run the full suite. If failures remain, list them
per-test in PROGRESS with a one-line classification — (a) asserts
run-log surface EVOLUTION (rewrite authorized, name it), (b) anything
else (STOP with the failure). Do not bulk-rewrite.

Docs: amend WO05 step 2/3 with the declaration rule — own commit:
`docs(specs): scheduler-v2 WO05 — subscribe-time logs declare the surface`.
Deferred spec note recorded: P4's text should gain one sentence naming
the immediate-log declaration channel (rides the later docs change with
the settled-origin note).

## REVIEWER RESOLUTION — 05/step-3 declaration-rule docs

- [x] pending — WO05 step 2/3 amended so registration-time `ReactivityLog`
  writes declare the static surface when annotations are absent, while
  resubscribe/run logs never change the surface.
- Recordings: docs-only commit; no `deno fmt`/`deno lint`/`deno check`
  required.
