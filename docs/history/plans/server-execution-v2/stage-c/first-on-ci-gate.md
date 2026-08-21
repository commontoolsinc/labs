---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "The stack's first-ever CI execution of the ON pattern lanes (land-off PR #6096): seven real ON red surfaces, all locally reproduced, NO demand hole — write-path defects only, two converging on the owed OW31/§2b build; one harness posture fix; skip-and-land disposition (skips gate the FLIP, not the land); the coverage re-baseline."
---

# First ON-lane CI gate (2026-08-21) — the land-off PR's first CI run

Run `32447348664` on PR
[#6096](https://github.com/commontoolsinc/labs/pull/6096)
(`claude/server-exec-v2-land-off`) — **the stack's first-ever CI
execution**: the 26-PR train was stacked, and stacked PRs get no CI
(`deno.yml` triggers on main and PRs into main), so every prior green
was a local run. This run was therefore also the first time the
server-execution ON lanes ever executed in CI.

Outcome: **two jobs failed** —
`pattern-integration-test-server-execution-on` (shards 5, 6, 7, 8, 10)
and `coverage-check` (§4) — and everything else was green, including
the OFF lanes (untouched), `package-integration-test-server-execution-on`
(the runner/runtime-client/shell integration ON lanes), and, INSIDE
the failing pattern-ON lane, the two standing ON gates:
**lunch-poll-vote PASSED (shard 7) and
cfc-group-chat-demo-two-browsers PASSED (shard 8), in CI, on the
CI-built ON binary.**

## 1. Headline

**NO DEMAND HOLE.** Every red was locally reproduced and classified
(§2, §3); none is the W0 §2.8(b) refutation shape. The (d′) demand
machinery came out clean everywhere it could be observed. Every
"value never appears" is a **write-path defect under ON** — a write
that no longer lands (program materialization lost at reload; a
client binding write never commits; storm-depth appends lost), a
write that lands with the wrong identity (service-labeled authorship;
the sqlite owner re-mint / reader-keyed clearance), or an action
killed at commit-prep before it can write (the CFC anyOf assert; the
#6098 compile refusal; the `splitDefinitions` undefined-read). Two of
the seven surfaces are the **already-owed OW31/§2b write-authority
carriage build surfacing** — known, post-merge pre-flip work, now
with CI surfaces as its lift evidence.

Full mechanism, store/log/live-run evidence, and fix seats S-A..S-J
for the three render-stall surfaces:
[`on-render-stall-rootcause.md`](on-render-stall-rootcause.md).

## 2. The failure table

Nine files failed across five shards; seven are real ON surfaces
(the sqlite pair counts as one surface), one was the test harness's
own defect (§3). "True ON" = re-run locally on the ON-built binary
AFTER the harness posture fix, fresh store, posture-verified.

| # | file (integration/) | shard | proximate CI failure | true ON (local) | class | disposition |
|---|---|---|---|---|---|---|
| 1 | `default-app.test.ts` | 5 | console gate: `TypeError: Cannot read properties of undefined (reading 'split')` at `splitDefinitions` (notes/reference-block.ts:62) in note.tsx lift callbacks | same crash (different step reaches it first) | ON read-semantics seam: the lift's input arrives undefined only under ON (the console error W4 §6.2 recorded on the note workload, fatal under the gate) | skip (file) → **OW51** |
| 2 | `cfc-group-chat-demo.test.ts` | 5 | Alice's authorship check: served rows labeled with the SERVICE identity, CFC verification stays "unverified" | red at Bob's send click: his `messageDraft` $value write NEVER reaches the store (0/4 runs, 300 s probe) | TWO write-path defects: §2b acting-identity carriage (the owed OW31 build) + client own-write durability | skip (file) → **OW31 + OW47** |
| 3 | `profile-embed.test.ts` | 6 | `ifc inside divergent anyOf branches` assert in the raw:wish commit-prep (byte-cache warm) | fresh compile: #6098 reserved-result-keys TransformerError on profile-create/picker.tsx, server-side | two stacked killers on the served-wish path; both ON-posture-only; wish UI never mounts, silently | skip (file) → **OW48 + OW49** (+OW50 surfacing) |
| 4 | `home-profile-reload-durability.test.ts` | 8 | profile name renders `#id` placeholder forever (2 steps, ~5 m each) | same; store archaeology: program commit missing on the broken spaces, 0 basis rows; `compile-cache/writeback` refused 17× against each profile space (77 foreign-write refusals total in the window) | program write lost at reload + the server fallback refused without §2b carriage + a silent forever-park | skip (file) → **OW45** (+OW31 S-A arm, +OW46 park visibility) |
| 5 | `sqlite-db-owner-multi-runtime.test.ts` | 10 | `bob's runtime must not re-mint itself as the db owner` | still red, same semantic assert | served-execution identity: the second user's runtime re-mints the db handle owner | skip (file) → **OW53** |
| 6 | `sqlite-read-clearance-multi-runtime.test.ts` | 5 | 3 steps: baseline-settle timeout; `baseline request hash stays reader-blind` fails; `the cleared result doc carries ONLY the declared surface` fails | still red, semantic asserts | the read-time clearance identity model diverges under ON (reader-keyed request hashes) | skip (file) → **OW53** |
| 7 | `cellset-lww.test.ts` | 10 | end-to-end own-write-race step (CI red was mixed-posture append refusal) | 3 steps GREEN; the end-to-end step red: `speculative-basis-refused` → the typed name's own write DROPPED | non-re-derivable USER write refused/withdrawn is lost (§3d premise fails for inputs) | skip (STEP) → **OW47** |
| 8 | `convergence-storm.test.ts` | 7 | 4 tests red (CI: mixed posture refused every append, landed=0/40) | 3 element-schema tests GREEN; the storm step red with a REAL loss: observer landed=**23/40** | write-path loss at storm depth (2×20 pipelined posts); where the 17 die is untriaged | skip (STEP) → **OW52** |
| 9 | `cfc-group-chat-demo-multi-runtime.test.ts` | 7 | 6 steps, 30 s timeouts | ALL 7 steps GREEN after the harness fix (7 s) | the HARNESS's mixed posture, not a product surface | harness fix (§3); no skip, no row |

## 3. The harness posture fix (the one code fix this gate ships)

Five of the nine files are the `MultiRuntimeHarness` family, and their
CI red had a single cause in the TEST HARNESS: it self-hosts a
`StandaloneMemoryServer` in the main test realm, whose engine reads
that realm's ambient flag — which nothing enabled — while the
per-session Deno-Worker clients resolve
`EXPERIMENTAL_SERVER_EXECUTION=true` from env. That is a MIXED
topology no deployment produces: the ON clients' event appends hit
the OFF-arm admission and are refused deterministically ("the OFF arm
has no event-append admission"), so every cross-session consequence
silently never happens. Reproduced locally byte-for-byte in
milliseconds.

The fix (in `multi-runtime-harness.ts`): `create()` resolves the
posture exactly like a deployed entry point (canonical env mapping,
else `SERVER_EXECUTION_DEFAULT_ENABLED`); ON with no explicit
`apiUrl` targets the integration environment's toolshed — the real ON
topology, serving loop included. OFF is byte-identical to before
(in-process standalone server). Effect, on the ON binary with fresh
stores: `cfc-group-chat-demo-multi-runtime` 6 CI-red steps → ALL 7
GREEN; `convergence-storm` narrows to the one storm step (whose red
becomes REAL, 23/40); `cellset-lww` narrows to the one end-to-end
step (`speculative-basis-refused`); the sqlite pair stays red with
semantic asserts; `data-file-multi-runtime` and
`cellset-lww-lost-update` green in both arms.

So the harness fix REPAIRS one file outright and makes the remaining
family reds HONEST (true-ON, semantic), which is what the two
step-level skips and the sqlite/storm/cellset rows are scoped to.

## 4. The coverage re-baseline

`coverage-check` failed because the `packages/runner` coverage-debt
amount moved: the ON lanes executed for the first time and first
contributed coverage profiles to the measurement, shifting the gate's
suggested accepted amount **+1267 → +1276**. The PR body's
`ACCEPT_COVERAGE_DEBT: packages/runner +1276 lines` line was updated
to the gate's own suggestion (the other six groups' overrides were
already satisfied). The debt is the landed-dark train's (~80k lines
behind an OFF flag); the optimize-on-main phase ratchets it back
down.

## 5. Disposition — skip-and-land

The seven surfaces carry honest ON-skip entries in
`tasks/server-execution-on-skips.ts` (SIX file entries + TWO
step-level entries — on the fixed harness topology cellset-lww and
convergence-storm are green but for one step each, so their files
keep running ON), every entry naming the mechanism, the report, and
its owed register row; the mechanisms carry owed rows **OW45–OW53**
(verification-coverage.md §3, the 2026-08-21 delta — OW31's two
converging surfaces point at OW31, nothing re-minted). The skips gate
the **FLIP**, not the land: the flip PR's bar remains the skip list
back to EMPTY, the OW31 build done, the owed rows closed, and the
benchmark against the owner's ruled bar (OW38 (ii)). The OFF posture
— what this PR ships as the default — was untouched by every one of
these reds.
