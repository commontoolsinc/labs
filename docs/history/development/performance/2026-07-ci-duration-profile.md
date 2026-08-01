---
status: historical
created: 2026-07-18
archived: 2026-07-18
reason: "Profiling snapshot and remediation record for the July 2026 Deno Workflow CI duration audit."
---

# Deno Workflow CI duration profile, July 2026

## Conclusion

The starting `main` run was
[`29671969142`](https://github.com/commontoolsinc/labs/actions/runs/29671969142).
It took 9 minutes 28 seconds. Pull request
[`4832`](https://github.com/commontoolsinc/labs/pull/4832) then ran commit
`cc5b1e659` twice. The retry used the same source and completed successfully.

| Run | Workflow elapsed | Slowest pattern integration job | Slowest workspace job | Slowest runner job | Check job |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starting `main` | 9m 28s | 5m 01s | 4m 20s | 3m 55s | 2m 15s |
| PR attempt 1 | 6m 39s | 4m 57s | 4m 06s | 3m 55s | 2m 06s |
| PR attempt 2 | 6m 59s | 5m 02s | 3m 36s | 4m 04s | 2m 14s |

Setup was not the main cost. Most test jobs spent 20 to 40 seconds outside
their main test step. Pattern compilation, transformer tests, schema-generator
tests, and runner tests accounted for most of the useful work.

The branch CI validated these results:

- Removing the duplicate `tasks/` test step removed 14 seconds of Check-job
  work. The whole Check job still varied from 126 to 134 seconds.
- Removing the duplicate dependency initializer saved no measurable time. Its
  visible step took zero or one second.
- The package shard pins shortened the workspace maximum by 17.7 seconds in
  attempt 1 and 6.0 seconds in attempt 2. They saved no workflow time because
  pattern integration remained slower. The pins and their contract test were
  removed after this result.
- Injecting the compile cache into the capability tests did not shorten either
  CI attempt. The restored cache key did not include pattern `.ts` files, so an
  exact immutable Actions cache could not learn the branch's new compiled
  modules. The key now covers `.ts` and `.tsx` sources.

Attempt 1 failed only the coverage-debt gate. It reported 238,065 uncovered
`packages/patterns` lines. Attempt 2 reported 238,061 lines from the same commit
and passed. The four-line change came from coverage collection rather than a
source change, so the coverage gate has a small nondeterministic boundary.

The CI results led to four follow-up changes that were not present in
`cc5b1e659`: repair the pattern-integration cache key, use two workspace package
workers, rebalance pattern integration from the uploaded per-file timings, and
move transformer type checking from the workspace shard to the concurrent
Check job. A later CI run must measure those follow-up changes directly.

## What was measured

GitHub's Actions API supplied job and step durations for the starting run and
its recent predecessors. The PR logs supplied exact workspace package timings.
The PR's JUnit and performance artifacts supplied the per-test timings and
cache state for both attempts.

The local measurements included:

- all five runner shards with JUnit output and without coverage;
- all six workspace shards with coverage and one package worker, matching CI's
  serial scheduling;
- every pattern capability shard with an empty compile cache and then with the
  cache produced by that first run; and
- a V8 CPU sample of a capability shard.

The workspace profiles used the local Deno 2.8.3 installation while the
repository pinned 2.8.1. Restricted loopback or storage access ended `shell`
early on shard 1, `ui` and `background-piece-service` on shard 2, `static` on
shard 3, and the first CLI slice and one coverage fixture in `tasks` on shard
4. The moved `fuse` and `cf-harness` packages completed. The aggregate shard
figures below are useful assignment weights, not successful end-to-end
benchmarks.

The CPU sample's JavaScript frames were concentrated in TypeScript scanning and
name resolution, the compiled-module parser, and the JSX expression-site
transformer. The native symbols did not match the local V8 build, so they were
not used. This agrees with the earlier
[pattern-integration compiler profile](pattern-integration-compile-bound.md):
compilation is the useful optimization target, not emulated storage or runtime
synchronization.

## The capability sweeps did not use the restored cache

The workflow restored a per-shard compile-cache file and set
`CF_COMPILE_CACHE_FILE`. The two capability test files constructed `Runtime`
directly without passing the shared `moduleByteCache`. Setting the environment
variable selected a persistence file, but no runtime read or wrote it. Before
the fix, a complete capability shard did not create the configured cache file.

The Performance Check still called the pattern-integration family warm when
the Actions cache had restored a file. Its cache-state artifact records whether
the file was restored, not whether every runtime in the test process used it.
Other integration tests populated the file, so this looked healthy from the
workflow level while the new expensive sweeps compiled every pattern again.

Both sweeps now use one capability-gate controller helper. That helper injects
the same process-wide byte cache used by the other pattern-integration
controllers. All four shards then produced cache files of about 3.3 MB.

| Capability shard | Empty cache | Reused cache | Reduction |
| --- | ---: | ---: | ---: |
| 1 | 14s | 5s | 64% |
| 2 | 14s | 6s | 57% |
| 3 | 8s | 3s | 63% |
| 4 | 11s | 4s | 64% |

The two PR attempts did not reproduce that local reduction. All four cache
state artifacts reported exact hits in both attempts, but the capability suite
times remained in the same range:

| Suite maximum | Attempt 1 | Attempt 2 |
| --- | ---: | ---: |
| Full discovered-pattern sweep | 106.1s | 101.5s |
| Curated allowed-and-rejected suite | 35.6s | 36.6s |

The source-side cache key hashed only `packages/patterns/**/*.tsx`. The branch
changed capability controllers and tests in `.ts` files. Actions caches cannot
replace an existing exact-key entry, so each job restored the old cache, added
the missing modules in its workspace, and then could not save the augmented
file under that key. The key now hashes both TypeScript extensions. Its prefix
still restores the preceding cache as a starting point. A new commit can save
the augmented cache under the new exact key.

The previously shipped
[`d0c5264d2`](https://github.com/commontoolsinc/labs/commit/d0c5264d2750a2c9fff7a8f08e15c730c4977d0c)
change that divides the capability sweeps across all four jobs is useful. It
removed the earlier concentration of the full sweep in one job. The cache
injection fixes a separate problem inside each divided slice.

## The Check job repeated the workspace task tests

The standalone `tasks/` test step predated `tasks` becoming a root workspace
member. Once it became a member, workspace shard 4 ran the same tests again and
collected their coverage. The latest Check job spent 14 seconds on the
standalone copy. Removing that step preserves both execution and coverage in
the workspace job.

No individual behavioral test was removed. The audit did not find evidence
that the full capability sweep or the curated capability suite was useless.
The full sweep protects every discovered pattern. The curated suite keeps
explicit allowed and rejected examples. Their duplicated compilation was the
waste.

The curated suite also repeats the battleship, card-piles, and scrabble cases
from the full sweep. They consumed about 16.5 seconds of aggregate CI test time
in attempt 2. They did not extend the slowest shard, and they make a direct run
of the curated file cover the handler-only game cases. They were retained. The
compile cache should make their second compilation inexpensive once the cache
key repair has run.

## Workspace package pins did not improve the workflow

The first local profile suggested moving `fuse` from shard 1 to shard 5 and
`cf-harness` from shard 3 to shard 2. The PR logs made it possible to replay the
round-robin assignment with the exact package times from each CI attempt.

| Attempt | Maximum with pins | Round-robin maximum | Workspace-only gain | Workflow gain |
| --- | ---: | ---: | ---: | ---: |
| 1 | 212.7s | 230.4s | 17.7s, or 7.7% | 0s |
| 2 | 191.8s | 197.8s | 6.0s, or 3.0% | 0s |

The `cf-harness` move did not change the maximum in either attempt. The `fuse`
move produced all of the workspace-only gain. Pattern integration was still at
least 51 seconds slower than the workspace matrix, so neither pin shortened the
workflow. The fixed six-shard table, its topology-specific name, and its
36-line contract test were removed. Workspace packages again use the ordinary
sorted round-robin rule.

## The serial workspace override protected a test that was already fixed

An earlier six-shard trial ran two packages concurrently. Five workspace jobs
passed. Shard 3 failed the task-runner test named `runTests passes internal
shard environment to expanded packages`. Two mock CLI commands appended their
markers to the same file. The failing assertion received
`shard=3/3shard=1/3` when it expected two separate lines. The failure was in the
test's assumption about concurrent file writes, not in a package under test.

The six workspace test steps in that CI run took 90, 58, 43, 138, 96, and 143
seconds in shard order. Shard 3 stopped at 43 seconds on the test failure. The
other five completed successfully with two package workers. These durations
come from an earlier revision, so they establish that two-worker CI operates
successfully but are not a direct speed comparison with this pull request.

The merged test already selects a workspace shard containing one CLI slice and
uses one writer. No recorded CI package failure therefore supports keeping
`TEST_CONCURRENCY=1`. Scheduling the two PR attempts' package timings through
two workers gives these estimates after removing the package pins:

| Attempt | Serial round-robin maximum | Two-worker estimate | Estimated gain |
| --- | ---: | ---: | ---: |
| 1 | 230.4s | 180.8s | 49.6s |
| 2 | 197.8s | 153.6s | 44.2s |

CI now uses the package runner's half-core default. That is two workers on a
standard four-core runner. `TEST_CONCURRENCY` remains available for a diagnostic
override.

## The four-shard pattern table has repeatable critical-path value

The pattern assignment table was evaluated with the same counterfactual used
for the workspace table. The observed per-file JUnit durations were kept fixed.
The files were then assigned by the old table, the current table, or sorted
round-robin with no table. Each shard kept its observed internally sharded work
and non-test job overhead.

| Run | Observed old-table maximum | Current-table model | No-table model | Current table versus no table |
| --- | ---: | ---: | ---: | ---: |
| Starting `main` | 301.0s | 281.9s | 295.7s | 13.8s, or 4.7% |
| PR attempt 1 | 297.0s | 276.0s | 291.6s | 15.5s, or 5.3% |
| PR attempt 2 | 302.0s | 281.4s | 296.3s | 14.9s, or 5.0% |

Pattern integration remained the critical job after each modeled assignment.
The current table therefore has an estimated workflow benefit of 13.8 to 15.5
seconds when downstream work is unchanged. These are counterfactuals built
from actual CI timings, not separate workflow runs.

Three earlier timing-artifact sets from runs
[`29667152509`](https://github.com/commontoolsinc/labs/actions/runs/29667152509),
[`29662362384`](https://github.com/commontoolsinc/labs/actions/runs/29662362384),
and
[`29661808609`](https://github.com/commontoolsinc/labs/actions/runs/29661808609)
provided an out-of-sample check. The current table reduced their slowest test
step by 13.4, 8.3, and 3.3 seconds compared with no table. The last run was
dominated by about 380 seconds of internally sharded work on shard 3, so
ordinary file placement had little leverage. The table did not lose to sorted
round-robin in any of the six measured timing sets.

Three ordinary files appeared among the four heaviest in every recent run:
`cf-code-editor`, `home-profile`, and `convergence-storm`. The remaining
top-four member alternated between `default-app` and
`home-rehydration-churn`. Sorted round-robin puts `cf-code-editor` and
`convergence-storm` together on shard 1. That shard also has the consistently
heaviest internally sharded slice. The table separates that collision. It
keeps every known assignment stable when a new unlisted file is added.

The old table's comments no longer described the expensive files. That table
was 5.3, 5.4, and 5.7 seconds slower than deleting the table in the three
principal timing sets. Moving `profile-embed` from shard 1 to shard 3 and
`cfc-authorized-save` from shard 1 to shard 4 shortened the modeled critical job
by 19.1 seconds on starting `main`, 21.0 seconds on PR attempt 1, and 20.6
seconds on PR attempt 2. The changes turned the table from a regression into a
repeatable critical-path improvement.

Every currently measured ordinary integration file is now fixed in the
assignment table. A new file falls back to round-robin over the unlisted files
until a later profile supplies its weight.

`FOUR_SHARD_ASSIGNMENTS` accurately names the table's validity constraint. The
partition has no measured meaning for another shard count, and the selector
consults it only when the total is four. The module name already supplies the
pattern-integration context. A generic name would suggest that the assignments
remain valid at other counts. If CI gains another profiled shard count, the
representation should become a map keyed by the count before the name becomes
generic.

The explicit table is maintenance work, but unlike the removed workspace table
it reduces the workflow's critical path. Its contract tests verify that the
profiled round-robin collision remains separated, explicit entries still name
real files, every ordinary file appears exactly once, and each internally
sharded file runs on all four shards. A heuristic retune could improve the three
principal runs by another 5.3 to 11.3 seconds. The same retune made the slowest
test step in an earlier cold run 19.2 seconds slower, so it was rejected as an
overfit rather than added to this branch.

## Transformer setup is repeated hundreds of times

`ts-transformers` was the largest workspace package in both attempts. It took
162.4 seconds and 135.1 seconds. A coverage-enabled local run took 27.7 seconds
with Deno's pre-test type check and 23.9 seconds without it. Checking the source
and all test entry points directly took 1.3 seconds. Those paths now run in the
concurrent Check job, and the package test uses `--no-check`.

The transformer tests contain 307 calls or helper definitions named
`createProgram`. The slow local files repeatedly construct a fresh TypeScript
program for small source snippets. The largest file totals were 10.7 seconds
for `destructuring-lowering-coverage`, 9.5 seconds for
`array-method-utils-coverage`, and 9.3 seconds for `ast/utils-coverage`.
Grouping independent snippets into shared virtual programs is the next
runtime-code experiment. It needs a separate correctness review because some
tests intentionally depend on isolated compiler state.

## Runner sharding is already adequate

The five local runner shards took 38.0, 35.8, 41.4, 44.3, and 32.9 seconds.
The slowest test-file totals were 30.4 seconds on shard 4 and 21.0 seconds on
shard 5. Moving files could save only several local seconds, and the existing
CI policy stops when the expected gain is under about 30 seconds. More runner
sharding would add setup and coverage artifacts without addressing the common
compiler cost. No runner assignment changed.

## Redundant workspace initialization was neutral machinery

Each workspace job had a visible `deno task initialize-db` step. The root
`deno task test` entry point then invoked the same task before selecting
packages. The visible step took zero or one second in each measured job. The
root entry point remains responsible for initialization, so local and CI test
runs keep one self-contained contract.

## Binary distribution is the next setup experiment

The build job uploads `toolshed`, `bg-piece-service`, and `cf` as one
`common-binaries` artifact. The measured artifact was 254,598,871 bytes.
Downstream jobs always download all three binaries even when they use only
one.

Local binary sizes were 333 MB for `toolshed`, 253 MB for `cf`, and 247 MB for
`bg-piece-service`. Their individual gzip sizes were about 91 MB, 72 MB, and
71 MB. Pattern integration and package integration need only `toolshed`.
Pattern unit tests need only `cf`. CLI integration needs `toolshed` and `cf`.
The measured download step took 10 to 16 seconds on pattern-integration jobs,
and one CLI job took 43 seconds.

A useful next experiment is to build and upload one artifact per binary in
parallel jobs. Each consumer could depend only on the binaries it uses. The
experiment must include upload and job-start overhead because three serial
upload steps in the existing build job could erase the download gain. Another
option is to run the source Toolshed in most integration shards and retain one
built-binary smoke test. That would remove the build dependency from those
shards, but it changes what those tests cover and needs a direct comparison.

## Further improvements

The next CI run should measure the cache-key repair, two-worker workspace
schedule, pattern-integration rebalance, and transformer `--no-check` change as
separate step and package timings. The cache repair needs two observations: a
new commit that saves an augmented key and a rerun that restores that exact
key.

Further experiments supported by the current data are:

- Record compile-cache reads, writes, and misses for every test process. Mark a
  job family warm only when its expensive runtimes report cache use.
- Upload workspace package timings as structured data rather than recovering
  them from logs. Keep accepted fixed assignments in source only when they
  reduce the workflow's critical path across repeated runs.
- Reuse TypeScript programs across compatible transformer test cases. The
  repeated program construction is both runtime work and test setup work.
- Split `common-binaries` by consumer and run the build paths concurrently.
  Compare the current 25-second artifact upload and 6-to-14-second downstream
  downloads against the extra job-start and upload costs.
- Make the coverage-debt gate tolerate or eliminate the observed four-line
  collection variance without allowing actual uncovered source growth.
- Profile the shared TypeScript and transformer pipeline with matching V8
  symbols. Improvements there apply to pattern integration, runner tests,
  generated patterns, pattern unit tests, and `cf check`.

There are also polling waits and retry sleeps in CI support code, including
`.github/actions/deno-install/action.yml`,
`.github/actions/wait-for-toolshed/action.yml`, and `tasks/perf-lib.ts`. They
either delay failure or make progress depend on elapsed time. A focused follow-up
should replace them with observable readiness or a single surfaced failure.
Start a dedicated agent for that change because it needs its own failure-mode
review; it was not mixed into these duration changes.
