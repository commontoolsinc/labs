# Sidecar source verification artifacts

Run the source-work probe from a checkout with the intended implementation:

```sh
deno run -A tools/server-execution-topics/sidecar-source-probe.ts
```

It opens four distinct profile-create slots (three in one space, one in a second
space), reopens each slot, and verifies every destination source closure. Each
OFF/ON arm gets a fresh emulated store and runtime. The probe asserts the actual
runtime and serving posture. It uses the real pattern route with a prewarmed
identity endpoint; source responses are counted, so this is an instrumented
mechanism probe, not an end-to-end latency benchmark.

For the baseline, create an isolated worktree at the `head` in
`baseline-manifest.json`, and copy `captured-probe.ts.txt` into
`tools/server-execution-topics/sidecar-source-probe.ts`. This is the exact probe
used by both captures. The current runnable probe additionally decodes its local
file URL so checkout paths containing spaces or Unicode work.
`candidate-manifest.json` identifies the base plus exact candidate patch and
file hashes. Apply `candidate.patch` to that base for its reproduction. The
probe file is supplied separately and is unchanged between variants.

For the red regression, apply `regression.patch` alone to a fresh baseline and
run:

```sh
ENV=test deno test --no-check --preload=packages/runner/test/clock-preload.ts -A packages/runner/test/source-reconciler.test.ts
```

The baseline rejects the new source-sharing and disposal assertions. Run the
current test file on the candidate for green validation; it also contains the
owner-selected-origin control. `SHA256SUMS` covers these compact artifacts.
`external-artifacts.json` locates and hashes full process logs, original capture
manifests and orchestration scripts in durable storage. The normalized manifests
use named path roots; exact capture paths remain in the original manifests.
Server binaries, browser rendering, seeding, deadlines and watermark completion
are outside this probe. Use the campaign integration and benchmark lanes for
those questions.
