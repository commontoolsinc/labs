---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "RULING-5 build (OW49 narrowing per the CFC owner's 2026-08-21 ruling with the adversarial reviewer's cautions as binding constraints): the assert narrowed to actual ambiguity, red-first both directions; the profile-embed ON lift attempt; the OW54 separability assessment with a follow-on outline; the FLAG-8 and OW50-contract ratification records."
---

# RULING-5 — the OW49 narrowing, the lift attempt, and the ratification batch

Seat: served-wish-path (continuation). Branch
`claude/server-exec-v2-ruling5-ow49` off `origin/main` @ `a1040a547`.
Authority: CFC owner's ruling 2026-08-21 ("sg", relayed by the
coordinator; the owner confirmed CFC ownership — "I'm CFC owner,
hixie is ramping up"), with the PR #6157 adversarial review's three
cautions as binding constraints.

## 1. The narrowing as built

`assertNoDivergentIfcBranches` (runner `cfc/schema-merge.ts`) admits a
combinator exactly when: the kind is anyOf or oneOf (allOf stays
refused — conjunctive, so type-disjoint siblings are
unsatisfiable-by-construction and no carrier reading exists); EXACTLY
ONE branch contains ifc anywhere beneath it (the POLICY CARRIER); and
every other branch is SYNTACTICALLY type-disjoint from the carrier —
both carry an explicit scalar `type` string, the strings differ, and
neither branch has a combinator at its root. Everything unprovable (a
missing `type`, a type array, a boolean schema, a nested combinator)
is NOT disjoint, by ruling — treating "cannot prove overlap" as
disjoint would reopen the policy dodge, the second of #3263's two
protected cases. More than one carrier is the first protected case
(genuine ambiguity) and stays refused. The recursion still descends
INTO the admitted carrier, so divergence nested deeper refuses exactly
as before. The narrowing holds at all four `mergeCfcSchemaEnvelopes`
call sites by construction: both entry asserts run the same function
(prepare.ts's stored/candidate try-site, the link-write verification
site, the claims-internal merge, and the label-map entry merge at
prepare.ts:872).

The merge itself needed no structural change for the ruled scope: the
node-level merge already preserves the union (the combinator rides the
spread), the carrier's ifc rides inside its branch untouched, and a
node-level ifc merging in from a claims skeleton lands beside the
union — the carrier remains the only branch-level policy, which is the
policy-carrier reading at the merge layer.

## 2. Red-first, both directions

- **The flip the ruling predicted:** with the narrowing in and the old
  pins untouched, the deterministic two-writer repro's journey went
  RED — writer B's changed `/result` link now MERGES (the state
  updates to the new resolve; no surfaced error) where the old pin
  expected the crash-surfaced refusal. Watched red, then re-pinned as
  "the ruled wish shape merges cleanly across two writers (RULING 5
  flip)" — the profile-embed lift condition at unit level.
- **The still-refused class:** the OW50 detectability pins (prep-crash
  totality, the unconditional console report, observe-mode survival,
  the scheduler crash survival) were re-based onto a
  genuinely-AMBIGUOUS envelope (`result.anyOf` with TWO ifc-carrying
  branches) — the class the narrowed assert still refuses — and run
  green unchanged in behavior. A new end-to-end journey pins the
  surfacing on that class through the REAL wish builtin: a discovery
  pass learns the wish-state doc id (content-derived, reproducible on
  a fresh server), the ambiguous envelope is seeded as the doc's FIRST
  write, the wish runtime PRE-PULLS the doc (the live ordering: the
  served doc and its label metadata are in the client's replica before
  the client's own action preps), and the wish's refused commit
  surfaces `error` + the error UI on the state doc.
- **The constraint pins (negative space of the ruling):** two-carrier
  anyOf refused at the root, under oneOf/items, under prefixItems
  (CT-1895's recursion-coverage intent preserved with an ambiguous
  fixture), and under additionalProperties; single-carrier refused
  when the sibling is same-type, type-less, type-array, a combinator,
  or a boolean; allOf refused even with a disjoint carrier; nested
  divergence inside the admitted carrier refused; and the admitted
  shape pinned to MERGE with the carrier's ifc intact (root anyOf and
  nested oneOf).

Suites: `cfc-schema-merge` 56 steps, `cfc-prepare-crash-surfacing` 15
steps, plus the neighbor sweep (policy-of-label,
extended-storage-transaction, additive-default, boundary,
cid-schema-verify, speculation-overlay) — 200 steps, all green under
the CI preload.

## 3. The lift attempt (profile-embed ON)

_(recorded below when the runs complete)_

## 4. OW54 separability assessment (directed; no fix in this PR)

The mechanism, from the code at this head: a served EVENT's commit
rejection flows through `handleCommitResult` →
`classifyCommitDisposition` (scheduler/events.ts). A deterministic CFC
pre-storage rejection is neither stale-basis nor permanent/terminal,
so it classifies `{kind: "give-up", reason: "non-retryable"}` — and
the give-up arm settles the commit callback and reports the dropped
write but never calls `served.onFailure`, so no consequence seals and
the durable LT1 entry re-drains every wave. Pre-OW50 the same crash
THREW from `prepareTxForCommit` inside the finalize and took the
ERROR arm (events.ts ~1422), whose contract is explicit: "the error
IS the consequence" — `served.onFailure({kind: "error", message})`.

**Assessment: cleanly separable.** The restoration is one narrow arm:
in the give-up disposition, when `served !== undefined` AND the error
is a deterministic CFC pre-storage rejection (the
"CFC enforcement rejected commit" message prefix — the same
discriminator `reportDroppedCfcRejectedWrite` already keys on), call
`served.onFailure({kind: "error", message})` before settling — exactly
the throw arm's honesty, scoped so transport-class give-ups keep
today's re-drain cadence. It touches only the served-event disposition
arm (no cfc/, no seal machinery, no wave code), and is red-first
pinnable in the executor events-down suite: a served event whose
handler writes a genuinely-ambiguous-envelope doc today leaves the
entry unconsequenced and re-draining; with the fix the entry seals an
error consequence and the drain advances. Because it changes
consequence semantics ((α)-critical), it is proposed as its OWN
follow-on PR, not folded here:

> **Follow-on PR outline (awaiting coordinator green-light):**
> `fix(scheduler): a served event refused pre-storage by CFC seals an
> error consequence (OW54)` — (1) red-first pin in
> `executor-events-down.test.ts` (ambiguous-envelope handler write →
> today: entry re-drained ≥2 waves, no consequence; after: ONE error
> consequence, stream advances, `served.onFailure` observed once);
> (2) the give-up-arm discriminated `served.onFailure` call; (3) the
> OW54 register row closed with the pin as lift evidence; (4) a note
> on the #6158 settle interaction (the unretired-intent timeout class
> disappears with the consequence sealed).

RULING-5 interaction, recorded in the row: the narrowing shrinks
OW54's exposed class from "any wish-family envelope" to genuinely
ambiguous envelopes only — rarer, but the corner remains until the
follow-on lands.

## 5. Ratification records (same PR, register)

- **OW31 FLAG-8** (shared-named-space first-creator-owns): RATIFIED —
  owner "ratify", 2026-08-21, recorded in the OW31 row's item (v):
  the genesis race's winner holding owner power with peers at
  `"*": WRITE` is the settled contract, not a residual.
- **OW50 contract change** (PolicyOf prepareCfc throw →
  rejected-commit-with-same-diagnostic): RATIFIED — owner "sg",
  2026-08-21, with the motivation context on the record: the change
  was forward-motivated by the silent-never-mount and the scheduler
  wedge; no pre-existing test was left broken — the three re-pins
  were green before and after, consciously migrated with the same
  diagnostics delivered through the rejection message.
