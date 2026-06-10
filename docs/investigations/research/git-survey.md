# Git Survey — Preparing Two Identity PRs (labs + pattern-factory)

Read-only survey to safely carve out the **multi-user identity** work into two PRs
without dragging in the user's unrelated pre-existing WIP. No working-tree mutations
were performed (status / diff / log / remote / ls / check-ignore only).

**Bottom line:** Both repos have a real GitHub `origin` and base on `origin/main`.
In **labs**, every MINE-EDITED file is a *pure additive identity diff* vs `origin/main`
(no user changes interleaved) — so the "copy working-tree file onto a fresh branch from
`origin/main`" reconstruction is SAFE for all of them. The labs skills mirrors
(`.claude/skills`, `.agents/skills`) are **symlinks to `skills/`**, so editing
`skills/` propagates automatically. In **pattern-factory**, all MINE-EDITED files are
also clean, but watch three non-MINE items: a modified `.gitignore` (infra cleanup,
NOT identity), and two non-mine briefs (`music-charts.md`, `music-discovery.md`).

---

## 1. Repo basics

### labs (`/Users/ben/code/labs`)

| | |
|---|---|
| Current branch | `ct-1674-meaning-qa` |
| `origin` (fetch/push) | `https://github.com/commontoolsinc/labs.git` |
| Real GitHub remote for a PR? | **Yes** |
| Default branch (`origin/HEAD`) | **`origin/main`** |

`git log --oneline -5`:
```
b2cc8a289 fix(patterns): Recorded reflections shows only meaning-track responses (CT-1674)
1a4d3ce10 feat(patterns): meaning-alignment Q&A v1 for the Self pattern (CT-1674)
69c57fc53 feat(patterns): neurotype self-report UI for the Self pattern (CT-1672) (#3908)
f1af61c47 feat(patterns): private self-model data layer (CT-1670) (#3907)
0813b47d1 perf(runner): skip redundant SES re-verification on integrity-gated warm hits (CT-1623) (#3905)
```
> The current branch's two top commits (`b2cc8a289`, `1a4d3ce10`) are the user's
> **committed meaning-qa work (CT-1674)** — unrelated to identity. The identity PR
> must base on `origin/main`, **not** on this branch tip, to avoid inheriting them.

### pattern-factory (`/Users/ben/code/pattern-factory`)

| | |
|---|---|
| Is a git repo? | **Yes** |
| Current branch | `main` (working directly on main, dirty) |
| `origin` (fetch/push) | `https://github.com/commontoolsinc/pattern-factory.git` |
| Real GitHub remote for a PR? | **Yes** |
| Default branch (`origin/HEAD`) | **`origin/main`** |

`git log --oneline -5`:
```
01097df Merge pull request #2 from commontoolsinc/wk/factory-sandbox-runner-backend
5c8e4bb Document sandbox-runner backend usage and migration posture
fed1093 Add sandbox-runner backend path to factory launcher
09a1c97 remove parking coordinator output dir
da296c4 follow-ups for tomorrow
```

---

## 2. Full `git status --short`

### labs
```
 M docs/common/ai/pattern-critique-guide.md          <- MINE
 M docs/common/ai/pattern-factory-build-guide.md     <- MINE
 M docs/common/components/COMPONENTS.md              <- MINE
 M docs/common/patterns/multi-user-patterns.md       <- MINE
 M mise.toml                                          <- USER-WIP (deno "2.8.1"->"latest")
 M packages/ui/src/v2/components/cf-autocomplete/cf-autocomplete.ts   <- USER-WIP
 M packages/ui/src/v2/components/cf-autolayout/cf-autolayout.ts       <- USER-WIP
 M packages/ui/src/v2/components/cf-badge/cf-badge.ts                 <- USER-WIP
 M packages/ui/src/v2/components/cf-calendar/cf-calendar.ts           <- USER-WIP
 M packages/ui/src/v2/components/cf-card/cf-card.ts                   <- USER-WIP
 M packages/ui/src/v2/components/cf-chip/cf-chip.ts                   <- USER-WIP
 M packages/ui/src/v2/components/cf-code-editor/styles.ts             <- USER-WIP
 M packages/ui/src/v2/components/cf-fab/cf-fab.ts                     <- USER-WIP
 M packages/ui/src/v2/components/cf-input/cf-input.ts                 <- USER-WIP
 M packages/ui/src/v2/components/cf-link-preview/cf-link-preview.ts   <- USER-WIP
 M packages/ui/src/v2/components/cf-list-item/cf-list-item.ts         <- USER-WIP
 M packages/ui/src/v2/components/cf-map/styles.ts                     <- USER-WIP
 M packages/ui/src/v2/components/cf-modal/styles.ts                   <- USER-WIP
 M packages/ui/src/v2/components/cf-prompt-input/cf-prompt-input.ts   <- USER-WIP
 M packages/ui/src/v2/components/cf-radio/cf-radio.ts                 <- USER-WIP
 M packages/ui/src/v2/components/cf-tab-bar/cf-tab-bar-item.ts        <- USER-WIP
 M packages/ui/src/v2/components/cf-tab-bar/cf-tab-bar.ts             <- USER-WIP
 M packages/ui/src/v2/components/cf-tab/cf-tab.ts                     <- USER-WIP
 M packages/ui/src/v2/components/cf-tags/cf-tags.ts                   <- USER-WIP
 M packages/ui/src/v2/components/cf-textarea/cf-textarea.ts           <- USER-WIP
 M packages/ui/src/v2/components/cf-tile/cf-tile.ts                   <- USER-WIP
 M packages/ui/src/v2/components/cf-toolbar/cf-toolbar.ts             <- USER-WIP
 M packages/ui/src/v2/components/cf-tools-chip/cf-tools-chip.ts       <- USER-WIP
 M skills/pattern-critic/SKILL.md                     <- MINE
 M skills/pattern-dev/SKILL.md                        <- MINE
 M skills/pattern-implement/SKILL.md                  <- MINE
?? .claude/projects/                                  <- USER-WIP (memory/handoff md)
?? TOKEN_INCONSISTENCIES.md                           <- USER-WIP
?? docs/investigations/                               <- MINE (see breakdown below)
?? docs/specs/batch-2-enhancements.md                 <- USER-WIP
?? docs/specs/cf-tab-bar.md                           <- USER-WIP
?? packages/cli/.claude/                              <- USER-WIP
?? packages/patterns/catalog/preview-identity.tsx     <- AMBIGUOUS (see notes)
?? packages/patterns/cf-theme-reactivity-smoke/       <- USER-WIP
?? packages/patterns/event-rsvp/                      <- MINE (main.tsx + main.test.tsx)
?? pass-log.md                                        <- USER-WIP
?? pass-traces.zip                                    <- USER-WIP
?? pass-traces/                                       <- USER-WIP
?? scripts/agents/connector.sh                        <- USER-WIP
?? scripts/agents/deployer.sh                         <- USER-WIP
?? scripts/agents/populator.sh                        <- USER-WIP
?? scripts/run-pass.sh                                <- USER-WIP
?? scripts/score-pass.py                              <- USER-WIP
?? scripts/setup-spike-9.py  ...  setup-spike-14.py   <- USER-WIP (6 files)
```

`docs/investigations/` (the MINE untracked tree) contains exactly:
```
docs/investigations/pf-identity-e2e.md
docs/investigations/research/exemplar-build.md
docs/investigations/research/factory-launcher.md
docs/investigations/research/identity-authoring-kit.md
docs/investigations/research/identity-map.md
docs/investigations/research/iter1-eval.md
docs/investigations/research/iter2-eval.md
docs/investigations/research/pattern-factory.md
docs/investigations/research/wiring-applied-A.md
docs/investigations/research/wiring-applied-B.md
docs/investigations/research/wiring-plan.md
```
> Note: `iter1-eval.md`, `wiring-applied-A.md`, `wiring-applied-B.md`, `iter2-eval.md`
> all exist. **`git-survey.md` (this file) is being created now** and will be the 11th
> research doc. `packages/patterns/event-rsvp/` holds `main.tsx` + `main.test.tsx` (both MINE).

### pattern-factory
```
 M .claude/agents/critic.md            <- MINE
 M .claude/agents/spec-interpreter.md  <- MINE
 M .claude/agents/ux-designer.md       <- MINE
 M .gitignore                          <- NOT in MINE list; infra cleanup (AMBIGUOUS, default EXCLUDE)
 M rubric/rubric.json                  <- MINE
 M rubric/rubric.md                    <- MINE
?? .claude/blackboard.db-shm           <- GITIGNORED-SCRATCH? (see note) -> EXCLUDE
?? .claude/blackboard.db-wal           <- GITIGNORED-SCRATCH? (see note) -> EXCLUDE
?? briefs/queue/event-rsvp.md          <- MINE
?? briefs/queue/music-charts.md        <- USER-WIP / other-work (EXCLUDE)
?? briefs/queue/music-discovery.md     <- USER-WIP / other-work (EXCLUDE)
?? mise.toml                           <- MINE (new, not ignored)
?? output/event-rsvp/                  <- GENERATED SCRATCH (EXCLUDE)
?? output/music-charts/                <- GENERATED SCRATCH, other-work (EXCLUDE)
?? output/music-discovery/             <- GENERATED SCRATCH, other-work (EXCLUDE)
```

---

## 3. Relevant `.gitignore` entries

### labs — root `.gitignore` (relevant lines)
```
22: claude-research.key
23: *.key                       <- *.key IS ignored
38: .claude/blackboard.db
43: .claude/blackboard.db-shm
44: .claude/blackboard.db-wal
45: .claude/worktrees/
```
- **`mise.toml`** — NOT ignored (it is a tracked file; the modification is visible).
- **`docs/investigations/`** + everything under it — NOT ignored (will be committed as MINE).
- **`packages/patterns/event-rsvp/`** — NOT ignored (MINE).
- **`*.key`** — ignored. No `workspace/` / `output/` / `factory.config.local.json`
  rules exist in labs (those are pattern-factory concepts).
- `.claude/projects/`, `pass-log.md`, `pass-traces*`, `TOKEN_INCONSISTENCIES.md` —
  NOT ignored, but they are USER-WIP and simply must not be added.

### pattern-factory — `.gitignore` (FULL, current working-tree version)
```
workspace/                       <- workspace/ IS ignored
factory.config.local.json        <- factory.config.local.json IS ignored
.claude/skills                   (symlink, ignored)
.claude/agents-upstream
.claude/scripts/upstream
docs
exemplars
*.key                            <- *.key IS ignored
node_modules/
.DS_Store / Thumbs.db
*.swp *.swo *~ .idea/ .vscode/ *.sublime-*
.claude/blackboard.db            <- base .db ignored
```
Answering the specific questions:
- **`factory.config.local.json` ignored?** **YES** (`.gitignore:5`). On disk (424 bytes),
  not tracked. Correctly excluded as machine-local secret/config.
- **`workspace/` ignored?** **YES** (`.gitignore:2`). The bare path `workspace/` reports
  "NOT IGNORED" only because the tracked `workspace/.gitkeep` exists; every real scratch
  child IS ignored — verified: `workspace/2026-06-08-event-rsvp-489a/` and
  `workspace/iter1-run.log` both match `.gitignore:2`. So all the iter*/run-log scratch
  (incl. `iter3.DONE`, `iter*-run.log`) is ignored. Good.
- **`output/` ignored?** **NO — `output/` is NOT in `.gitignore`.** Only `output/.gitkeep`
  is *tracked*. So `output/` is a *tracked-but-mostly-empty* dir: any new subfolder
  (`output/event-rsvp/`, `output/music-charts/`, `output/music-discovery/`) shows up as
  **untracked**, NOT ignored. (`output/music-charts` + `output/music-discovery` are NOT
  committed — `git ls-files output/` returns only `output/.gitkeep`; the prompt's
  assumption that they "appear committed" is **incorrect**.) `.DS_Store` inside output is
  ignored. **Action: do not `git add output/...`** — these are regenerable run artifacts.
- **`*.key` ignored?** **YES** (`.gitignore:15`) — identity keys excluded.
- **`mise.toml` ignored?** **NO** — `mise.toml` is not listed; it is a brand-new untracked
  file and IS intended to be MINE.
- **`.claude/blackboard.db-shm` / `-wal` ignored?** **NO** — `.gitignore` only lists
  `.claude/blackboard.db` (the base file), not the `-shm`/`-wal` sidecars, so they appear
  as untracked. They are SQLite scratch — **EXCLUDE** (do not add). (Consider adding
  `.claude/blackboard.db-shm`/`-wal` to `.gitignore` later; out of scope here.)

### `.gitignore` is itself MODIFIED in pattern-factory (not in MINE list)
`git diff origin/main -- .gitignore` removes stale rules (`output-runs/`, `.runtime/`,
the per-file `.claude/agents/*.md` upstream-symlink ignores, a bare `skills` rule) and
adds `.claude/agents-upstream` + `.claude/blackboard.db`. This is **symlink/infra
housekeeping, NOT identity work**, and was not listed as MINE. Treat as **AMBIGUOUS →
default EXCLUDE** from the identity PR unless you decide it's a prerequisite. If excluded,
note it will remain a dirty file in the user's tree (harmless).

---

## 4. Classification table

Legend: **MINE** = identity work, include · **USER-WIP** = pre-existing unrelated, exclude ·
**SCRATCH** = gitignored or regenerable artifacts, exclude · **AMBIGUOUS** = decide.

### labs
| Path | Class | Notes |
|---|---|---|
| docs/common/ai/pattern-critique-guide.md | MINE | +16, pure identity (category 14) |
| docs/common/ai/pattern-factory-build-guide.md | MINE | +6, identity reading list |
| docs/common/components/COMPONENTS.md | MINE | +57, "Identity components" section |
| docs/common/patterns/multi-user-patterns.md | MINE | +91, "Presenting Identity" |
| skills/pattern-critic/SKILL.md | MINE | +8, dead-string identity rule |
| skills/pattern-dev/SKILL.md | MINE | +7, identity guidance |
| skills/pattern-implement/SKILL.md | MINE | +3, reading-list line |
| docs/investigations/pf-identity-e2e.md | MINE | new |
| docs/investigations/research/*.md (10 existing + this) | MINE | new research docs |
| packages/patterns/event-rsvp/main.tsx | MINE | new exemplar pattern |
| packages/patterns/event-rsvp/main.test.tsx | MINE | new test |
| mise.toml | USER-WIP | tracked edit `deno "2.8.1"`→`"latest"`; env change, NOT identity |
| packages/ui/src/v2/components/cf-*.ts (23 files) | USER-WIP | the user's UI token/component work |
| .claude/projects/ | USER-WIP | memory handoff md |
| TOKEN_INCONSISTENCIES.md | USER-WIP | |
| docs/specs/batch-2-enhancements.md | USER-WIP | |
| docs/specs/cf-tab-bar.md | USER-WIP | pairs with cf-tab-bar UI work |
| packages/cli/.claude/ | USER-WIP | |
| packages/patterns/cf-theme-reactivity-smoke/ | USER-WIP | theme smoke test |
| packages/patterns/catalog/preview-identity.tsx | AMBIGUOUS | name says "identity" but NOT in the MINE list; likely a scratch preview. **Default EXCLUDE** unless you confirm it belongs to the exemplar. |
| pass-log.md, pass-traces.zip, pass-traces/ | USER-WIP | eval run artifacts |
| scripts/agents/{connector,deployer,populator}.sh | USER-WIP | |
| scripts/run-pass.sh, scripts/score-pass.py | USER-WIP | |
| scripts/setup-spike-9..14.py (6) | USER-WIP | |

> labs has **no gitignored-scratch** among the changed paths (`.claude/blackboard.db*`
> are already committed/ignored and don't appear in status). The exclusion problem in
> labs is purely "don't add USER-WIP," not "filter ignored files."

### pattern-factory
| Path | Class | Notes |
|---|---|---|
| .claude/agents/critic.md | MINE | -26/+16 |
| .claude/agents/spec-interpreter.md | MINE | +27/-2 |
| .claude/agents/ux-designer.md | MINE | +9 |
| rubric/rubric.json | MINE | +21/-8 |
| rubric/rubric.md | MINE | +78/-79 |
| briefs/queue/event-rsvp.md | MINE | new brief |
| mise.toml | MINE | new, not ignored |
| .gitignore | AMBIGUOUS | infra/symlink cleanup, NOT identity, not in MINE list → default EXCLUDE |
| briefs/queue/music-charts.md | USER-WIP | other pattern's brief |
| briefs/queue/music-discovery.md | USER-WIP | other pattern's brief |
| output/event-rsvp/ | SCRATCH | regenerable run output (NOT ignored, but artifact) → EXCLUDE |
| output/music-charts/ | SCRATCH | other-work artifact → EXCLUDE |
| output/music-discovery/ | SCRATCH | other-work artifact → EXCLUDE |
| .claude/blackboard.db-shm | SCRATCH | SQLite sidecar (not ignored but transient) → EXCLUDE |
| .claude/blackboard.db-wal | SCRATCH | SQLite sidecar → EXCLUDE |
| factory.config.local.json | SCRATCH | gitignored secret/config (on disk, untracked) → EXCLUDE |
| workspace/** (iter*.log, iter3.DONE, dated run dirs) | SCRATCH | gitignored via `workspace/` → EXCLUDE |

---

## 5. CRITICAL overlap check — are MINE-EDITED files contaminated with user changes?

Method: for every MINE-EDITED (tracked) file, `git diff origin/main -- <file>` and inspect.
The reconstruction plan (copy current working-tree file onto a fresh branch from
`origin/main`) is SAFE **iff** the file's entire diff is identity work.

### labs — ALL CLEAN ✅
Every MINE doc/skill file is **purely additive identity content**; no interleaved
unrelated edits.

| File | diffstat vs origin/main | Verdict |
|---|---|---|
| docs/common/components/COMPONENTS.md | +57 / -0 | clean — adds "Identity components", `cf-avatar`, `cf-profile-badge` |
| docs/common/patterns/multi-user-patterns.md | +91 / -0 | clean — adds "Presenting Identity" |
| docs/common/ai/pattern-critique-guide.md | +16 / -0 | clean — adds category 14 "Identity & Authorship" |
| docs/common/ai/pattern-factory-build-guide.md | +6 / -0 | clean — identity reading list |
| skills/pattern-critic/SKILL.md | +8 / -0 | clean — dead-string identity rule |
| skills/pattern-dev/SKILL.md | +7 / -0 | clean — identity guidance |
| skills/pattern-implement/SKILL.md | +3 / -0 | clean — reading-list line |

> All seven are **additions only (zero deletions)** — strongest possible signal that they
> sit on top of `origin/main` with no user edits mixed in. The
> copy-working-tree-onto-fresh-branch reconstruction is SAFE for all labs MINE files.
>
> **`mise.toml` is the one tracked file to be careful about: it is NOT identity** — its
> only diff is `deno "2.8.1"`→`"latest"`. Do **not** copy it into the labs identity PR.

### pattern-factory — MINE-EDITED clean, but `.gitignore` is a separate (non-MINE) edit
| File | diffstat vs origin/main | Verdict |
|---|---|---|
| .claude/agents/spec-interpreter.md | +27 / -2 | MINE (identity authoring guidance) |
| .claude/agents/critic.md | +16 / -26 | MINE (identity critique rubric) |
| .claude/agents/ux-designer.md | +9 / -0 | MINE |
| rubric/rubric.json | +21 / -8 | MINE |
| rubric/rubric.md | +78 / -79 | MINE |
| .gitignore | +/- infra | **NOT MINE** — symlink/blackboard cleanup; exclude by default |

> The five MINE pattern-factory files have small deletions, but those are part of the
> same identity-rubric rewrite (e.g. recalibrating critic/rubric for identity), not
> foreign user edits. Reconstruction is SAFE. The only non-MINE tracked modification is
> `.gitignore` — keep it out of the identity PR (or land it as a deliberate separate
> prerequisite if you decide it's needed).

---

## 6. labs skills mirror — SYMLINKS (not copies) ✅

`.claude/skills/` and `.agents/skills/` are directories whose **entries are per-skill
symlinks back into `../../skills/`**:

```
.claude/skills/pattern-dev        -> ../../skills/pattern-dev
.claude/skills/pattern-critic     -> ../../skills/pattern-critic
.claude/skills/pattern-implement  -> ../../skills/pattern-implement
.agents/skills/pattern-dev        -> ../../skills/pattern-dev   (identical pattern)
```
(`.claude/skills` and `.agents/skills` themselves are plain dirs, but each child skill is a
symlink — confirmed via `ls -la`.)

**Implication:** editing `skills/pattern-dev/SKILL.md` etc. is automatically reflected in
both mirrors. There are **no stale copies to regenerate**; the identity PR only needs the
three `skills/*/SKILL.md` files. (Indeed `git status` shows only `skills/...` as modified —
no `.claude/skills/...` or `.agents/skills/...` entries appear, confirming the symlinks
aren't separately tracked.)

---

## 7. pattern-factory specifics

- **Git repo?** Yes. **Remote?** `origin = https://github.com/commontoolsinc/pattern-factory.git`
  (real GitHub remote — PR is possible). Currently on `main` (dirty).
- **`mise.toml`** — untracked, NOT ignored → MINE, include.
- **`factory.config.local.json`** — gitignored (`.gitignore:5`), present on disk, untracked
  → EXCLUDE (machine-local).
- **`briefs/queue/event-rsvp.md`** — untracked, NOT ignored → MINE, include.
- **Other uncommitted changes that are NOT mine (must avoid):**
  1. `.gitignore` (modified) — infra cleanup, exclude by default.
  2. `briefs/queue/music-charts.md`, `briefs/queue/music-discovery.md` — other patterns'
     briefs, exclude.
  3. `output/event-rsvp/`, `output/music-charts/`, `output/music-discovery/` — regenerable
     run artifacts (NOT ignored but should not be committed), exclude.
  4. `.claude/blackboard.db-shm`, `.claude/blackboard.db-wal` — SQLite scratch, exclude.
  5. `workspace/**` (dated run dirs, `iter*-run.log`, `iter3.DONE`) — gitignored, exclude.

---

## 8. Recommended branch + base + exact file list per PR

Base both on the up-to-date default branch. **Fetch first** so `origin/main` is current.

### PR A — labs
- **Base:** `origin/main`
- **Branch:** `ct-<ticket>-multi-user-identity` (e.g. `ct-1675-multi-user-identity`)
- **Include exactly (12 paths):**
  ```
  docs/common/components/COMPONENTS.md
  docs/common/patterns/multi-user-patterns.md
  docs/common/ai/pattern-critique-guide.md
  docs/common/ai/pattern-factory-build-guide.md
  skills/pattern-critic/SKILL.md
  skills/pattern-dev/SKILL.md
  skills/pattern-implement/SKILL.md
  docs/investigations/pf-identity-e2e.md
  docs/investigations/research/   (all 11 .md, including this git-survey.md)
  packages/patterns/event-rsvp/main.tsx
  packages/patterns/event-rsvp/main.test.tsx
  ```
- **Explicitly EXCLUDE:** `mise.toml`; all 23 `packages/ui/src/v2/components/cf-*` files;
  `.claude/projects/`; `TOKEN_INCONSISTENCIES.md`; `docs/specs/*`; `packages/cli/.claude/`;
  `packages/patterns/cf-theme-reactivity-smoke/`; `pass-log.md` / `pass-traces*`;
  `scripts/agents/*` / `scripts/run-pass.sh` / `scripts/score-pass.py` /
  `scripts/setup-spike-*.py`; and `packages/patterns/catalog/preview-identity.tsx`
  (AMBIGUOUS — confirm before adding).
- **Reconstruction safety:** all MINE files are pure-additive vs `origin/main`, so
  `git checkout -B <branch> origin/main` then re-create/copy ONLY the paths above
  (e.g. `git checkout <current-tip> -- <each MINE tracked file>` for the edited docs/skills,
  and copy the untracked new files/dirs) yields a clean identity-only diff. Because the
  current branch's top commits are the user's meaning-qa work, do **not** branch off the
  current tip and do **not** cherry-pick those commits.

### PR B — pattern-factory
- **Base:** `origin/main`
- **Branch:** `<ticket>-identity-authoring` (e.g. `identity-authoring-kit`)
- **Include exactly (7 paths):**
  ```
  .claude/agents/spec-interpreter.md
  .claude/agents/critic.md
  .claude/agents/ux-designer.md
  rubric/rubric.json
  rubric/rubric.md
  briefs/queue/event-rsvp.md
  mise.toml
  ```
- **Explicitly EXCLUDE:** `.gitignore` (AMBIGUOUS infra cleanup — land separately if you
  decide it's a prerequisite); `briefs/queue/music-charts.md`;
  `briefs/queue/music-discovery.md`; `output/event-rsvp/`; `output/music-charts/`;
  `output/music-discovery/`; `.claude/blackboard.db-shm`; `.claude/blackboard.db-wal`;
  `factory.config.local.json` (gitignored); all of `workspace/**` (gitignored).
- **Reconstruction safety:** the five tracked MINE files are clean identity edits;
  `git checkout -B <branch> origin/main` then `git checkout <main-tip> -- <the 5 tracked
  files>` plus copying the two new untracked files (`briefs/queue/event-rsvp.md`,
  `mise.toml`) gives an identity-only diff. Verify `output/` and `.claude/blackboard.db-*`
  are never staged (they are not ignored, so a blind `git add -A` WOULD capture them — add
  paths explicitly).

---

### One-line caveats
- The prompt's premise that `output/music-charts` + `output/music-discovery` are *committed*
  is **wrong** — only `output/.gitkeep` is tracked; both dirs are untracked artifacts. So
  `output/` is "tracked dir, untracked contents" — a blind `git add -A` in pattern-factory
  would wrongly grab them. **Always add paths explicitly in pattern-factory.**
- pattern-factory `.gitignore` is dirty and is NOT identity work — decide consciously
  whether to ship it; default is to leave it out.
- labs `mise.toml` is the single tracked non-identity edit hiding among MINE docs — exclude it.
