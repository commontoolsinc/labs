# Wiring Applied — Agent A (labs files)

Applied the identity-wiring edits from `wiring-plan.md` (#8, #3, #6, #7) to the
FOUR/FIVE labs files. All edits used the Edit tool. No other files touched. The
pattern-factory files (#1, #2, #4, #5) were left to the other agent. No git
add/commit. `packages/patterns/index.md` and the `exemplars/` symlink were NOT
touched.

Pre-flight: confirmed `docs/common/patterns/multi-user-patterns.md` EXISTS and
has a `## Presenting Identity` heading (line 204), so the `#presenting-identity`
anchor referenced by every inserted bullet resolves.

---

## EDIT 1 — docs/common/ai/pattern-critique-guide.md (wiring-plan #8) — OK

**Anchor matched:** end of the Violation Categories block — after `### 13.
Regression Check` and its 4-row table, immediately before `## Output Format`.
Inserted new category `### 14. Identity & Authorship (multi-user)` verbatim
(6-row Check/verify/Fix table covering ID1–ID6 + the See/Severity line).

Context after the edit:
```
| ownership / authorship | "who created / wrote this" stored as a bare name | snapshot the actor's profile, or attest with CFC `AuthoredByCurrentUser` / `RepresentsCurrentUser` |

See `docs/common/patterns/multi-user-patterns.md#presenting-identity` and `docs/common/components/COMPONENTS.md#identity-components`. Severity: a forgeable / dead-string **current-viewer** identity is MAJOR ...

## Output Format
```

## EDIT 1b — same file, Useful References list — OK

**Anchor matched:** the "Useful References" list at the end of the file. Added
`docs/common/patterns/multi-user-patterns.md` after the `COMPONENTS.md` bullet.

Context after the edit:
```
- `docs/common/components/COMPONENTS.md`
- `docs/common/patterns/multi-user-patterns.md`
- `docs/common/capabilities/llm.md`
```

**Category-count update (instructed in EDIT 1 "ALSO"):** NOT NEEDED in this file.
The guide's intro and headings contain NO category COUNT — there is only a
`## Violation Categories` header (no "13 categories" prose) and bare `### N.`
section numbers. Verified by grep (`categories|13 |thirteen|fourteen` → only the
`## Violation Categories` header line). The canonical list now physically has 14
numbered categories (`### 1.` … `### 14.`). No "13"→"14" string existed here to
change. (The "13"→"14" count fixes the plan mentions live in the pattern-factory
critic.md and the rubric mapping table — those are the other agent's files.)

---

## EDIT 2 — skills/pattern-critic/SKILL.md (wiring-plan #3) — OK

**Anchor matched:** end of the bound-control-self-feedback paragraph (the
emphasis text ending "...clearly necessary and idempotent."), before "Then use
the detailed references...". Appended the `- **Dead-string identity
(multi-user):** ...` emphasis bullet verbatim. (The surrounding emphasis is prose
rather than a bulleted list; the inserted item is a standalone `-` bullet exactly
as specified, separated by a blank line.)

Context after the edit:
```
same value back into that same cell as a reactive-loop hazard unless it is
clearly necessary and idempotent.

- **Dead-string identity (multi-user):** flag a person rendered as a bare name or `<img>` ... See `docs/common/patterns/multi-user-patterns.md#presenting-identity` (critique-guide category 14).

Then use the detailed references already maintained in the repo for:
```

## EDIT 2b — same file, reference-doc list — OK

**Anchor matched:** the reference-doc list that already includes
`COMPONENTS.md`. Added `docs/common/patterns/multi-user-patterns.md` after the
`COMPONENTS.md` bullet.

Context after the edit:
```
- `docs/common/components/COMPONENTS.md`
- `docs/common/patterns/multi-user-patterns.md`
- `docs/common/patterns/ui-cookbook.md`
- `docs/common/capabilities/llm.md` - LLM integration
```

---

## EDIT 3 — docs/common/ai/pattern-factory-build-guide.md (wiring-plan #6) — OK

**Anchor matched:** the Build Contract "read-first" bullet list, immediately
after the `- UI/component docs when implementing the visual design` bullet (and
before the `- debugging docs after any compile...` bullet). Inserted the
conditional identity read bullet verbatim (wrapped to match the file's ~80-col
bullet wrapping; wording unchanged).

Context after the edit:
```
- UI/component docs when implementing the visual design
- for any pattern with multiple people or a "current user":
  `docs/common/components/COMPONENTS.md` (Identity components) and
  `docs/common/patterns/multi-user-patterns.md` (Presenting Identity) — resolve
  the viewer via `#profile`, render the viewer with `cf-profile-badge` and others
  with `cf-avatar`, build the roster by join + snapshot, and never use a
  typed-name field as identity
- debugging docs after any compile, test, or runtime failure that is not
  immediately obvious
```

---

## EDIT 4 — skills/pattern-dev/SKILL.md (wiring-plan #7) — OK

**Anchor matched:** end of the scoped-state discussion — right after the warning
"...put the inner scoped declaration on the field or cell that actually has that
scope." (the line that follows the fake-isolation guidance), before "When working
in a Pattern Factory Build workspace, also read:". Inserted the `**Identity
(multi-user):**` paragraph verbatim (wrapped to the file's ~80-col prose width;
wording unchanged).

Context after the edit:
```
`PerUser<PerSession<T>>`; put the inner scoped declaration on the field or cell
that actually has that scope.

**Identity (multi-user):** Scope decides *where* state lives; identity decides
*who* it belongs to. Resolve the viewer via `wish({ query: "#profile" })` ...

When working in a Pattern Factory Build workspace, also read:
```

---

## EDIT 5 — skills/pattern-implement/SKILL.md (wiring-plan #7) — OK

**Anchor matched:** the "Read First" list, immediately after the existing
`- \`docs/common/concepts/identity.md\` - equals() for object comparison` bullet,
before "For Pattern Factory Build, do not start implementation...". Inserted the
`multi-user-patterns.md` read bullet verbatim (wrapped to match the list's
continuation-line style; wording unchanged).

Context after the edit:
```
- `docs/common/concepts/identity.md` - equals() for object comparison
- `docs/common/patterns/multi-user-patterns.md` - Presenting Identity (viewer via
  `#profile`, `cf-profile-badge` vs `cf-avatar`, roster by join+snapshot) when the
  pattern has multiple people or a current-user concept

For Pattern Factory Build, do not start implementation until you have read the
```

---

## Summary

| Edit | File | Anchor | Result |
|------|------|--------|--------|
| 1  | pattern-critique-guide.md | after §13 table, before `## Output Format` | OK |
| 1b | pattern-critique-guide.md | Useful References list | OK |
| —  | pattern-critique-guide.md | category-count "13"→"14" | N/A (no count text exists) |
| 2  | pattern-critic/SKILL.md | after bound-control emphasis para | OK |
| 2b | pattern-critic/SKILL.md | reference-doc list (w/ COMPONENTS.md) | OK |
| 3  | pattern-factory-build-guide.md | Build Contract read-list, after UI bullet | OK |
| 4  | pattern-dev/SKILL.md | end of scoped-state discussion | OK |
| 5  | pattern-implement/SKILL.md | Read First list, after identity.md bullet | OK |

All anchors matched; nothing forced; no FAILED edits. Files outside the five
targets were read-only. No `index.md` regeneration, no `exemplars/` change, no
git add/commit.
