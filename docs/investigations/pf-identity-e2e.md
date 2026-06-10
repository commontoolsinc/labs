# Investigation Log: Pattern Factory × Identity (E2E)

> Scientific-loop notes for using the **pattern factory** to generate a NEW
> multi-user / identity pattern from a spec, then iterating on the factory +
> identity docs / examples / components / spec based on what the output gets
> wrong. Maintained per the `investigate-debug` framework. Resilient to context
> compaction — a fresh agent should be able to resume from the Checkpoint.

## Problem
- **Goal:** Drive the pattern factory with a spec for a multi-user pattern that
  is *adjacent to but not present in* the existing example library. Evaluate
  whether the generated pattern correctly handles **identity**: per-user vs
  shared state, rendering identity via the canonical cf-* components, identity
  APIs ("who am I" / author / owner / DID), and wish-for-identity discovery.
- **This is an E2E test of:** (1) the pattern factory itself, (2) the identity
  concepts/docs, (3) user-specific state, (4) correct use of identity UI controls.
- **Stakes:** Expected to surface improvements to the pattern factory (possibly
  *beyond* the profile/identity area) and to identity docs/examples/components.
- **Constraints:** Multi-iteration (assume it fails on the first go). Manage
  context via *supervised subagents*. Subagents write deliverables to files
  (the stop-hook derails their final chat messages in this sandbox).

## Known Facts
- [fact] **Multiplayer inventory** (Explore agent): `group-chat-lobby`,
  `group-chat-room`, `profile-group-chat`, `scoped-group-chat`,
  `shared-profile-roster`, `cozy-poll` (voting), `fair-share` (group expenses),
  `battleship/multiplayer` (turn-based 2p), `parking-coordinator` (admin
  allocation), `cfc-authorship-chat` (verified authorship), `scoped-user-directory`
  (roster). Source: `packages/patterns/`. (Per-pattern identity-handling detail
  still thin — revisit exemplars later.)
- [fact] **Gaps (no existing pattern):** presence/who's-online, approval
  workflows, per-user *private* state alongside shared, reactions on arbitrary
  content, RSVP/attendance, leaderboards, live co-editing, group-membership
  discovery, multi-author comment threads, delegation, consent/mutual agreement,
  general turn-taking framework.
- [fact] **Identity components exist** incl. `cf-profile-badge` (+ signed avatar);
  shipped via PRs #3879/#3881/#3882/#3883. cf-* Lit components live in
  `packages/ui/src/v2/components/`.
- [fact] **Env:** deno is pinned to **2.8.1** via `mise.toml` (user confirmed,
  `deno -v` = 2.8.1 for them). The sandbox Bash here resolves **2.7.14**; force
  the right one with `mise exec deno@2.8.1 -- deno ...` when execution is needed.
  NOT a real blocker.
- [fact] **Stop hook** runs `tasks/check.sh` (type check; deno version gate
  >=2.8 <2.9). In this sandbox it fails on the version gate and *derails the
  final message of subagents*. Mitigation: subagents write their report to a
  file; ignore the hook.
- [fact] **Factory substrate** (full detail: `research/pattern-factory.md`): a
  multi-agent LLM flow `spec → ux_design → ui_design → build → critic →
  manual_test`. The **Orchestrator + spec/ux/ui agents are EXTERNAL** (the
  `common-fabric-2` launcher, NOT in this repo). In-repo we have: build/critic/
  manual-test subagents (`.claude/agents/{pattern-maker,pattern-critic,manual-tester}.md`),
  the skills, the build contract (`docs/common/ai/pattern-factory-build-guide.md`),
  and committed outputs (`packages/patterns/factory-outputs/`, best example
  `parking-coordinator/`). **No single `factory run` command exists.** Build
  self-verify gate: `deno task cf check <p>.tsx --no-run` && `deno task cf test`.
- [fact] **Spec format** = `# Pattern Spec` →  Description, Complexity Assessment
  (Tier/exemplars/rationale), Data Model, User Interactions, Acceptance Criteria,
  Edge Cases, Assumptions. Canonical: `factory-outputs/parking-coordinator/spec.md`.
  NOTE: the template has **no "Identity & Presentation" section** — a likely
  high-leverage improvement.
- [fact] **Identity surface** (full detail: `research/identity-map.md`):
  components = `cf-avatar` (untrusted; data:-URI / glyph / initials),
  `cf-profile-badge` (TRUSTED; bind `$profile` *cell*; draws verified seal from
  CFC `represents-principal` label), `cf-cfc-authorship` (authored-by chip).
  Current viewer via `wish({query:"#profile"|"#profileName"|"#profileAvatar"})`
  (viewer-only; **no list-all-profiles** primitive). **No user-space "who am I"
  API** — per-user identity is implicit via scoped cells
  `Writable.perUser/perSession/perSpace`. Multi-user roster idiom = each user
  **joins + snapshots** their name/avatar into a `PerSpace` roster.
- [fact] **KEY GAP**: no doc *mandates* using `cf-profile-badge`/`cf-avatar` to
  render people. `docs/common/components/COMPONENTS.md` has no entry for either;
  the mandate RFC `docs/specs/multi-user-identity-pattern.md` (commit `3a8e13ce6`)
  is unmerged / not on the working tree; most multiplayer patterns render dead
  name strings. → **prime improvement target.**
- [fact] **Runtime blockers to design AROUND**: **CT-1665** (can't save profile
  avatar/elements — verified-binding) and **CT-1667** (cross-space owner-field
  name read → badge shows "Profile"). Mitigation: the test spec must READ
  identity (never edit the profile) and use join+snapshot, not cross-space reads.

## Hypotheses (what the factory will likely get wrong) — to test against output
- H1 (display): build phase renders people as **dead name strings / raw `<img>`**
  rather than `cf-avatar` / `cf-profile-badge`, because docs don't mandate the
  components and most exemplars use strings. | conf: **HIGH**
- H2 (viewer): build phase does **not** resolve the current viewer via the
  `#profile` wish, and shows no `cf-profile-badge` "You" card. | conf: med-high
- H3 (state): per-user vs shared state modeled imperfectly — may store ids/DIDs
  to fake isolation instead of `Writable.perUser`. | conf: med
- H4 (authorship): "who did X" stored as a name field rather than CFC
  `AuthoredByCurrentUser` / `cf-cfc-authorship`. | conf: med-high
- H5 (roster idiom): may attempt cross-space profile reads (hitting CT-1667 /
  no-list-all) instead of the join+snapshot idiom. | conf: med
- H6 (meta/factory): the spec phase under-specifies identity because the spec
  template has **no "Identity & Presentation" section** — if true, fixing the
  template is a high-leverage, profile-independent improvement. | conf: med

## Experiments
- **E1 — RSVP full factory run.** Action: `cd ~/code/pattern-factory &&
  ./run-factory.sh --brief briefs/queue/event-rsvp.md --model claude-opus-4-8`
  (PATH pinned to deno 2.8.1; full pipeline incl. manual_test). Brief is
  identity-laden but implementation-neutral (never names avatar/profile/per-user).
  Tests H1–H6 / scores ID1–ID7.
  - Expected if **H1** (display): generated `main.tsx` renders responder names as
    plain `{name}` text / raw `<img>`; **no** `cf-avatar`/`cf-profile-badge` import.
  - Expected if **H2** (viewer): no `wish({query:"#profile"|"#profileName"})`; no
    "You" badge; the viewer is identified by a typed-in name (or not at all).
  - Expected if **H3/H6** (state): RSVPs stored as one array keyed by a name/id
    string with dedup-by-name, **not** `Writable.perUser`; maybe a synthetic userId.
  - Expected if **H4** (authorship): `event.createdBy` is a stored name string,
    not CFC `AuthoredByCurrentUser`/`RepresentsCurrentUser`.
  - Expected if **H5** (roster): roster from typed names, not join+snapshot.
  - **Experiment success ≠ pattern success:** the run succeeds if we obtain a
    gradeable pattern we can score on ID1–ID7 with file:line evidence. A pattern
    that fails identity is a *successful, informative* experiment.
  - Output: `~/code/pattern-factory/output/event-rsvp/` + scratch
    `~/code/pattern-factory/workspace/<run-id>/`.
- **E2 — RSVP re-run AFTER wiring (transfer test).** Same brief, same static-first
  pipeline, deno pinned, detached bg. Wiring applied + verified (diff reports
  `research/wiring-applied-{A,B}.md`): critique-guide **category 14 "Identity &
  Authorship"**; pattern-critic SKILL emphasis + ref; build-guide + pattern-dev/
  implement doc pointers; factory `critic.md` Extended Check + 13→14 counts;
  `spec-interpreter` identity rule + **"Identity & Presentation" spec section** +
  checklist + narrowed maker scope; `ux-designer` scope bullet + checklist;
  `rubric.json` CCR-12 + UXD-9 (parses OK) + rubric.md rows/mapping. **event-rsvp
  NOT exposed** (containment held). Predict if wiring works: spec.md gains an
  Identity & Presentation section; main.tsx uses `#profile` + `cf-profile-badge` +
  `cf-avatar` + join/snapshot + `equals()`; critic FLAGS any dead-string identity;
  ID1–ID7 lift sharply vs E1.
  - **E2 RESULT (run `b043`, KILLED again at build — same churn):** ✅ **WIRING
    WORKED.** spec.md has an "## Identity & Presentation" section, cites
    `fair-share` (the intended transfer source), uses organizer/attendee
    SNAPSHOTS + join-and-snapshot ("no pre-defined member list"). main.tsx
    (partial build) uses `wish("#profile")`, `cf-profile-badge` (viewer),
    `cf-avatar` (others), `PerUser`/`PerSpace`, `equals()` for "is this me" —
    night-and-day vs E1's dead strings.
  - **Transfer + containment CONFIRMED:** zero reference to the held-out
    `packages/patterns/event-rsvp`; spec-interpreter sourced `fair-share` via the
    DOCS (`notes/spec-interpreter.md:21-26`), not by copying our exemplar.
  - **NOT yet obtained:** a verified-compiling FINAL pattern, the critic's new
    identity check firing LIVE, a factory grade — the run dies at ~build (churn)
    before critic/grade. Compile-check via labs `cf` fails (file out-of-labs-root;
    would need copy-into-labs).
  - **Open blocker: the bg run keeps getting reaped by session churn (~build) —**
    needs true OS-detachment (`nohup`, reparent to init) or a user-run terminal to
    reach a COMPLETE run. Even so, the partial already answers the core question.
  - Cosmetic: rubric.md prose still says "13 violation categories" (~L406) —
    grader uses tables/json, non-blocking.
  - **E2b (complete-run retry) LAUNCHED FULLY DETACHED** (`nohup` + subshell-exit
    → reparented to init → escapes the churn reaper that killed 90bc/b043) for a
    COMPLETE run (live critic identity check + grade + verified pattern). Sentinel
    `~/code/pattern-factory/workspace/iter3.DONE` written on claude exit; log
    `workspace/iter3-run.log`; a tracked waiter watches the sentinel for
    notification (waiter may itself be churn-killed → then poll / user ping). New
    run-id = newest `workspace/2026-*-event-rsvp-*` (≠ b043/90bc). If the waiter
    returns FAST (<~2 min) → claude crashed early (check iter3-run.log); if ~1.5h
    → completed. **E2b RESULT (run `489a`) — COMPLETE; detachment WORKED**
    (survived churn — the waiter died but the factory ran to done). status=completed,
    **final_score 73 ("Solid")**, build 3 iters / 0 errors / **41 tests pass**,
    critic **3 passes** (P1 MAJOR auto-join; P2 regressions CRITICAL
    button-in-computed + MAJOR write-in-computed; P3 clean), grade 73 (Correctness
    85, Code Craft 75, Tests 80, Spec 80, UX 73, Exp 72, First-run 70; raw 76 −3
    iters). manual_test skipped. Output `output/event-rsvp/`. Critic findings were
    REACTIVITY, not identity (build got identity right up front). Full ID1–ID7 eval
    → `research/iter2-eval.md` (in progress).
  - **FACTORY-INFRA FINDING (beyond identity):** `pattern-maker` subagent_type is
    NOT registered — Claude Code doesn't scan `.claude/agents-upstream` (the symlink
    to labs `.claude/agents`), so the orchestrator fell back to general-purpose
    agents carrying the maker instructions/skills. Works but degraded (explains
    iter-1 context exhaustion). Candidate fix: register upstream agents as real
    subagent types (copy/symlink into `.claude/agents/` or add to settings).
  - **E2b EVAL VERDICT (full: `research/iter2-eval.md`) — EXPERIMENT SUCCEEDED.**
    iter-2 scores **ID1–ID7 = ALL PASS** (vs iter-1's 1 PASS + 1 PARTIAL). Every
    lever fired end-to-end: spec.md has a correct "Identity & Presentation"
    section; main.tsx uses `#profile` + `cf-profile-badge` (self) + `cf-avatar`
    (others) + join/snapshot + `equals()` cell-ref identity; the **critic's new
    category #14 "Identity & Authorship" ran in ALL 3 passes** with per-ID PASS +
    file:line evidence (the highest-leverage lever — iter-1 had NO identity
    dimension and *blessed* the anti-pattern); the grade scored identity clean in
    code_craft + ux_design. Genuine transfer — the maker reasoned to the cell-ref
    `me` idiom, didn't copy a fixture.
  - **⚠ Transfer-test integrity — partial leak at the BUILD layer:** spec/brief/ux
    are clean (no event-rsvp ref), but the *maker + critic* notes cite the held-out
    `packages/patterns/event-rsvp` as a corpus exemplar (the general-purpose maker
    globbed `packages/patterns`). It leaned on it for the explicit-join DECISION,
    not the identity primitives (equally taught by `fair-share` + docs). So identity
    transfer is real but not perfectly blind. Containment held at SPEC level
    (spec-interpreter scoped to `exemplars/`) but NOT at BUILD level. Clean-test
    fix: hide event-rsvp from the maker (new domain / rename / exclude from glob).
  - **More factory-infra findings (beyond identity — `iter2-eval §7`):** (a) a
    spec-literalism fix pass forced an anti-pattern (button + write inside
    `computed()`) → 2 regressions, later reverted — critic should weigh spec vs
    framework idiom; (b) tests via `.send()` are BLIND to UI-layer breakage
    (button-in-`computed` was "41/41 green") → want a render/click smoke check
    (esp. with manual_test off); (c) the maker FABRICATED a doc citation
    (non-existent `computed/side-effects.md`) to defend the anti-pattern (critic
    caught it) → validate cited doc paths.

## WHERE WE ARE (latest — supersedes the older Checkpoint below)
Core loop COMPLETE; experiment SUCCEEDED: factory failed identity (iter-1) →
root-caused → defined the right way (docs + exemplar) → wired factory → re-ran →
**ALL ID1–ID7 PASS, all levers fired** (iter-2 `489a`, score 73). Open choices:
- **(A) Clean BLIND re-run on a NEW multi-user domain** (kudos / approval /
  presence) — no held-out-exemplar collision → confirms the wiring GENERALIZES
  (not RSVP-specific) and is leak-free.
- **(B) Act on factory-infra findings** — register `pattern-maker` subagent
  (`agents-upstream` not loaded); critic spec-vs-idiom guard + UI render/click
  smoke check; doc-citation validation.
- **(C) Land the work** — docs (COMPONENTS.md, multi-user-patterns.md) + exemplar
  (event-rsvp) + factory wiring → proper `ct-…-identity` branch (currently on
  unrelated `ct-1674-meaning-qa`); decide labs PR vs factory-repo commit.
- **(D) Synthesize learnings + wrap.**
Detachment recipe that WORKS for long factory runs (survives session churn):
`( nohup bash -c '…claude -p…; touch workspace/<id>.DONE' >/dev/null 2>&1 & )`
+ a tracked waiter polling the sentinel.

## PRs PREPARED (CT-1676) — work secured
Linear: **CT-1676** (standalone). Two PRs, each built from `origin/main` in an
isolated worktree (user's working trees + indexes untouched — verified main
indexes EMPTY, branches unchanged: labs `ct-1674-meaning-qa`, pf `main`):
- **labs#3914** (`ct-1676-multi-user-identity`): COMPONENTS Identity components +
  multi-user-patterns Presenting Identity + critique-guide cat 14 + build-guide &
  3 skills pointers + `packages/patterns/event-rsvp/` exemplar. 9 files, +1068/−0;
  fmt/lint/check clean. **Upstream dependency.**
- **pattern-factory#49** (`ct-1676-factory-identity-wiring`): spec-interpreter +
  critic + ux-designer + rubric.json/md + mise.toml + validation brief. 7 files.
  Depends on labs#3914 (critique-guide cat 14).
- Investigation docs kept OUT of the PRs (user choice); they remain UNCOMMITTED in
  the labs working tree under `docs/investigations/` as the local record.
- **⚠ Working-tree note:** my identity edits + investigation docs still sit
  UNCOMMITTED in the user's labs tree (`ct-1674-meaning-qa`) and pf tree (`main`),
  intermixed with the user's WIP. Safely captured in the PRs → a `git add -A` on
  those branches would re-add them; exclude, or have me tidy them out on request.
- **NEXT (user intent):** another full factory rerun — ideally a BLIND test on a
  NEW domain (kudos / approval / presence) to confirm generalization + close the
  build-layer event-rsvp leak.

## E3 — FULL pipeline rerun (incl. manual_test / browser), supervised
- PRs converted to **draft** (labs#3914, pf#49) per user. Investigation kept
  in-tree (NOT tidied) until we're happy.
- Prereqs: created `labs/claude.key` (120B local dev key for deploy); removed
  `factory.config.local.json` so the committed `require_manual_test=true` governs
  → FULL pipeline this time.
- Launched the FULL run on the SAME RSVP brief, **detached** (nohup recipe;
  sentinel `workspace/iter3full.DONE`, log `workspace/iter3full-run.log`). Adds the
  manual_test deploy + agent-browser phase skipped in 489a → tests whether the
  identity-correct pattern actually WORKS in a browser. ~2.5–3h.
- Supervision: a background waiter on the sentinel notifies the main loop; on
  completion the **evaluation runs in a subagent** → `research/iter3-full-eval.md`
  (ID1–ID7 + manual-test/browser findings + grade; compare to 489a). If the waiter
  is churn-reaped, the detached run still completes — recover via
  `workspace/iter3full.DONE` / newest `workspace/2026-*-event-rsvp-*/pipeline.json`
  (run-id ≠ 489a/b043/90bc).
- **E3 RESULT (run `71b6`) — COMPLETE, full pipeline incl. BROWSER** (detachment
  worked again; waiter reaped but run finished). status=completed, **final_score 69
  ("Functional")**, build 40 tests pass, critic 2 passes (P1: 2 MAJOR index-identity
  + maxLength → fixed; P2 clean), **manual_test RAN (deploy + agent-browser)**,
  grade 69 (raw 74 −5 for 3 iters). Output `output/event-rsvp/`. ⚠ Dev servers left
  LINGERING on 8100/5273 (factory-started deno; not killed — safety).
- **⭐ CRITICAL FINDING (the browser earned its keep):** manual_test caught
  **DEFECT-1 (HIGH)** that ALL static runs (incl. 489a "all PASS") missed —
  **`cf-profile-badge` bound via `$profile` INSIDE a `computed()` subtree renders
  BLANK** (whole UI blank; `$`-bidirectional bindings are illegal inside
  `computed()`, and patterns build UI from computed subtrees). Factory fixed it by
  rendering the viewer with `cf-avatar` (forced spec deviation, −10 Spec Fidelity).
  → Challenges our canonical guidance ("badge the viewer") and may mean OUR
  exemplar + docs have a latent render bug. **PRs are drafts — good.** Likely the
  real rule is "cf-profile-badge must sit at a STATIC position, not inside a
  reactive `computed()`" (cf. memory: [UI] must be static VNode; use ifElse as a
  child of a static wrapper). Eval subagent investigating → `research/iter3-full-eval.md`.
  - **Status: build artifacts COMPLETE; run KILLED during critic** (session/env
    churn — empty stdout log). Reached spec✅ ux✅ build✅ (compiles, 30 tests
    pass); `critic-001.md` written, no fix pass; grade/summarize never reached.
    Run dir: `workspace/2026-06-08-event-rsvp-90bc/`. Full scorecard +
    snippets: `research/iter1-eval.md` (verified — spot-checked source, no halluc).
  - **E1 RESULT — identity scorecard:** ID1 FAIL, ID2 FAIL, **ID3 PASS** (correct
    `PerSpace`/`PerUser` scoping, no DID-faking — verified main.tsx:44-48), ID4
    FAIL, ID5 FAIL, ID6 FAIL, ID7 PARTIAL ("you" badge intent present; but no
    avatars + fragile name-equality). **H1–H5 all CONFIRMED. H6 CONFIRMED.**
  - **ROOT CAUSE = systemic factory identity blind spot at 3 levels (verified):**
    1. **spec-interpreter decided it:** `spec.md:180-182` "Identity is purely
       name-based, not account-based"; modeled a first-class "Viewer Identity" =
       self-typed nickname.
    2. **ux-designer** made the RSVP name field *be* the identity mechanism.
    3. **critic has NO identity dimension** (12 categories, zero) and affirmatively
       blessed it: `critic-001.md:51` "name-based identity … This is spec-correct."
    → Pattern is a textbook dead-string model: people = `<span>{name}`, "me" = a
      typed string compared by lowercased name, dedup-by-name, ownership = stored
      name string. No `cf-avatar`/`cf-profile-badge`/`#profile` wish/CFC anywhere.
  - The factory **never had a chance to do better** — none of its inputs
    (exemplars `habit-tracker`/`simple-list`, docs, critic rubric, spec template)
    mention identity. Confirms the KEY GAP (no doc mandates the components) and H6.

## Decisions / Changes
- Decision: Subagents write reports to `docs/investigations/research/*.md` to
  survive the stop-hook derail. Rationale: deliverable must not depend on the
  agent's final chat message.
- **D1 (substrate):** Use the **REAL factory launcher at `~/code/pattern-factory`**
  (user confirmed it's present) — NOT the reconstruct-via-subagents fallback. So
  the full `spec → ux → ui → build → critic → manual_test` pipeline is exercised,
  including the external spec/ux/ui agents. Improvements may therefore extend into
  `~/code/pattern-factory` itself (its agents/skills/spec-template), which is
  squarely the "improvements beyond profile" we expected.
- **D2 (spec):** Build an **Event RSVP / headcount** pattern (Intermediate tier).
  Provide a NEUTRAL, product-flavored *brief* (no implementation prescriptions —
  do NOT name cf-profile-badge / PerUser) so we genuinely test whether the
  factory reaches for the right identity primitives on its own.
- **D3 (depth):** First iteration is **static-first** (user choice): skip
  manual_test/browser → spec → ux → build → critic → grade → summarize. Faster
  (~1–1.5 hrs); most identity findings are visible in generated code. Browser run
  deferred to a later iteration once identity handling looks right. Enforced two
  ways: `factory.config.local.json` `require_manual_test:false` **and** an explicit
  "skip Phase 4" instruction in the launch prompt (the orchestrator may otherwise
  run manual_test for UI-heavy patterns on its own judgment, orchestrator.md:200).
- **D5 (iteration-2 approach — user choice):** **Define-the-right-way FIRST**,
  no re-run yet. Author in labs: (a) COMPONENTS.md identity entries, (b) canonical
  multi-user **identity & presentation** guidance, (c) a spec-template "Identity &
  Presentation" section, (d) a **gold-standard multi-user identity exemplar**
  (compiles + tests). **Review with user** before wiring the factory's own agents
  (critic rubric / spec-interpreter / ux-designer = DEFERRED) or spending a re-run.
  When the re-run happens it will be a **detached launch** (setsid/nohup) by me
  (iter-1 bg run was killed). Realistic target (blockers-aware): viewer-only
  `#profile` + `cf-profile-badge` "You"; others via `cf-avatar` snapshots; join+
  snapshot roster; `equals()`/cell-ref identity; CFC authorship where feasible.
- **D4 (run env hardening — findings + fixes):**
  - The factory runs as a **headless `claude -p`** from `~/code/pattern-factory`,
    using the user's Claude auth (smoke-tested OK with `--model claude-opus-4-8`;
    `FACTORY_SMOKE_OK`). It spawns its own Task subagents.
  - **`ct→cf` rename scare = non-issue.** labs added a PreToolUse hook
    `block-legacy-cli.ts` (labs `.claude/settings.json`) that blocks `ct`. But it
    only fires when `$CLAUDE_PROJECT_DIR=labs`. The factory session's project dir
    is `pattern-factory` (its `.claude/settings.json` has **no hooks**; user
    settings none). Ground-truthed: `deno task ct --help` runs fine in a factory
    session. So the factory's `ct`-based build gate works. (Only MY labs-session
    Bash must use `cf` not `ct`.)
  - **Created `~/code/pattern-factory/mise.toml`** pinning deno 2.8.1 (factory had
    no pin → risked resolving mise's global default, older than the pattern
    type-checker wants). Launch also pins PATH to the 2.8.1 install. Belt + braces.
  - Factory's nested session has **no Stop/SubagentStop hooks** → no deno-version
    stop-derail inside the run (unlike my labs subagents earlier).
- **D6 (iteration-2 wiring — user APPROVED docs+exemplar):** Wire the factory as a
  **transfer test** (event-rsvp NOT exposed to the factory; `fair-share` — a
  different domain — is the existing identity exemplar it must transfer from):
  (1) factory `critic` agent — add an "Identity & Authorship" review category
  (ID1–ID7 checks); (2) factory `spec-interpreter` — identity decision rule +
  emit an "Identity & Presentation" spec section, point at `fair-share`;
  (3) ensure the maker reads the new identity docs (build guide / pattern-dev
  skill); (+ optional ux-designer + grader rubric.json identity dimension). Then
  **detached** re-run of the SAME RSVP brief → re-score ID1–ID7 for lift.

## Identity Rubric (the measurement instrument)

Score each generated pattern on these. Each dimension: PASS / PARTIAL / FAIL +
evidence (file:line) + the **improvement it implies** (doc / example / component /
spec-template / factory-skill). This rubric is itself a candidate deliverable
(could land in `pattern-critique-guide.md` as an "Identity" section).

- **ID1 Render others' identity** — people shown via `cf-avatar`/`cf-profile-badge`,
  not dead name strings or raw `<img src>`.
- **ID2 Render current viewer** — resolves "me" via `#profile`/`#profileName`
  wish and shows the viewer's own profile (e.g. a `cf-profile-badge` "You" card,
  à la `fair-share`).
- **ID3 Per-user vs shared state** — correct `Writable.perUser/perSession/perSpace`;
  did NOT store DIDs/ids to fake isolation.
- **ID4 Join + snapshot idiom** — each user contributes their own name/avatar
  snapshot to a `PerSpace` roster; no cross-space owner reads.
- **ID5 Authorship/ownership** — "who did this" via CFC
  (`AuthoredByCurrentUser`/`RepresentsCurrentUser`) and/or `cf-cfc-authorship`,
  not a stored name.
- **ID6 Identity-correctness pitfalls** — uses `equals()`/references for identity,
  not `id` fields; doesn't compare mutable display names.
- **ID7 Identity UX** — self visually distinguished from others; avatar `alt`/
  names accessible; consistent treatment.

## Open Questions
- RESOLVED — factory invocation: see `research/pattern-factory.md` §2 (no single
  command; reconstruct via subagents / cf-harness / external launcher).
- RESOLVED — identity APIs & data model: see `research/identity-map.md` §3–5.
- **DECISION (user):** run substrate — reconstruct-via-subagents [rec] /
  cf-harness / external launcher.
- **DECISION (user):** which spec — RSVP [rec] / availability-presence / kudos /
  approval.
- **DECISION (user):** first-iteration depth — static identity eval [rec] /
  full incl. browser manual-test.
- OPEN: will the in-repo build subagent (`pattern-maker`) reach for identity
  components unprompted? (the core test → H1/H2)
- OPEN: does the spec template need an explicit "Identity & Presentation"
  section? (→ H6)

## Iteration 2 plan — improvement targets (ranked by leverage; from iter1-eval §F)
1. **Add an "Identity & Authorship" category to the pattern-critic rubric** —
   *highest leverage*; the critic ran 12 categories, caught 0 identity issues, and
   explicitly blessed dead-string identity. Checks: people via `cf-avatar`/
   `cf-profile-badge` not raw strings/`<img>`; viewer via `#profile`/`#profileName`
   not a self-typed name; ownership/authorship via CFC not a stored name; per-person
   identity keyed by cell ref/`equals()` not normalized display name. *Where:*
   factory `critic` agent + `skills/pattern-critic` + a gotcha doc.
2. **Spec-interpreter identity decision rule** + a **"Viewer Identity / Presentation"
   section in the spec template** — the failure is seeded at spec.md:180-182.
3. **Write a canonical multi-person identity exemplar** — the factory imitates
   exemplars; strongest behavior-changer after the rubric. Encode the *realistic*
   target (blockers-aware): viewer via `#profile` + "You" `cf-profile-badge`;
   others via `cf-avatar`; join+snapshot roster with a `PerUser` "me" pointer;
   `equals()`/cell-ref dedup; CFC authorship where feasible.
4. **Fill the COMPONENTS.md identity gap** (`cf-avatar`/`cf-profile-badge`/
   `cf-cfc-authorship`) — the doc the pattern-maker actually reads.
5. **ux-designer:** stop equating the name field with identity.
> Note: "the right way" is currently UNDERSPECIFIED + constrained by CT-1665/1667
> and the missing who-am-I/list-all primitives. So step 3/4 must DEFINE a
> realistic target (viewer-only `#profile` + join/snapshot), not an idealized one.

## Transfer-test containment (DO NOT VIOLATE)
event-rsvp is held out of the factory's awareness by THREE independent accidents
(per `research/wiring-plan.md`). Keep all three until the re-run is scored:
1. `~/code/pattern-factory/exemplars/` is a CURATED symlink dir (counter/todo-list/
   habit-tracker/battleship) — event-rsvp not among them. Do NOT reconcile it to
   the documented "whole patterns dir" symlink (CLAUDE.md/README describe that, but
   reality is curated — leave the mismatch).
2. `packages/patterns/index.md` does NOT list event-rsvp (catalog not regenerated)
   — do NOT regenerate it while the test is open.
3. spec-interpreter is scoped to scan `exemplars/` only — do NOT add a
   `packages/patterns` grep. fair-share (different domain) is the legit identity
   exemplar it must transfer from.

## Checkpoint
- **Current understanding:** E1 done. The factory has a **systemic identity blind
  spot** — spec-interpreter + ux-designer + critic all default to name-string
  identity, and the critic rubric has no identity dimension. State scoping is the
  one bright spot (`PerSpace`/`PerUser` correct). Evidence: `research/iter1-eval.md`.
- **Ruled out:** deno blocker; "factory broken by ct→cf" (false — factory session
  has no labs hooks); that the factory would handle identity adequately (it does
  not — by design, not by slip).
- **Iter-2 progress (define-the-right-way):** DONE — authored canonical docs:
  `docs/common/components/COMPONENTS.md` "Identity components" (cf-avatar +
  cf-profile-badge + the render-people-not-strings rule), and
  `docs/common/patterns/multi-user-patterns.md` "Presenting Identity" section
  (resolve viewer via `#profile`; badge self / avatar others; join+snapshot;
  `equals()`/cell-ref identity; anti-patterns; CT-1665/1667 constraints; a spec
  "Identity & Presentation" checklist) + Checklist + Good-Examples updates.
  Authoring kit: `research/identity-authoring-kit.md` (fair-share = gold model,
  scoped-user-directory = clean "me" cell-ref). DONE: gold-standard
  `packages/patterns/event-rsvp/main.tsx` exemplar — compiles, 15 tests pass,
  satisfies ID1–ID7 (verified core: Input has NO name field; viewer via `#profile`;
  `cf-profile-badge` "You"; join+snapshot; `me` = cell-ref; RSVP written THROUGH
  `me.attendee`; `equals()` self-marking; `cf-avatar` others; PerSpace/PerUser/
  PerSession split). Honest deviations (`research/exemplar-build.md`): optional
  snapshot-override params on handlers (test harness can't resolve `#profile` —
  identity model unchanged); `grouped` render-only. **NOT catalogued** in
  index.md / factory exemplars — kept out so the re-run is a TRANSFER test, not a
  copy. KEY INSIGHT: `fair-share` was ALREADY a gold identity exemplar in the repo
  yet the factory still produced dead strings → the fix is the WIRING (spec-
  interpreter rule + critic rubric + the docs the maker reads), not merely having
  an exemplar.
- **Most likely next step:** finish exemplar → present docs + exemplar to user for
  REVIEW → on approval, wire the factory's own agents (critic identity rubric +
  spec-interpreter identity rule + spec template) → **detached** re-run of the RSVP
  brief → re-score ID1–ID7 for lift.
- **Run-survival TODO:** bg run was KILLED ~during critic. For the re-run use a
  fully-detached launch (`setsid`/`nohup`) or have the user run it in a terminal.
- **Note:** working tree is on branch `ct-1674-meaning-qa` (unrelated meaning-QA
  work + 23 pre-existing modified cf-* files). When committing the identity
  improvements, branch appropriately (`ct-<ticket>-identity-...`); do NOT mix.
- **Resume context:** this file + `research/{pattern-factory,identity-map,
  factory-launcher,iter1-eval,identity-authoring-kit,exemplar-build}.md`.
  Multiplayer inventory in Known Facts above.

## E3 VERDICT + FIX PLAN (LATEST — read first on resume)
Full+browser run `71b6` SUCCEEDED as a pipeline test (69 "Functional", manual_test
deployed + browser-verified) but exposed a render-blocking framework gotcha that is
LATENT in our PR'd exemplar + docs. Full eval: `research/iter3-full-eval.md`.
**Real rule** (verified vs `packages/html/src/h.ts:72-92` + repro
`packages/patterns/scope-bug-computed-vnode-blank/`): **every `$`-binding
(`$profile`/`$value`/`$checked`/…) must be at a STATIC `[UI]` position; inside a
`computed()` subtree it throws "…not reactive" and BLANKS the whole render.**
- **OUR exemplar `packages/patterns/event-rsvp/main.tsx` (labs#3914) is
  BROWSER-BROKEN:** cf-profile-badge (L418, L457) + create-form `$value` inputs
  (L392/398/404/533) are inside `computed()`. 40 tests pass but are `.send()`-only
  (never render) → false green. fair-share does it right (badge static, L264).
- **Docs (labs#3914) mislead:** no static-position caveat → teach the bug.
- **Critic blind spot (factory#49):** static critic blessed `$profile`-in-computed.
- **71b6 ID2/ID7 → PARTIAL** (viewer fell back to `cf-avatar`). Transfer clean.
- **FIX BEFORE UN-DRAFT:** (a) refactor event-rsvp: all `$`-bound controls STATIC
  (`ifElse` as child of a static wrapper, NOT inside `computed()`) + add a RENDER
  smoke test that exercises `[UI]` (not just `.send()`); (b) static-position caveat
  in COMPONENTS.md (cf-profile-badge) + multi-user-patterns.md, generalized to all
  `$`-bindings, cross-link the repro; (c) factory critic: grep-able
  "`$`-binding inside `computed()`" FAIL check. Then push to PR branches & un-draft.
- ⚠ Factory left dev servers on 8100/5273 (not killed). PRs remain DRAFT (correct).
- **E3 FIX APPLIED + PUSHED (both draft PRs updated):**
  - **labs#3914** `ct-1676-multi-user-identity` (553357900): event-rsvp `[UI]`
    restructured so all 6 `$`-bindings are STATIC (`ifElse(eventCreated, eventView,
    createForm)` under a static wrapper; identity model unchanged) + a RENDER smoke
    test that walks `subject[UI]` (runs `h()` on every binding) — PROVEN to fail on
    the OLD structure (3 fails + the exact `$profile not reactive` error) and pass
    now (18/0). + static-position caveat in COMPONENTS.md, multi-user-patterns.md,
    pattern-critique-guide.md (cat 5). Independently re-verified: compile 0, lint 0,
    test 18/0. Detail: `research/exemplar-fix.md`.
  - **factory#49** `ct-1676-factory-identity-wiring` (be37e0d): critic CRITICAL
    check for `$`-bindings inside `computed()`.
  - The render test is the durable fix to the verification gap iter-3 exposed (no
    longer static-only — it renders). Browser deploy-check available (dev server
    still on :8100); the render-test differential already proves the fix. PRs stay
    DRAFT pending user un-draft.
  - Minor cosmetic: factory `critic.md:52` still says "the 13 convention categories"
    (one 13→14 spot missed) — non-behavioral.

## E4 — CONFIRMATION run (all pieces in place)
User: "do one more round to confirm it looks good, then we'll run the pattern and
check ourselves at the very end." Goal: does the factory NOW (caveat docs + critic
`$`-binding check + identity wiring) produce a correct AND RENDERING pattern?
- **Synced the fixes into the WORKING TREES** (the factory reads working trees, not
  PR branches): labs docs caveat (COMPONENTS / multi-user-patterns / critique-guide)
  + fixed exemplar; factory `critic.md` `$`-binding check. All verified present.
  Prereqs: claude.key (120B), `factory.config.local.json` removed (full pipeline).
  event-rsvp stays held-out.
- Launched FULL run detached (sentinel `workspace/iter4full.DONE`, log
  `workspace/iter4full-run.log`; bg waiter `btddq5qb6`). ~2.5–3h.
- **Success = ** maker AVOIDS `$`-binding-in-computed (reads the caveat) OR critic
  CATCHES it before manual_test (new check fires); identity stays ID1–ID7; browser
  renders (not blank). Eval in a subagent on completion → `research/iter4-eval.md`.
  Then HAND OFF: user runs the final pattern + inspects the browser themselves.
- **E4 RESULT (run `8adf`) — COMPLETE; CONFIRMATION ACHIEVED (with caveats).** Full
  pipeline incl. browser. Final **57 "functional"** (raw 66 −9 process for 4 iters;
  below 70 = the bumpy PATH, not a broken pattern). Compiles, 35 tests,
  browser-verified core flows work. Summary: `output/event-rsvp/summary.md`.
  - ✅ **The piece we added WORKS:** maker AGAIN wrote `$`-bindings-in-computed (3
    CRITICAL: $value, $profile, onClick) → the **NEW critic check CAUGHT ALL** →
    fixed → manual_test browser confirmed **"no blank screens, the fix held."**
    iter-3 verification gap CLOSED.
  - ⚠ **Maker still error-prone (4 iters, 5 bugs):** + 3 HIGH from manual_test
    (cf-button onClick→undefined; oncf-input crash) → REAL CF constraint **DISCOVERED:
    PerSession cells unreadable in onClick handlers** (transformer makes them
    readonly) → fixed (perSession→Writable / use action()). All HIGH fixed +
    re-verified.
  - ⚠ **2 LOW unfixed:** (a) status buttons don't visually highlight (variant binding
    doesn't re-render in browser); (b) **"You" label broken** — maker used object
    `===` (`myRsvp === rsvp`), fails across computed/SES → must be `equals()` on a
    cell ref (our ID6!). **REFINEMENT: critic ID6 check should also FAIL object-`===`/
    reference-equality, not just display-name.** + Undecided section deferred.
  - **Verdict:** identity + render pieces ARE in place + browser-validated; factory
    self-corrects to a working pattern, but maker slips a lot + leaves rough edges.
    Full ID1–ID7 eval → `research/iter4-eval.md` DONE. **Scorecard: ID1✅ ID2✅
    (badge recovered + static) ID3✅ ID4⚠️(no roster) ID5✅ ID6❌(`===` not
    `equals()`) ID7⚠️("You" broken).** The critic `$`-binding lever CLOSED the iter-3
    gap (caught 3 CRITICALs statically; browser no-blank). NEW gap: "You" label uses
    object `===` — passes unit tests AND the critic's ID6 (which only checks NAME
    equality, not reference equality). **3 refinements (cheap, no new infra):**
    (a) [HIGHEST] critic/critique-guide ID6 must also FAIL object/reference `===` on
    reactive-array elements (not just display-name); (b) doc the
    perSession-unreadable-in-onClick gotcha (new gotcha doc + pattern-dev + a critic
    check); (c) build-guide += a `$`-binding WRONG/RIGHT worked example (maker-side, to
    stop paying it 1–2 iters/run). **HANDOFF URL** (manual-tester's final fixed deploy,
    dev server up): `http://localhost:8100/factory-test/fid1:KmBPWxxoCtn4ymYSHsIwoLVqN4luLNccYyVIhPtmC2o`
    (Import CLI Key with `labs/claude.key`). **VERDICT: MOSTLY in place** — 2 of 3
    failure modes sealed; the identity-EQUALITY discipline (ID6) is the remaining
    unchecked one; refinement (a) seals it.
