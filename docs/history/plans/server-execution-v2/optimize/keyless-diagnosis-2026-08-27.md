---
status: historical
created: 2026-08-27
archived: 2026-08-27
reason: "Diagnosis record: the OW45 r06/r09 'keyless stranded' member root-caused from the b1-lifts campaign's first local reproduction — not a stranded piece but a wrong-branch optimistic navigation (speculative read of usedCreateAnotherNote diverging from durable state), with the keyless-identity durability contradiction (Runner.setup stamps keyless refs durably against pattern-manager's own contract) as collateral, and a04 classified as the write-side mark-without-effects family; the distilled findings and the L1/L2/L3 owner questions live in verification-coverage.md OW45. Raw run artifacts stay off-repo at the measuring box (b1-lifts-evidence/)."
---

# r06/r09 keyless-identity stranded-piece member — root-cause report

Seat: server-execution v2 diagnosis, 2026-08-27.
Worktree: `/Users/berni/labs-worktrees/keyless-diagnosis`
(branch `claude/server-exec-v2-keyless-diagnosis`, base `e21c28f43`).
Evidence: `/Users/berni/labs-worktrees/b1-lifts-evidence/runs/default-app/`
(campaign head `4b70949ac`); all store citations are to the runs' own
sqlite stores, all code citations to current main (`e21c28f43` — the
relevant code is unchanged between the two heads).

## Verdict in one paragraph

The r06/r09 red is **not** a read/delivery death and **not** a stranded
whole piece. It is a **wrong-branch optimistic navigation**: the client's
speculative run of the notebook's final-"Create" handler read
`usedCreateAnotherNote` as false/undefined while the durable, authoritative
value was `true`, so it enacted `navigateTo(newNote)` optimistically —
navigation the server's authoritative execution of the same event
provably did **not** compute (no intent entry exists in any store). The
test's waits and diagnostics all read `view.pieceId`, which now names the
brand-new NOTE, so `isNotebook`/`noteCount`/`notes` read as
false/-1/empty forever and the step times out at its 300 s net. The
famous keyless `pattern-load-error` is **downstream collateral** of
mounting that freshly materialized note: the server had durably stamped a
session-keyless `patternIdentity` on one orphan sub-piece doc of the note
— a pointer no other session can ever load. Three separable defects, none
of them the five fixed mechanisms; the trigger and the signature are both
**design-gap class** (owner's), stated precisely below.

## The store facts (a03; a07 is byte-shape identical)

Notebook space `did:key:z6Mkqmsngb…7Vjf`, 60 commits
(16 authored / 44 derived).

1. **All keyless pattern pointers are durable and server-written.** 8
   distinct `keyless:fid1:…` identities, one per piece root (1 notebook
   + 7 notes), each written exactly once, always inside a **derived**
   commit (seqs 10, 24, 31, 36, 42, 48, 52, 57 — the piece
   materialization commits of the serving runtime,
   holder `did:key:z6MksHnZ…#88d64765`). Every GREEN run's store carries
   the same 8 durable keyless refs (verified a01–a10); the write is
   universal, not the red condition.
2. **The keyless docs are orphans.** The failing identity
   `keyless:fid1:0r4P8HEr…#default` lives on
   `of:fid1:FBvClKauu…` (argument = `/quote`-wrapped redirect to its
   reserved output spot `of:fid1:WU6FQJQzn…`, whose `result` points
   back). **No other durable doc references either.** They are reachable
   only through session-side structure; the client meets them by
   re-deriving the same deterministic doc ids when it runs the note
   pattern body itself.
3. **The event ledger.** The 7 create events are authored appends by the
   client session; their consequences are derived commits: seq 24
   (first "Create Another", patches `usedCreateAnotherNote`
   `of:fid1:pI89kQXf…` → **true**, 14:27:55), seqs 31–52 (the other
   Create Anothers), seq 56 (authored append of the final "Create",
   14:27:58), seq 57 (its consequence, 57 ops, 14:27:58): materializes
   the 7th note `of:fid1:qwyG5zdEXph…` (patternIdentity = the real
   compiled Note identity `U3pL8_F31Z…`), its orphan keyless sub-piece
   (fact 2), and patches `usedCreateAnotherNote` **true → false** —
   proof the authoritative run read `true`, i.e. computed
   `shouldNavigate = !true = false`.
4. **No navigation intent for the note exists anywhere.** The
   session-scoped effects doc (`of:server-execution-effects`) carries
   exactly one navigate intent in the whole run — the "New Notebook"
   click's, targeting the notebook `of:fid1:DyR4VHx0…` (seq 10, acked
   seq 11, idempotent re-append seq 12, cleared seq 13). Nothing ever
   targets the note.

## The log facts

- a03 `test.log`: TWO `set-view` lines in the failing step — 3.536 s →
  `fid1:DyR4VHx0…` (the notebook), **8.139 s → `fid1:qwyG5zdEXph…` (the
  new note)**. Every GREEN run has exactly ONE. a07: same two-set-view
  shape. a04 (the third red): ONE set-view — a different class (below).
- One client-worker error, 14:27:59.482:
  `pattern-load-error Failed to load pattern keyless:fid1:0r4P8HEr…#default`
  — ~1.5 s after the navigation, the identity durably minted by the
  server in seq 57. No `unloadable-pointer-rolled-forward`, no
  `Unknown pattern`, nothing else.
- The #6224-armed decisive line
  (`deferred-start-catchup-failed …resolved without the piece running`,
  runner.ts:3994/4012) **did not fire — and could not have**:
  `deferred-start-catchup` itself was 0 campaign-wide (ensure-ON
  posture, no start deaths). Its absence is decisive in the other
  direction: these reds are not the catchup-resolved-without-running
  variant.
- The failure diagnostics that the register recorded as "every read of
  the piece returns nothing" are reads of the WRONG PIECE:
  `collectNotebookRenderState` / `notebookSourceStateMatches`
  (`packages/patterns/integration/default-app.test.ts:3256`, `:1766`)
  read `globalThis.app.serialize().view.pieceId` — after the stray
  navigation that is the NOTE. `isNotebook:false, noteCount:-1,
  notesLength:0` is what a healthy note looks like through notebook
  glasses, and the "84 stored UI note chips" live in the NOTE's `$UI`.
  The piece was never unreadable; the diagnostics followed the view.

## Causal chain (a03/a07, and the entry's CI charge)

1. `notebook.tsx:751` (`createNoteAction`):
   `shouldNavigate = !usedCreateAnotherNote.get()` →
   `navigateTo(newNote)`. Six prior "Create Another" runs set the flag
   true; durable state says true from seq 24 on.
2. Under EXPERIMENTAL_SERVER_EXECUTION the client's handler run is a
   speculative echo (overlay-destination.ts): its writes never commit,
   and `navigateTo` **optimistically enacts** in the speculative run
   (`optimisticNavigate`, navigate-to.ts:335 — "navigation is
   reversible, so the speculative run still enacts"). The client's
   speculative run of the final Create read the flag false/undefined and
   navigated. The authoritative run read true and wrote no intent
   (store facts 3–4). Nothing withdraws an optimistic enactment whose
   authoritative counterpart resolves "no effect" — the convergence
   contract (protocol.md §5 nonce convergence) only covers the
   *intent-arrives* case.
3. The navigation forces the client to mount the note. The client runs
   the note pattern body, deterministically re-derives the orphan
   sub-piece doc id, instantiates it live with its OWN session-keyless
   mint (hash C), and arms the patternIdentity watcher
   (runner.ts:3007). The server's seq-57 doc arrives carrying the
   server's keyless mint (hash S ≠ C); the watcher load fails
   (`pattern-load-error`, runner.ts:3045) and the CT-1923 roll-forward
   **correctly refuses** (runner.ts:3069 — the running ref is itself
   keyless). The sub-piece pointer permanently names an identity no
   session can load; nothing re-fires. This is the register's recorded
   r06/r09 signature — real, but collateral: it strands one orphan
   sub-piece, not the notebook, and not the step.
4. The step then fails on its own instruments: every wait reads
   `view.pieceId` = the note → 300 s → RED. The CI ON-unskip artifact
   (run 33008274232 shard 5: same fingerprint, ZERO load errors) is the
   same chain with step 3's hash race falling the other way — the
   navigation alone produces the full client fingerprint, load error
   optional. This unifies the entry's current charge with r06/r09.

Why 2/10 and quiet-biased: the wrong-branch read requires the final
click to land in the window where the six speculative echoes have
retired (watermark-driven, speculation.md §4) while the client's
confirmed base for the flag doc still predates seq 24.
`usedCreateAnotherNote` is read only inside handlers — no
derivation/render demand — so under lazy materialization nothing pulls
the authoritative patch to the client replica; echo retirement then
exposes the stale base ("the authoritative value replaces the echo" is
demand-gated and can regress). On a quiet box the server materializes
and the watermark advances fastest relative to the click burst — the
retirement can beat the final click. Both reds were quiet; the lunch
campaign recorded the same quiet-arm-worse skew. The divergent-read
mechanism is the one link inferred from design rather than witnessed
(the overlay is process-memory; no client trace exists) — flagged, not
filled: the two candidate windows are echo-retirement regression
(above) and plain confirmed-base sync lag; both produce the same
wrong branch.

## The write-path answer (register question)

`Runner.setup()` stamps `patternIdentity`/`patternSetupIdentity` durably
for keyless patterns because `entryRefForPattern` (runner.ts:1756) NEVER
returns undefined — it mints `keyless:<structure-hash>` for hand-built
patterns (pattern-manager.ts:527 `ensureKeylessPatternIdentity`) — while
the stamping site's guard `if (entryRef)` (runner.ts:2315) was written
believing "a KEYLESS hand-built pattern has no entry ref and so gets no
durable pointer" (the comment three lines above). The inner comment at
runner.ts:2320 already admits the opposite ("that pointer is stamped
durably like any other"). When setup runs in the serving runtime, the
stamp lands in a derived commit — the durable keyless writer. A second
sanctioned writer exists: `substituteOpPatternRefs` (runner.ts:7576)
writes `$patternRef: {identity: "keyless:…"}` into map/filter/flatMap
inputBindings, pinned by stored-pattern-rehydration.test.ts. Both
contradict pattern-manager.ts:543: "such refs must never be written into
durable state."

## The strand answer (register question)

Nothing re-fires because every recovery is correctly gated out:
the CT-1923 roll-forward refuses when the running ref is also keyless
(runner.ts:3069 — rolling forward would poison the store with the
reading session's own keyless ref); `loadPatternByIdentity` has no
closure to load for a keyless identity (session-only by construction);
and the deferred-start catchup never arms (no start died). The strand is
permanent by design given the durable keyless write — the defect is the
write, not the absent re-fire.

## a04 — classified: a different member (write-side loss)

One set-view (no navigation), zero load errors, notebook live with
noteCount 5/7. Store: all 7 create events durably appended (clientSeq
5–11), all 7 marked `consequenced: true` — but the consequences of
clientSeq 10 (6th Create Another) and clientSeq 11 (final Create) are
**1-op, 802-byte derived commits that carry ONLY the consequenced mark**
(seqs 53, 56) — no note materialization, no flag write, nothing. A
healthy consequence (e.g. seq 49) is 19 ops. Two user actions
permanently lost: the mark makes the drain never re-dispatch, and a
dropped first-ever run leaves no basis rows to re-run it (the D3
basis-row gap record, verification-coverage.md:6479). This is the
lunch FILE entry's write-side family, NOT r06/r09: the §3d
mark-vs-effects atomicity break (the mark survived contributions that
did not) is its own defect and needs the owner's §3d disposition. The
final Create being one of the two lost events is also why a04 did NOT
navigate.

## Fix-or-design-gap

No code fix landed; all three layers end in unstated semantics that are
the owner's to rule (mandate: flag, don't fill):

- **L1 (trigger): speculative-read regression.** speculation.md §4's
  "the authoritative value replaces the echo" is demand-gated;
  retirement is coverage-gated. For handler-only docs (no render/derive
  demand) the replacement may never arrive and a later speculative run
  reads the pre-echo base. Options: gate retirement of an entry on the
  ARRIVAL of authoritative values for the docs it wrote; or demand-pull
  written docs at retirement; or pin handler-read basis docs into the
  client's demand set for the session.
- **L2 (the standing wrong effect): optimistic-enactment withdrawal.**
  optimisticNavigate's premise "navigation is reversible" has no
  reversal mechanism for the branch-divergence case (authoritative run
  computes NO effect). Options: on the event's consequences arriving
  without the matching intent nonce, un-enact (navigate back / re-enact
  the authoritative view state); or suppress optimistic enactment when
  the deciding read's basis is speculative/uncovered (a cousin of the
  existing attempt-minted skip at navigate-to.ts:352).
- **L3 (the signature): the keyless-durability contradiction.** Two
  code paths durably write `keyless:` refs (one pinned by tests as
  sanctioned), against pattern-manager.ts:543's "never durable"
  invariant, and the CT-1923 arm treats durable keylessness as
  can't-happen. Under server execution the same-session assumption
  behind both writers is structurally broken (the server materializes,
  other sessions read). Options: stop stamping keyless pointers in
  setup (restores the stamping site's own claimed contract; readers get
  the designed `no-pattern-meta` verdict instead of a poisoned
  `pattern-unloadable`); or make hand-built sub-patterns loadable
  (persist a program closure / compile them content-addressed), which
  is the only option that makes served piece trees fully mountable by
  other sessions. The identity-assignment semantic — may a durable
  piece tree ever contain a pointer only one session can load — is
  exactly the "unstated identity-assignment semantic" class named in
  the seat mandate.

An honest scope note: fixing L3 alone would NOT have greened a03/a07
(the verdict came from L1+L2); fixing L1 or L2 alone leaves durable
poison pointers in every store. The ON-skip entry's charge is L1+L2;
its recorded signature is L3.

## Register corrections made (this branch)

- The r06/r09 "durable pointers all REAL / keylessness is session-side"
  claim corrected: durable keyless pointers exist in every run at this
  head, written by the serving runtime's derived commits (a03 seq 57).
- Root cause appended to the 2026-08-27 campaign row; a04 classified as
  the consequenced-mark-without-consequences write-side member.
