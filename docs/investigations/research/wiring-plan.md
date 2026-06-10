# Wiring Plan: Multi-User Identity Awareness in the Pattern Factory

Goal: make the factory treat identity as a first-class spec concern (maker reads
the new identity docs), make the critic FLAG dead-string identity, and make the
grader score it. The canonical "right way" lives in:

- `docs/common/components/COMPONENTS.md#identity-components`
- `docs/common/patterns/multi-user-patterns.md#presenting-identity` (the 5-question
  "What a spec should capture about identity" checklist, lines 275-288, maps 1:1 to
  ID1-ID7).

Rubric dims to land: ID1 render others via cf-avatar/cf-profile-badge (not strings);
ID2 viewer via `#profile` (not a typed name); ID3 PerUser/PerSpace (not DID-faking);
ID4 join+snapshot roster; ID5 ownership/authorship via CFC or snapshot (not a stored
name); ID6 identity by `equals()`/cell-ref (not name dedup); ID7 identity UX.

Edits below are READ-ONLY proposals — anchors + recommendations only. Author final
wording yourself.

---

## ⚠️ EVENT-RSVP CONTAINMENT (transfer-test integrity) — READ FIRST

`event-rsvp` DOES exist at `/Users/ben/code/labs/packages/patterns/event-rsvp/`
(`main.tsx`, `main.test.tsx`). It is the held-out transfer target and must stay
invisible to the factory. Current state and the leak vectors:

1. **`exemplars/` is a real directory of CURATED symlinks** (verified `file`):
   `battleship/`, `counter→`, `habit-tracker→`, `todo-list→`, `index.md→`. event-rsvp
   is NOT among them. ✅ SAFE as-is.
2. **`exemplars/index.md` → `packages/patterns/index.md`**. event-rsvp is NOT in
   `index.md` (grepped: no `rsvp` match — the catalog has not been regenerated). ✅
   SAFE — but FRAGILE: if anyone runs the index/catalog regenerator, event-rsvp gets
   written into `index.md` and the spec-interpreter (told to read `exemplars/index.md`,
   CLAUDE.md:240) will see it. ACTION: do NOT regenerate `packages/patterns/index.md`
   while the transfer test is open.
3. **DOC/REALITY MISMATCH (highest risk).** `pattern-factory/CLAUDE.md:47` and
   `README.md:69` both DESCRIBE the symlink as `exemplars/ -> labs/packages/patterns`
   (the *entire* patterns dir). Reality is a curated dir. If anyone "fixes" the symlink
   to match the docs, ALL of `packages/patterns/` — including event-rsvp — is exposed.
   ACTION: leave the curated dir as-is; do NOT reconcile it to the documented single
   symlink until after the transfer test.
4. **spec-interpreter has `Glob` + `Grep`** (frontmatter `tools:` line 4) and `docs/`
   symlinks the whole labs docs tree. It is *instructed* only to "Scan `exemplars/`"
   (line 64), and event-rsvp lives under `packages/patterns` (not `docs/`), so it is
   not reachable today. But the tools COULD reach `../labs/packages/patterns` if a
   future instruction widened the search. ACTION: when you add identity guidance to
   spec-interpreter (target #1), do NOT tell it to grep `packages/patterns`; keep
   exemplar awareness scoped to `exemplars/`.
5. `factory.config.json` / `factory.config.local.json` `default_exemplars` =
   `[counter, todo-list, habit-tracker, battleship/pass-and-play]`. ✅ No event-rsvp.

Net: contained today via three independent accidents (curated dir, stale index.md,
narrow instruction). Keep all three. The doc/reality symlink mismatch (#3) is the one
to actively guard.

---

## 1. spec-interpreter.md — make identity a first-class spec concern

Path: `/Users/ben/code/pattern-factory/.claude/agents/spec-interpreter.md`

Structure: frontmatter (Read/Glob/Grep/Write); "Scope: What You Decide vs What Others
Decide" (the maker owns identity *implementation* today — see lines 37-46:
"How to handle identity (equals(), cell references, etc.)"); "Workflow" §1 Read Context
→ §2 Assess Complexity → §3 Produce the Spec (mandatory ordered sections list, lines
83-126) → §4 Sparse vs Detailed → §5 Notes; "Quality Checklist".

Two insertions:

**(a) Identity decision rule.** The current Data Model section already says (lines
105-106) "Do NOT add ID fields for identity tracking — the platform handles object
identity through cell references." That is the natural anchor. Insert immediately
AFTER that bullet a multi-person rule:

> Anchor (insert after line 106, the "Do NOT add ID fields" bullet under
> **Section: Data Model**):
> ```
> - Do NOT add ID fields for identity tracking — the platform handles object
>   identity through cell references, not custom IDs
> ```

Recommendation: add a sibling rule — "When the brief involves multiple people or
references 'the current user'/'me': model people as profile *snapshots*
(`displayName`, `avatar`) plus a shared roster, NEVER a self-typed name field for the
viewer; the viewer is resolved at runtime via `#profile`. Do not invent DIDs or
user-id fields to fake isolation — that is a scope concern (PerUser/PerSpace), not a
data field." Point at `docs/common/patterns/multi-user-patterns.md#presenting-identity`.

**(b) Emit an "Identity & Presentation" section.** The mandatory section list ends at
**Section: Assumptions** (lines 125-126). That is the anchor.

> Anchor (insert a new bold **Section:** entry after **Section: Assumptions**,
> line 126):
> ```
> **Section: Assumptions** -- Decisions made by the spec-interpreter when the
> brief was ambiguous or silent. Document what was chosen and why.
> ```

Recommendation: add **"Section: Identity & Presentation (multi-user patterns only)"**
that requires answering the 5 questions verbatim from
`multi-user-patterns.md` lines 275-288 (viewer via `#profile`; viewer shown with
cf-profile-badge vs others with cf-avatar; PerSpace roster / PerUser "me" / PerSession
form state; person identified by cell-ref+`equals()` not display name; ownership/
authorship attested via CFC or snapshotted). Gate it: "include only when the pattern
has multiple people or a 'current user' concept; otherwise state 'Single-user — N/A'."
Also add a matching line to the **Quality Checklist** (after line 178): "If multi-user,
the Identity & Presentation section answers all 5 identity questions."

NOTE re Scope section: lines 37-46 currently hand ALL identity to the maker. Soften the
viewer/roster *requirement* (a product concern) while leaving `equals()`/cell-ref
*mechanics* to the maker — otherwise the new section contradicts the Scope table.

---

## 2. critic.md — add an "Identity & Authorship" review category

Path: `/Users/ben/code/pattern-factory/.claude/agents/critic.md`

Where the categories live (IMPORTANT): the factory critic does BOTH —

- It **invokes the labs skill**: Workflow §1 "Load the Pattern-Critic Skill"
  `Skill('pattern-critic')` (lines 31-38), described as giving "the 13 convention
  violation categories." (Note: critic.md says "13" in two places, lines 37 & 46;
  the iter-1 output showed 12 numbered — the canonical source actually defines **13**
  categories; see target #8. The "12 vs 13" drift is cosmetic but worth fixing while
  you are here.)
- The 13 numbered categories themselves are NOT in critic.md or in
  `pattern-critic/SKILL.md`. Their canonical source is
  `docs/common/ai/pattern-critique-guide.md` (target #8), which SKILL.md says to "Read
  first … the canonical reference." So the 12/13 numbered list the iter-1 critic emitted
  came from the critique guide via the skill.
- critic.md then adds its OWN "Extended Checks" (lines 51-88): Static-vs-Reactive,
  Computed Duplication, Spec Compliance, Defensive Coding, Handler Architecture.

So there are TWO valid homes for an identity category: (i) the shared numbered list in
the critique guide (target #8) — preferred, because the grader's `critic_ref` mapping
and pattern-dev all point there; (ii) critic.md's Extended Checks — factory-only.
Recommend BOTH: a numbered category in the guide (canonical) + an Extended Check block
here so the factory critic always runs it even before the guide edit lands.

> Anchor (insert a new Extended Check after the **Handler Architecture Consistency**
> block, before "### 5. Write the Review", i.e. after line 88):
> ```
> **Handler Architecture Consistency**
>
> - Is the action/handler choice consistent across the pattern? ...
> - Are inline arrow functions created per-item in .map() where handler() should
>   be used?
> ```

Recommendation: add **"Identity & Authorship"** Extended Check with FAIL conditions
mapped to ID1-ID7: a person rendered as `{name}` text or raw `<img>` instead of
`cf-avatar`/`cf-profile-badge` (ID1); a "type your name"/"who am I" text field used as
the current viewer instead of `wish({query:"#profile"})` (ID2); user-id/DID fields or
name strings used to fake per-user isolation instead of PerUser/PerSpace scope (ID3);
a roster not built by join+snapshot (ID4); ownership/authorship stored as a bare name
instead of a snapshot or CFC wrapper (ID5); roster dedup / "is this me?" by display-name
equality instead of `equals()` on a cell reference (ID6). Cite
`multi-user-patterns.md#presenting-identity` "Anti-patterns" list. Add a
guard: "N/A for single-user patterns — do not penalize." Severity: dead-string viewer
identity = MAJOR (incorrect behavior across users); name-string render = MINOR/MAJOR
per ID. Also update the two "13" mentions and the §3 heading "Convention Violations
(Categories 1-13)" if the guide grows to 14.

---

## 3. pattern-critic/SKILL.md — where the rule list is

Path: `/Users/ben/code/labs/skills/pattern-critic/SKILL.md`

Structure: it has NO numbered rule list of its own. Lines 6-11 delegate: "Start with
the shared critique guidance in `docs/common/ai/pattern-critique-guide.md` … Read that
guide first. It is the canonical reference." Lines 13-27 add emphasis bullets (SES/
determinism, bound-control self-feedback) and a reference doc list (which already
includes `docs/common/components/COMPONENTS.md`, line 24). Lines 29+ are "Quick
Patterns" + a "Scoped State Review" table (PerSpace/PerUser/PerSession) that already
flags "user ids or session ids embedded in data to simulate isolation → Use scope
wrappers" (line 120 — this is essentially ID3).

> Anchor (append a bullet to the emphasis list after the bound-control paragraph,
> i.e. after line 18 "clearly necessary and idempotent."):
> ```
> ... treat an event handler that writes the
> same value back into that same cell as a reactive-loop hazard unless it is
> clearly necessary and idempotent.
> ```

Recommendation: add one emphasis bullet — "Be explicit about dead-string identity:
flag a person rendered as a bare name/`<img>` (use cf-avatar/cf-profile-badge), a
typed-name field used as the current viewer (resolve `#profile`), and roster dedup /
'is this me' by display-name instead of `equals()` on a cell reference. See
`docs/common/patterns/multi-user-patterns.md#presenting-identity`." This keeps SKILL.md
thin (its job) and pushes the full numbered category into the critique guide (#8). The
existing reference list (lines 20-27) already points at COMPONENTS.md; add
`docs/common/patterns/multi-user-patterns.md` there too.

---

## 4. ux-designer.md — identity is a UX concern (ID7)

Path: `/Users/ben/code/pattern-factory/.claude/agents/ux-designer.md`

Structure: frontmatter (Read/Glob/Grep/Write); Goal; "Scope: What You Decide"
(IA, flows, state choreography, progressive disclosure, interaction patterns, emotional
design, lines 19-32); Workflow §1-§7 → "Design Information Architecture",
"Design Core User Flows", "Design Empty and Edge States", "Define Interaction
Patterns", then §7 "Write the Design Document" (template, lines 118-144) and §8 Quality
Checklist.

> Anchor (add a bullet to the **Scope: What You Decide** list, after the
> **Emotional design** bullet, line 31-32):
> ```
> - **Emotional design**: Does this reduce anxiety or create it? Does it feel
>   fast or sluggish? Does completing a task feel satisfying?
> ```

Recommendation: add a **"Identity presentation (multi-user only)"** scope bullet —
"Never equate the data 'name' field with identity. Show the *viewer* via their own
profile (cf-profile-badge, resolved from `#profile`), and *other* people via avatars
(cf-avatar) + their snapshotted name; mark which roster entry is 'me'. Decide where
identity appears in the IA (who's-here roster, authorship on records, 'you' affordance)."
Also add one Quality-Checklist line (after line 157): "If multi-user, the design says
how the viewer and others are presented (profile badge vs avatars), not a name field."
Point at `multi-user-patterns.md#presenting-identity` + `COMPONENTS.md#identity-components`.

---

## 5. rubric.json + rubric.md — score identity (ID1-ID7)

Paths: `/Users/ben/code/pattern-factory/rubric/rubric.json`,
`/Users/ben/code/pattern-factory/rubric/rubric.md`

Structure (json): top-level `version` (3.0), `scoring_models` (deduction ceiling 85 /
evidence baseline 55), and `dimensions` with SEVEN keys + weights:
`correctness .15`, `code_craft .15`, `test_coverage .10`, `spec_fidelity .10`,
`ux_design .20`, `experience_quality .20`, `first_run .10` (sums to 1.00). Each
dimension has `weight`, `scoring_model`, `description`, `checks[]` where each check is
`{id, description, severity, scoring_guidance}` and code dims also carry `critic_ref`.

DECISION — FOLD, don't add an 8th dimension. Adding a dimension forces re-weighting all
7 (they sum to 1.00) and re-baselining the worked example. Identity is partly a *code/
correctness* concern (dead-string viewer, name dedup) and partly an *experience*
concern (how people are shown). Split it:

- **code_craft** (deduction): add identity-mechanics checks here (ID2/ID3/ID6) — these
  are convention violations the critic already FAILs. Add `critic_ref` to the new
  critique-guide category (#8).
- **ux_design** (evidence): add identity-presentation checks (ID1/ID4/ID5/ID7) — these
  are "is it designed" judgments.

JSON shape to copy for a new code_craft check (append to
`dimensions.code_craft.checks`, after `CCR-11`):
```json
{
  "id": "CCR-12",
  "description": "Multi-user identity: viewer resolved via #profile (not a typed-name field); per-user isolation via PerUser/PerSpace scope (not stored DIDs/user-ids/name strings); 'is this me'/roster dedup via equals() on a cell reference (not display-name equality). N/A for single-user patterns.",
  "severity": "major",
  "critic_ref": "pattern-critic Identity & Authorship",
  "scoring_guidance": "-10 per dead-string identity violation. N/A (no deduction) if single-user."
}
```
JSON shape for a new ux_design check (append to `dimensions.ux_design.checks`,
after `UXD-8`):
```json
{
  "id": "UXD-9",
  "description": "Multi-user identity presentation: the viewer is shown via cf-profile-badge and other people via cf-avatar (never bare name text or raw <img>); a roster is built by join+snapshot; record ownership/authorship is shown via snapshot or CFC. N/A for single-user.",
  "severity": "minor",
  "scoring_guidance": "±5. Correct identity components and clear 'who's here' = positive; people rendered as name strings = negative. N/A if single-user."
}
```

> rubric.json anchor (code_craft): insert after the `CCR-11` object that ends at
> line 160 (`"scoring_guidance": "-5 per issue"` + closing `}`), before the `]` that
> closes `code_craft.checks`.
> rubric.json anchor (ux_design): insert after the `UXD-8` object ending at line 283,
> before the `]` closing `ux_design.checks`.

rubric.md mirrors json: §2 Code Craft has a CCR table (lines 149-161); §5 UX Design has
a UXD table (lines 250-259); and a "Relationship to Pattern-Critic" mapping table
(lines 409-423).

> rubric.md anchors:
> - add a `CCR-12` row after the `CCR-11` row (line 161) in the §2 table.
> - add a `UXD-9` row after the `UXD-8` row (line 259) in the §5 table.
> - add a row to the critic-mapping table (after line 422 "12. Design Review") mapping
>   "Identity & Authorship → Code Craft (CCR-12), UX Design (UXD-9)".

Recommendation: keep severities modest and gate every identity check "N/A for
single-user" so the grader does not penalize a single-user pattern for lacking a roster.
Do NOT touch weights or the worked example numbers.

---

## 6. pattern-factory-build-guide.md — tell the maker to read the identity docs

Path: `/Users/ben/code/labs/docs/common/ai/pattern-factory-build-guide.md`

Structure: "Build Contract" (lists the Read-First docs the maker must consult before
writing — bullet list lines 20-30, incl. reactivity.md, new-cells.md, type/schema docs,
UI/component docs); then Top-Level Pattern Mode / State Ownership / Verification /
Failure Recovery / Test Coverage.

> Anchor (add a bullet to the Build Contract read-list, after the
> "UI/component docs when implementing the visual design" bullet, line 29):
> ```
> - UI/component docs when implementing the visual design
> - debugging docs after any compile, test, or runtime failure that is not
>   immediately obvious
> ```

Recommendation: add a conditional read bullet — "for any pattern with multiple people
or a 'current user': `docs/common/components/COMPONENTS.md` (Identity components) and
`docs/common/patterns/multi-user-patterns.md` (Presenting Identity) — resolve the viewer
via `#profile`, render the viewer with cf-profile-badge and others with cf-avatar, build
the roster by join+snapshot, never use a typed-name field as identity." Since the guide
already says "Record the docs consulted in notes/pattern-maker.md" (line 36), this
auto-creates an audit trail for identity reads.

---

## 7. pattern-dev/SKILL.md (+ pattern-implement/SKILL.md) — identity pointer

Paths: `/Users/ben/code/labs/skills/pattern-dev/SKILL.md`,
`/Users/ben/code/labs/skills/pattern-implement/SKILL.md`

pattern-dev structure: delegates to `pattern-development-guide.md` (line 8); requires
reactivity.md + new-cells.md (lines 13-17); a large Scoped-State section
(PerSpace/PerUser/PerSession, lines 21-88) that ALREADY says "Do not store user ids or
session ids in ordinary data to simulate isolation; use scope wrappers" (lines 33-35 —
this is ID3); then Build-guide pointer (lines 90-95), transformer notes, runtime notes,
and a "Components" reference at the bottom (lines 173-176) that points at the catalog +
`COMPONENTS.md`. It does NOT currently reference `multi-user-patterns.md`.

> Anchor (best spot: end of the scoped-state discussion, right where it already warns
> about faking isolation — after line 88 "that actually has that scope."), OR extend
> the bottom Components bullet (lines 173-176).
> ```
> ... put the inner scoped declaration on the field or cell
> that actually has that scope.
> ```

Recommendation: add a short "Identity" pointer adjacent to the scope guidance — "Scope
decides *where* state lives; identity decides *who* it belongs to. For multi-user
patterns resolve the viewer via `wish({query:'#profile'})` (never a typed-name field),
render the viewer with cf-profile-badge and others with cf-avatar, and identify people
by `equals()` on a cell reference, not display name. See
`docs/common/patterns/multi-user-patterns.md#presenting-identity` and
`docs/common/components/COMPONENTS.md#identity-components`." (One pointer; the docs carry
the detail.)

pattern-implement structure: "Read First" list (lines 33-46) already includes
`docs/common/concepts/identity.md` (equals()) — line 46.

> Anchor (add after line 46, the existing identity.md bullet):
> ```
> - `docs/common/concepts/identity.md` - equals() for object comparison
> ```

Recommendation: add "`docs/common/patterns/multi-user-patterns.md` — Presenting Identity
(viewer via #profile, cf-profile-badge vs cf-avatar, roster by join+snapshot) when the
pattern has multiple people or a current-user concept."

---

## 8. pattern-critique-guide.md — the canonical numbered category

Path: `/Users/ben/code/labs/docs/common/ai/pattern-critique-guide.md`

Structure: "This is the canonical reference for reviewing Common Fabric patterns." It
holds THE numbered "Violation Categories" — **13** of them (1 Module Scope … 4 Type
System [has "custom identity field where equals() is intended → Use equals()", line 72]
… 12 Design Review, 13 Regression Check). This is the source the pattern-critic skill
loads and the source of the iter-1 critic's numbered list. Ends with Output Format,
Severity, Useful References.

> Anchor (add a new numbered category at the end of the Violation Categories block,
> after **### 13. Regression Check** and its table, i.e. after line 179, before
> "## Output Format" at line 181):
> ```
> ### 13. Regression Check
>
> | Check | What to verify |
> |-------|----------------|
> | tests still pass | existing tests run cleanly after the change |
> | type signatures preserved | or intentionally migrated with a clear reason |
> | handlers still work | existing functionality is not broken |
> | no unintended side effects | changes stay scoped to the intended area |
> ```

Recommendation: add **"### 14. Identity & Authorship (multi-user)"** as a Violation
table mapping ID1-ID6 to fixes: person rendered as name text/`<img>` → cf-avatar /
cf-profile-badge (ID1); typed-name field used as the current viewer → resolve via
`wish({query:"#profile"})` (ID2); stored DIDs/user-ids/name strings to fake isolation →
PerUser/PerSpace scope (ID3); roster not built by join+snapshot → snapshot
`{displayName,avatar}` from `#profile` (ID4); ownership/authorship stored as bare name →
snapshot or CFC `AuthoredByCurrentUser<T>` (ID5); dedup / "is this me" by display-name →
`equals()` on cell reference (ID6). Add "N/A for single-user patterns." Reference
`docs/common/patterns/multi-user-patterns.md#presenting-identity` and
`#identity-components`. Then add `docs/common/patterns/multi-user-patterns.md` to the
"Useful References" list (lines 234-239). Because this is the shared source, target #2
(critic.md "13"), the SKILL.md count, and the rubric.md mapping table all then refer to
**14** categories — update those three counts in the same pass for consistency.

---

## Edit order (suggested)

1. `pattern-critique-guide.md` (#8) — canonical category 14; everything else points here.
2. `pattern-critic/SKILL.md` (#3) — one emphasis bullet + ref.
3. `critic.md` (#2) — Extended Check + fix the "13"→"14" counts.
4. `rubric.json` + `rubric.md` (#5) — CCR-12 + UXD-9 + mapping row (no weight change).
5. `spec-interpreter.md` (#1) — identity rule + new spec section + checklist line.
6. `ux-designer.md` (#4) — scope bullet + checklist line.
7. `pattern-factory-build-guide.md` (#6), `pattern-dev` + `pattern-implement` (#7) —
   doc pointers for the maker.

Throughout: do NOT add event-rsvp to `index.md`, do NOT reconcile the
`exemplars/` curated dir to the documented single symlink, and keep spec-interpreter's
exemplar awareness scoped to `exemplars/` (no `packages/patterns` grep).
