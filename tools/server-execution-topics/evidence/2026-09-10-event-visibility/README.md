# Event visibility evidence

These are clock-controlled correctness and mechanism observations from
recommendation 3 of the server-execution topics campaign. They are not latency
trials. The matched and mutation cases use fresh in-memory stores,
server-execution ON, and real serving runtimes over the memory loopback
transport. No browser shell participates in those cases. Dependency/compiler
disk caches remain populated. Manifests record commands, runtime, load, source
hashes, and exit codes; load exceeded the quiet-machine threshold in these
observations.

`baseline` and `fixed` use identical `matched-workload.ts.txt` bytes. Both start
from `a5ed830f06827ce1b9bc0dfbe0b6a023315f3268`; each `implementation.patch` is
relative to that commit. The baseline patch adds observation counters and their
types only. The baseline fails the watermark assertion after recording two
durable waves. The fixed arm records one wave containing both consequences and
passes. Neither arm fires a backstop before those observations.

To reproduce an arm, create a disposable worktree at the recorded base, apply
that arm's `implementation.patch`, create `packages/runner/test/executor`, and
copy `matched-workload.ts.txt` there as `visibility-matched.probe.ts`. From the
worktree's `packages/runner` directory, run the manifest's command with
`ENV=test`. Deno 2.9.4 is the repository pin for this snapshot. The expected
exit codes are 1 for baseline and 0 for fixed. The JSON observation printed
before the assertion is also saved as `results.json`.

`mutations` starts from the fixed patch. Each named mutation patch is relative
to that fixed source. Apply one in a fresh disposable checkout with the fixed
patch, copy `mutation-workload.ts.txt` to
`packages/runner/test/executor/visibility-mutations.probe.ts`, and run that
case's manifest command from `packages/runner`. Its final argument selects the
documented control case; the ordinary committed test suite runs every case. All
six mutations fail with an assertion, while `control-before` and `control-after`
run all nine cases and pass. `mutation-results.json` records those outcomes. A
mutation that passes has not reproduced this evidence.

`output.json` preserves each complete UTF-8 output stream in its `text` field,
including escaped terminal control characters. Its `rawSha256` hashes those
decoded UTF-8 bytes. This keeps the original output recoverable without literal
control bytes in tracked files. `SHA256SUMS` hashes the archive files
themselves; run `shasum -a 256 -c SHA256SUMS` from this directory to verify
them.

The full runner and integration logs, build provenance, and campaign ledger are
retained under
`/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/`. The compact
evidence here is sufficient to replay these mechanism controls without that
machine. The mechanism fixtures contain synthetic identities and empty event
payloads; integration payloads come from the checked-in test fixtures.

`integration-off` and `integration-on` record separate fresh-store runs through
the repository's baked-toolshed CI capabilities. Both ran the same six test
files (seven suites, 27 steps), including two-browser voting and cross-session
event gating. The manifests include server, client, and baked-shell posture. On
the OFF arm, the chained-event test reports that its event-consequence primitive
runs only under ON. This is an existing test condition.

To reproduce those integration runs, apply the fixed patch to the recorded base
and copy `run-arm.ts.txt` and `seed-check.ts.txt` into
`tools/server-execution-topics/` without the `.txt` suffix. The second file is
captured as supporting source by the runner; this invocation does not execute
it. Run the build commands in `integration-builds.json` from that checkout,
moving each `dist/toolshed` output into
`.ci-cache/binaries/toolshed-baked-default` or
`.ci-cache/binaries/toolshed-baked-opposite` before the next build. The build
metadata names the base commit; the recorded production-file hashes identify the
uncommitted implementation compiled over it.

Invoke the runner with the corresponding role, a new absolute artifact
directory, `correctness`, and the Deno workload arguments listed in the run
manifest. It chooses its own ports, verifies all three postures, and closes its
own server. The manifest's absolute paths describe the recording machine;
substitute the disposable checkout and fresh output directory when replaying.
The collected statistics summarize that run, not a marginal latency effect. The
complete pre/post statistics remain in the named durable directories with hashes
in `stats-summary.json`; recoverable workload output is included here.
