# Server-execution topics verification probes

These tools support the
[campaign ledger](../../docs/plans/server-execution-topics-campaign.md). They
run against synthetic local stores and retain evidence outside temporary
scratch. A successful mechanism probe is not a latency result or completion of
an implementation gate.

## Capture a mechanism

Run from the repository root with its pinned Deno version. The artifact
directory must be new; its parent must already exist.

```sh
deno run -A tools/server-execution-topics/capture-probe.ts watch /absolute/new-watch-run 100 1000 10000
deno run -A tools/server-execution-topics/capture-probe.ts serving /absolute/new-serving-run
deno run -A tools/server-execution-topics/capture-probe.ts event-visibility /absolute/new-event-run
deno run -A tools/server-execution-topics/capture-probe.ts sidecar /absolute/new-sidecar-run
```

Each capture saves the exact runtime head, tracked worktree patch, script
snapshots and SHA-256 hashes, command, Deno version, flags, machine information,
load observations, raw stdout/stderr, and result hashes. It preserves failed
captures and exits unsuccessfully when the probe fails. Restore the recorded
runtime head and script snapshots to reproduce an older capture.

The retained index-demand ablation is JSON-encoded so its unified-diff context
spaces remain byte-exact without becoming trailing whitespace in repository
source. Decode its `patch` field before applying it; the adjacent `sha256` field
hashes those decoded bytes. The raw patch is also retained in the campaign's
durable artifact directory.

| Probe              | What it establishes                                                                                       | What it does not establish                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `watch`            | Iterator work on real session add, refresh, and replacement; exact session/interest cardinalities         | Allocation bytes, CPU attribution, complete traversal cost, or latency           |
| `serving`          | Plain-root terminal sync calls, re-confirmation after demand departure, grace coalescing and input bypass | Cold browser latency, creation races, or multi-user fairness                     |
| `event-visibility` | Admitted entries can remain absent after covered sync and become visible on real frame application        | Handler consequences, watermark coverage, or avoided backstop duration           |
| `sidecar`          | Repeated resolution/compilation across distinct slots, same-slot reuse, and destination source closure    | Fresh-runtime compiled reload or closure persistence through a real serving wave |

The watch counter is active across an asynchronous phase window. Ancillary
client delivery can enter from an earlier operation or spill into the next
window. Treat those rows as observed work, not an operation's causal frame
count. The named server add/refresh loops support the whole-session scaling
claims. Loaded-address iteration and its nested map iteration overlap; do not
sum them as separate costs.

The serving probe holds the existing grace callback and preserves other timers.
It rejects causal observations containing an input-wait timer wake, a deadline
callback firing, or a deadline-exhausted cycle. It identifies the deadline by
its SpaceServer caller and callback result token, and requires observing a
deadline arm so source drift cannot silently disable that discriminator. This
instrumentation belongs in a dedicated process, not alongside unrelated work in
the same JavaScript runtime.

## Run against matching baked toolshed arms

`run-arm.ts` uses the repository's CI capabilities, role mapping, posture probe,
and process ownership. It starts a baked toolshed in a new store and requires
the published build SHA to match the workload head. Build the binaries at that
head before using it:

```sh
campaign_head=$(git rev-parse HEAD)
campaign_opposite=$(deno eval 'import { serverExecutionCiLane } from "./tasks/server-execution-ci.ts"; console.log(serverExecutionCiLane("opposite").enabled)')
mkdir -p .ci-cache/binaries
COMMIT_SHA="$campaign_head" env -u EXPERIMENTAL_SERVER_EXECUTION deno task build-binaries toolshed
cp dist/toolshed .ci-cache/binaries/toolshed-baked-default
COMMIT_SHA="$campaign_head" EXPERIMENTAL_SERVER_EXECUTION="$campaign_opposite" deno task build-binaries toolshed
cp dist/toolshed .ci-cache/binaries/toolshed-baked-opposite
```

Builds temporarily change compilation configuration. Finish them before running
another task that reads that configuration. Keep binary hashes and build logs
with the evidence; do not commit generated binaries.

```sh
deno run -A tools/server-execution-topics/run-arm.ts default /absolute/new-off-run correctness run -A tools/server-execution-topics/seed-check.ts
deno run -A tools/server-execution-topics/run-arm.ts opposite /absolute/new-on-run correctness run -A tools/server-execution-topics/seed-check.ts
```

`seed-check` verifies actual topic IDs, titles, body lengths, ordered index
entries, and citation targets. It saves statistics before opening its fresh
reader. That reader starts no pieces locally; in the ON arm its demand can cause
serving recomputation. Its observed watermark is not an assertion that the last
event's consequence was already covered before readback.

The driver also accepts ordinary Deno test or benchmark arguments. `correctness`
mode always marks latency as ineligible. `profile` mode retains that separation.
`latency` mode refuses an initial one-minute load above 5, samples load through
the workload, and fails if any observed sample exceeds 5. It does not arrange
paired runs automatically: use adjacent alternating arms, at least three pairs,
matching fixture shape and completion conditions, and no competing campaign
tests or profiling. A sampled load record is not proof that every instant
between samples was quiet.

These probes do not replace the repository's required package, pattern, or
integration lanes. The v2 testing specification's integration command and the
current baked CI capability path are distinct harnesses; report which one
actually ran.
