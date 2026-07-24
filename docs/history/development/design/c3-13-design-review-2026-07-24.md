---
status: historical
created: 2026-07-24
archived: 2026-07-24
reason: "Adversarial DESIGN panel over the C3.13 (served foreign-read value carriage) design; 3 lens-diverse skeptics + a code-verifying judge against tree head 37f657fd3. 9 raw findings -> 6 binding amendments (CV1-CV6), 1 refuted. ROOT DESIGN RULED SOUND (the loadRoot hook + validate-skip preserves the seq-domain invariant and same-space byte-identity; the validate-skip is load-bearing). The two serious amendments are acceptance-integrity: CV1 the gate value-clause is vacuous unless pinned to the SETTLED server value; CV2 the C3.13-2 fixture harness has no Runtime. Drives the build."
---

# C3.13 Served Foreign-Read VALUE Carriage — Code-Verifying Synthesis

## Synthesis summary (archive-header style)

**Panel:** adversarial DESIGN review of `c3-13-design-2026-07-24.md` against labs tree head `37f657fd3` (branch `codex/server-execution-w1-2-shared-pool`). **Raw:** 9 skeptic findings. **After dedupe + re-verification:** 6 binding amendments (CV1–CV6) — 2 serious (acceptance-integrity), 2 minor (rationale/plumbing), 2 note (citation/wording). **1 raw finding REFUTED at its headline** (#5, "R4 is OPEN") — the seq-domain desync it alleges is closed by enqueue serialization, verified below.

**ROOT-DESIGN RULING: SOUND.** The `loadRoot` foreign-read hook + `validate()`-skip preserves the seq-domain invariant and stays same-space byte-identical. The two blocker-class checks the panel was charged to break both PASS:

- **Seq-domain leak (R1) — NOT PRESENT.** The value arrives via a pure `#foreignMounts` `Map.get` (v2-host-provider.ts:2254); no home seq is read or advanced. `buildReads` drops every `read.space !== this.#space` (v2.ts:4730) and `compactCommitReads(this.#space,…)` re-filters (v2.ts:4811-4812), so a B-seq cannot reach `#confirmedSeqByLocalSeq`/pending-read. The read-activity push is value-source-independent — it fires under `space: address.space` at v2-transaction.ts:1294-1306 *before* the value is read, unchanged by the fix. The stamp set is untouched (`entry.seq` at executor-worker.ts:1098; `entry.document` still dropped). **R3 (floor re-poison) holds by the same fact.**
- **`validate()`-skip hiding a home race (R5) — NOT PRESENT.** `claim()` genuinely rejects the mount-served commit without the skip (attestation.ts:146 re-reads the empty B replica → `expected {value} ≠ actual undefined` → `StateInconsistency` at 162), confirming the skip is *load-bearing*, not cosmetic. `mountServed` is set only when `foreignReadDocument` returns a foreign mount entry, and `#foreignMounts` can never hold a home entry (writes gated on `outcome.status==='served'`, v2-host-provider.ts:2226; a home read can never be 'served', guard at :482) — so no home doc can ever be marked `mountServed`. The skip cannot mask a local race.

**Contested owner-defaults ruling:**
- **D1=a (transaction hook + validate-skip): SOUND.** The seam is reachable and correct. Correction only to its "5 surgical touch points / byte-identical" framing (CV4).
- **D2=a (skip `claim()` for mount-served): SOUND.** R5 verified — foreign consistency is the C3.5-basis/C3.8-fence's job; local `claim()` guards local-replica races that do not exist for a point-read snapshot.
- **D6=a (read the mount live at `loadRoot`): DECISION SOUND, RATIONALE FACTUALLY WRONG (CV3).** Value+stamp are atomic — but because of **enqueue serialization**, not "monotonic ingestion." #5's push to ship D6=b snapshot / D1=b is **not required** and is not adopted.

**Blockers clustered (acceptance integrity):** CV1 + CV2. Neither invalidates the ROOT seam; both would let C3.13 ship *unproven* (a green gate that is green pre-fix, and a WO fixture that cannot execute a derivation). These must land with the design or the red-green discipline is vacuous.

---

## Verdicts (per raw finding)

| # | Claim | Verdict | One-line reason (code-verified) |
|---|-------|---------|----------------|
| 1 | WO-3 acceptance vacuous via `readerDoubledSeen` membership | **CONFIRMED** | Gate records `readerDoubledSeen` "NOT asserted" (gate:913-916); post-wake barrier *blocks until* the client-primary recompute pushes (gate:738-740), so the correct value is in the stream pre-fix; only the settled server value distinguishes fixed/broken. |
| 2 | R4/D6 rationale wrong; serialization is the real bound | **CONFIRMED** | Both mount writers ride the serial `work` queue (`enqueue` chains off prior tail, executor-worker.ts:220-221); refresh is a *separate* enqueued item (:1277). Monotonicity (v2-host-provider.ts:2234) only forbids rollback. |
| 3 | R2/D3 mis-cite :482 as the mount-populate seam | **CONFIRMED** | `#foreignMounts` doc-write is at v2-host-provider.ts:2235 inside `readForeignDoc`, gated on 'served' (:2226); :482 is the serve-authorization/route guard and writes nothing. Conclusion (home never mounted) holds via a multi-hop path. |
| 4 | `loadRoot` cannot set `DocumentEntry.mountServed` as written | **CONFIRMED** | `loadRoot` returns a bare `RootAttestation` (v2-transaction.ts:2289-2297); the `DocumentEntry` is built by the *caller* `document()` at :2256, after `loadRoot` returns. |
| 5 | Recommended trio leaves R4 desync OPEN; ship snapshot/D1=b | **REFUTED (headline)** | Both value-read (`loadRoot` in `scheduler.run`, :1521) and stamp-read (`route()` at action-transaction-router.ts:393-394, before `afterRouteSelected`→`markRouted`→`routeReady` :1526) fall inside the *single* enqueued `startClaimedAction`; the only mid-run writer is a separate serial work item that cannot interleave. Its rationale-critique is real (→ CV3). |
| 6 | C3.13-2 misscoped: `setupForeignHarness` has no Runtime | **CONFIRMED** | Harness returns `{server,frames,storage,provider,lease,claimRef,claim,other,otherSeq,close}` (test:264-283); no `new Runtime`/`computed`/`scheduler.run`/`.sink` in the file — cannot fold a real derivation. Alt Runtime-over-HostStorageManager fixtures exist. |
| 7 | C3.13-3 vacuous (dup of #1) | **CONFIRMED (dedupe→#1)** | Same root cause; folded into CV1. |
| 8 | `loadRoot` mountServed / touch-point short by one (dup of #4) | **CONFIRMED (dedupe→#4)** | Same root cause; folded into CV4. |
| 9 | Defect mechanism mis-states `create()` throwing on the read path | **CONFIRMED** | `open()` builds `Provider` with a *lazy* `createSession` closure (v2.ts:1364-1369); `create()` throws only when invoked (v2-host-provider.ts:2052), not on a sync `getDocument`. `open(B)` does **not** throw → `loadRoot` *is* reached (reinforces seam validity). |

---

## Amendments (binding)

### CV1 — [serious] WO-3 / C3.13-3 must bind to the SETTLED server-authoritative value; forbid the `readerDoubledSeen` membership form
*(from #1, #7)*

The gate's `readerDoubledSeen` stream **already contains the correct `2×foreign`** before the fix: defect (ii) is falsified (reader recomputes client-primary, gate header:85-97), and the post-wake barrier at gate:738-740 blocks until that speculative value is pushed. The broken serve (0) only clobbers it *later* on the covered overlay drop. Any `readerDoubledSeen.some(v => v === 2×foreign)` / "reaches 10" assertion is therefore **green pre-fix**.

**Amendment:** In WO-3, strike the "`readerDoubledSeen` (line 603) **and/or**" hedge. Pin the served-value clause to the **settled server-committed** value, asserted only after proven quiescence:
- assert `xsp-gate-result.doubled == 2×foreign` read either (a) from a **fresh client** sync (nonNeg-style, gate:853-858) that never carries the reader's overlay, or (b) as the reader's revealed value **strictly after** `basisCoveredOverlayDrops == claimedOverlayRoutes` (gate:754-755) *and* pool idle — the last value once nothing follows.
- **Explicitly forbid** any `.some(...)`/`.includes(...)`/"transits" membership form on `readerDoubledSeen`. Red = 0 pre-fix, green = `2×foreign` post-fix. Name the committed-doc assertion as *the* binding surface in the WO row.

### CV2 — [serious] Retarget C3.13-2 at a Runtime-backed-by-`HostStorageManager` fixture; `setupForeignHarness` cannot run a derivation
*(from #6)*

`setupForeignHarness` (executor-provider-foreign-point-reads.test.ts:173) yields a raw `HostStorageManager`/provider and drives `readForeignDoc`/`foreignDocument` directly — **no Runtime, scheduler, or computed graph** — so it structurally cannot execute `computed(() => (source.get() ?? 0) * 2)` through `loadRoot`. The `VALUE = 82` (=2×41, the harness's foreign doc value at test:214) assertion is sound *only* through the real `loadRoot` path.

**Amendment:** Re-scope C3.13-2 onto a `Runtime`-over-`HostStorageManager` fixture in the style of `test/fixtures/server-execution-product-client.ts` (`HostStorageManager.connect` + `new Runtime`) or `executor-candidate-claim.test.ts` — define a real cross-space-linked `source` (`link.space = READ_SPACE`) and `computed doubled`, run through `runtime.scheduler`, assert folded `VALUE = 82` (red before C3.13-1). Alternatively extend `setupForeignHarness` to construct that Runtime. Update the WO row: it still adds no production code, but "test-only rides C3.13-1" understates the runtime-harness wiring it requires. Move the R6 deep-path assertion onto this same runtime fixture.

### CV3 — [minor] Rewrite the R4 mitigation and D6(a) rationale to cite enqueue serialization; record it as a binding constraint with a regression guard
*(from #2; subsumes the correct half of #5. #5's remedy — default D6=snapshot or adopt D1=b — is NOT adopted: serialization already closes R4.)*

D6(a)'s "monotonic ingestion means no rollback" and R4's "synchronous run→observe→route flow" are both false as stated: monotonicity fixes only the *direction* of a desync, and the route is explicitly async (executor-worker.ts:1508-1511). The property that actually makes value+stamp atomic is **enqueue serialization** — verified: both mount writers (`hydrateForeignReadMount` :1505, `refreshForeignMountForWake` enqueued at :1277) ride the single serial `work` queue (:220-221), and both the value-read (`loadRoot` during `scheduler.run` :1521) and the stamp-read (`route()` at action-transaction-router.ts:393-394, before `routeReady` resolves at :1526) execute inside the *one* enqueued `startClaimedAction` item — so no wake-refresh can interleave.

**Amendment:** Replace the R4/D6(a) rationale with the serialization citation above. Record a **binding constraint**: R4 becomes reachable — and D6(b) snapshot-at-run-start then becomes required — if *either* the stamp read or the accepted route is moved outside the enqueued `startClaimedAction` item (the :1510-1511 comment already carves "eventual accepted settlement" out of the work lane), *or* if either mount writer leaves the serial queue. Add a WO-1 note / regression assertion pinning that the stamp read stays inside the run item.

### CV4 — [minor] Thread `mountServed` out of `loadRoot` (or hoist the consult into `document()`); count it as a 6th touch point
*(from #4, #8)*

Step 3's prose ("`loadRoot` … mark the `DocumentEntry` `mountServed`") is not implementable: `loadRoot` returns a bare `RootAttestation` and the `DocumentEntry` is constructed by `document()` at v2-transaction.ts:2256 afterward. `DocumentEntry` is a union (`ReadDocumentEntry | WritableDocumentEntry`, :127), so the flag needs a declared home.

**Amendment:** Either (a) widen `loadRoot`'s return to `{ attestation: RootAttestation; mountServed: boolean }` (update **both** the `data:` inline branch and the normal branch) and set `doc.mountServed = loaded.mountServed` in `document()` at :2256-2259; or (b) hoist the `foreignReadDocument` consult up into `document()` so one function owns `initial` **and** the flag (leaves `loadRoot` byte-identical). Correct D1's count to **6 touch points**, and scope "base/client byte-identical" to *runtime behavior* (true — clients get `mountServed=false`), not `loadRoot`'s signature under option (a).

### CV5 — [note] Re-cite the real mount-populate seam in R2/D3; frame the explicit home-guard as PRIMARY, not belt-and-suspenders
*(from #3)*

`v2-host-provider.ts:482` is the serve-authorization/route guard, not a `#foreignMounts` write. The mount is written only by `HostStorageManager.readForeignDoc` (:2235), gated on `outcome.status==='served'` (:2226), from executor-worker.ts:672 (`refreshForeignMountForWake`) **and** :730 (`hydrateForeignReadMount`) — a second populate path D3 never enumerates.

**Amendment:** Re-word R2/D3: `#foreignMounts` is written only by `readForeignDoc` (:2235) on a 'served' outcome; :482 closes home because a home `readSpace` can never yield a 'served' outcome (it falls through to the session path). Because that no-home-mount property is a cross-provider, multi-hop invariant, keep the explicit `space !== homeSpace` guard in the `foreignReadDocument` override and frame it as the **primary** local safety (cheap, self-contained), not belt-and-suspenders.

### CV6 — [note] Correct the defect mechanism: `open(B)` does not throw; `loadRoot` is reachable
*(from #9)*

Design line 17 (inherited from the gate header) attributes the empty foreign read to the executor provider's `create()` throwing. `open()` installs a **lazy** `createSession` closure (v2.ts:1364-1369) and never invokes it on a synchronous `getDocument`; `create()`'s bind-check throws only when actually invoked (v2-host-provider.ts:2052). The B replica is opened lazily and never synced (foreign sync/writes reject at :482), so `getDocument(id)` returns `undefined` → `Default<0>` → `doubled=0`.

**Amendment:** Restate the mechanism accordingly and add the explicit note that **`open(B)` does not throw** — which is precisely why `loadRoot` runs after `branch()`→`open(B)` and the hook is a valid seam. (Conclusion `doubled=0` is unchanged; only the stated cause is corrected, removing a trap that could read the seam as unreachable.)

---

**Net:** the ROOT design ships as-is on its load-bearing seam (loadRoot hook + validate-skip; D1=a/D2=a/D6=a all sound). CV1 and CV2 are prerequisites for the WOs to *prove* the fix rather than pass vacuously; CV3–CV6 correct rationale, plumbing, and citations without altering the seam. No blocker-class defect (seq-domain leak, validate-skip home race, same-space regression, defect-(i) re-poison) survives verification.
