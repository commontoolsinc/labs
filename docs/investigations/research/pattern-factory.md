# Pattern Factory — Research Report

> Scope: where the "Pattern Factory" lives in `labs`, how it is invoked on a
> spec, what it ingests/produces, its execution flow, docs/tests, and
> practicalities. Read-only investigation.

## TL;DR

The **Pattern Factory** is a **multi-phase, multi-agent LLM flow** that turns a
plain-language brief/spec into a complete, deployed-and-verified Common Fabric
pattern (`pattern/main.tsx` + `pattern/main.test.tsx`). Phases:
`spec → ux_design → ui_design → build → critic → manual_test`, driven by an
**Orchestrator** that loops (build → test → fix) and emits a scored summary.

**Critical caveat for reproducibility:** the *orchestration layer* (the
Orchestrator, `spec-interpreter`, `ux-designer`, `ui-designer` agents and the
phase launcher) is **NOT checked into this repo**. It lives in an external
harness/launcher (referred to as "Pattern Factory" / "its launcher" in
`packages/cf-harness/docs/SKILLS_SUPPORT_SPEC.md`, run from a sibling checkout
the spec calls `common-fabric-2`). What this repo (`labs`) contains is the
**contract surface the factory consumes plus its outputs**:

- the **build/test/critic/user subagents** (`.claude/agents/`)
- the **skills** the factory preloads per phase (`skills/`)
- the **build-phase contract doc** (`docs/common/ai/pattern-factory-build-guide.md`)
- **output artifacts** from real runs (`packages/patterns/factory-outputs/`)
- the **next-gen native harness** that will run it, `cf-harness`
  (`packages/cf-harness/`), which documents the exact invocation.

So there is no single in-repo `factory run <spec>` command today. The two
reproducible entry points that exist *in this repo* are (a) running the
build-phase subagents via Claude Code Task delegation, and (b) the
`cf-harness` CLI invocation documented for the factory's build phase (see §2).

> Do **not** confuse this with `scripts/run-pass.sh` + `scripts/setup-spike-*.py`
> + `scripts/agents/{deployer,populator,connector}.sh`. Those are a **separate**
> "CF FUSE agent experiment" driven by the `hermes` CLI (e.g.
> `scripts/setup-spike-14.py:4` "Run 14 of the CF FUSE agent experiment"). They
> populate/connect data in a live space over FUSE — they are NOT the pattern
> factory. See §8.

---

## 1. Where it lives (file paths & packages)

### 1a. In-repo contract surface (what the factory reads)

| Thing | Path | Role |
| --- | --- | --- |
| Build-phase contract | `docs/common/ai/pattern-factory-build-guide.md` | Defines the Build deliverable, top-level-pattern rules, state-ownership rules, the verification gate, and test-coverage expectations. The single most authoritative in-repo factory doc. |
| Shared dev guide | `docs/common/ai/pattern-development-guide.md` | Canonical pattern dev guidance (skills point here). |
| Shared test guide | `docs/common/ai/pattern-testing-guide.md` | `pattern-testing-guide.md:26` has a "For Pattern Factory Build" section. |
| Critique guide | `docs/common/ai/pattern-critique-guide.md` | Critic-phase rubric. |
| Build subagent | `.claude/agents/pattern-maker.md` | "Writes pattern code in small increments. Sketch, run, iterate." `model: sonnet`, has a PostToolUse hook. |
| Manual-test subagent | `.claude/agents/manual-tester.md` | Deploys + CLI/browser-verifies against acceptance criteria; writes a structured report. Explicitly references "factory runs" (`manual-tester.md:49`). |
| Critic subagent | `.claude/agents/pattern-critic.md` | `model: haiku`, fast violation scan. |
| Pattern-user subagent | `.claude/agents/pattern-user.md` | (companion agent) |
| Build post-edit hook | `.claude/scripts/pattern-maker-post-edit.ts` | After Write/Edit on a pattern `.tsx`, injects `Run it: deno task cf check <file>`. |

Skills the factory preloads per phase (canonical authored source in `skills/`,
mirrored to `.claude/skills/` and `.agents/skills/`):
`pattern-dev`, `pattern-schema`, `pattern-implement`, `pattern-ui`,
`pattern-test`, `pattern-critic`, `cf`, `agent-browser`. Several have explicit
"When working in a Pattern Factory Build workspace…" sections, e.g.
`skills/pattern-dev/SKILL.md:90`, `skills/pattern-implement/SKILL.md:16`,
`skills/pattern-test/SKILL.md:13`, `skills/pattern-schema/SKILL.md:36`.

### 1b. The future native harness

- `packages/cf-harness/` — `@commonfabric/cf-harness`, "an in-house agent
  harness package for Common Fabric … Loom as the first target use case"
  (`packages/cf-harness/README.md:1`). Pattern Factory is the **near-term
  motivating case** for its Skills support (`docs/SKILLS_SUPPORT_SPEC.md:11`).
  It has a real prompt/tool loop, sandboxed `bash`, `delegate_task`
  (single-child subagents), skill preload, persistence/resume, and CFC policy
  plumbing. CLI entry: `packages/cf-harness/src/cli.ts` / `src/main.ts`,
  task `deno task run` (`packages/cf-harness/deno.json:4`).
- `packages/cf-harness/docs/SKILLS_SUPPORT_SPEC.md` — **the file with the literal
  factory invocation** (`:364`, `:606` "Pattern Factory Wiring").
- `packages/cf-harness/docs/IMPLEMENTATION_PLAN.md:197,292` — notes that
  `delegate_task` exists "to give Loom and Pattern Factory a native delegation
  primitive" and that "Pattern Factory depends on repo-local skills".

### 1c. Output artifacts from real runs

- `packages/patterns/factory-outputs/` — committed outputs of factory runs:
  - `parking-coordinator/` — the most complete example: `spec.md`,
    `summary.md` (full run log), `score.json` (rubric scoring), `main.tsx`
    (1,546 lines), `main.test.tsx` (38 assertions).
  - `lot-watch/` — `DESIGN.md`, `main.tsx`, `main.test.tsx`.
  - `lot-with-coordinator-demo/` — `main.tsx`.
  - Committed via PR #3712 (`git log`: `fdca47106 feat: parking-coordinator
    vehicle data + Lot Watch pattern`).

### 1d. Investigation precedent

- `docs/investigations/pf-identity-e2e.md` — an existing scientific-loop log for
  "using the pattern factory to generate a NEW multi-user / identity pattern
  from a spec". Its Open Questions (`:64`) literally include "Exact, reproducible
  invocation of the pattern factory?" — i.e. this is acknowledged as
  non-obvious. (This report answers it.)

---

## 2. How it is invoked (THE deliverable)

There is **no single in-repo `cf factory` command**. The factory is an agent
orchestration. There are three concrete ways to drive it; the canonical one
today is **A** (the orchestration lives outside the repo and uses these
subagents), with **B** as the explicitly-documented harness path and **C** as
the manual fallback.

### A. Canonical: external Orchestrator driving the in-repo subagents

The real runs (e.g. parking-coordinator) were produced by an **Orchestrator**
that runs each phase and delegates to phase agents. Evidence:
`factory-outputs/parking-coordinator/summary.md` names the agents explicitly —
"From Spec-Interpreter", "From Pattern-Maker", "From Orchestrator", plus a
"Critic Review" and "Manual Test" phase, and a `run_id` like
`2026-03-05-parking-coordinator-qkmw`.

The Orchestrator/launcher and the `spec-interpreter` / `ux-designer` /
`ui-designer` agents are **not in this repo** — `grep` for them returns only
references inside `factory-outputs/*` and `cf-harness` docs, never an agent
definition. They live in the external "Pattern Factory" launcher (the
`SKILLS_SUPPORT_SPEC.md` repeatedly says "its launcher already knows the
phase, so it can pass explicit skills", `:608`). The build/critic/manual_test
phases are the ones whose agents *are* checked in here (`.claude/agents/`), so
those phases are reproducible standalone (see C).

To reproduce a full run you need that external launcher (the `common-fabric-2`
checkout referenced in the spec). It is not present on this machine's `labs`
tree; only its inputs/outputs and the build-phase subagents are.

### B. Documented harness invocation (cf-harness, per-phase) — the literal command

`packages/cf-harness/docs/SKILLS_SUPPORT_SPEC.md:364-372` gives the exact way
the factory invokes the harness for a build:

```bash
# from the cf-harness package dir
deno task run -- \
  --workspace /path/to/common-fabric-2 \
  --cwd pattern-factory \
  --skills-root /path/to/common-fabric-2/labs/skills \
  --skill pattern-dev \
  --skill pattern-implement \
  --prompt "Build this pattern..."
```

`deno task run` = `deno run -A src/main.ts` (`packages/cf-harness/deno.json:4`).
Full flag set: `packages/cf-harness/src/cli.ts:315`. Relevant flags:
`--workspace`, `--cwd`, `--skills-root`, repeatable `--skill`, `--prompt` /
`--prompt-file`, `--model`, `--gateway-base-url`, `--gateway-auth-mode`,
`--allow-tool` (narrow tools), `--structured-result-path/-schema`,
`--resume-run`, `--run-manifest` (Loom).

The recommended **phase → skills** mapping the launcher passes
(`SKILLS_SUPPORT_SPEC.md:611-620`):

| Phase | `--skill` values |
| --- | --- |
| `spec` | (none initially) |
| `ux_design` | (none initially) |
| `ui_design` | `pattern-ui` |
| `build` | `pattern-dev`, `pattern-implement`, `cf` |
| `critic` | `pattern-critic` |
| `manual_test` | `pattern-test`, `agent-browser`, `cf` |

> Status: this is the *intended/spec'd* wiring. `SKILLS_SUPPORT_SPEC.md:700`
> recommends "Pause further Pattern Factory build orchestration until
> `cf-harness` can preload explicit skills" — Slice 1 (skill preload) is marked
> implemented (`:356`); full factory wiring (Slice 2) is the next step. So the
> cf-harness path is real but still maturing.

### C. Manual / standalone reproduction in this repo (build phase only)

Because the build/critic/manual-test agents are checked in, you can run those
phases by hand with Claude Code's Task tool, pointing each subagent at a phase
deliverable. The build phase's own self-verification gate
(`pattern-factory-build-guide.md:124`) is the literal pair of commands the maker
must pass before declaring done:

```bash
deno task cf check <pattern>.tsx --no-run     # compile + typecheck
deno task cf test  <pattern>.test.tsx         # pattern tests
```

The manual-tester subagent then deploys + verifies
(`.claude/agents/manual-tester.md`): it starts dev servers
(`./scripts/check-local-dev.sh || ./scripts/restart-local-dev.sh --force`,
with `--port-offset=200` for factory runs), deploys via
`deno task cf piece new <pattern>/main.tsx --identity claude.key --api-url <url>
--space <space>`, exercises handlers via `cf piece call/step/inspect`, and
browser-tests via `agent-browser`.

(See `cf` skill for exact CLI syntax; the build guide says "Use the `cf` skill
for exact CLI syntax. The normal gate is …".)

---

## 3. Input format — what a "spec" looks like

The factory's *user-facing* input is a plain-language **brief**. The `spec`
phase (`spec-interpreter`) turns that brief into a structured **`spec.md`**,
which is the durable contract every later phase consumes.

Canonical example spec lives at
`packages/patterns/factory-outputs/parking-coordinator/spec.md`. Its structure
(headings) is the de-facto spec schema:

- `# Pattern Spec: <Name>`
- `## Description`
- `## Complexity Assessment` (Tier: Basic/Intermediate/Advanced; Reference
  exemplars; Rationale)
- `## Data Model` (entities + fields + `### Relationships`)
- `## User Interactions` (numbered)
- `## Acceptance Criteria` (the checklist manual-test verifies)
- `## Edge Cases`
- `## Assumptions` (decisions the spec-interpreter made)

Short excerpt (`spec.md:1-26`):

```markdown
# Pattern Spec: Parking Coordinator

## Description
A coordination tool for a small team to manage shared office parking spots. ...

## Complexity Assessment
- **Tier:** Intermediate
- **Reference exemplars:** `contacts/contact-book.tsx` ...,
  `habit-tracker/habit-tracker.tsx` ...
- **Rationale:** The pattern manages three related entity types ...
```

The build phase additionally consumes `ux-design.md` and `ui-design.md`
(produced by the `ux_design` / `ui_design` phases). The build guide:
"Pattern Factory Build turns an existing brief, spec, UX design, and UI design
into a top-level pattern deliverable" (`pattern-factory-build-guide.md:8`).
Note: those design docs are not committed for parking-coordinator (only `spec.md`
+ `summary.md` + `score.json` were kept), but `lot-watch/DESIGN.md` is an example
of a design artifact.

---

## 4. Output — what it produces & where it lands

Per the Build contract (`pattern-factory-build-guide.md:6-15`) a run produces:

- `pattern/main.tsx` — the deployable pattern (reactive TSX module)
- `pattern/main.test.tsx` — pattern tests
- `notes/pattern-maker.md` — auditable journal of docs consulted
- `reviews/test-report.md` — manual-tester's structured report

These are written into a **factory workspace** (the `--cwd pattern-factory`
working dir). When promoted into `labs`, they land under
`packages/patterns/factory-outputs/<name>/`, alongside run metadata:

- `spec.md` (input contract)
- `summary.md` — full human-readable run log: what was requested/built, key
  design decisions per agent, quality-gate results, **iteration history with
  per-phase wall-clock timings**, lessons learned, and a final recommendation.
- `score.json` — machine-readable rubric scoring (see §5).

The pattern itself, once deployed by manual-test, becomes a live **piece** in a
space (via `cf piece new`). So the end-to-end output is both **on-disk source +
tests + reports** and a **deployed, browser-verified piece**.

Example output scale: parking-coordinator `main.tsx` is 1,546 lines with a
38-assertion test suite (`summary.md:35`).

---

## 5. Execution flow

Phases (from `factory-outputs/parking-coordinator/summary.md` +
`SKILLS_SUPPORT_SPEC.md` phase table):

1. **spec** (`spec-interpreter`) → `spec.md`. Assesses complexity tier, picks
   reference exemplars, resolves brief ambiguities into explicit Assumptions,
   defines the data model + acceptance criteria.
2. **ux_design** (`ux-designer`) → `ux-design.md`.
3. **ui_design** (`ui-designer`, skill `pattern-ui`) → `ui-design.md`.
4. **build** (`pattern-maker`, skills `pattern-dev`/`pattern-implement`/`cf`) →
   `main.tsx` + `main.test.tsx`. Sketch → run → iterate; must pass
   `cf check --no-run` and `cf test` before "done"
   (`pattern-factory-build-guide.md:119-135`). Reads
   `reactivity.md`/`new-cells.md` as baseline; on failure follows a "Failure
   Recovery Discipline" matrix (`:138`).
5. **critic** (`pattern-critic`, `model: haiku`) → critic review. Fast scan for
   documented violations (module-scope handlers, missing `$` bindings, ternary-
   for-elements, reactive `[NAME]` without `computed()`, string-vs-object HTML
   styles).
6. **manual_test** (`manual-tester`, skills `pattern-test`/`agent-browser`/`cf`)
   → deploys to a local dev server (port-offset 200 for factory runs),
   CLI-verifies each handler (`call → step → inspect`), browser-verifies each
   acceptance criterion, writes `test-report.md`.

**Self-verification & internal iteration: yes.** The Orchestrator loops. In the
parking-coordinator run: design-first (ran spec/ux/ui to completion), then a
build, then critic (no fix needed), then manual-test which found a HIGH bug
(`DEFAULT_SPOTS` not used → fresh deploy had 0 spots) + a MEDIUM runtime error;
then the Orchestrator invoked `pattern-maker` again for a **fix pass**, then a
**manual re-verification** confirmed 16/16 acceptance criteria. Two iterations →
`iteration_modifier: -2` applied to the score (`score.json:6`,
`summary.md:142-230`).

**Does it call sub-agents?** Yes — that is the core mechanism. In Claude Code
form, phases are Task subagents (`.claude/agents/*`). In the cf-harness form,
the parent delegates via the `delegate_task` tool (single-child, fresh context,
sanitized return; `IMPLEMENTATION_PLAN.md:197`).

**Scoring:** final `score.json` (rubric_version 3.0) weights Correctness 15,
Code Craft 15, Test Coverage 10, Spec Fidelity 10, UX Design 20, Experience
Quality 20, First-Run 10, then applies an `iteration_modifier` (-1 per extra
iteration). Parking-coordinator: raw 75 → final **73/100** ("solid").
Each dimension carries `failures` with `check_id`, `line_number`,
`suggested_fix`, and `positive_evidence` — i.e. the critic output is structured
and actionable.

---

## 6. Docs + tests

**Docs (in-repo):**
- `docs/common/ai/pattern-factory-build-guide.md` — primary build contract.
- `docs/common/ai/pattern-{development,testing,critique}-guide.md` — phase guides
  (each has explicit "Pattern Factory Build" sections).
- `packages/cf-harness/docs/SKILLS_SUPPORT_SPEC.md` — factory ↔ harness wiring,
  the literal invocation, and phase→skills mapping.
- `packages/cf-harness/docs/IMPLEMENTATION_PLAN.md` — delegation/skills rationale.
- `docs/investigations/pf-identity-e2e.md` — prior E2E investigation log.
- Per-run docs: `factory-outputs/<name>/{summary.md,spec.md,score.json}`,
  `factory-outputs/lot-watch/DESIGN.md`.

**Tests:**
- There is **no test that runs the factory itself** (it is an LLM flow). Tests
  exercise the *outputs*:
  - `packages/patterns/integration/parking-coordinator-admin-view.test.ts` —
    integration test on a factory-produced pattern.
  - `packages/patterns/factory-outputs/parking-coordinator/main.test.tsx`,
    `factory-outputs/lot-watch/main.test.tsx` — the maker-written pattern tests.
- `cf-harness` has its own unit/integration tests
  (`packages/cf-harness/test/`, `integration/engine.integration.test.ts`,
  `deno task test` / `test:integration`), including a "Pattern Factory build
  smoke" referenced in `SKILLS_SUPPORT_SPEC.md:14` — i.e. a harness-level smoke,
  not a labs test.

---

## 7. Practicalities

- **Time:** real, per the parking-coordinator log (`summary.md:142-230`):
  Build ≈ **93 min** (1 iteration), Critic ≈ 7.5 min, Manual Test ≈ 41 min,
  Fix pass ≈ 1.7 min, plus design phases. So a full intermediate-tier run is
  **~2.5–3 hours of agent wall-clock**. Plus the design phases up front.
- **Cost:** multi-agent, mixed models — `pattern-maker`/`manual-tester` use
  `sonnet`, `pattern-critic` uses `haiku` (per `.claude/agents/*` frontmatter).
  Long build transcripts → non-trivial token cost. (No dollar figures in repo.)
- **LLM API keys:** **required** — every phase is an LLM agent. The cf-harness
  path needs an OpenAI-compatible gateway (`--gateway-base-url`,
  `--gateway-auth-mode bearer|none`, `--model`; default model in `cli.ts`).
- **Local dev servers:** **required for the manual_test phase** (deploy +
  browser). Manual-tester runs `check-local-dev.sh`/`restart-local-dev.sh` and
  uses `--port-offset=200` for factory runs to avoid clashing with a human's
  servers (`.claude/agents/manual-tester.md:49`). Build/critic phases do not
  need a server (only `cf check`/`cf test`).
- **Toolchain:** `deno` pinned to **2.8.1** via `mise.toml`. Non-interactive
  shells may resolve an older deno; force with `mise exec deno@2.8.1 -- deno …`
  (noted in `pf-identity-e2e.md:39`).
- **Known flakiness / sharp edges (from `summary.md` lessons):**
  - **Automated tests can mask deploy-time bugs** — parking-coordinator's tests
    passed `DEFAULT_SPOTS` explicitly, hiding that a fresh deploy had 0 spots;
    only manual-test caught it. The build guide added explicit first-run/default
    coverage guidance because of this.
  - **CTS transformer gotchas** the maker hit: destructuring-alias confusion
    (use direct property access in `.map()`), `readonly` array mismatches
    (spread before passing), OpaqueCell proxy access in nested closures
    (pre-compute reactive data as top-level `computed()` returning plain
    objects). These recur and are now baked into the build guide / lessons.
  - **Stop-hook derail (sandbox):** `tasks/check.sh` (deno version gate) can
    fail in non-interactive harness shells and clobber a subagent's final chat
    message — hence the convention that subagents **write deliverables to files**
    rather than rely on final messages (`pf-identity-e2e.md:21,59`).
  - **"One-fix-pass loops are dangerous"** — a second loop discovering new
    issues can blow up the timeline (`summary.md:301`).

---

## 8. NOT the pattern factory (disambiguation)

The root-level scripts that *look* factory-adjacent are a different experiment —
the **CF FUSE multi-agent spike**:

- `scripts/run-pass.sh` — runs three agents (`deployer`, `populator`,
  `connector`) one "pass" at a time, exports each session with the **`hermes`**
  CLI, and scores via `scripts/score-pass.py`.
- `scripts/agents/{deployer,populator,connector}.sh` — each does
  `hermes chat -Q --yolo -m "$MODEL" -s fuse-agent,fuse-workflow -q "…"`
  (model defaults to `gpt-5.4-mini`). They operate on a live space over FUSE.
- `scripts/setup-spike-9..14.py` — setup for "Run N of the CF FUSE agent
  experiment" (`setup-spike-14.py:4`). Space e.g. `agent-spike-14`, mount
  `/tmp/ct-spike14`.
- `scripts/agents/agent-bootstrap.md`, `pass-log.md`, `pass-traces/` — bootstrap
  + logs for those passes.

These deploy *existing* patterns and populate/connect data; they do **not**
generate a pattern from a spec. Different harness (`hermes`, not Claude Code /
cf-harness), different goal. Keep them out of factory reasoning.

Also distinct: `.claude/agents/oracle.md` + `corrector.md` are the
Oracle/Corrector knowledge-base agents (see `/oracle` command), unrelated to the
factory.

---

## 9. Quick reference

- **Read first:** `docs/common/ai/pattern-factory-build-guide.md`
- **Literal harness invocation:** `packages/cf-harness/docs/SKILLS_SUPPORT_SPEC.md:364`
- **Example spec:** `packages/patterns/factory-outputs/parking-coordinator/spec.md`
- **Example full run log:** `packages/patterns/factory-outputs/parking-coordinator/summary.md`
- **Example scoring:** `packages/patterns/factory-outputs/parking-coordinator/score.json`
- **In-repo subagents:** `.claude/agents/{pattern-maker,manual-tester,pattern-critic,pattern-user}.md`
- **Build self-verify gate:** `deno task cf check <p>.tsx --no-run` && `deno task cf test <p>.test.tsx`
- **Harness CLI flags:** `packages/cf-harness/src/cli.ts:315`
- **Open gap:** full orchestrator + spec/ux/ui agents are external
  (`common-fabric-2` launcher), not in this repo.
