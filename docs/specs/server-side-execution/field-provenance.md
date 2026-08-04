# v2 verification: field provenance — follow every value

**Verification instrument, NON-NORMATIVE** — the second of the pair
(see [scenario-traces.md](scenario-traces.md), which owns the
shared execution protocol). Traces evaluate the spec top-down along
twelve hand-picked journeys; this audit is the bottom-up
complement: for each load-bearing FIELD, enumerate every producer,
every carrier hop, every consumer, and every retirement, and check
that the chain CLOSES on every path family — mechanically, over
all paths, not twelve samples.

Origin (2026-08-03): every heavyweight defect of the review week
was one shape — *a value needed downstream, destroyed or dropped
at a hop*. The outbox losing the run's identity; the same-space
cascade event with no carriage at all (LT1); `actingSession`
missing from one of three metadata statements; the enacted-nonce
record dying at reload (LT8). Journeys catch these only where one
happens to walk the broken hop. Chains catch them wherever they
are.

## 1. Protocol

scenario-traces.md §1 applies verbatim (cite-or-GAP — never fill
by analogy; FLAG-don't-fix; CONTRADICTION-don't-pick; positive
evidence only; deferrals are answers; docs only, never code).
Audit-specific rules on top:

1. **The chain table.** Per field, four rows of life — BORN (who
   mints it, when, from what), CARRIED (every hop: commit
   metadata / write-level field / wire request field / engine
   table / outbox entry / client memory / client durable), CONSUMED
   (every reader and what it DECIDES), RETIRED (overwrite,
   compaction, GC, or never) — every cell cited.
2. **Closure verdicts, per path family** (§2): a field
   participating in a path must connect producer → consumer with
   no dropped hop. Report per (field, path): `CLOSED` |
   `BROKEN-AT: <hop>` | `N/A` (field does not ride this path —
   say why).
3. **Three structural checks** beyond closure:
   - **Orphan consumer** — a reader whose value has no producer on
     some path that reaches it;
   - **Dead producer** — a written value nothing ever reads
     (wire-shape discipline: flag it, it may be vestigial or
     load-bearing-elsewhere);
   - **Unsanctioned carriage** — the field rides a hop that
     protocol.md §7's closed metadata list (or its named
     sanctions: basis rows, write-level event fields) does not
     cover.
4. **Output format**: per field — the chain table, then the
   closure verdict lines, then structural-check results — followed
   by a FINDINGS section (GAP/FLAG/CONTRADICTION items only) and a
   per-cluster verdict line: `CLUSTER <X>: CLEAN | FINDINGS(k)`.

## 2. Path families

Check each field against the families it plausibly rides;
declaring `N/A` requires a reason.

- **P1 client-authored** — doc write / event append from an
  authenticated session (admission, stamping).
- **P2 server-derived wave** — seal → wave commit, including
  same-space cascade entries (write-level carriage) and the
  SpaceServer's own writes.
- **P3 delegated / outbox crossing** — cross-space event appends
  and `.inSpace` provisioning (metadata, validation, stamping at
  the target).
- **P4 effect completion** — memo miss → outbox → external call →
  completion commit (the derived commit that never passes
  sealing).
- **P5 recovery / activation** — crash, lease handover, index
  re-mark, event reprocessing, park/activate.
- **P6 client lifecycle** — speculation overlay, offline queue,
  reload, push filtering, enact/ack.

## 3. The roster (sixteen fields, six clusters)

- **Cluster A — event identity**: `firedAt.user`,
  `firedAt.session`, `clientSeq`, `eventId`. All six families.
- **Cluster B — delegation & authority**: `actingPrincipal`,
  `actingSession`, `capabilityRef`, the effect authority handle.
  P2–P5.
- **Cluster C — instance & attribution**: `scope_key` in all four
  roles (storage row key, derived-commit ADDRESSING annotation,
  lease-holder read field, basis `action_scope_key` /
  `entity_scope_key`), the ATTRIBUTION acting-identity annotation
  (per action run), CFC per-run provenance labels. All families.
- **Cluster D — commit & watermark metadata**: `class`, `holder`,
  `derivedThrough` + the watermark doc (`W`), `eventWatermark`,
  `consequenceOf`. P1–P2, P5, P6 (settledness).
- **Cluster E — effect channel & memo**: `nonce`, `ackedNonce`,
  `issuedIn`, `requestHash` (the memo key), the outbox identity
  carriage (result-cell address + acting identity). P2, P4, P6.
- **Cluster F — client-side state**: `sessionId` itself (mint →
  persist → carry → retire → GC), overlay `origin` +
  `baseSeq`, the offline event queue's entries. P1, P3 (carried
  identity), P6, P5 (retirement/GC).

## 4. Reference chains

Pending the first adjudicated pass. Verified chain tables fold in
here per cluster; a doc edit that touches a field's producer,
carrier, or consumer re-derives THAT FIELD's chain and diffs
(same cadence as scenario-traces.md §1).

## 5. Findings routing

Identical to scenario-traces.md §5: GAP / FLAG / CONTRADICTION →
the PR rulings ledger; governing docs win until a ruling lands; a
ruling updates the affected reference chains in the same PR.
