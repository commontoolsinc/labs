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

- [x] pending — remove push-mode usage from tests, helpers, and benches
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
