# Handoff — Part B: pull `.src` off the cold-load critical path (workstream 2 = A + C)

**Status (2026-07-01): NOT STARTED.** The prerequisite — the identity re-root
(the handoff labels it **B**) — is DONE and PR'd (**#4436**). This doc is the seed
for the remaining perf work that actually banks the ~83ms.

Read first: [`COLD-LOAD-MASTER-HANDOFF.md`](./COLD-LOAD-MASTER-HANDOFF.md) (index),
[`BOOT-FLOOR-FINDINGS.md`](./BOOT-FLOOR-FINDINGS.md) §5–§6 (the lever + the A/B/C
design). Label note: the handoff's **A/B/C** ≠ "Part A/B" in chat — B (identity
re-root) is done; **Part B here = the handoff's A + C.**

---

## What's done — the prerequisite (handoff "B")

The content-addressed action-identity re-root is IMPLEMENTED, red-teamed, and PR'd
as **#4436** (branch `gideon/content-addressed-action-identity`), **pending Berni's
review**. It made scheduler action identity content-addressed (`{ identity,
symbol }`) so it no longer reads `.src`. Includes a per-instance action-id fix that
came out of the red-team — see [`B-IDENTITY-REROOT-HANDOFF.md`](./B-IDENTITY-REROOT-HANDOFF.md)
and `docs/specs/action-id-per-instance-decision.md`.

**NB — branch topology:** the FULL, current B (with the per-instance collision fix
+ the Cubic P1 / CI fix) lives on the **PR branch `gideon/content-addressed-action-identity`
(#4436)**. This investigation branch (`gideon/lunch-poll-load-investigation`) holds
the handoff docs + tooling but an OLDER B (pre-collision-fix). **Stack Part B on
the PR branch, not on this one.**

---

## The goal — the ~83ms (#1 boot-floor bucket)

Every piece boot eagerly runs `annotateFunctionDebugMetadata` per
lift/handler/computed → `getExternalSourceLocation` / `resolveLocationFromFunctionSource`
→ the per-char source-map walk (`getLineAndColumnAtOffset`). Measured ~83–100ms.
The short-circuit experiment proved the lever: trivial settle **~662 → ~579ms**
with annotation off.

## C — make the annotation lazy/debug-only (the perf win)

Gate `annotateFunctionDebugMetadata` behind a debug flag, default OFF (Berni:
"cost is 0 when debugging is off"). B made `.src` non-load-bearing for the
**scheduler** identity, which is what unlocks this — **BUT there is a hard,
security-sensitive prerequisite:**

**⚠️ The remaining `.src` READERS must be re-rooted first, or lazy `.src` breaks
them:**

1. **CFC `resolveProvenanceImplementationIdentity` (`packages/runner/src/cfc/implementation-identity.ts`,
   ~:57–79) reads `.src` and FAIL-CLOSES the `writeAuthorizedBy` gate.** It requires
   `parseVerifiedSourceLocation(src)` to parse AND `identityFromCanonicalSource(src)
   === provenance.identity`, else returns `{ kind: "unsupported" }` → the authorized
   write is DENIED (via `resolvePolicyFacingImplementationIdentity` → `runner.ts`
   ~:3089/:3375 → `cfc/prepare.ts` `writeAuthorizedBy`). So if `.src` is unset/lazy
   at boot, CFC verified-identity flips **`verified → unsupported` → writes denied**.
   **This is the load-bearing, security-sensitive core of Part B.** The garble
   harness's BOUNDARY test (`packages/runner/test/src-garble-identity-invariant.test.ts`,
   on #4436) is the tripwire — it asserts CFC flips `verified → unsupported` under
   `.src` garble.
   - **Fix:** re-root this CFC check onto the same content-addressed `{ identity,
     symbol }` provenance B established (drop the `.src` consistency check, or make
     it tolerate an absent `.src`). Security change → **red-team-gated, coordinate
     with seefeld/Berni** (same gate #4436 went through).
2. `recordModuleProvenance` `.src` guard (`packages/runner/src/harness/engine.ts`
   ~:1053) reads `.src` as a cross-module re-exporter mismatch guard. Weaker (a
   no-op when `.src` is undefined) but it weakens the re-exporter-spoof defense —
   decide keep vs re-root with the authors.

Only after (1) [and a call on (2)] can `annotateFunctionDebugMetadata` skip at boot
without breaking CFC writes.

## A — fix the broken cheap source-map path (debug-quality follow-on)

Independent of C, lower urgency (it's about debug correctness, not the boot cost).
Empirical (instrumented, `cf check` on lunch-poll, 2026-06-30): the cheap stack
path (`getExternalSourceLocation`) fails for **64/82** primitives (→ expensive
fallback), and its 18 "successes" return the **WRONG, colliding** location
(`packages/runner/src/builder/module.ts` ~:138 — the runtime factory frame). So the
cheap path is both frequently-null AND actively-wrong; the expensive fallback is
currently the only correct source. Mechanism: `engine.ts` ~:900–926 loads per-module
source maps; `INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS` (`module.ts` ~:97) filters
`factory.ts` but not `module.ts`; the eval-frame sourceURL/line-shift handling is
suspect. Fixing it makes on-demand `.src` correct + cheap (so debug-time `.src`
works). This is "Gideon's thread" per the Discord exchange.

## Sequencing

1. **Re-root the CFC `.src` fail-closed check** onto provenance (security-gated) —
   the blocker for lazy `.src`. Optionally the `recordModuleProvenance` guard too.
2. **C** — gate `annotateFunctionDebugMetadata` behind a debug flag → banks ~83ms.
   Validate observably: revert + re-measure the trivial-pattern boot settle.
3. **A** — fix the cheap source-map path so on-demand/debug-time `.src` is correct.

## State / pointers

- **Prerequisite (B) done:** PR **#4436**, branch `gideon/content-addressed-action-identity`,
  pending Berni. **Stack Part B on it.**
- **This investigation branch** (`gideon/lunch-poll-load-investigation`, pushed to
  origin): handoff docs + `cpuprof*.py` tooling + `seed.sh`; B code here is OLDER.
- **Parallel thread (workstream 3, bucket #2 — TS-parse-in-worker):** branch
  `gideon/cold-load-ts-parse` (workspace D), independent of A/B/C. Per its seed a
  parse-memo fix ("its own Fix A") shipped — do NOT confuse with this A/B/C.
- **Rig / 7-bucket map / stance:** master handoff §1/§3/§9, boot-floor findings.
- **Re-verify on CURRENT `main`:** the 2026-06-30 profile + sites predate heavy main
  churn (the OpaqueRef→Reactive rename, etc.) — confirm the CFC `.src` read, the
  eager-annotation lever, and the cheap-path breakage still hold before planning.

## Stance (carry it, not just the facts)

- Re-derive on current `main`; don't inherit conclusions — validate the instrument.
- Verify load-bearing claims directly (the CFC `.src` fail-closed dependency was
  found by the red-team, NOT the original handoff — the handoff under-called it).
- Validate every fix is observable (revert + re-measure the trivial boot).
- The CFC re-root is security-load-bearing → seefeld/Berni + a red-team pass.
