---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW51 loss-triage: the default-app splitDefinitions undefined-read is the ARRIVAL-ORDERING shape — a scheduler lift on a freshly served-instantiated note runs while its input's link chain (through the piece's result/process doc) is still materializing; the mid-chain resolution yields undefined and the leaf schema's default:null never applies. Crashes BOTH the shell worker AND the toolshed's serving runtime. Fix is a flagged contract fork (defer-on-unresolved-chain vs lifts-tolerate-undefined) — not decided here; skip stays."
---

# OW51 — the default-app `splitDefinitions` undefined-read: triage

Register row: `docs/specs/server-side-execution/verification-coverage.md`
§3 OW51. Evidence base:
`docs/history/plans/server-execution-v2/stage-c/first-on-ci-gate.md`
row 1; W4 §6.2 (the same console error on the note workload, 17 and 6
occurrences per ON rep, 2-for-2 at n=20).

## 1. Reproduction (ON binary, this worktree's tip)

Built the ON binary (`EXPERIMENTAL_SERVER_EXECUTION=true deno task
build-binaries toolshed`; `/api/meta` verified
`shellServerExecutionDefine "true"`, servingLoop present, gitSha =
branch tip) and ran `default-app.test.ts` against it, fresh store:
**both steps failed the console gate** on the registered error while
the FUNCTIONAL flow succeeded (notes created, listed, reload
survives). Stacks pin both crash sites to note.tsx's two
`pendingEdit.get()` readers — `pendingAddresses` (note.tsx:428,
`splitDefinitions` at 431) and the staged-edit apply computed
(note.tsx:444/448) — no `editProjection` is ever driven; the crash is
a background failure of a FRESH note's computeds during the
create/open flow.

**The crash is not client-only.** The same run's TOOLSHED log carries
the identical TypeError from the SERVER's own serving runtime
(`[ERROR][scheduler] Action failed: cf:module/…:__cfLift_18/19` →
`splitDefinitions` → the pull-settle loop, `settle.ts`
`runPullSettleOrder`), seconds after `event-view-lag` warnings
("replica view holds undefined at index N" — the serving replica's
view lagging its store during the creation burst). The serving
runtime has NO speculation overlay and no runtime-client protocol —
so every overlay-, protocol-, and reconciliation-specific hypothesis
dies here: the undefined read happens in the CORE runner's
scheduler-driven lift evaluation, on both sides.

**The trigger is RACY, not deterministic**: 1 of 6 local browser runs
reproduced (5 occurrences); five fresh-store re-runs — including the
W4 n=20 series shape (`CF_NOTE_CREATE_TIMING_SERIES=20`) — stayed
green on this quiet box. CI, the stage-c agents' boxes, and W4's
loaded bench reproduced it near-reliably; W4 recorded loads. The
window is load-sensitive.

## 2. What the crashing read is

`pendingEdit` is `new Writable<string | null>(null)` in the pattern
body. `createWithDefault` (runner `cell.ts`) carries the initial
`null` as the cell SCHEMA's `default` — there is NO durable write of
the initial value. Both readers guard `body === null` only, so an
`undefined` falls through into `splitDefinitions(undefined)`.

Every leaf-level default-application site in the read path is
null-safe (`schema.default !== undefined` — `traverse.ts`
`applyDefault`/3696, `schema.ts` 737/1673/831): a read that REACHES
the leaf schema cannot yield undefined for this cell. The undefined
therefore enters ABOVE the leaf — the read dies mid-chain, before
the leaf schema (and its default) is ever consulted.

## 3. Which ON read shape: ARRIVAL ORDERING through the piece-doc chain

Store archaeology on the crashed run's space (102 commits):

- Healthy `__cfLift_18` (pendingAddresses) instances record exactly
  two basis docs each, both at their note's instantiation-wave seq,
  and the docs' values are `result`-REDIRECT links into the note
  piece's result/process doc — the lift's input read reaches
  `pendingEdit` THROUGH the piece's result-doc chain, one hop past
  the redirect.
- The crashed action instance (`__cfLift_18:0ipYKhGE9KG4`) has NO
  basis rows (a throwing run commits none); its crash lands at
  18:08:31.5 exactly amid the creation burst's commit train
  (seq 92–102, 18:08:30–32) and the server's own replica-VIEW lag
  warnings.
- Under ON the note is instantiated by a SERVED handler run
  (default-app's `menuNewNote` → `navigateTo(Note({...}))` runs
  authoritatively in the wave); the client's speculative
  instantiation of the same child is refused at commit
  (`piece-start-commit-failed … read basis names speculative overlay
  layer(s)` — observed directly in the headless probe) and per
  speculation.md §4 (W2.1) the two runs' handler-frame-caused entity
  ids DIFFER — so every reader materializes the authoritative child's
  doc chain from pushes/store, and there is a real window in which a
  scheduler lift runs while the chain (result/process doc → internal
  cell) is not yet resolvable in the reading runtime's replica view.

Negative results that complete the picture (all green ON, same
toolshed): a client-authored creation of note.tsx (PiecesController),
an open-by-id from a bootstrap-created piece (MultiRuntimeHarness),
and a served `createNewNote` child creation that nothing demanded —
single-piece, low-contention flows in which the chain materializes
before any lift runs.

Against the register row's three candidates:

- **served value vintage** — NO: nothing stale is served; the read
  dies on a not-yet-materialized chain, and the durable state is
  complete and correct moments later (the functional flow passes).
- **schema default not applied** — as a SYMPTOM only: the leaf
  default is unreachable because the read never gets there; every
  leaf application site handles `default: null` correctly.
- **arrival ordering** — YES: a lift evaluated against a replica view
  in which its input's link chain is still arriving reads
  `undefined` where the OFF arm — which instantiates and reads in
  one runtime, synchronously with its own committed docs — always
  supplies the value.

## 4. The fix fork — FLAGGED, not decided (flag-don't-fill)

The root cause honestly names the RUNNER's read-dispatch semantics,
and the remedy is a contract decision between two arms:

1. **Defer-on-unresolved-chain (runner side).** A scheduler lift
   whose input chain is not yet materialized does not RUN with
   `undefined` — the run defers and re-arms on arrival. For the
   CLIENT this direction is arguably already SPEC-STATED:
   speculation.md §2's "Unreplicated inputs: a speculative read of a
   doc/path the client has not replicated is PENDING for that branch
   … the branch renders its ordinary loading state" — running the
   callback with `undefined` is at odds with that sentence. For the
   SERVER's serving runtime the equivalent is UNSTATED (the
   demanded-structure machinery defers loads, serving-loop.md §1/§3,
   but nothing states the lift-input pending rule) — new spec
   wording, scheduler-semantics blast radius, and a liveness design
   question (what re-arms the deferred run) make this an owner call.
2. **Lifts tolerate undefined during arrival (pattern contract).**
   Guard `body == null` in note.tsx (and every pattern like it).
   Small and immediately effective — but under OFF a schema-defaulted
   input NEVER reads undefined, so this quietly rewrites the pattern
   author contract ("your lift may see undefined for any input while
   docs arrive") for every pattern, exactly the change the register
   row says must be flagged rather than made.

Both arms change a stated or relied-upon semantic; neither is landed
here. The `integration/default-app.test.ts` ON skip STAYS (its entry
now points at this report); the OW51 register row records the root
cause and the flagged fork, and stays OWED pending the ruling.

## 5. Verification of what landed

No product code changed for OW51 (triage only — probes were
working-tree instruments, reverted). Docs: this report; the register
row updated in place; the skip entry's reason updated to carry the
root cause. The reproduction assets (crashing run's store + toolshed
log with the server-side stack) are preserved off-repo on the triage
bench.
