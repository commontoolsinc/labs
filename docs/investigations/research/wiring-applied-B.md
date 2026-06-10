# Wiring Applied — Batch B (Agent B)

Identity-wiring edits applied to FOUR pattern-factory pattern-factory-agent /
rubric files. All edits applied with the Edit tool. No labs files touched. No
git add/commit. rubric.json verified to still parse.

Source of truth for anchors: `wiring-plan.md` sections #1, #2, #4, #5.

---

## EDIT 1 — `/Users/ben/code/pattern-factory/.claude/agents/spec-interpreter.md` (wiring-plan #1)

### 1a — Data Model sibling bullet (multi-person identity rule) — OK

Anchor matched: the "Do NOT add ID fields for identity tracking — the platform
handles object identity through cell references, not custom IDs" bullet under
**Section: Data Model**. Inserted the new bullet immediately after it, before the
"Relationships subsection:" line.

Surrounding context after the edit:

```
- Do NOT add ID fields for identity tracking — the platform handles object
  identity through cell references, not custom IDs
- When the brief involves multiple people or "the current user" / "me": model
  people as profile **snapshots** (`displayName`, `avatar`) in a shared roster,
  and resolve the viewer at runtime via `#profile` — NEVER add a self-typed name
  field for the viewer. Do not invent DIDs or user-id fields to fake isolation
  (that is a `PerUser` / `PerSpace` scope concern, not a data field). See
  `docs/common/patterns/multi-user-patterns.md#presenting-identity`.

Relationships subsection:
```

### 1b — new "Section: Identity & Presentation" mandatory spec section — OK

Anchor matched: **Section: Assumptions** (the last mandatory spec section),
immediately before "### 4. Handling Sparse vs. Detailed Briefs". Inserted the new
bold **Section:** entry between them.

Surrounding context after the edit:

```
**Section: Assumptions** -- Decisions made by the spec-interpreter when the
brief was ambiguous or silent. Document what was chosen and why.

**Section: Identity & Presentation (multi-user patterns only)** -- Include only
when the pattern has multiple people or a "current user" concept; otherwise
write "Single-user -- N/A". Answer:

1. Who is the current viewer, and how is it resolved? (Must be `#profile`, not a
   typed-in name.)
...
5. Is any record's ownership/authorship attested (CFC) or just snapshotted?

### 4. Handling Sparse vs. Detailed Briefs
```

(All 5 numbered questions inserted verbatim; only the list whitespace was
normalized to the file's markdown style — a blank line after the intro sentence so
the numbered list renders.)

### 1c — Quality Checklist bullet — OK

Anchor matched: the Quality Checklist, after the "Complexity matches the brief…"
bullet and before the "The pattern would feel useful to a real person…" bullet.

Surrounding context after the edit:

```
- Complexity matches the brief (don't spec an advanced pattern for a simple
  concept)
- If multi-user, the Identity & Presentation section answers all 5 identity
  questions.
- The pattern would feel useful to a real person, not just like a demo
```

### 1d — narrow the maker-owned identity line (Scope section) — OK

Anchor matched: under "**The pattern-maker decides (implementation):**", the line
"How to handle identity (equals(), cell references, etc.)". Replaced it with the
mechanics-only wording plus a note pointing at the new spec section. Did NOT add
any instruction to grep `packages/patterns`; exemplar awareness left scoped to
`exemplars/`.

Surrounding context after the edit:

```
- TypeScript interfaces and type annotations
- How to *implement* identity mechanics (`equals()`, cell references, scope
  wrappers). The identity *model* (viewer via `#profile`, roster snapshots,
  badge/avatar presentation) is decided in the spec — see the Identity &
  Presentation section under "Produce the Spec".
- Writable<>, Default<>, Stream<> usage
```

---

## EDIT 2 — `/Users/ben/code/pattern-factory/.claude/agents/critic.md` (wiring-plan #2)

### 2-main — "Identity & Authorship" Extended Check block — OK

Anchor matched: end of the **Handler Architecture Consistency** Extended Check
block (the "Are inline arrow functions created per-item in .map()…" bullet),
immediately before "### 5. Write the Review". Inserted the verbatim block (heading
+ 6 ID-mapped bullets + canonical reference line).

Surrounding context after the edit:

```
- Are inline arrow functions created per-item in .map() where handler() should
  be used?

**Identity & Authorship (multi-user patterns only — N/A for single-user; do not penalize single-user)**

- Are people rendered with `cf-avatar` / `cf-profile-badge`, not `{name}` text or a raw `<img>`? (ID1)
...
Canonical reference: `docs/common/patterns/multi-user-patterns.md#presenting-identity` (category 14 in the critique guide).

### 5. Write the Review
```

### 2-counts — "13" → "14" category-count updates — OK

The task said the convention list count appears in ~2 places. THREE legitimate
"category count" references were found and updated (all genuine references to the
numbered category list):

1. Workflow §1 blurb: "This gives you the 13 convention violation categories." →
   "…14 convention violation categories." — OK
2. §3 heading: "### 3. Convention Violations (Categories 1-13)" →
   "(Categories 1-14)" — OK
3. Review-template comment: "[...continue for all 13 categories...]" →
   "[...continue for all 14 categories...]" — OK

(No other "13" appears in critic.md.)

---

## EDIT 3 — `/Users/ben/code/pattern-factory/.claude/agents/ux-designer.md` (wiring-plan #4)

### 3a — "Identity presentation (multi-user only)" Scope bullet — OK

Anchor matched: the **Scope: What You Decide** list, after the **Emotional
design** bullet and before "## Inputs". Inserted the verbatim bullet.

Surrounding context after the edit:

```
- **Emotional design**: Does this reduce anxiety or create it? Does it feel
  fast or sluggish? Does completing a task feel satisfying?
- **Identity presentation (multi-user only)**: Never equate the data "name"
  field with identity. Show the *viewer* via their own profile
  (`cf-profile-badge`, resolved from `#profile`) and *other* people via avatars
  (`cf-avatar`) + their snapshotted name; mark which roster entry is "me".
  Decide where identity appears in the IA (who's-here roster, authorship on
  records, a "you" affordance). See
  `docs/common/patterns/multi-user-patterns.md#presenting-identity`.

## Inputs
```

### 3b — Quality Checklist bullet — OK

Anchor matched: §8 Quality Checklist, after the "You haven't designed more views
than necessary" bullet and before the "The emotional quality matches the use
case…" bullet.

Surrounding context after the edit:

```
- You haven't designed more views than necessary
- If multi-user, the design says how the viewer and others are presented
  (profile badge vs avatars), not via a name field.
- The emotional quality matches the use case (a parking tool should feel
  calm and efficient, not playful and whimsical)
```

---

## EDIT 4 — rubric.json + rubric.md (wiring-plan #5)

Actual last existing ids confirmed: **code_craft → CCR-11**, **ux_design →
UXD-8**. New ids therefore: **CCR-12** and **UXD-9** (matching the wiring-plan's
anticipated ids). No new dimension added; no weights changed; worked example
untouched.

### 4a — rubric.json: append CCR-12 to `dimensions.code_craft.checks` — OK

Anchor matched: the CCR-11 object (ends `"scoring_guidance": "-5 per issue"`),
before the `]` closing `code_craft.checks`. Added a comma after the CCR-11 object
and appended the verbatim CCR-12 object (severity major, critic_ref
"pattern-critic Identity & Authorship", -10 / N/A guidance).

Surrounding context after the edit:

```
          "scoring_guidance": "-5 per issue"
        },
        {
          "id": "CCR-12",
          "description": "Multi-user identity: viewer resolved via #profile (not a typed-name field); per-user isolation via PerUser/PerSpace scope (not stored DIDs/user-ids/name strings); 'is this me'/roster dedup via equals() on a cell reference (not display-name equality). N/A for single-user patterns.",
          "severity": "major",
          "critic_ref": "pattern-critic Identity & Authorship",
          "scoring_guidance": "-10 per dead-string identity violation. N/A (no deduction) if single-user."
        }
      ]
    },
```

### 4b — rubric.json: append UXD-9 to `dimensions.ux_design.checks` — OK

Anchor matched: the UXD-8 object (ends `…Cramped or broken layout = negative."`),
before the `]` closing `ux_design.checks`. Added a comma after the UXD-8 object and
appended the verbatim UXD-9 object (severity minor, +/-5 guidance). Inserted
exactly as written in the task block (scoring_guidance begins `+/-5.`).

Surrounding context after the edit:

```
          "scoring_guidance": "±5. Clean, well-structured layout = positive. Cramped or broken layout = negative."
        },
        {
          "id": "UXD-9",
          "description": "Multi-user identity presentation: the viewer is shown via cf-profile-badge and other people via cf-avatar (never bare name text or raw <img>); a roster is built by join+snapshot; record ownership/authorship is shown via snapshot or CFC. N/A for single-user.",
          "severity": "minor",
          "scoring_guidance": "+/-5. Correct identity components and clear 'who's here' = positive; people rendered as name strings = negative. N/A if single-user."
        }
      ]
    },
```

### 4c — rubric.json parse check — OK

Command run:
`PATH="$HOME/.local/share/mise/installs/deno/2.8.1/bin:$PATH" deno eval "JSON.parse(Deno.readTextFileSync('/Users/ben/code/pattern-factory/rubric/rubric.json')); console.log('JSON OK')"`

Result: **JSON OK** (exit 0). rubric.json still parses after both appends.

### 4d — rubric.md mirror — OK

Three mirror edits, all matched:

1. Code Craft table (§2): CCR-12 row added after the CCR-11 row — OK
   ```
   | CCR-11 | Appropriate complexity — no over-abstraction, no logic duplication    | Minor    | -5 each   |
   | CCR-12 | Multi-user identity: viewer via #profile, PerUser/PerSpace isolation, dedup via equals() (N/A single-user) | Major | -10 each |
   ```
2. UX Design table (§5): UXD-9 row added after the UXD-8 row — OK
   ```
   | UXD-8 | Layout uses ct-screen, ct-vstack/ct-hstack appropriately             | Minor    | ±5     |
   | UXD-9 | Multi-user identity presentation: viewer via cf-profile-badge, others via cf-avatar, roster by join+snapshot (N/A single-user) | Minor | ±5 |
   ```
3. "Relationship to Pattern-Critic" mapping table: row added after the
   "13. Regression Check" row — OK
   ```
   | 13. Regression Check       | N/A (factory creates new patterns)                      |
   | Identity & Authorship      | Code Craft (CCR-12), UX Design (UXD-9)                   |
   ```

Note: rubric.md narrative still says the pattern-critic produces a checklist for
"13 violation categories" (prose at line ~406). The task scope for EDIT 4 only
called for the three table rows above (it did not list the rubric.md prose count
among the deliverables), so that prose count was left unchanged. The critique-guide
category-count reconciliation (#8) and any rubric.md prose "13"→"14" is owned
elsewhere / by the other agent — flag for follow-up if a consistent "14" is wanted
in rubric.md prose too.

---

## Constraints honored

- Used the Edit tool for all source edits (Write only for this report).
- No `/Users/ben/code/labs` files touched (this report is the only labs write, as
  instructed).
- No event-rsvp added anywhere; exemplars/ / index.md / default_exemplars not
  touched.
- spec-interpreter NOT instructed to grep `packages/patterns`; exemplar awareness
  kept scoped to `exemplars/`.
- No git add / commit. No processes killed.

## Result: all anchors matched, all edits OK; rubric.json parses (JSON OK).
