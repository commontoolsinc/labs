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
patch, copy `recorded-source/mutation-workload.ts.txt` to
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
own server. The captured manifests' absolute paths describe the recording
machine; substitute the disposable checkout and fresh output directory when
replaying. The replay runner writes artifact locations relative to its manifest
and keeps resolved checkout paths, commands, and environment under `provenance`.
The collected statistics summarize that run, not a marginal latency effect. The
complete pre/post statistics remain in the named durable directories with hashes
in `stats-summary.json`; recoverable workload output is included here.

## Replay validation controls

`recorded-source` preserves the exact scripts used by the original manifests.
The top-level replay scripts reject a nonpositive or noninteger topic count, an
unsuccessful health-statistics response, and a selector that matches no mutation
case. The teardown control asserts that the response began after transport
settlement; it does not wait indefinitely on an unobserved response. The normal
fake clock holds positive-delay timers while `clock.settle()` drains transport
work, and the rescan cases explicitly tick their timer boundary.

`review-controls.json` records the top-level ten-case workload, all six original
mutations, two additional mutations, and an unknown selector. The legacy control
retains a consequenced, sequence-less entry, then admits the same ID through the
real server, which stamps a new sequence. Both new handlers run. Dropping the
numeric-sequence qualification from the separate twin-deduplication check makes
that control fail. The early consumed-entry checks instead match the exact ID
and sequence; they remain necessary when a consequence arrives during the
visibility response. The no-response teardown mutation fails its named assertion
without a timeout. Copy the top-level `mutation-workload.ts.txt` to the probe
path above to replay these cases, using the command and selector in each row.

`review-input-controls.json` evaluates the topic-count and statistics-handling
source fragments from both recorded and replay scripts with controlled inputs.
The 503 response is accepted and written by the recorded script; the replay
script rejects it before writing. This is a helper validation control and does
not seed a board or establish runtime correctness. Run
`deno run --allow-read --allow-write verify-replay-inputs.ts EVIDENCE_DIR OUTPUT`
to repeat it after copying the verifier to a `.ts` filename. The verifier reads
exact fragments from the archived source files, so the recorded source hashes
identify the code evaluated.

`review-manifest-control.json` records a fresh ON baked-server run of a trivial
Deno command to verify relative artifact addressing and provenance retention. It
tests the capture helper, not the topics workload or client rendering.
