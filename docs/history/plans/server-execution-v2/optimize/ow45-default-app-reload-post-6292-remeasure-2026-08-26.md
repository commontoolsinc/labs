---
status: historical
created: 2026-08-26
archived: 2026-08-26
reason: "Measurement record: the default-app reload STEP's post-#6292 ON gate ran 9/10 green; the only red was a new store-incomplete setup-error shape, so the skip stayed."
---

# Default-app reload post-#6292 re-measure

This report records the ten-run re-measure of the oldest remaining patterns
STEP skip after #6292 fixed the client-side loss of `cid:` effects before the
initial watch response. The gate targeted
`integration/default-app.test.ts`'s
`should persist and reload every rapidly created notebook note` step.

- Repository: `commontoolsinc/labs`
- Worktree: `/Users/berni/labs-worktrees/r01-remeasure`
- Branch: `claude/server-exec-v2-r01-remeasure`
- Measured head: `37b45336a6b17ad27039cc525e4ba2e89f517449`
- #6292 commit in the measured head: `9c9073995`
- Pinned toolchain:
  `/Users/berni/.local/share/loom/toolchains/deno/2.9.4/deno`, Deno 2.9.4
- Evidence root: `/Users/berni/labs-worktrees/r01-remeasure-evidence`

## Method

The campaign followed the measurement method in
`ow45-armb-server-ensure-stage1-report.md` exactly:

- Built one ON toolshed binary at the measured head.
- Neutralized only the target step's skip guard in the working tree for all
  runs; the registry entry remained present.
- Verified the target step ran by parsing its exact verdict after the step
  description; no skip-print appeared in any counted run.
- Used a fresh store, an independent 97xx port, and a posture probe per run.
- Required `shellServerExecutionDefine == "true"` and a present
  `servingLoop` before starting the test.
- Set `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false`, matching the continuous
  integration ON lanes where the entry runs.
- Masked the LLM environment with `CFTS_AI_GATEWAY_URL=""` and
  `CFTS_AI_LLM_ANTHROPIC_API_KEY=fake`.
- Ran from `packages/patterns` with the prescribed unchanged 600-second
  harness bound.
- Interleaved five quiet and five loaded counted runs and recorded the
  machine's actual load averages.
- Tore down by PID only and verified the port was free after every run.

## Build

- Command:
  `COMMIT_SHA=37b45336a6b17ad27039cc525e4ba2e89f517449 EXPERIMENTAL_SERVER_EXECUTION=true deno task --no-lock build-binaries toolshed`
- Binary: `/Users/berni/labs-worktrees/r01-remeasure/dist/toolshed`
- Size: 619,556,642 bytes
- SHA-256:
  `747c162b30bd18e144ebbf9ef1c03b7a84d44d005949bcbd4a919e17d1970ebd`

## Counted-run ledger

| Run | Mode | Port | Load before / after | rc | Wall | Step verdict | Catch-up | Catch-up failed | Pattern-load error | Stale-read lines | Evidence |
| --- | --- | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| r01 | quiet | 9741 | 16.44 / 20.51 | 124 | 600 s | TIMEOUT | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r01/` |
| r02 | loaded | 9742 | 14.07 / 32.26 | 0 | 41 s | GREEN (`ok`, 24 s) | 2 | 0 | 0 | 2 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r02/` |
| r03 | quiet | 9743 | 30.48 / 26.84 | 0 | 20 s | GREEN (`ok`, 11 s) | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r03/` |
| r04 | loaded | 9744 | 23.88 / 67.77 | 0 | 24 s | GREEN (`ok`, 13 s) | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r04/` |
| r05 | quiet | 9745 | 54.38 / 42.47 | 0 | 17 s | GREEN (`ok`, 10 s) | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r05/` |
| r06 | loaded | 9761 | 28.53 / 26.29 | 0 | 21 s | GREEN (`ok`, 13 s) | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r06/` |
| r07 | quiet | 9747 | 18.46 / 17.54 | 0 | 19 s | GREEN (`ok`, 12 s) | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r07/` |
| r08 | loaded | 9748 | 15.61 / 17.28 | 0 | 22 s | GREEN (`ok`, 13 s) | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r08/` |
| r09 | quiet | 9749 | 15.24 / 13.84 | 0 | 12 s | GREEN (`ok`, 7 s) | 2 | 0 | 0 | 2 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r09/` |
| r10 | loaded | 9750 | 10.22 / 10.73 | 0 | 15 s | GREEN (`ok`, 9 s) | 1 | 0 | 0 | 1 | `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r10/` |

Quiet was 4/5 green and loaded was 5/5 green. Across the ten counted runs:

- `deferred-start-catchup`: 12
- `deferred-start-catchup-failed`: 0
- `pattern-load-error`: 0
- stale-read lines: 12
- terminal `Error committing deferred` lines: 0
- target-step skip-print lines: 0

Every run used the same binary hash and measured head, passed the posture
probe, started on a free port, and left its port free after PID-only teardown.

## Red classification

The sole red, r01, is a new shape.

The target step started after the preceding step passed in 20 seconds, reached
`Await runtime idle for notebook regression...`, and remained in the target
step until the unchanged 600-second harness bound returned rc 124.

The durable target notebook space held 89 commits, 808 entities, and 1,220
revisions. Its notebook root had a real pattern identity. Its argument was a
real notebook with exactly six note links, written in six post-creation patches
at seqs 37, 45, 55, 63, 71, and 83. No seventh append was durable.

The logs carried one `pattern-swap-setup-error`:

> updated arguments do not match the candidate schema: parentNotebook: notes:
> 0: parentNotebook: recursive schema validation made no progress

They also carried seven `event-view-lag` deferral lines, reaching index 5, and
zero `pattern-load-error` lines.

This is not the earlier r01 signature: that required all seven appends durable,
a live piece context, and a silently starved read. This store had six notes, an
explicit setup error, and the step did not reach the final authority read.

This is not the earlier r06/r09 signature: that required one keyless
`pattern-load-error` followed by whole-piece unreadability while the durable
pattern pointers remained real. This run had no `pattern-load-error`; its root
was durable with a real pattern identity.

The detailed classification is at
`/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r01/classification.md`.
The same directory carries `test.log`, `toolshed.log`, and the raw fresh store.

## Status of the earlier residues

The read-side residues from the pre-#6292 gate are likely closed by intervening
fixes, but the evidence is not symmetric:

- r01 has a mechanism story: #6292 fixed the loss of a pre-watch `cid:` effect
  before `SpaceReplica` absorbed it, matching the read-side delivery loss that
  made r01 plausible. The old complete-store, live-context, silent-starvation
  signature did not occur in this campaign.
- r06/r09 have absence-of-observation only. Their keyless-identity
  `pattern-load-error` mechanism was never root-caused, and the signature did
  not occur in this campaign.

This campaign therefore supports “likely closed” for the earlier residues, not
a proved common mechanism or an unconditional closure claim.

## Disposition

No lift. The result was 9/10 green, so the STEP entry and its bound guard stay.
No lift PR was opened from the campaign.

The skip's current charge is the new store-incomplete setup-error shape. Its
lift bar remains 10/10 green under the same quiet-and-loaded ON protocol. The
campaign does not determine whether the seventh append was refused, dropped,
or never issued, and it does not assign a root cause to the recursive-schema
setup error.

One excluded preflight is preserved at
`/Users/berni/labs-worktrees/r01-remeasure-evidence/attempts/r06-port-9746-occupied/`.
It found unrelated port holders and exited before launching toolshed. Counted
r06 used free port 9761.
