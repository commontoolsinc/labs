---
status: historical
created: 2026-08-26
archived: 2026-08-26
reason: "Root-cause report: the default-app store-incomplete red split browser and serving pattern-source authority, stranding the seventh event before served admission while a recursive pattern-swap validation error exposed the same divergence."
---

# Default-app store-incomplete root cause

This report follows the sole red from the post-#6292 default-app reload
campaign recorded in
`ow45-default-app-reload-post-6292-remeasure-2026-08-26.md`. It determines
where the seventh note creation stopped, what produced the recursive-schema
error, and which claims remain unavailable from the captured process state. It
does not change production behavior or lift the guarded STEP.

## Analysis posture

- Repository: `commontoolsinc/labs`
- Analysis branch:
  `codex/server-exec-v2-default-app-setup-error-rootcause`
- Worktree:
  `/Users/berni/labs-worktrees/default-app-setup-error-rootcause`
- PR #6367 head and live-analysis base:
  `672890c094c6b148f5f3fbc44f2266deca7140bb`
- `origin/main` fetched at worktree creation:
  `53632a88fa40d18ae68ee217999edd7b425ec147`
- Merge base at worktree creation:
  `3c6e296ba571c6dbaafb51f716f09478de66c2b2`
- PR #6367 merged during handoff as `bb45dc41c`; the documentation branch was
  then rebased onto current `origin/main`:
  `c89b58eca80dbf48b285745f694a90f504b01602`
- Clean analysis-head ON binary SHA-256:
  `bf713bac43366a341dbf6ecafa351ecefd891987ebe32ec6bdfe5c860f94168f`
- Diagnostic-instrumentation ON binary SHA-256:
  `9c57e1907f107c9d2a5c2f6e2513359a74d0a02c68ebc88f978b4f3dc44c9e53`
- Pinned toolchain:
  `/Users/berni/.local/share/loom/toolchains/deno/2.9.4/deno`, Deno 2.9.4

The captured campaign remains at measured head
`37b45336a6b17ad27039cc525e4ba2e89f517449`, using ON binary SHA-256
`747c162b30bd18e144ebbf9ef1c03b7a84d44d005949bcbd4a919e17d1970ebd`.

Evidence roots:

- Captured campaign:
  `/Users/berni/labs-worktrees/r01-remeasure-evidence/`
- Captured red:
  `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r01/`
- Loaded green control:
  `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r02/`
- Quiet green control:
  `/Users/berni/labs-worktrees/r01-remeasure-evidence/runs/r03/`
- Live causal probes:
  `/Users/berni/labs-worktrees/default-app-setup-error-rootcause-evidence/`

Live probes used a fresh file-URL store and port, masked the LLM environment,
set `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false`, required
`shellServerExecutionDefine == "true"` and a present `servingLoop`, and
neutralized only the target STEP guard. The 600-second outer bound was not
changed. Processes were stopped by PID and their ports were verified free.

## Finding

The captured red did not lose a browser action. The seventh `Create` was
authored and durably appended at store sequence 87. It has neither a
consequence nor a terminal event status, and the served watermark stops before
it. The precise event classification is therefore **stranded before served
queue admission and terminal classification**. It was not refused, dropped,
or never issued.

The initiating fault was a split pattern-source topology in the off-repository
measurement launcher:

1. `run-gate.sh` launched each toolshed on its independent 97xx port but did
   not set the toolshed process's `API_URL`.
2. The browser test did set `API_URL` to that run's 97xx toolshed.
3. `packages/toolshed/env.ts` defaults an unset `API_URL` to
   `http://localhost:8000`. `packages/toolshed/runtime-options.ts` deliberately
   uses `MEMORY_URL` for the store and `API_URL` for pattern source, so a remote
   pattern host is supported behavior.
4. In red r01, an unrelated older toolshed happened to answer on port 8000.
   The browser compiled the current note identity
   `30y74xQLD0UrX1PyXSXCcdLUJkaVB-JSR_2edN0C1Qo#default`; the serving runtime
   fetched and installed older identity
   `c-jbvEpTajY4kifrlT-3vpUMJ0F6N1MXzxo55Nu1qc8#default`.
5. The older source document was
   `of:fid1:66aXbx3yxXKLTjReAkrnhxVmNmpzDDFPTTZLtw7Hdys`, with source hash
   `9bc1db8b975ffb501a6f609569aeb19a03a149a328dfbff3c4cd4ce9ada178e0`.
   It maps exactly to repository commit
   `8ca18b71e10c4b756f5d66cd40335299a7d1b7a0`. Its only semantic difference in
   the note pattern was the unused headless `wish("#recent")` removed by
   `dd671fb0e38147fb90b31815ddd5ecfaddc5ff37` (#6301).

The source split caused a swap of already-running note pieces. Swap setup
revalidated a real note argument containing a back-link into its notebook.
That notebook contains the note in `notes[0]`, which links back to the same
notebook. `packages/runner/src/cfc/schema-sanitization.ts` detects that the same
schema/value pair was revisited without reducing the problem and returns
`recursive schema validation made no progress`. The validator returns an
error; it is not an unbounded recursive call.

The `pattern-swap-setup-error` is thus a direct witness and consequence of the
split source authority. It is not the seventh event's refusal, because the
captured error precedes that event and the event has no terminal refusal. It is
also not sufficient by itself to hang: a live stale-source run emitted the
same error after all seven note appends had landed, and an instrumented
identity-only run returned the error while all client idle branches drained
and the test failed normally in 22 seconds.

The hang and missing append share the source-authority divergence and its
ordering, but the captured evidence supports a narrower direct statement:
after the divergence, served progress stopped before the seventh event could
be admitted or terminalized. The final event remained pending behind a served
watermark that never covered it, so the client-facing
`waitForRuntimeIdle`/`Scheduler.idleWithPendingCommits` barrier could not
resolve. The original browser process did not record which in-memory idle
branch remained nonempty after the setup error; that exact blocker cannot be
reconstructed from the durable store.

## Captured red timeline

Target space:
`did:key:z6Mkhec13wMjURwmhxbYJvsfCLn8AyS5HkNSNrCW9ViphN5z`.
Notebook root:
`of:fid1:ZFAnoOhjISTrMQ9Yir2e4zpCUrCKtqKgp5p0pE0fF5U`.
Notebook argument:
`of:fid1:mqb_ZK5DcSdUC1liH3_5VpSrkeWk2D-n_ZAPeL0jI7I`.
Creation stream:
`of:fid1:ev-4VcPSrQEnBrhjj7PoOR03qOJyVbc196gXAx8l4io`.
Final `Create` stream:
`of:fid1:zMgUm9bwIZ6qN8SbF4zlAmUpu54jFJVvXgXCCph67FQ`.

| Boundary | Durable/log evidence | Classification |
| --- | --- | --- |
| Enter target STEP | Previous STEP passes in 20 seconds; target reaches `Await runtime idle for notebook regression...`. | Test is executing, not skipped. |
| Create notes 1–6 | Authored events at seqs 36, 43, 53, 60, 69, and 81; notebook appends/consequences at seqs 37, 45, 55, 63, 71, and 83. | Browser actions, served handlers, and parent mutations complete. |
| Pattern update | The server obtains note identity `c-jbv…` from port 8000 while the browser uses `30y…`. | Pattern authority diverges. |
| Swap validation | At 16:59:44.273, `pattern-swap-setup-error` names candidate `c-jbv…` and argument shape `{ content: "", isHidden: true, linkPattern: "", parentNotebook: <notebook root>, references: {}, title: "New Note" }`. | Swap setup returns a recursive-schema error. |
| Event-view deferral | Seven `event-view-lag` warnings occur, reaching index 5. | Admission is delayed; this alone is not terminal. |
| Seventh browser action | At 16:59:51, the final `Create` is durably authored at seq 87. Its sidecar entry has no consequence, status, error, or reason. | Emitted and appended; not refused or dropped. |
| Client speculation | A seventh note root `of:fid1:NxkaufptEJeXgm3bfgSQ-Cet6oAspfukzBPOHE5DF0k` and argument `of:fid1:iSX1uxNOUrtIaAofqY63QQsvv9twigfskN0bIkcYFpI` exist, but the notebook argument never links them. | The client speculative path ran; the authoritative parent append did not. |
| Competing source writes | Seq 88 records the server's `c-jbv…` source/provenance update on a sixth note; seq 89 records current-source provenance on the orphan seventh note. | Both source authorities are durable in the same run. |
| Served progress | The durable served watermark document is written at seq 82 with value 81; no later watermark covers seq 87. The scheduler basis has a handler for the final stream. | The event is stranded before served admission, not missing a handler. |
| Idle/harness | No seventh notebook append is durable. `waitForRuntimeIdle` stays pending until the unchanged 600-second outer bound returns rc 124. | Pending event/served work prevents the client durability barrier from settling. |

The store has 89 commits, 808 entities, and 1,220 revisions. The notebook root
retains the real pattern identity
`w9szWGSgrs0synMrp9g-LnhnuFksykYyJLIiJXXmeB0#default`. There is no
`pattern-load-error`.

## Green control timeline

Loaded r02 used target database
`runs/r02/memory/engine-v3/engine-v3/did:key:z6MkkRSU91jFf5VC7Bn7EvmFqE7V1TPzKJyyEq3kvVjZoe8w.sqlite`, notebook root
`of:fid1:GFL4XlPx-dVxSYPjqTPbcXizyuffTv-OKOv4qJJuiF4`, and argument
`of:fid1:vAzCO2lAlDACA0UvTCv4seNrObcU0XQ87WnPST1B8LI`.

| Boundary | Durable/log evidence | Classification |
| --- | --- | --- |
| Source lookup | The serving process's port-8000 source lookup gets connection refused. | No conflicting pattern candidate is installed. |
| Seven browser actions | Authored note events occur at seqs 37, 43, 54, 60, 68, 74, and 84. | All actions reach the store. |
| Seven served consequences | Notebook appends occur at seqs 38, 47, 56, 63, 72, 79, and 86. | Every event is terminally consequenced and mutates the parent. |
| Idle/test | The target STEP passes in 24 seconds. | No pending event remains at the durability barrier. |

The r02 store has 94 commits, 805 entities, and 1,237 revisions. Quiet r03
passes the STEP in 11 seconds despite `event-view-lag` indices 1–4, providing a
second discriminator: an event-view lag is not sufficient for the red.

## Live causal probes

The live runs were causal discriminators, not a new lift campaign.

### Self-consistent source

`runs/live-self-source-01/` pointed browser and serving source reads at the same
analysis-head toolshed. It did not produce the stale candidate or the captured
hang. It exposed a distinct current-head test symptom after five appends
(`stream action argument is undefined` for later client actions) and is only a
negative topology control.

### Exact old source

`runs/live-stale-source-02/` served source from the exact old checkout at
`8ca18b71e10c4b756f5d66cd40335299a7d1b7a0` on port 8000 while the current
binary served the test on port 9869. It reproduced:

- the exact `c-jbv…` candidate;
- the recursive-schema `pattern-swap-setup-error`;
- `event-view-lag` through index 5;
- a nonresponsive, CPU-bound serving process.

All seven note appends landed before that run stalled. This rules out the
schema error as an automatic refusal of the seventh append and shows that
ordering decides whether the stall overtakes the final event.

### Identity-only source

`runs/live-identity-only-01/` changed only a source comment on the current note
pattern and served that identity from port 8001 while the test toolshed ran on
port 9870. It reproduced the recursive-schema error and a 600-second rc 124
stall. This rules out the removed `wish("#recent")` behavior: a distinct source
identity plus the durable recursive argument shape is enough to reach the
error/stall family. It also rules out ambient load as necessary; the original
red and this probe were quiet.

### Idle instrumentation

The narrow diagnostic binary traced the existing client idle branches without
changing production behavior. `runs/live-idle-trace-03/` was green.
`runs/live-idle-trace-identity-01/` saw the recursive client callback error but
then drained queued events, pending commits, and pattern-load parked heads to
zero and returned a normal test failure in 22 seconds. The instrumentation
changed timing enough that it did not recreate the 600-second state. It proves
that the setup error does not intrinsically leak an idle counter, but it cannot
name the original r01 process's final in-memory blocker.

## Schema path

The exact failing candidate in the captured red was the older note pattern
`c-jbvEpTajY4kifrlT-3vpUMJ0F6N1MXzxo55Nu1qc8#default`. Two note pieces were
observed with that candidate:

- root `of:fid1:UD-wBGcfw-SOPs9HMFHikxTLesn_p3f3NbCXKfxY96U`, argument
  `of:fid1:BzaovdlY-9jA0P8lI0uwlNvOZNkwmDj8DUuW2NxUG6M`;
- root `of:fid1:utiMWnqOgPW91zwiAmpmUoflgnwCanKAV6bGMecszwA`, argument
  `of:fid1:GacnWwqCfHadMI07_z9RlR9VZ1iyJKPU3khU3KhlYDI`.

Both arguments have the same relevant shape: a note holds
`parentNotebook -> notebook`, the notebook's first notes entry holds
`parentNotebook -> the same notebook`, and the candidate's recursive
NotebookPiece/NotePiece schema asks validation to follow that graph. The active
pair guard in `schema-sanitization.ts` sees the same schema and same value
again, with no progress, and returns an indeterminate validation result. An
offline replay returned in about 2.8 seconds; a raw link-overlay traversal took
about 78 milliseconds over roughly 12,413 calls. The error is finite.

`packages/runner/src/runner.ts` logs `pattern-swap-setup-error` when candidate
setup or argument update fails. That error path leaves the running pattern on
its previous viable setup; it does not create an event consequence or classify
an unrelated event. Pattern swap and event admission therefore have distinct
durable records in r01.

## Answers to the investigation questions

1. **Was the seventh creation action emitted?** Yes. The browser-authored event
   is durable at seq 87.
2. **Was its event durably appended?** Yes, on the final `Create` stream and in
   its sidecar.
3. **How was it classified by the served event pipeline?** It was stranded
   before served queue admission and before any terminal classification. It
   was not processed, dropped, or refused; its sidecar has no status or
   consequence and the served watermark does not cover it.
4. **Did its handler run?** The client speculative handler path ran far enough
   to materialize an orphan seventh note. The served authoritative handler did
   not run: there is no consequence and no parent mutation.
5. **Did the handler produce a note mutation or pattern swap?** Client
   speculation produced child note setup/provenance, not the notebook append.
   No pattern swap can be attributed to the seventh served event. The observed
   swap requests come from the concurrent pattern-source updater.
6. **Was the seventh append refused, dropped, or never issued?** None of those.
   The event was issued and durable; the parent append was never produced
   because the event was stranded pre-admission.
7. **Which candidate and argument triggered the setup error?** Candidate
   `c-jbv…`, source document `of:fid1:66a…`, against the concrete note argument
   payload and piece arguments listed above.
8. **Why did validation recurse without progress?** The embedded recursive
   schema follows `note.parentNotebook.notes[0].parentNotebook` back to the
   same value under the same schema pair; the progress guard terminates it.
9. **Was the schema error causal, consequential, or independent?** It is a
   consequence and diagnostic witness of the initiating split source
   authority. It is not the direct refusal of the seventh event and is not
   sufficient for a hang. The same divergence/order can both invoke it and
   stop served progress before the final event.
10. **What remained pending after the error?** Durably, the seq-87 event was
    pending beyond a watermark covering only through seq 81. That is enough to
    keep the client pending-work barrier open. The exact original browser
    scheduler branch holding that work is not durable and was not logged.
11. **Why did greens avoid the path?** In r02/r03, the implicit port-8000
    source host was absent, so the updater could not install a conflicting
    candidate. In the self-consistent live control, both authorities agreed.
12. **What was the trigger?** Pattern-source identity divergence plus ordering
    against the recursive durable note/notebook graph. It was not load, a
    fixed note index, the old note source semantics, or event-view lag alone.
    Timing determines whether all seven events finish before the divergence
    stalls progress.

## Ruled out

- **Browser omission:** seq 87 proves the seventh action was emitted.
- **Event refusal or drop:** the event has no terminal status, error, reason,
  or consequence.
- **Missing served handler:** the final stream has a scheduler-basis handler.
- **Legacy r01:** that store had all seven appends and a live context; this one
  does not.
- **Legacy r06/r09:** r01 has no keyless `pattern-load-error` and keeps a real
  root identity.
- **Load as a necessary trigger:** the captured red and identity-only probe
  were quiet.
- **A particular note index:** the exact stale-source probe completed all
  seven appends before stalling.
- **The removed `wish("#recent")`:** a comment-only identity change reproduced
  the family.
- **`event-view-lag` alone:** quiet r03 had lag deferrals and completed.
- **The recursive validator as the endless loop:** offline validation returns,
  and an instrumented live error can drain idle normally.

## Causal links and open limits

Established causal chain:

1. The launcher omits the server's source `API_URL`.
2. The server falls back to port 8000 while the browser uses the run port.
3. An unrelated old source server supplies a distinct note identity.
4. The server updater requests swaps of current note pieces.
5. Candidate setup traverses the existing cyclic note/notebook value and
   returns the recursive-progress error.
6. Under the captured ordering, served progress does not reach the seventh
   durable event, leaving it nonterminal beyond the watermark.
7. `waitForRuntimeIdle` continues to await the event/durability fixpoint until
   the unchanged harness bound fires.

The following remains open:

- Which original client scheduler collection or promise held the final event
  after the error. The durable store establishes pending work but cannot
  recover in-memory ownership.
- Which precise serving-side computation consumed the CPU during the
  long-stall live probes. The stale-source sample is dominated by V8 JIT frames
  and does not identify a TypeScript owner.
- Whether a supported remote pattern-source deployment needs a product-level
  authority/version policy to prevent competing identities from repeatedly
  updating a live recursive piece. The measurement topology was accidental,
  but distinct `API_URL` and `MEMORY_URL` are intentional.
- Whether the current-head self-source `stream action argument is undefined`
  symptom is a separate product defect. It was not present in the captured
  campaign and is outside this mechanism.

## Regression and fix disposition

No production regression test or production fix was added.

The proven initiating defect is in the off-repository campaign launcher. A
deterministic launcher regression would assert that the toolshed process gets
`API_URL=http://localhost:$PORT/` and that browser and serving source probes
return the expected identity before the counted STEP begins. That launcher is
not part of this repository, so this branch cannot add its direct test.

The repository intentionally supports a pattern API host distinct from its
memory host and listening port. Changing toolshed defaults to force self-source
would alter supported production behavior without proving that it is the
correct authority policy. The live reproductions also did not isolate a local
runtime change whose removal could mutation-kill an automated regression:
adding the narrow idle trace changed the ordering and the stall disappeared.
The fix bar is therefore not met, and no mutation check applies.

The exact measurement fix seat is the launcher: set the server process's
`API_URL` to its independent run port and fail preflight unless both browser
and serving source authorities report the expected identity. Any runtime
hardening for competing source authorities needs its own design and red-first
mechanism pin.

The default-app STEP skip and its in-file guard remain. A lift still requires a
separate 10/10 quiet-and-loaded campaign using the corrected source-authority
posture.
