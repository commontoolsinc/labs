# Pattern Factory Launcher — Research Report

> Scope: the **external Orchestrator/launcher** at `/Users/ben/code/pattern-factory`
> (sibling to `labs`). This repo holds the orchestrator + spec/ux/ui agents and
> drives the full pipeline `spec → ux_design → (ui_design) → build → critic →
> manual_test → grade → summarize` from a plain-language brief, delegating to the
> labs build/critic/manual-test subagents via Claude Code `Task`. Read-only
> investigation. Paths are absolute.
>
> Companion: `/Users/ben/code/labs/docs/investigations/research/pattern-factory.md`
> (the labs-side contract surface). **Correction to that doc:** it claims the
> orchestrator + spec/ux/ui agents are "NOT in this repo" and live in a
> `common-fabric-2` checkout. They ARE here, in
> `/Users/ben/code/pattern-factory/.claude/agents/`. The launcher runs via the
> user's `claude` CLI (Claude Code Task delegation), **not** via `cf-harness`.
> The cf-harness path in that doc is a *future/alternate* backend, not what these
> scripts use.

---

## 0. THE COMMAND (most important deliverable)

The factory is a headless Claude Code session run **from the pattern-factory repo
root**. The session itself acts as the orchestrator and spawns subagents with the
`Task` tool. Output lands in `/Users/ben/code/pattern-factory/output/<pattern-name>/`
(see §4 for why it is NOT written into `labs` directly, and how to promote it).

### Canonical full run on a NEW brief

```bash
# 0. one-time setup (only if not already done — see §3 verification)
cd /Users/ben/code/pattern-factory
./scripts/setup-symlinks.sh                       # links docs/skills/agents/exemplars -> /Users/ben/code/labs
cd /Users/ben/code/labs && deno task ct id new > claude.key   # identity key the manual_test phase needs
cd /Users/ben/code/pattern-factory

# 1. write your brief (free-text, see §2 for shape)
#    either drop a file in briefs/queue/ ...
cp briefs/templates/minimal.md briefs/queue/my-pattern.md
$EDITOR briefs/queue/my-pattern.md

# 2a. launch via the wrapper (RECOMMENDED — handles prompt + Ctrl-C)
./run-factory.sh --brief briefs/queue/my-pattern.md

# 2b. ... or inline free-text, no file needed
./run-factory.sh --brief "A kanban board with To Do / In Progress / Done columns"
```

`run-factory.sh` (`/Users/ben/code/pattern-factory/run-factory.sh:167`) ultimately
runs, **headless**, from the repo root:

```bash
claude -p "Process the brief at briefs/queue/my-pattern.md through the full \
factory pipeline. Read .claude/agents/orchestrator.md for the pipeline instructions." \
  --model claude-opus-4-6 \
  --allowedTools "Task,Bash,Read,Write,Edit,Glob,Grep,Skill"
```

That literal `claude -p ...` is the bare-metal invocation (README §Quick Start
`/Users/ben/code/pattern-factory/README.md:50`, CLAUDE.md
`/Users/ben/code/pattern-factory/CLAUDE.md:184`). The wrapper just builds the
prompt, sets the model, traps `SIGINT`, and runs it as a child process.

> **Model caveat:** the scripts default to `--model claude-opus-4-6`
> (`run-factory.sh:23`, `scripts/run-batch.sh:17`), which is stale. Override with
> a current model: `./run-factory.sh --brief ... --model claude-opus-4-8` (or
> omit `--model` from the raw `claude -p` form to use your CLI default). The
> `claude` CLI on this machine is v2.1.85 at
> `~/.local/share/mise/installs/npm-anthropic-ai-claude-code/2.1.85/bin/claude`.

### Preview first (no LLM spend)

```bash
cd /Users/ben/code/pattern-factory
./run-factory.sh --brief briefs/queue/my-pattern.md --dry-run   # prints the exact claude command + prompt
```

### Run the next queued brief (no --brief)

```bash
cd /Users/ben/code/pattern-factory
./run-factory.sh         # picks the first briefs/queue/*.md (excluding .gitkeep)
```

### Batch (many briefs, unattended, per-brief logs)

```bash
cd /Users/ben/code/pattern-factory
./scripts/run-batch.sh                       # every briefs/queue/*.md, sequential
./scripts/run-batch.sh briefs/queue/a.md briefs/queue/b.md
# logs: workspace/batch-YYYYmmdd-HHMMSS/<brief-name>.log
```

### Watch it run live (interactive)

```bash
cd /Users/ben/code/pattern-factory
./run-factory.sh --brief briefs/queue/my-pattern.md --interactive
# NOTE: interactive mode prints the prompt and drops you into `claude` — you must
# PASTE the printed prompt yourself. There is a known bug where it auto-submits
# before you can edit (architecture-design.md "Near-term"). Prefer headless.
```

**Bottom line:** for a clean full run targeting labs content, the one command is
`cd /Users/ben/code/pattern-factory && ./run-factory.sh --brief briefs/queue/<x>.md --model claude-opus-4-8`,
after `setup-symlinks.sh` + `claude.key` exist and (for the manual_test phase)
labs dev servers are reachable on the offset ports (§6).

---

## 1. Entry point

| Layer | Path | Role |
| --- | --- | --- |
| Wrapper CLI | `/Users/ben/code/pattern-factory/run-factory.sh` | Arg parse → build prompt → `claude -p`. Flags: `--brief`, `--model`, `--backend {local,sandbox-runner}`, `--runner-url`, `--interactive/-i`, `--dry-run`, `--help`. |
| Batch CLI | `/Users/ben/code/pattern-factory/scripts/run-batch.sh` | Loop over briefs, headless, capture logs. |
| Brain | `/Users/ben/code/pattern-factory/.claude/agents/orchestrator.md` | The actual pipeline controller (the prompt tells the session to read this). `model: opus`, `tools: Task, Bash, Read, Write, Glob, Grep, Skill`. |
| deno tasks | `/Users/ben/code/pattern-factory/deno.json` | Only two tasks: `ct` (wraps labs CLI, see §4) and `check` (→ `tasks/check.sh`). **There is no `deno task run` / no main.ts / no bin/.** The "run" is `claude -p`. |

It is **headless / non-interactive by default** (`claude -p`). `--interactive`
exists but is buggy. There is no in-repo TypeScript main; the orchestrator logic
lives entirely in the markdown agent prompt + the user's `claude` CLI.

Two alternate backends exist but are NOT needed for a local labs-targeted run:
- `--backend sandbox-runner` → `scripts/sandbox-runner-run.sh` (submits to a
  remote k8s sandbox service; needs `--runner-url`, default
  `http://127.0.0.1:8081`). `run-factory.sh:84` restricts `--backend` to
  `local|sandbox-runner`.
- pattern-drafter (`pd`) cloud backend via `scripts/pd-bundle.sh` (referenced in
  README §Cloud; **the script is not present in the current tree** — only
  `setup-symlinks.sh`, `run-batch.sh`, `sandbox-runner-run.sh` exist under
  `scripts/`).

---

## 2. Input — the brief

The user-facing input is a **plain-language free-text brief**, NOT a pre-written
`spec.md`. The `spec` phase (spec-interpreter) turns the brief into `spec.md`.

Three ways to provide it (`run-factory.sh:94-114`):

1. **Queued file** — drop `*.md` in `/Users/ben/code/pattern-factory/briefs/queue/`,
   run with no `--brief` (takes the first) or `--brief briefs/queue/x.md`.
2. **File path** — `--brief ./anything.md` (any path; `[[ -f "$BRIEF" ]]` test).
3. **Inline text** — `--brief "make a recipe app"` → embedded directly in the prompt.

The brief can be as sparse as a name + one sentence. Templates at
`/Users/ben/code/pattern-factory/briefs/templates/`:
- `minimal.md` — just `**Name:**` + `**Description:**` (one line each). "The
  sparser the brief, the more creative freedom the factory takes."
- `standard.md` — + user stories + data-shape hints.
- `detailed.md` — full spec-ish with schemas/handlers/UI.

The spec-interpreter is explicitly tuned to enrich sparse briefs
(`/Users/ben/code/pattern-factory/.claude/agents/spec-interpreter.md:128-146`,
"Err on the side of a richer feature set").

**Example briefs already in the repo** (`briefs/queue/`): `kanban-board.md`,
`budget-tracker.md`, `pomodoro-timer.md`, `anki-flashcards.md`,
`parking-coordinator.md`, `music-charts.md`, `music-discovery.md`. Good shape
reference — `briefs/queue/kanban-board.md`:

```markdown
# Pattern Brief
## Overview
**Name:** Kanban Board
**Description:** A simple kanban-style board for organizing tasks into columns. ...
## User Stories
- As a user, I can see my tasks organized into columns (e.g., To Do, In Progress, Done)
- ...
## Data Shape
- **Column**: has a name and contains an ordered list of cards
- **Card**: has a title, belongs to a column
## Requirements & Constraints
- Start with 3 default columns: "To Do", "In Progress", "Done"
```

---

## 3. Workspace targeting — how it finds/uses labs

The launcher consumes labs via **symlinks created by
`/Users/ben/code/pattern-factory/scripts/setup-symlinks.sh`**, which resolves the
labs root from `factory.config.json` `labs_path` (default `"../labs"`).
`../labs` from `/Users/ben/code/pattern-factory` resolves to
**`/Users/ben/code/labs`** — already correct on this machine. There is no
`--workspace`/`--skills-root`/`--cwd` flag on `run-factory.sh`; targeting is
purely the symlinks + config.

Symlinks (verified live, all point at `/Users/ben/code/labs`):

| Link in pattern-factory | → labs target | Purpose |
| --- | --- | --- |
| `docs` | `/Users/ben/code/labs/docs` | Common Fabric docs the agents read |
| `.claude/skills` | `/Users/ben/code/labs/.claude/skills` | pattern-dev/test/ui/cf etc. skills |
| `.claude/agents-upstream` | `/Users/ben/code/labs/.claude/agents` | the **build/critic/test** subagents |
| `.claude/scripts/upstream` | `/Users/ben/code/labs/.claude/scripts` | upstream hooks |
| `exemplars/<name>` | `/Users/ben/code/labs/packages/patterns/<name>` | per-exemplar links (counter, todo-list, habit-tracker, battleship/pass-and-play) + `index.md`, driven by `default_exemplars` in config |

`setup-symlinks.sh` is idempotent (`ln -sfn`). Re-run it any time the labs path
or exemplar list changes. (Minor current-state note: `exemplars/` is a real dir
with per-pattern symlinks inside; `exemplars/battleship` exists as a real subdir
holding the `pass-and-play` link — harmless. `setup-symlinks.sh` `:101` builds
nested paths via `mkdir -p`.)

### Where outputs land

Per the orchestrator (`orchestrator.md:36-47, 267-280`):

- **Per-run scratch:** `/Users/ben/code/pattern-factory/workspace/<run-id>/`
  (gitignored). Contains `brief.md`, `spec.md`, `ux-design.md`, `pattern/`
  (`main.tsx` + `main.test.tsx`), `reviews/` (critic-NNN.md, test-report.md,
  manual-test.md), `notes/<agent>.md`, `score.json`, `summary.md`,
  `pipeline.json`.
- **Final output:** `/Users/ben/code/pattern-factory/output/<pattern-name>/`
  — copies of `pattern/`, `spec.md`, `ux-design.md`, `score.json`, `summary.md`,
  `brief.md`. (README/CLAUDE.md also mention `completed/` ≥ minimum_score and
  `rejected/` below — but the current orchestrator routes *everything* to
  `output/`; "no pass/fail binary," `orchestrator.md:267`. `completed/` and
  `rejected/` hold only `.gitkeep`.)

**Generated pattern + spec.md + summary.md + score.json land in
`/Users/ben/code/pattern-factory/output/<name>/`, NOT in `/Users/ben/code/labs`.**
To get a finished pattern into labs you copy it into
`/Users/ben/code/labs/packages/patterns/factory-outputs/<name>/` (that is exactly
where prior runs were promoted — parking-coordinator/lot-watch live there). A
`scripts/promote-pattern.sh` is described in the architecture doc but is **not
present** in the current `scripts/` tree, so promotion is currently manual `cp`.

Real prior runs present: `output/music-charts/` and `output/music-discovery/`
(plus their `workspace/2026-03-09-music-*` scratch dirs).

---

## 4. Required env / auth

**This is the key divergence from the labs cf-harness story.** The launcher does
NOT use an OpenAI-compatible gateway, `ANTHROPIC_API_KEY`, or any `--gateway-*`
flags. It shells out to the user's **`claude` CLI** (`claude -p`), so it uses
**your existing Claude Code auth/subscription**. There is **no `.env` /
`.env.example`** in the repo (confirmed) and none is needed for LLM access.

What IS required before a run:

1. **`claude` CLI** authenticated (it is — v2.1.85 on PATH).
2. **Identity key for the manual_test phase:**
   `/Users/ben/code/labs/claude.key`. **Currently MISSING** — create it:
   `cd /Users/ben/code/labs && deno task ct id new > claude.key`. The
   manual-tester deploys with `--identity ../labs/claude.key`
   (`/Users/ben/code/pattern-factory/.claude/agents/manual-tester.md:57-60`). It
   is gitignored (`*.key`). Build/critic phases do NOT need it; only deploy does.
3. **Labs local dev servers** (manual_test phase only — see §6).
4. **Deno** + **agent-browser CLI** (manual_test browser checks).

The `--model` flag is the only model selection. There is no per-phase model
override surface in the launcher (each subagent hardcodes its own `model:` in
frontmatter — opus orchestrator, sonnet spec/ux/build/test, see §5).

`factory.config.local.json` (gitignored, optional) can carry machine overrides —
`{ "labs_path": "...", "identity_key": "...", "api_url": "..." }`
(`architecture-design.md:143-151`, CLAUDE.md:82-88). **It does not exist here**;
defaults work because `../labs` resolves correctly.

---

## 5. Phases & agents

Pipeline (orchestrator.md:84-88, CLAUDE.md:90-118):
`Brief → Spec → UX Design → Build → Critic → Fix? → [Manual Test → Fix?] → Grade → Summarize → Output`.

Note: the **ui_design phase from the labs-side spec is NOT a separate phase
here** — this launcher folds UI concerns into `ux_design` + build. The labs doc's
six-phase `ux_design/ui_design` split reflects the cf-harness wiring spec, not
this orchestrator.

**Factory agents — defined HERE** (`/Users/ben/code/pattern-factory/.claude/agents/`):

| Agent | File | model | Phase |
| --- | --- | --- | --- |
| orchestrator | `orchestrator.md` | opus | drives all phases |
| spec-interpreter | `spec-interpreter.md` | sonnet | brief → `spec.md` |
| ux-designer | `ux-designer.md` | sonnet | spec → `ux-design.md` |
| critic | `critic.md` | (factory critic) | reviews tested artifact |
| grader | `grader.md` | — | scores vs `rubric/rubric.json` → `score.json` |
| summarizer | `summarizer.md` | — | → `summary.md` |
| manual-tester | `manual-tester.md` | sonnet | deploy + CLI/browser verify |

(There is **no `ui-designer.md`** in this repo — the labs doc's `ui-designer` is a
cf-harness-spec concept, not realized here.)

**Delegation mechanism:** plain Claude Code **`Task` subagents**, not cf-harness,
not `delegate_task`. The orchestrator literally calls
`Task(subagent_type="spec-interpreter", prompt="...paths...")` etc.
(`orchestrator.md:98, 115, 134, 171, 207, 244, 260`). It passes file paths only,
never content. Each subagent reads its own `.md` for instructions.

**Build/critic/test = labs (upstream) agents**, reached via the
`.claude/agents-upstream` symlink → `/Users/ben/code/labs/.claude/agents/`:
`pattern-maker`, `pattern-critic`, `pattern-user` (+ the labs `manual-tester`,
`oracle`, `corrector`). The Build phase invokes `subagent_type="pattern-maker"`
(`orchestrator.md:134`). So: **orchestration + spec/ux/grade/summarize live in
pattern-factory; the actual code-building/critiquing agents live in labs and are
symlinked in.** Both sets are discoverable because Claude Code scans
`.claude/agents/` and the launcher places/links both.

Build self-verify gate (orchestrator.md:156-159) uses the pattern-factory `ct`
task: `deno task ct check workspace/<run>/pattern/main.tsx --no-run` and
`deno task ct test workspace/<run>/pattern/main.test.tsx`. The `ct` task in
`/Users/ben/code/pattern-factory/deno.json:3` runs
`<labs>/packages/cli/mod.ts` with net/ffi/read/write/env perms — i.e. it is the
labs CLI invoked from the factory repo. (Labs itself exposes the same tool as
`cf` via `deno task cf`; inside the factory it is `ct`.)

---

## 6. manual_test / browser + dev-server prerequisites

The manual_test phase **starts the labs dev servers itself**
(`/Users/ben/code/pattern-factory/.claude/agents/manual-tester.md:36-50`):

```bash
cd ../labs
./scripts/start-local-dev.sh --port-offset=100 --force
# Toolshed: http://localhost:8100   Shell: http://localhost:5273
```

So you do NOT have to start them first — but it uses **port-offset 100**
(`port_offset_base` in `factory.config.json:3`), i.e. Toolshed **8100**, Shell
**5273**, deliberately offset from a human's default 8000/5173 servers so a
factory run doesn't clash with your own. `scripts/start-local-dev.sh` exists in
labs and honors `--port-offset` / `--force`. The manual-tester then:

- Deploys: `deno task ct piece new <pattern>/main.tsx --identity ../labs/claude.key
  --api-url http://localhost:8100 --space factory-test` (`manual-tester.md:56`).
- CLI-verifies each handler with `piece call → piece step → piece inspect`
  (always `step` after `call`, else computed values are stale; `manual-tester.md:64-77`).
- Browser-verifies via **`agent-browser`** (clears `/tmp/ct-browser-profile`
  first to avoid stale cached JS pinned to a different port; `manual-tester.md:88-110`).
  Default **headless**; `--headed` only for interactive runs.

Prereqs for this phase specifically: labs `claude.key`, deno, `agent-browser`
CLI installed, and ports 8100/5273 free. Build + critic phases need none of this
(only `ct check`/`ct test`). `require_manual_test` in `factory.config.json` is
`true` (`:13`), so a full run WILL hit deploy/browser unless you flip it (§8).

> Known CLI limitation (architecture-design.md "Near-term", CT-1250):
> identity-based handlers (`moveCard`, `removeCard` using `equals()`) can't be
> fully verified via CLI JSON args — those need the browser path.

---

## 7. Run management

- **Run ID:** `YYYY-MM-DD-<pattern-name>-<short-random>`, generated by the
  orchestrator (`orchestrator.md:38`). Example real run:
  `2026-03-09-music-charts-2ay1`.
- **State + transcript:** the orchestrator writes/updates
  `workspace/<run-id>/pipeline.json` (phase status, per-phase `started_at` /
  `completed_at` / `duration_ms`, build iterations, scores) and freeform
  `workspace/<run-id>/notes/<agent>.md` journals (orchestrator, spec-interpreter,
  ux-designer, pattern-maker, pattern-critic, grader, summarizer). Headless stdout
  from `claude -p` is your live console; `run-batch.sh` tees it to
  `workspace/batch-*/<name>.log`.
- **Monitor progress while running:**
  ```bash
  cd /Users/ben/code/pattern-factory
  cat workspace/<run-id>/pipeline.json              # phase status snapshot
  ls -t workspace/<run-id>/notes/                   # per-agent journals appended live
  tail -f workspace/<run-id>/notes/orchestrator.md  # decision narrative
  ```
- **Resume:** there is **no resume mechanism**. `claude -p` is one-shot; a killed
  run leaves a partial `workspace/<run-id>/`. Re-running starts a fresh run-id.
  (The cf-harness path has `--resume-run`; this launcher does not.)
- **Duration:** no per-phase timings are recorded in the committed
  `pipeline.json`/`summary.md` for music-charts (`duration_ms` was specced but
  the sample run only logged statuses). The labs-side report estimates a full
  intermediate-tier run at **~2.5–3h agent wall-clock** (build ~93m + critic +
  manual-test ~41m, from the parking-coordinator log in labs
  `packages/patterns/factory-outputs/parking-coordinator/summary.md`). Treat that
  as the order of magnitude. music-charts took **4 build iterations**, final
  score 59; music-discovery is the other sample.

---

## 8. Config to edit for a clean labs-targeted run

Primary config: `/Users/ben/code/pattern-factory/factory.config.json` (read on
every run; merge `factory.config.local.json` if present — local wins,
`orchestrator.md:18-27`). Current values:

```json
{
  "labs_path": "../labs",
  "port_offset_base": 100,
  "port_offset_range": 50,
  "default_exemplars": ["counter","todo-list","habit-tracker","battleship/pass-and-play"],
  "pipeline": { "max_build_iterations": 5, "require_manual_test": true },
  "scoring": { "rubric_path": "rubric/rubric.json" }
}
```

Realistic edits:

| Want | Change |
| --- | --- |
| **Skip deploy/browser** (cheap/dry; no dev server, no claude.key) | set `pipeline.require_manual_test` → `false` in `factory.config.json` (or a `factory.config.local.json`). The orchestrator may still run it for UI-heavy patterns "if it judges value" (`orchestrator.md:200-205`) — to be safe also say so in the brief/prompt. |
| **Current model** | `--model claude-opus-4-8` on `run-factory.sh` (defaults to stale `claude-opus-4-6`), or edit `MODEL=` in `run-factory.sh:23` / `run-batch.sh:17`, or use raw `claude -p` without `--model`. |
| **Cap build cost** | lower `pipeline.max_build_iterations` (default 5 → e.g. 2). |
| **Different exemplars** | edit `default_exemplars`, then re-run `./scripts/setup-symlinks.sh`. |
| **Avoid port 8100/5273 clash** | `port_offset_base` (manual-tester reads/uses 100). |
| **Non-sibling labs path** | `labs_path` (abs or relative) + re-run `setup-symlinks.sh`. Defaults are correct here. |
| **Skip ux phase** | not a config toggle — would require editing `orchestrator.md` to drop the Phase 1b `Task(ux-designer)` call. There is no `--phases`/`--skip` flag. |

`pipeline.json` schema in orchestrator/architecture docs also references
`max_dev_iterations`/`max_critic_iterations`/`require_tests`/`minimum_score`,
but the live `factory.config.json` only sets `max_build_iterations` +
`require_manual_test`; the rest fall back to orchestrator defaults
(`max_dev_iterations` 5, `require_tests` true, `minimum_score` 70).

There is **no dry-run / cheap LLM mode** beyond `--dry-run` (which only prints the
command and does not call the model) and the `require_manual_test=false` toggle.

---

## 9. Pre-flight checklist (clean full run targeting labs)

```bash
cd /Users/ben/code/pattern-factory

# 1. symlinks present & pointing at /Users/ben/code/labs
ls -l docs .claude/skills .claude/agents-upstream            # all 3 -> /Users/ben/code/labs/...
#    if any missing/wrong:  ./scripts/setup-symlinks.sh

# 2. identity key for manual_test (MISSING right now)
ls -l /Users/ben/code/labs/claude.key || \
  ( cd /Users/ben/code/labs && deno task ct id new > claude.key )

# 3. labs ct task reachable from factory
deno task ct --help >/dev/null && echo "ct OK"

# 4. (manual_test only) agent-browser + free ports 8100/5273
which agent-browser

# 5. preview the exact command, then go
./run-factory.sh --brief briefs/queue/<your-brief>.md --model claude-opus-4-8 --dry-run
./run-factory.sh --brief briefs/queue/<your-brief>.md --model claude-opus-4-8
```

Then collect results from `/Users/ben/code/pattern-factory/output/<name>/` and,
if promoting into labs, `cp -R` into
`/Users/ben/code/labs/packages/patterns/factory-outputs/<name>/`.

---

## 10. Quick reference (key files)

- Wrapper / THE command: `/Users/ben/code/pattern-factory/run-factory.sh:167`
- Orchestrator brain: `/Users/ben/code/pattern-factory/.claude/agents/orchestrator.md`
- Factory agents dir: `/Users/ben/code/pattern-factory/.claude/agents/` (orchestrator, spec-interpreter, ux-designer, critic, grader, summarizer, manual-tester)
- Build/critic/test agents (labs, symlinked): `/Users/ben/code/pattern-factory/.claude/agents-upstream/` → `/Users/ben/code/labs/.claude/agents/`
- Config: `/Users/ben/code/pattern-factory/factory.config.json` (+ optional `factory.config.local.json`)
- Symlink setup: `/Users/ben/code/pattern-factory/scripts/setup-symlinks.sh`
- Batch: `/Users/ben/code/pattern-factory/scripts/run-batch.sh`
- Brief templates: `/Users/ben/code/pattern-factory/briefs/templates/{minimal,standard,detailed}.md`
- Example briefs: `/Users/ben/code/pattern-factory/briefs/queue/*.md`
- manual_test/deploy/browser + ports: `/Users/ben/code/pattern-factory/.claude/agents/manual-tester.md`
- Full design (timing/rubric/lifecycle): `/Users/ben/code/pattern-factory/docs-factory/architecture-design.md`
- Sample completed runs: `/Users/ben/code/pattern-factory/output/{music-charts,music-discovery}/`
- `ct` task (→ labs CLI): `/Users/ben/code/pattern-factory/deno.json:3`

## 11. Gotchas / corrections vs the labs-side doc

- **Orchestrator + spec/ux agents ARE in this repo** (labs `pattern-factory.md`
  said they were external in `common-fabric-2`). Correct location:
  `/Users/ben/code/pattern-factory/.claude/agents/`.
- **Auth = your Claude Code CLI**, not a gateway / `ANTHROPIC_API_KEY` /
  cf-harness. cf-harness is a separate future backend, unused by these scripts.
- **There is NO `ui_design` phase and no `ui-designer` agent here** — it's
  `spec → ux_design → build → critic → manual_test → grade → summarize`.
- **Output goes to `pattern-factory/output/<name>/`, not into labs.** Promotion
  into `labs/packages/patterns/factory-outputs/` is a manual `cp`
  (`promote-pattern.sh` is documented but absent).
- **Default `--model claude-opus-4-6` is stale** — pass a current model.
- **No resume**; one-shot `claude -p`.
- **`claude.key` is missing in labs right now** — create before a run that hits
  manual_test, or set `require_manual_test=false`.
- The repo's stop-hook gate `tasks/check.sh` type-checks `completed/**` +
  `rejected/**` `.tsx` via `deno task ct check` — a known harness artifact; ignore
  if it complains about empty/deno-version on stop.
- `scripts/pd-bundle.sh` (cloud/pd backend, README §Cloud) is **not present** in
  the current tree; only the `local` and `sandbox-runner` backends are wired.
