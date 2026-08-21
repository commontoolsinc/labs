---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "Optimize-phase build report: the OW31 ruled write+read identity posture — genesis under the space's own keys naming the acting user OWNER, service-principal writes into user home spaces refused, ACL-only service reads with every other served read under the acting user, and the S-A compile-cache carriage arm. Incremental; carries the FLAGGED questions."
---

# OW31 build report — the ruled write+read identity posture

Builder: OW31 BUILD agent. Worktree `/Users/berni/labs-worktrees/ow31-identity`,
branch `claude/server-exec-v2-ow31-identity` off `origin/main` @ `ce92b445f`.
Started 2026-08-21. Status: **IN PROGRESS** (this file is written incrementally).

Authoritative inputs (read in full before building):

- Register row: `docs/specs/server-side-execution/verification-coverage.md`
  "OW31 — the service-principal READ-AUTHORITY grant" (the ruling verbatim,
  findings i–iv, build pins, acceptance gates; WRITE ruled 2026-08-18,
  READ ruled 2026-08-19 — ACL-only service reads, superseding the scope
  report's read-only-service-class recommendation).
- Work order: `docs/history/plans/server-execution-v2/stage-c/stage-c-ow31-scope-report.md`
  (B0–B7, flags F1–F10) — read against the READ-side supersession.
- Specs: `docs/specs/server-side-execution/protocol.md` §2/§2b,
  `docs/specs/server-side-execution/serving-loop.md` §3b/§3d.
- S-A seat evidence: `docs/history/plans/server-execution-v2/stage-c/on-render-stall-rootcause.md`
  §1 (17 `seal-space-commit-failed` compile-cache writeback refusals per
  profile space).

## Plan of record

1. **B0/B3 — genesis owner = acting user** (`registerSpaceIdentity(identity, { owner })`,
   threaded from serving-side `resolveSpaceName`; serving runtime with no
   actor REFUSES; client shape byte-identical).
2. **B4 — ordering + INV-13 mirror at the sink** (genesis forced before a
   creation-granted foreign batch; sink refuses a foreign batch into a
   seq-0/no-ACL engine; kill/replay convergence).
3. **READ posture (ruled 2026-08-19)** — remove the OWNER blanket; service
   identity reads a space's ACL ONLY; every other served read under the
   acting USER's identity. Escape hatch: cases user-identity routing cannot
   cover are FLAGGED, not blanket-kept.
4. **B5 — "the service principal cannot write into a user home space"** pins.
5. **S-A — §2b delegated carriage for `compile-cache/writeback/<patternIdentity>`**
   into the piece's own space; if no acting user is attributable at
   writeback time, FLAG with the system-class alternative (do not choose it).
6. **B6 — acceptance gates** (served-wish + lunch live gates; observe-mode
   canary; store dump).
7. **B7 — spec/register edits** (protocol.md §2b mechanism sentence;
   OW31 row RULED → BUILT with evidence).

## Progress log

- 2026-08-21: worktree verified clean at ce92b445f; register row, scope
  report, protocol §2/§2b, serving-loop §3b, render-stall §1 read in full.
  Report skeleton committed. Code reading next.

## FLAGGED questions (running list)

(none yet)
