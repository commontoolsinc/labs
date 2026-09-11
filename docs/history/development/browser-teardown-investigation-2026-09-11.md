---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Investigation snapshot of current-Chrome teardown, descriptor retention, and updater-isolation validation."
---

# Browser teardown investigation, 2026-09-11

The inherited-stderr mechanism reproduced on fresh main with the installed
Chrome. It involved **both Chrome Crashpad and GoogleUpdater crash handlers**.
The narrow prototype prevents Chrome test launches from scheduling installed
browser maintenance. It does not replace lifecycle waits with a timer and does
not establish that all current-browser teardown failures are fixed.

## Provenance and environment

- Base: `263057f5deb76c93def7fa89ad9ffd386bb40d66`, fetched from
  `commontoolsinc/labs` origin/main on September 11.
- Baseline branch: `codex/browser-teardown-investigation`, worktree
  `/Users/berni/.codex/worktrees/browser-teardown-investigation/labs`.
- Prototype branch: `codex/browser-teardown-updater-isolation`, worktree
  `/Users/berni/.codex/worktrees/browser-teardown-fix/labs`, same base.
- `/Users/berni/src/labs` was left on its existing checkout. Other worktrees,
  production data, execution defaults, thresholds, and enabled lanes were not
  changed. Signals were limited to captured investigation processes.
- macOS 26.4.1 (25E253), ARM64; Deno pin and actual fresh-login resolution:
  2.9.4 through `/opt/homebrew/bin/deno`; V8 15.0.245.2-rusty, TypeScript 6.0.3.
- Astral: pinned JSR `@astral/astral` 0.5.6.
- Browser: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  **153.0.8010.36**. Normal adapter selection, `ASTRAL_BIN_PATH` unset for
  baseline and validation runs. No Chrome 125 run was used.
- Executable SHA256:
  `fe21b4086d7f035b17ce4c8ff9d1ceef88eb9510252a5b311d7a5aa48c352b32`.
  Framework SHA256:
  `8d46f03a86ab51c8a329dd6d106bb5275d28d4c3a8da77f120c6ddfb968577b0`.
- Crashpad executable SHA256:
  `ad0dc3566ba0eb1e56ba4e253052a24abe85edda4de4149a32462276a13bbc05`.
  The full executable paths are in `metadata/binary-hashes.json`.
  Installed GoogleUpdater was 152.0.7933.0, hash in that same file.
- Machine load was high and variable, including a one-minute load near 198.
  Every run records load and process snapshots. Repository benchmark isolation
  was not established; durations are observations of lifecycle completion,
  **not latency comparisons or performance claims**. One failed ON run overlapped
  our repository type check, in addition to unrelated machine work.

Evidence root: `/Users/berni/.codex/artifacts/browser-teardown-2026-09-11`.
Paths below are relative to that root unless explicitly repository paths.

## Blocking chain on current main

The repository, not Astral's `Browser.close()`, owns the relevant process wait.
`packages/integration/browser-process.ts` launches `Deno.Command` with stdout
and stderr piped. It reads the DevTools endpoint from stderr, then continuously
drains both streams. `stopBrowserProcess()` signals the root Chrome, awaits
both drains, and then awaits `child.status`. It suppresses only recognized
already-exited errors. `BrowserProcess.close()` finally disconnects Astral;
`Browser.close()` subsequently removes the private profile directory.

Astral 0.5.6's own close asks CDP to close the browser and has a timed process
fallback; Labs bypasses that method. Labs still uses Astral's page close and
websocket disconnect. Page close uses the DevTools HTTP close-target endpoint.
The repository holds the process and pipe handles; readers own their stream
locks, and there is no cancellation of an inherited pipe during normal close.

`ShellIntegration` cleanup is sequential: presentation cleanup, page runtime
coverage/disposal, page close, browser close. Lunch-poll registers host cleanup,
guest cleanup, then sink cancellation and controller disposal. The pinned BDD
runner invokes registered afterAll functions in registration order. Thus a
browser wait blocks subsequent controller `Runtime.dispose()` and outer test
runner cleanup. The page's own runtime disposal precedes browser close; it is
incorrect to say no runtime disposal can have occurred.

Controller disposal awaits runner/storage/scheduler work through
`Runtime.dispose()`. On the reproduced pipe stall, the blocked browser wait
precedes that work; there is no evidence that storage initiated that stall.
The outer normal integration runner eventually shut down its isolated toolshed
and shell after the diagnostic intervention released the test.

### Natural reproduction and causal intervention

`normal-on-01` started through `deno task integration patterns lunch-poll-vote`
with server execution explicitly ON and a fresh store. The voting assertion
passed. The suite did not complete. The root Chrome processes had exited.
Deno PID 58885 fd 42 still read pipe `0x417d3396fba64a54`; Chrome Crashpad PID
61099 held its peer `0x64eba47afca46442` on fd 2.

After ps/lsof and native sampling, terminating that descriptor-proven Crashpad
**did not unblock cleanup**. A system-wide lsof found the same write endpoint
in GoogleUpdater crash-handler PIDs 62414 and 62418. Both started during this
run, were absent from the before snapshot, and had the investigation's
`packages/patterns` as cwd. Terminating these two proven holders released the
pipe, allowed suite completion, and allowed server cleanup. Exit code zero
therefore describes **intervention-assisted completion**, not a passing run.

Captures: `captures/normal-on-01-active/`, `captures/normal-on-01-stall/`.
Signal records, samples, pipe endpoints, updater logs, and pre-intervention
server logs are retained. Pipe addresses can be reused after closure; matches
across non-overlapping snapshots do not establish ownership.

### Controlled descriptor reproduction

`controlled-descriptor-01` uses the actual installed Chrome through an explicit
**diagnostic-only** `ASTRAL_BIN_PATH` wrapper. The wrapper forks a detached
helper that redirects stdin/stdout, inherits stderr, and waits on a FIFO. The
parent execs Chrome. The wrapper is not used for integration validation.

The trace establishes: page close completed; browser close began; Chrome PID
24260 exited successfully and stdout reached EOF at 16:47:39.186Z; stderr and
browser close remained pending. Detached helper PID 24289 held the matching
stderr descriptor. Releasing its FIFO at 16:48:58Z closed the final write end;
stderr EOF and BrowserProcess.close completion followed at 16:48:58.989Z, then
profile cleanup completed. No timeout declares this success, and no helper is
left running. See the run log, `runs/controlled-descriptor-control/`, and
`captures/controlled-descriptor-01-held-after-exit/`.

This independently proves the lifecycle dependency. It does not establish why
Chrome's native crash handler retained every Mach right in the natural case.

## Attribution and intermittency

The mechanism is high-confidence: detached helper descriptor retention blocks
the repository's EOF-based cleanup. Attribution is an interaction between
Chrome/updater subprocess inheritance and Labs' choice of pipe EOF as a proxy
for profile-writer completion. It is not an Astral BrowserProcess.close defect
on this base: that class and wait are repository code.

Exact Chrome-tag sources independently support the updater path:

- [Browser startup checks the updater-scheduler switch](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.36/chrome/browser/chrome_browser_main.cc).
- [The scheduler posts its initial work after 19 seconds](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.36/chrome/browser/updater/scheduler.cc).
- [The Mac updater scheduler launches maintenance in a new process group](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.36/chrome/browser/updater/scheduler_impl.cc).

Downloaded source and retrieval metadata are in `metadata/upstream/`. Crashpad
main-branch sources show macOS subprocess launch preserving descriptors 0–2 and
double-forking; those sources are **not proven to be the exact bundled revision**.
Native Crashpad sampling found Mach-message/semaphore waits, not an active
upload. Whether inherited Mach exception rights in updater processes extend
Chrome Crashpad's lifetime remains unresolved.

A short browser-only baseline run completed naturally. A held baseline browser
also completed naturally, with stderr EOF later than root exit/stdout EOF.
The equivalent baseline ON two-suite run completed naturally after long teardown
intervals; updater lifecycle logs showed handlers ending at different times.
The OFF equivalent also completed. Launch duration, whether maintenance starts,
and when detached holders release descriptors explain the observed possibility
of success without establishing a frequency or complete causal model of native
helper exit. These results do not show server execution causes the browser bug.

## Prototype and regression

The only executable production change adds `--disable-updater-scheduler` to
Chrome launches in `spawnBrowser()`, preserving caller arguments. Firefox is
unchanged. Current installed Chrome and its own crash reporting stay enabled.
The prototype retains stream draining, actual child status, error propagation,
and profile cleanup order. It adds no sleep, retry, timeout, discarded stream,
or success-on-interruption behavior.

The launch-policy regression fails on base and passes with the switch. The
existing real subprocess descriptor test is strengthened to establish root
exit and stdout EOF while stderr remains held, then release the holder through
stdin and observe close completion. Fake-launch failures continue to propagate;
a Firefox case checks that the Chrome-specific switch is absent. The complete
integration package passed: 61 tests, 75 steps. Repository fmt, lint, and type
checking passed. A held real-Chrome prototype diagnostic also completed with
both streams and status accounted for.

This is a narrow mitigation and an appropriate upstreamable launch policy,
not a general solution to unmanaged subprocess lifetime. Upstream Chrome/
GoogleUpdater should explicitly redirect detached maintenance-service standard
descriptors and investigate inherited Mach exception rights. A broader Labs
change needs explicit ownership/reaping of all profile writers before releasing
streams or removing the profile. Cancelling stderr or timing out the wait alone
would hide ownership failures. No such broad change is claimed here.

## Validation and limitations

| Run | Arm / scope | Outcome |
| --- | --- | --- |
| normal-on-01 | Base ON, normal lunch-poll lane | Assertion pass, pipe stall; intervention-assisted exit 0, not a pass |
| baseline-off-01 | Base OFF, lunch-poll + group-chat | 2 tests / 2 steps passed; natural completion |
| baseline-on-02 | Base ON, same two files | 2 tests / 2 steps passed; natural completion after long teardown intervals |
| fixed-on-01 | Prototype ON | Missing prior-only file; no tests ran |
| fixed-on-02 | Prototype ON, full affected workload | Lunch assertion failure, live-Chrome delay, intervention and interruption; not a pass |
| fixed-off-01 | Prototype OFF, full affected workload | 6 tests / 25 steps passed; natural completion |
| fixed-on-diagnostic-03 | Prototype ON, same workload with preload | 6 tests / 25 steps passed; all disposal phases completed; diagnostic only |
| fixed-on-04 | Prototype ON, same workload without preload | 6 tests / 25 steps passed; natural completion |

The final uninstrumented ON and OFF runs used current Chrome with no browser
override. Their servers also shut down with exit zero. Binary hashes were
rechecked unchanged after validation. This is one successful uninstrumented
prototype run per arm, not a measured flake-rate reduction or proof that the
earlier assertion failure and live-Chrome delay are fixed. A separate
instrumented ON run completed page/runtime/process/stream cleanup in order.
All shorter controls, regressions, builds, static checks, server runs, failures,
and interventions remain in `run-ledger.json`.

A self-review through `cf-review` found the executable change confined to
Chrome launch policy, with caller arguments, Firefox, stream waits, child
status, and errors preserved. It corrected misleading comments that equated
pipe EOF with all descendant processes exiting. The unresolved validation
failure above is a limitation of the recommendation, not a reason to discard
that run. No upstream issue, PR, merge, deployment, or production change was
made.

The first attempted five-suite prototype invocation accidentally named the
prior campaign's `topic-board-seed.test.ts`, absent on this base; import failure
occurred before tests. It remains in the ledger as `fixed-on-01`. The actual
current workload names topic-board-fixture, topic-board-child-contract,
topic-create-onscreen, lunch-poll-vote, and cfc-group-chat-demo-two-browsers.
These five files contain six top-level tests. This is the full affected
workload, not a claim to have run every unrelated pattern integration test.

The unsuccessful `fixed-on-02` ON run must remain visible: lunch-poll failed
after host profile-name fill, with a policy-rejected write, before voting.
During subsequent teardown Chrome PID 18605 was still alive, unlike the
original exited-root pipe stall. Its native sample included a worker waiting
in `SecItemCopyMatching`/securityd IPC. That stack does not prove the main
shutdown dependency or identify its cause. The root was force-stopped after
captures, which let the suite advance; the test process was later interrupted
while group-chat was pending. It is neither a successful run nor proof that the
updater flag fixes the separate live-Chrome failure. The uninstrumented capture
cannot determine every pending JS cleanup phase in that attempt.

## Reproduction commands and retained evidence

Every execution attempt, including failures and interventions, has
`runs/<name>/manifest.json`, exact argv, selected environment, source head,
diff summary, start/end load, process snapshots, and `output.log`. The
machine-readable ledger links these runs and separately classifies outcomes.
Full patches, selected exact base sources and hashes, installed binary hashes,
compiled per-arm toolshed binaries, upstream source snapshots, native samples,
pipe captures, and diagnostic scripts are retained.

`build-on` and `build-off` compile toolshed and its baked shell with explicit
matching execution values and the exact base SHA. Each test arm uses a new
store and a private port. Saved `/api/meta` verifies SHA, server flag, and
`shellServerExecutionDefine`; health stats verify presence/absence of serving
execution. Client test processes carry the same explicit flag. The OFF health
response omits `servingLoop`; the diagnostic posture script was corrected to
accept that documented representation, without changing the server or tests.

The diagnostic scripts contain instrumentation outside the repository. Normal
runs use no preload or browser override. Run manifests are authoritative for
which is which. No older-browser control is counted as validation.

The supplied prior reports were opened only after writing
`metadata/independent-explanation-01.md`. They support an earlier exited-Chrome,
Crashpad-held-pipe observation; this investigation adds updater holders and
causal release. Their original bytes were preserved; hashes are retained in
`metadata/prior-hashes.json`. The prior campaign's six-file workload
included a seed test not present on this main SHA.
