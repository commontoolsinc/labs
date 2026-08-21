---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "First-ON-CI-gate evidence: the three ON render-stall surfaces root-caused — NO demand hole; every red a write-path defect (program write lost + carriage-refused server fallback; served rows with service identity; client binding-write never commits); two surfaces converge on the owed OW31/§2b carriage build; fix seats S-A..S-J."
---

# ON render-stall root cause — the three "rendered value never appears" surfaces

Investigator: read-only on the branch (scratch edits reverted; worktree clean). Worktree `/Users/berni/labs-worktrees/land-off` @ `ba50f8961`.
Date: 2026-08-20/21. Status: **COMPLETE for the land-gate question** (each surface classified with store/log/live-run evidence; the one client-internal seam not fully traced is named in §6).

## 0. Headline

**DEMAND HOLE: NO — on all three surfaces.** None of these is the W0 §2.8(b) refutation shape (a rendered value whose writer is outside the tracked-ids demand closure). The (d′) demand machinery came out clean everywhere it could be observed: where the serving loop had the structure and the inputs, it derived (group-chat: 33–41 derived commits, demand counters healthy, settle series normal; home-profile: the identical Grace case derived the name with 72 basis rows). Every "value never appears" here is a **write-path defect under ON**: a write that no longer lands (program materialization lost at reload; client draft write never commits), a write that lands with the wrong identity (service-labeled authorship), or an action killed at commit-prep before it can write (CFC asserts/compile refusals). Bounded seams, each named below — not the serving loop's demand model.

Meta-family: the ON design re-homed *derivation* to the server and guarded *writes* by serve-ownership/authority — and each surface is a write whose new home is either dead (refused, no carriage), lost (raced by reload / silently dropped), or mislabeled (service identity). The demand walk's deletion is not implicated.

## 1. Surface 1 — home-profile-reload-durability: profile name renders `#id` placeholder forever

### Mechanism (3 sentences)
Under ON the CreateProfile flow splits: the served event-handler run commits the new profile space's piece SETUP cross-space (server-authored; lands fine — the name is durably in the argument), but the piece's PROGRAM (code + CFC labelMap + schema docs) is only ever written by the client's own local run as a separate post-arrival commit — and the server's fallback, the `compile-cache/writeback/<patternIdentity>` action running in the HOME space's wave, is **refused by the wave accumulator as a foreign-space write with no §2b delegated carriage** (serving-loop.md §3d, RULED 2026-08-14 (c)) — `seal-space-commit-failed`, 17 refusals per profile space in one run. The reload kills the trailing create's client-side program commit (it is issued after `waitForRuntimeIdle` returns, because the handler no longer runs client-side at create time), nothing ever re-issues it, and the profile space's serving loop — started, watermark written, piece demanded — parks the structure load forever in the non-terminal "unloadable pattern awaiting its source docs" branch (`space-server.ts` ~2818: `structureLoadDeferred`), silently. The demanded computed name docs (pre-created ids in the setup) never receive values; the client, which does not re-derive served work, renders the `#3GsWo8`-style id fallback forever.

### Evidence
- Store (`…/scratchpad/on-store/…`): Ada's profile space `z6MkooEW…`: seq1 space-create, seq2 derived watermark=1, seq3 server-authored setup (403,086B, 66 ops, `patternIdentity {identity:"Jlzs0wulc…", symbol:"default"}`, `{"initialName":"Ada Lovelace"}`), then NOTHING. `scheduler_basis` rows: **0**. Alan's space `z6MkoBbg…`: identical, 0 rows. Grace's `z6MkrM4z…`: same + **seq4 client-session authored commit (124,973B): the program** (`of:…code` 45KB, CFC labelMap 78KB, `cid:` schema) → seq5 derived `computed:… add /value "Grace Hopper"` → …; **72 basis rows**. The trailing create before each reload (Ada in step 1, Alan in step 2) is the one whose program commit is missing — matching the test's own "the trailing create's commit had the least time" framing, resurfacing on a new write class.
- Server log (`toolshed-on.log`): 77 `foreign-write-refused` + 77 `seal-space-commit-failed` during the test window (05:33:42–05:38:50): `compile-cache/writeback/Jlzs0wulc…` 17× against EACH of the three profile spaces (also refused against Grace's, where it didn't matter — the client write had landed), plus `cf:module/Jlzs0wulc…:{__cfLift_1,__cfLift_4,applyInitialName}` 26× against Grace's space (the home wave also ran the profile module cross-space and was refused writing its results — her name derived only because her OWN space's loop ran it).
- No wave ever served Ada's space ("wave serving z6MkooEW": 0 lines); no error names her space from its own loop — the wedge is fully silent (no `structureLoadFailures`, no log).
- OFF control (live, this session): `home-profile-reload-durability` OFF = **green in 11 s** (run `rc-home-profile-off`). CI shard8's ON failure text is byte-identical in shape to the local one.

### Classification
**Server-never-derived, demanded-but-structure-missing** (write-availability), composed with a client-side durability gap (the program write is issued after the idle barrier and dies with the reload; post-reload adoption never re-materializes). NOT a demand hole — demand reached the piece; the identical demand derived Grace's name.

### Bounded or structural?
Bounded, with a named owed seat: the write-authority carriage (§2b: acting identity + capabilityRef) that OW31's post-merge build owes is exactly what the dead server-side writeback path needs. The silent-forever park is a detectability sub-gap (OW19-adjacent).

### Fix seats (named, not built)
- **S-A (server, primary):** give `compile-cache/writeback` a legitimate write path into the piece's own space — either §2b delegated carriage (the OW31 build) or a RULING that program/compile-cache materialization docs are system-class, content-addressed, idempotent writes exempt from the foreign-write refusal. This also heals already-broken spaces on next demand.
- **S-B (client):** cover the program-materialization commit with the pending-commit durability barrier (`Scheduler.idleWithPendingCommits`) so `waitForRuntimeIdle` cannot return before the program is durable — restores the exact contract this test pins.
- **S-C (client):** re-issue program materialization on adopt/open when the space lacks the program docs for a referenced patternIdentity (heal-on-read).
- **S-D (observability):** the "unloadable pattern awaiting source docs" deferral must count/log after N cycles (today it is a silent forever-park; `structureLoadFailures` stays 0).

## 2. Surface 2 — cfc-group-chat-demo "gates sends through the trusted surface"

Two distinct defects, one per failure point. Neither is a demand hole; neither is a double-render (that reading is refuted below).

### 2a. CI shape (fails at Alice's authorship check, test line 154): served writes carry the SERVICE identity
Mechanism: under ON the trusted send is an events-down handler run on the serving runtime, and its durable consequence — the message row — is labeled `authored-by` / `represents-principal` **`did:key:z6MksHnZ…` (the service signer), not Alice**; the CFC authorship verification compares the row's claim (name "Alice") against the resolved value's authored-by label, so `state` stays `"unverified"` forever and the verified row never appears. Store proof from the LOCAL runs (not just CI): Alice's message commit (seq 37, derived) carries authored-by ×4 and represents-principal ×2, ALL `z6MksHnZ…`; Bob's profile entity labelMap likewise. The local runs passed this check only because the client's own speculative (Alice-labeled) copy was still what rendered at probe time — the durable truth is identical to CI's. This is the **protocol.md §2 "server-produced authored row" / §2b acting-identity carriage** that the foreign-write refusal message itself names as missing, i.e. the **OW31 write-authority build (explicitly owed post-merge, pre-flip)**. Deterministic once the served copy is what renders; bounded; known-owed.

### 2b. Local shape (fails at Bob's send click, line 197): the client's draft write never commits, so the served `sendDisabled` correctly never flips
Mechanism: `sendDisabled = computed(snapshot === undefined || draft empty)` (trusted.tsx:1060–1063; disabled bound at :1101). Bob's profile save works end-to-end (his session commits the draft + save event; the server derives his myProfile, the per-user computeds, and the participants row — seq 40–45 + 26 service-session user-scope sets). But **Bob's `messageDraft` write — a `$value` binding patch on the piece root's user-scope instance doc, the exact op that landed for Alice (`patch user of:rPncV5… /value/messageDraft`) — never reaches the store**: 0 occurrences of "Hello from Bob" in 4 independent runs, including a 300-second probe run (scratch test edit, reverted) in which Bob's session committed **12 other writes** (seq 41–62) while the draft patch never appeared and `#trusted-send-button` stayed `disabled=true` for the full 300 s. With the inner native button `disabled` (cf-button reflects it onto the shadow `<button>`), the trusted click's hit-target retargets to the `cf-button` host — which is exactly the observed chain `cf-button#trusted-send-button < slot < div < cf-hstack`. **The "click lands on a DIFFERENT instance" reading is wrong: it is the SAME, disabled instance retargeting the click to its own host.** (Two "Send" texts in the body = host send + trusted send, both by design.)

Classification: **client-write-never-lands** (a user input into a serve-owned user-scope instance doc, after an identity switch, wedged permanently client-side) → the served derivation is correctly stale — server-side demand, derivation, and delivery all clean. The value shown in the input is the client's local overlay; the durable write never exists, so no server-side heal can ever converge it (opposite direction from the swatch stall's delivered-but-masked).

Fix seats (named, not built):
- **S-E (client, primary):** trace and fix the `$value`-binding commit path for served-instance user-scope docs after `shell.login` — candidates: an overlay entry whose origin commit was withdrawn on a wave race and, being a non-re-derivable USER write, is silently dropped (the "its own reads re-run it when fresh state lands" premise of serving-loop.md §3d does not hold for inputs — same which-direction hazard as the scheduler's logged "dropping the write without retry" class), or a flush queued behind the arrival/echo gate that never drains. Needs one instrumented client build; §6.
- **S-F (barrier):** whatever the wedge, `waitForRuntimeIdle`'s pending-commit barrier did not see this write as pending (idle returned with the write unfl ushed) — the barrier must cover binding writes into served docs.
- **S-G (test aim, secondary):** line 197 clicks without `waitForDisabled(false)` (unlike line 147/148) — under ON the enable is a served round-trip, so the wait belongs there regardless; it does NOT fix the wedge (proven: 300 s).
- OW31's carriage (2a's seat) is independent of 2b.

Flagged observation (not this surface's cause, non-fatal in the flow): a served event-handler commit was CFC-rejected ~6–7 times then "dropped without retry" — `missing trusted-event policy input for of:fid1:JdAxhXro… at /messages/*` (fresh-run toolshed.log, 39 lines) — possibly the designed host-send gate firing through an error-shaped path ("relevant transaction was not prepared"), possibly a served-trusted-event prep gap. Worth a look before flip; flag-don't-fill.

## 3. One family or not (the coordinator's question 2)

**Not one mechanism.** home-profile = program-write loss + write-authority-refused server fallback; group-chat-CI = service-identity labeling (OW31); group-chat-local = client binding-write never commits. What they DO share: all three are **client-or-carriage write-path integrity under ON**, none is demand/derivation — and two of the three (home-profile S-A, group-chat 2a) converge on the same owed OW31/§2b carriage build. The triage's "one family" hypothesis holds only at that meta level.

## 4. Surface 3 — profile-embed: the wish UI (`#wish-profile-name-input`) never renders

Two deterministic killers stacked on the same wish path; which one you see depends on whether compiled bytes are available. Both kill the wish UI before it mounts; the OFF control (live run `rc-profile-embed-off`) is **green in 12 s**.

### 4a. The `ifc inside divergent anyOf branches` assert (the CI shape) — verdict: **pre-existing assert × ON-shaped input** (option (a), with a caveat)
- The assert (`assertNoDivergentIfcBranches`, `packages/runner/src/cfc/schema-merge.ts:336`, via `mergeCfcSchemaEnvelopes` ← `prepareBoundaryCommit` `cfc/prepare.ts:5428`) is **main's code** — introduced by #3263, last touched by #4969 (CT-1895); `cfc/schema-merge.ts` / `cfc/prepare.ts` appear nowhere in the train's touched-file set.
- It fires inside a `raw:wish:` action's commit-prep on the **browser runtime** (CI shard6: `[ERROR][scheduler] … raw:wish:nPX8lxMfKnKp`, then `SES_UNHANDLED_REJECTION`), killing the wish action, so the wish UI never mounts.
- OFF: the identical wish flow passes — so the /result envelope only becomes divergent-ifc-carrying under ON (served/instance schema envelopes merged with the local one at the boundary commit). The profile schema family is documented as divergent-union-branch-prone (`packages/patterns/system/profile-home.tsx` comments: defaults placed outside the CFC wrapper precisely to avoid "divergent CFC union branches"; the `BackwardsCompatibleProfile` consumer view).
- So: the LIMIT is pre-existing and deterministic for any envelope with that shape ("bounded, known-class: served-wish CFC prep"), but the SHAPE arriving at the assert is a train-posture product — under OFF this flow never produces it. Calling it purely pre-existing would be wrong; calling it train-introduced code would also be wrong.

### 4b. The `Can't load profile-create.tsx` TransformerError (the local shape) — verdict: **main's day-old rule, exposed by the ON compile posture**
- The rule is `packages/ts-transformers/src/transformers/reserved-result-keys.ts` — created by **#6098 (`2284f3a08`, on origin/main, landed 2026-08-20 16:52, the day before the first ON CI run)**: "a result may not declare its own screen opaque" ($UI declared `unknown` at a result root).
- Locally (fresh stores, no byte cache) the SERVER fails to load `profile-create.tsx` and `profile-picker.tsx` with this error (pointing into `profile-home.tsx:636:16`), during profile-embed AND home-profile windows; the wish/system-pattern derivation on that side is dead. In CI the compile byte-cache / in-store compile cache (`compile-cache-hit compileToRecordGraph`) skips fresh transformation, so the wish RUNS and dies at 4a instead — which is why CI and local show different proximate errors for the same dead wish.
- The OFF arm compiles the same files green (live run), so the rule trips only in the ON serving-path compile posture (the schema-generator emission the serving side needs — the restored C.1 certificate surface — walks the result schema strictly). The pattern files are byte-identical to origin/main.
- Follow-on: the failed error-UI reporting ("Can't report … in the surface it belongs to", StorageTransactionInconsistent) means even the red error surface lands at most once.

Fix seats (named, not built): **S-H** decide the rule × system-patterns composition (either the wish/system patterns get compliant `$UI` typing on main, or the serving compile relaxes the #6098 check for the consumer-view position it currently trips on); **S-I** the divergent-anyOf envelope needs either a merge rule for ifc-in-anyOf at /result or the served envelope normalized before merge — CFC-owner call; **S-J** wish-action commit-prep failures should surface in the wish UI (today: silent never-mount, `pendingIpc` empty, 1 subscribe).

## 5. Verification inventory

| probe | result |
|---|---|
| triage local logs (all 3 surfaces) | read; shapes confirmed |
| CI shard5/6/8 failure bodies | read; group-chat CI = authorship-unverified (NOT the click); home-profile CI = same as local; profile-embed CI = ifc assert |
| store archaeology, on-store/ (home-profile: 5 spaces; group-chat: 3 spaces) | as in §1/§2 |
| toolshed-on.log sweep | 77 foreign-write refusals; TransformerErrors; 0 piece-start-commit-failed server-side; 0 "divergent anyOf" server-side |
| live: profile-embed OFF | green 12 s |
| live: home-profile OFF | green 11 s |
| live: group-chat ON (fresh store ×2, incl. 300 s disabled-wait probe) | red, same point; Bob draft absent from store both runs; button disabled 300 s; stats: demand counters healthy, `foreignWriteRefusals: 0`, `structureLoadTerminal: 51` (benign no-pattern-meta parks, OW19) |
| scratch test edit | reverted (`git checkout`; worktree clean) |

Prior-art alignment: the swatch-stall report (delivered-but-masked; diverged overlay; W-freeze) is the nearest relative of 2b but is a DIFFERENT direction (there the durable truth was right and masked; here the durable write never exists). The OW43/undemanded-pull class was not observed on these surfaces.

## 6. What was NOT determined (flagged, not filled)

1. **2b's exact client seam**: whether Bob's draft write dies as a withdrawn-overlay origin commit (non-re-derivable write dropped) or an unflushed queue behind the arrival gate — needs one instrumented client build; the store can't see it. Also whether the identity switch (`shell.login`) is a necessary condition.
2. **4a's envelope**: which anyOf branches diverge at /result (served vs local schema vintage? instance-keyed envelope?) — needs an envelope dump at `prepareBoundaryCommit`.
3. **The wish compile's division of labor under ON** (client vs server) — the TransformerError is proven server-side; the client's fresh-compile behavior under ON was not isolated.
4. The `/messages/*` CFC "missing trusted-event policy input" rejection storm: designed host-gate vs served-trusted-event prep gap.
5. Whether main's #6098 rule also breaks any OFF-lane server-adjacent compile (nothing observed; OFF lanes green).
