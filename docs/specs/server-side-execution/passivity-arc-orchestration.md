# Server-primary passivity arc — build & orchestration plan

**Live plan.** The orchestration companion to this directory's design docs
([`README.md`](README.md) — the original spec), the phase plan
([`implementation-plan.md`](implementation-plan.md)), the lattice register
([`context-lattice-execution.md`](context-lattice-execution.md)) and the
current arc's plan+evidence log
([`client-passivity.md`](client-passivity.md), whose §0 is START-HERE).
Those say WHAT and WHY; this says WHO BUILDS IT AND IN WHAT ORDER. Keep §1
accurate as work lands; archive to `docs/history/` per
[`docs/README.md`](../../README.md) when the arc completes.

**Goal of the arc (owner, 2026-07-28):** everything reactive runs on the
server. Client-side execution of reactive functions becomes *purely
speculative* — the client may compute for its own rendering but never commits
anything except handler/event-driven writes. Design rationale, including the
three motivations that make this worth its cost, is
[README §1 / §4 Q3](README.md) and decisions
D8–D10 in [client-passivity §7](client-passivity.md).

**Why this file exists.** The arc is months of work across many context
windows. This file is the orchestration script: it carries the state, the
hard-won knowledge that is expensive to rediscover, and a pre-written
delegation prompt per work item so a fresh context can drive the whole thing
without re-deriving any of it.

---

## 0. If you are resuming — do exactly this

1. Read **§1 State** (short). It names the next wave.
2. Read **§2 Standing knowledge** (short). It is the stuff that costs hours to
   rediscover and minutes to read.
3. Read **§3 Rules of engagement** — specifically which items must NOT be
   delegated.
4. For the next wave's items: dispatch each item's **verbatim prompt** from §4
   as a subagent, in parallel where the item says `parallel: yes`.
5. As each returns: run the item's **Verify** line YOURSELF. Do not accept a
   subagent's claim of success — run the command. (Agents in this repo have
   reported green while leaving a gate red.)
6. Commit per item (not per wave), update §1, push.
7. When a wave's gate in §5 is met, move to the next wave.

**Do not** start a wave whose §5 gate is unmet, and do not batch several items
into one commit — per-item commits are what make a partially-complete wave
resumable.

---

## 1. State

**Branch:** `codex/server-execution-w1-2-shared-pool` (LABS repo).
**Last landed:** `57e625424` — wave A (A1–A4) + C1 + the branch's lint/fmt debt.

| Wave | What | Status |
| --- | --- | --- |
| A | R5/R13 effect rows — brokers, descriptors, `wish` | **DONE** except A5 |
| B | Post-A measurement re-run | **DONE** — zero movement; see §5h |
| **A5** | served sqlite-op commit path (D2) | **NEXT** — scope grew, see below |
| **C2** | client-side lattice-claims negotiation | **NEXT** — C1 ruled, scope settled |
| **P2x** | the ×12 diagnosis, unblocked by C1 | **NEXT** — hypothesis in hand |
| D | P3 passivity mechanism | blocked on C2 |
| D | P3 passivity mechanism — the client stops running standing work | blocked on B + C |
| E | P5 passive delivery + warm spaces | blocked on D |
| F | P6 acceptance | blocked on E |

**Already landed this arc (for context, do not redo):**

- `565a06916` CA4 audit + two rank-dial probes + §5g memo.
- `3d659cb14` group-chat SERVED in the gate topology; three-arm ladder;
  `non-space-read-scope` 33 events / 19 offenders → 1 → 0.
- `9caf341e2` R7 diagnosis.
- `dbb5fc86c` R7 fix — issuance-side context-floor consult; fences 2 → 0 → 0.
- `91434cc6d` spec motivations + R5 worklist.
- `b058731e1` this orchestration plan.

**Known-open:**

- `dynamic-write-outside-static-surface` ×12 (1 offender). **C1 UNBLOCKED
  THIS** — ruled SURVIVES, so it is not a P3 dependency and is now ordinary
  P2 serving-coverage work. Start from the certificate-completeness
  hypothesis in client-passivity §5h, not from a fresh investigation.
- **CP6's refutation is re-opened, owner-gated.** A3 proved `llmDialog` and
  `navigateTo` are effect nodes at runtime (§2.7 item 6). Whether `llmDialog`
  performs *double* egress was never re-measured after the kind changed.
- **`wish` bypasses the executor's egress denial.** It builds
  `new HttpProgramResolver(url)` with no fetch transport, so it falls through
  to `globalThis.fetch` and `fetch: denyExternalBuiltinFetch` never sees the
  call. Independent of the descriptor question; needs its own decision.
- The rank dials remain programmatic-only. No deployment can flip them; the
  browser cannot negotiate `context-lattice-claims-v1` at all. That is wave C2.
- **A5's scope grew.** A2 established that `sqliteQuery` is NOT blocked on
  D2, and that the lane-scoped read seam in `packages/memory` (G1) and the
  descriptor shape (G3) fold INTO A5 rather than preceding it. Compose A5's
  prompt from client-passivity §5h's A2 paragraph.
- The arc's goal statement vs CP1 — see the tension flagged at the end of
  §5h. Owner call: is the target zero client reactive commits, or zero on the
  served path?

---

## 2. Standing knowledge — do not rediscover

Everything here was paid for once. Subagent prompts in §4 tell the agent to
read this section; keep it accurate.

### 2.1 Getting the executor to actually serve

The `SharedExecutionPool` **does not wake an executor that is already live** —
`#acceptAcceptedCommit` in `packages/runner/src/executor/shared-execution-pool.ts`
returns early on `slot.executor !== null`. Its wake path exists to start or
unpark a Worker, never to drive one. And `set-demand` only *enqueues* the
structural swap; activation completion is observable **only** through
`settle()`.

A fixture that starts a pool and then drives clients gets a live Worker
holding its lanes and running nothing (`schedulerRuns: 0`). Drive the Worker's
`settle()` / `wake()` / `settle()` fixpoint explicitly. Worked examples:
`packages/runner/test/server-execution-rollout-products.test.ts` and
`packages/patterns/integration/server-execution-group-chat-user-rank-probe.test.ts`.

### 2.2 CFC patterns in loopback fixtures

- Loopback gate clients need a `trustSnapshotProvider` on the Runtime, or the
  first commit fails `cfc-relevant-transaction-not-prepared`. The harness's
  `openGateClient` does **not** supply one — see `openProbeClient` in the
  group-chat probe for the shape.
- Trusted handlers (group-chat `saveProfile`, `sendTrustedMessage`,
  `addTrustedRoom`) require a DOM-provenance event marked with
  `markRendererTrustedEvent` from `@commonfabric/runner/cfc`. Without it the
  writes are **silently dropped** with a warning and the fixture measures an
  unused piece. Copy `trustedEvent(surface, action)` from the group-chat probe.
- A session bound to the executor lease (`bindExecutionSession`) may not emit
  unclaimed observations. Use a second, unbound client for anything that must
  look like an ordinary client run.

### 2.3 Test topology

- `deno task test` (root) iterates workspace packages. It **does not** run
  `packages/patterns/integration` — that is
  `deno task integration` → `./integration/*.test.ts` with `--trace-leaks`.
- `packages/runner`'s `test` task runs `test/*.test.ts`, so runner probes DO
  ride the root battery.
- Every Worker-spawning test must run inside `withExecutorTeardownBarrier`
  (FW7) or `--trace-leaks` sanitizers flake at teardown.
- `docs/` is excluded from `deno fmt` (see root `deno.jsonc` `fmt.exclude`) —
  hand-wrap markdown at ~72 chars to match.

### 2.4 Known flaky gate — do not chase

`packages/patterns/integration/server-execution-cross-space-gate.test.ts`
fails its 60s `waitForCondition` barrier intermittently under load.
**Measured 3/6 failures at clean HEAD with zero local changes.** If it fails,
re-run it before believing it; it deserves its own barrier fix, which is not
part of this arc.

### 2.4b The fmt/lint gate — measured on BOTH sides, attribution settled

Measured by the orchestrator in detached worktrees with empty `git status`:

| | `deno fmt --check` | `deno lint` |
| --- | --- | --- |
| main `aac9bd3dc` | 26 unformatted / 2128 files | **clean** |
| branch `b058731e1` | 22 unformatted / 3735 files | **1 problem** |

**The lint error was ARC DEBT, and is now FIXED** (`a34c15fd2`). main is
lint-clean; `require-await` at
`packages/runner/src/executor/executor-worker.ts:1071` arrived on this branch
with `d28092a64`. The `async` keyword is load-bearing — `enqueue<T>` requires
`() => Promise<T>` — so the fix was a `// deno-lint-ignore require-await`
carrying a reason, NOT deleting the keyword. Note the directive must sit on
the line IMMEDIATELY before the code: a multi-line explanation above it breaks
the suppression and adds an unused-directive error, taking the count 1 → 2.

Both gates are green on this branch as of `57e625424`. **A new fmt/lint
failure is now yours** — but re-check your own files individually before
believing the stop hook, which runs repo-wide and can transiently catch
another agent's in-flight write.

**The fmt drift is on both sides and they are different sets.** All 22 on the
branch are in branch-modified files, so the arc introduced those; main
separately carries 26 of its own. Two distinct cleanups; do not conflate them,
and do not let "main is dirty too" excuse the branch's 22.

**Do not run repo-wide `deno fmt` mid-wave** — it rewrites files other agents
have open, which is the whole-file-clobber hazard §3 warns about. Take the
branch's fmt cleanup as its own commit on a quiet tree (all agents reported),
and keep it separate from any behavioral commit so the mechanical reformat
stays reviewable.

**Beware the dirty-tree reading.** Mid-wave, two of the 22
(`packages/runner/src/runner.ts`,
`packages/runner/test/executor-action-router.test.ts`) sit in the working set,
so it looks like the agents caused it. They did not — every subagent in this
wave independently checked and reported this correctly.

### 2.5 Measurement discipline (mandatory — see client-passivity §0)

Fresh store per run (`rm -rf packages/toolshed/cache` after stopping the
offset-750 servers); kill leftover `ms-playwright` browsers; record load
average; full-capture harness output (never `tail`); curl
`/api/health/stats` in the same command right after the harness exits;
compare arms only in **adjacent pairs**; real-Worker e2e one file per `deno`
invocation; engagement counters on every number or it reads "not engaged".

**Load matters.** This box has run at load 18–34 during this arc. Counts and
set relations are load-insensitive; latencies are not. Do not quote a latency
taken above load ~5.

### 2.5b Two traps that silently return the wrong answer

- **`grep` treats `packages/memory/v2/engine.ts` as BINARY** and prints
  nothing rather than erroring. Plain `grep -c sqlite engine.ts` returns
  empty; `grep -ac` returns 18. Use `grep -a` on that file or you will
  conclude, wrongly, that the biggest file in the memory layer has no
  handling for whatever you searched. (Found by A5, reproduced by the
  orchestrator.)
- **`git add docs/` is too broad while agents are running.** It sweeps
  concurrent agents' doc edits into an unrelated commit — this happened to
  `0ad293c2b`, which silently carries C2's `EXPERIMENTAL_OPTIONS.md` work
  under a commit message about something else. Stage explicit paths.

### 2.6 Comparing action ids across arms

Action ids read `cf:module/<hash>:<lift>:<instance>`; the trailing instance
segment is minted per Runtime, so raw ids are **not** comparable between two
arms that each build a Runtime. Normalize to the derivation key
(first three colon-segments). See `derivationKey` in
`packages/runner/test/server-execution-group-chat-rank-probe.test.ts`. Getting
this wrong makes every cross-arm set relation vacuously zero.

### 2.7 The R5 mechanism (how a builtin becomes server-executable)

1. `packages/runner/src/builtins/server-execution.ts` —
   `SERVER_EXECUTABLE_BUILTIN_IDS` is the exact allowlist of effect builtins
   the server may execute. Membership is what earns the `:server-v1`
   implementation fingerprint (`serverBuiltinImplementationHash`).
2. `packages/runner/src/runner.ts:~5134` stamps that fingerprint; a canonical
   builtin outside the set instead gets `builtinImplementationHash` (`:v1`) and
   then rejects `incomplete-static-surface` until a descriptor exists.
3. `packages/runner/src/runner.ts:~5244` mints the
   `ServerBuiltinActionDescriptor` **generically** from `serverBuiltinId` —
   so adding an id to the allowlist gives it a descriptor automatically from
   `inputCells` / `schedulingWrites` / `serverBuiltinRuntimeWrites`.
4. Computation builtins use the parallel
   `SERVER_COMPUTATION_BUILTIN_IDS` / `ServerBuiltinComputationDescriptor`
   (currently `ifElse`, `when`, `unless`) and the
   `serverBuiltinComputation` branch at the same site.
5. Kind pins live in `packages/runner/test/builtin-effect-registry.test.ts`
   (static, no Runtime): a builtin performing egress must register
   `isEffect: true` and appear in its id list.
6. **A builtin's registration is not its kind.** `runner.ts:5304` resolves
   `module.isEffect ?? builtinIsEffect` — the FACTORY's return wins over
   `index.ts`. `llmDialog` (`llm-dialog.ts:3219`) and `navigateTo`
   (`navigate-to.ts:121`) both `return { ..., isEffect: true }`, so they are
   **effect** nodes at runtime no matter what `addModuleByRef` says.
   Consequence for W2.15: never give them a computation descriptor —
   `serverBuiltinComputationScopeSummary` returns undefined unless
   `observation.actionKind === "computation"`, so the descriptor would mint
   and then never assemble. Pinned by "builtins whose factory declares
   isEffect are effect nodes regardless of the registration source" in the
   same file.

**CORRECTION (2026-07-28, A3).** An earlier revision of this plan asserted
"`llmDialog` is CONFIRMED a computation — CP6's egress claim was REFUTED."
**That was wrong**, and it came from a test comment that was itself wrong: the
"llmDialog stays a computation" assertion only regex-parses `index.ts`
registrations, so it is green while the effective kind is the opposite. This
is the exact failure mode §0 step 5 warns about — a green test asserting a
false thing — so it is worth remembering that it occurred inside this arc's
own standing knowledge. **CP6's refutation is re-opened and is owner-gated:**
the claim was that `llmDialog` performs no direct egress. Its *kind* is now
known to be effect; whether it performs *double* egress is a separate
question that nobody has re-measured.

### 2.8 The `llm` hole, already diagnosed (wave A1)

- `packages/runner/src/builtins/llm.ts:68` `llmClientOptions(runtime, space,
  serverBuiltinId?: "generateText" | "generateObject")`.
- Line ~79: when running server-side (`runtime.hasServerBuiltinFetch()`) and
  `serverBuiltinId === undefined`, it **throws**
  `"unsupported LLM builtin has no server broker route"`.
- The shared tool loop is `executeWithToolsLoop` (`llm.ts:377`), whose
  `serverBuiltinId` param is declared at `:391` with the same narrow union.
- `generateText` passes `serverBuiltinId: "generateText"` at `llm.ts:1183`.
- **The `llm` builtin's own call at `llm.ts:810` passes nothing** — that is the
  hole. `llm` is registered `isEffect: true`
  (`packages/runner/src/builtins/index.ts:73`) and already listed in the
  registry test's `OTHER_EFFECT_IDS`, but it is absent from
  `SERVER_EXECUTABLE_BUILTIN_IDS`.
- The broker route itself is `runtime.fetchBuiltin(serverBuiltinId, path, url,
  init)` (`packages/runner/src/runtime.ts:2074`), reached through
  `createInternalLLMBrokerRequestOptions`. Test scaffolding for it:
  `packages/runner/test/runtime-host-for-space.test.ts:123`
  (`describe("Runtime.fetchBuiltin")`).

### 2.9 R7 (landed — context for anyone touching claim issuance)

Claim rank and the engine's effective context are computed by two different
functions; only the engine's saw the durable, monotonic
`scheduler_context_floor`, which an ordinary **unclaimed client run** can pin
to `user`/`session`. The host now consults it at issuance
(`#assertExecutionClaimContextFloorAdmits`, `packages/memory/v2/server.ts`) and
declines a claim broader than the floor. The engine fence remains the backstop
for the issuance→commit race. Full write-up: client-passivity §5g.

**Relevance to the arc:** this class of bug is a *transition artifact*. It
exists only because two executors write the same durable state. Expect more of
them while both sides run, and expect them to disappear at P3 — that is an
argument for crossing rather than lingering.

---

## 3. Rules of engagement

### Delegate (subagent)

- Well-scoped builds with a named acceptance test.
- Investigations with one specific question and a written deliverable.
- Test authoring against an existing fixture family.

Use `general-purpose` unless the item says otherwise. Dispatch items marked
`parallel: yes` in a single message with multiple tool calls.

**Cap: at most THREE subagents in flight at once** (owner, 2026-07-28) — the
5-hour quota is a real budget and a wide fan-out burns it. `parallel: yes`
means "may run alongside others", not "dispatch all of them now". When a wave
has more than three parallel items, dispatch the highest crossing-weight three
(CP10) and hold the rest until a slot frees. A second reason to prefer three:
every parallel item shares one worktree, so each extra agent adds edit-collision
and test-interference risk on the shared registry files.

**When parallel items share a file** (wave A: `server-execution.ts`, and the
zero-verdict pin in `server-execution-product-fixtures.test.ts`), add to each
prompt: use anchored `Edit`s and never whole-file `Write`s on a shared file;
never `git checkout`/`stash`/`commit`; keep test runs narrow; and check
`git diff --stat` before chasing a failure that looks unrelated. Without that
clause the likeliest wave failure is not a bad build — it is one agent
debugging another's half-applied edit.

### Do NOT delegate — do these yourself

- **Measurement runs.** The protocol in §2.5 is easy to violate and a violated
  run produces confident wrong numbers. Every number that reaches a spec is
  taken by the orchestrator.
- **Owner-gated decisions** (anything the plan marks owner-gated; the D-series
  in client-passivity §7).
- **Commits, commit messages, pushes.** The narrative is the deliverable.
- **Accepting a result.** Always run the Verify line yourself.
- **Spec edits to `docs/specs/server-side-execution/*`.** Subagents may draft
  into a scratch file; the orchestrator lands the wording.

### Subagent prompt contract

Every prompt in §4 already contains this; keep it if you write new ones:

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (standing
> knowledge) — it will save you hours.
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: files changed, the exact test
> command that proves it, and anything you found that contradicts §2.

---

## 4. Work items

### Wave A — R5/R13 effect rows

Priority is **crossing-weighted per CP10**: a mid-chain unservable strands
everything downstream, so it outranks a leaf with higher raw incidence.
Register row: `docs/specs/server-side-execution/context-lattice-execution.md`
§8 R5 / R13.

---

#### A1 — `llm` effect broker · parallel: yes

**Goal.** `llm` becomes server-executable, like `generateText` already is.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/builtin-effect-registry.test.ts packages/runner/test/builtin-implementation-hash.test.ts packages/runner/test/runtime-host-for-space.test.ts
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 — especially §2.7
> (how a builtin becomes server-executable) and §2.8 (this exact hole, already
> diagnosed; the line numbers are current).
>
> TASK: give the `llm` builtin a server broker route, exactly as `generateText`
> has one. The diagnosis in §2.8 is complete — you should not need to
> rediscover it. Expected shape: add `"llm"` to `SERVER_EXECUTABLE_BUILTIN_IDS`;
> widen the `serverBuiltinId` unions in `llmClientOptions` and
> `executeWithToolsLoop`; pass `serverBuiltinId: "llm"` at the `llm` builtin's
> `executeWithToolsLoop` call (`llm.ts:~810`). VERIFY rather than assume that
> the generically-minted descriptor (§2.7 item 3) covers what `llm` mints at
> runtime — check `serverBuiltinRuntimeWrites` against the cells `llm` actually
> creates, and say so explicitly in your report either way.
>
> RED-FIRST: before changing behavior, add a test that fails for the right
> reason. Put the identity pin in
> `packages/runner/test/builtin-implementation-hash.test.ts` and the routing
> behavior in `packages/runner/test/runtime-host-for-space.test.ts` (there is a
> `describe("Runtime.fetchBuiltin")` block at :123 to model on). Show me the
> red output in your report, then the green.
>
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: files changed, the exact test
> command that proves it, whether the descriptor genuinely covers `llm`'s
> runtime writes, and anything contradicting §2.

---

#### A2 — `sqliteQuery` effect broker · parallel: yes

**Goal.** `sqliteQuery` becomes server-executable. Unlike `llm` this is
**not** fetch-shaped, so §2.7's allowlist move alone will not be enough —
expect real broker work.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/builtin-effect-registry.test.ts && deno test -A --filter sqlite packages/runner/test/
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (especially §2.7),
> then decision **D2** in `docs/specs/server-side-execution/client-passivity.md`
> §7, then the R5 row in `context-lattice-execution.md` §8.
>
> TASK: design and implement the server-side broker path for the `sqliteQuery`
> effect builtin (`packages/runner/src/builtins/sqlite-builtins.ts`, registered
> at `builtins/index.ts:~94`). START BY REPORTING THE DESIGN before you build:
> `sqliteQuery` is not fetch-shaped, so the existing
> `ServerBuiltinFetchBroker` seam
> (`packages/runner/src/executor/server-builtin-transport.ts`) may not fit. Say
> plainly whether it fits, and if not, what the minimal new seam is. If the
> honest answer is "this needs the D2 served-commit path first" (item A5), say
> that and stop — a correct scoping answer is a good outcome for this task.
>
> If it does fit: implement red-first with tests, following §2.7.
>
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: the design call and its
> rationale, files changed, the exact test command, and anything contradicting §2.

---

#### A3 — W2.15 descriptors for five computation builtins · parallel: yes

**Goal.** `llmDialog`, `compileAndRun`, `sqliteDatabase`, `navigateTo`,
`inspectConfLabel` get W2.15-shape computation descriptors so they stop
rejecting `incomplete-static-surface`.

**Note:** `llmDialog` is **confirmed a computation** — CP6's egress claim was
REFUTED; it orchestrates effect-classified `llm` nodes with no direct egress.
Do not "fix" it into an effect.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/server-execution-product-fixtures.test.ts packages/runner/test/builtin-effect-registry.test.ts
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (especially §2.7
> item 4 — the computation-descriptor seam), then the W2.15 material referenced
> from the R5 row in `docs/specs/server-side-execution/context-lattice-execution.md` §8.
>
> TASK: add W2.15-shape computation descriptors for `llmDialog`,
> `compileAndRun`, `sqliteDatabase`, `navigateTo`, `inspectConfLabel`. The
> existing exact registry is `SERVER_COMPUTATION_BUILTIN_IDS` in
> `packages/runner/src/builtins/server-execution.ts` (`ifElse`, `when`,
> `unless`) — read the docblock there; it is explicit that the registry is
> deliberately exact and that envelope-shaped builtins are a different design.
> For EACH of the five, verify against the builtin source what it actually
> reads and writes, and only add it if its surface genuinely is
> "reads its inputs, writes exactly its direct output(s)". If one of them is
> envelope-shaped or otherwise does not fit, LEAVE IT OUT and report why —
> a partial, correct result beats five wrong entries.
>
> `llmDialog` is CONFIRMED a computation (CP6's egress claim was refuted); do
> not reclassify it.
>
> Red-first with tests. Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: which of the five you added,
> which you left out and why, files changed, the exact test command, and
> anything contradicting §2.

---

#### A4 — R13 `wish` descriptor · parallel: yes

**Goal.** `wish` gets a descriptor. Its shape is decided by the resolver
contract (plan W2.15b). Measured ×4 in the flagship fixture — a real hole.

**Verify (run yourself):**
```bash
deno test -A packages/runner/test/server-execution-product-fixtures.test.ts
```

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2 (especially §2.7),
> then the **R13** row in `docs/specs/server-side-execution/context-lattice-execution.md`
> §8, then `packages/runner/src/builtins/wish.ts`.
>
> TASK: `wish` has static builtin identity but no descriptor, so it classifies
> `incomplete-static-surface`. Determine its resolver contract from the source
> and give it a descriptor of the right shape. Note that
> `packages/runner/test/server-execution-product-fixtures.test.ts` currently
> carries an explicit exemption for `impl:cf:builtin/wish:v1` in its
> zero-verdict pin — when `wish` gets a real descriptor that exemption should
> narrow or go away, and that is the natural red-first signal for this task.
>
> If the resolver contract turns out NOT to have a bounded static surface, say
> so plainly with evidence rather than inventing one — "wish needs a different
> mechanism, here is why" is a good outcome.
>
> Do NOT commit, do NOT push, do NOT edit anything under
> `docs/specs/server-side-execution/`. Report: the contract you found, what you
> built (or why you did not), files changed, the exact test command, and
> anything contradicting §2.

---

#### A5 — served sqlite-op commit path (D2) · parallel: no (after A2)

**Goal.** Routing-layer lane-scope admission + row-label re-derivation, per
**D2**. D2 says BUILD it: the permanent-ruling alternative was rejected
because CP21 shows the required static detectability is structurally absent
(dynamic sqlite ops ride arbitrary callers' commits).

**Verify:** to be set from A2's design report.

**Prompt:** compose after A2 reports — its design call determines the shape.
Carry forward: the D2 rationale, `packages/runner/src/builtins/sqlite/`, and
whatever seam A2 identified.

---

### Wave B — measurement (orchestrator only, NOT delegated)

**B1.** Re-run the three-arm ladder probe and record the delta wave A bought.

```bash
deno test -A packages/patterns/integration/server-execution-group-chat-user-rank-probe.test.ts
```

Read `unservedByCode` / `offendersByCode` per arm. Expect the effect rows to
move `broker-required` classes; `dynamic-write-outside-static-surface` should
be unchanged (it is not an effect row). Record in client-passivity §5g.

Also re-run the classification probe:
```bash
deno test -A packages/runner/test/server-execution-group-chat-rank-probe.test.ts
```

**Gate:** numbers recorded in the spec before wave C proceeds past C1.

---

### Wave C — P3 preconditions

#### C1 — Does P3 delete the §4 widening artifact? · parallel: yes (can start now)

**Goal.** Decide whether `dynamic-write-outside-static-surface` (×12, 1
offender, survives both scoped ranks) is worth diagnosing, or whether a
passive client removes the requirement entirely. This is a **paper
investigation**, ~1 hour, and it reorders the plan if the answer is "deleted".

**Verify:** the deliverable is a written argument with code citations; the
orchestrator reads and rules.

**Prompt:**

> Repo: LABS, worktree `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`,
> branch `codex/server-execution-w1-2-shared-pool`.
> READ FIRST: `docs/specs/server-side-execution/passivity-arc-orchestration.md` §2, then
> `docs/specs/server-side-execution/client-passivity.md` §5g (the whole
> section), then the §4 output-widening pair contract — start at
> `laneBroadScopeNamingWriteViolation` in
> `packages/runner/src/scheduler/servability.ts:~727` and its engine twin
> `assertLaneBroadScopeNamingWrite` in `packages/memory/v2/`, plus
> `packages/memory/v2/scope-naming-link.ts`.
>
> QUESTION, and it is the only one: the §4 widening pair exists so that a
> CLIENT reading a scoped-lane write sees a correct self-scoping redirect. If
> the client becomes purely speculative — it still computes for rendering but
> NEVER commits reactive results — does that requirement still exist? Answer
> with code citations, not intuition. Specifically: enumerate who READS the
> broad instance today and why, and for each reader say whether a passive
> client still needs it.
>
> Deliverable: a written argument in
> `/private/tmp/claude-501/.../scratchpad/c1-widening-under-passivity.md`
> (create the directory if needed; do NOT write into docs/). State a verdict:
> DELETED / NARROWED / SURVIVES, with the reasoning that would let someone
> disagree with you.
>
> Do NOT commit, do NOT push, do NOT change any source. Report the verdict and
> the strongest counter-argument to it.

---

#### C2 — Client-side `context-lattice-claims-v1` negotiation · parallel: no (after C1)

**Goal.** The binding blocker from the CA4 audit: the browser client has no way
to negotiate the subcapability, and the principal-wide cohort gate therefore
makes user lanes un-openable in exactly the deployments worth measuring. This
is what unblocks the two-browser payoff surface.

**Precedent and template:**
`packages/patterns/integration/server-execution-f5-env-bridge-gate.test.ts` —
the F5 gate exists because the *identical* miswire already happened once (env
dials never reached the advertisement in realm-separated deployments). Build
this the same way: red-first, asserting the subcapability negotiates END TO
END from the dials alone.

**Prompt:** compose after C1; scope depends on whether the §4 artifact is being
carried forward.

---

### Waves D–F — sketch only (specify when C completes)

- **D · P3 passivity mechanism.** Per-session subcap, passive-mode demand
  producer, dynamic-reactivation contract, effect-attempt journal. THIS is
  where single-user boot shifts and multi-user actually gets faster. Design
  doc first (delegate the draft, orchestrator rules on it), then build.
  Watch: D5 hold-never-flicker is the user-visible risk surface.
- **E · P5 passive delivery + warm spaces.** Demote-never-retire, D3
  push-then-catch-up boot seed. Makes the persistent-page premise true for
  real returning users; kills the cold-start cliff jointly with the §5d
  serving-path work.
- **F · P6 acceptance.** Three-way at protocol n; fully-engaged ≤ flag-off on
  interaction AND boot; engagement by counters; cold row published alongside.
  Non-negotiable by this plan's own language (see D7).

**Standing constraint for D/E:** D10 sets the bar at *fast first paint with
gaps*, not zero-execution first paint. Speculation is for interaction latency
and nothing else; it is never load-bearing for convergence.

---

## 5. Phase gates

| Gate | Condition |
| --- | --- |
| A→B | All A items landed or explicitly scoped out with a recorded reason. Full battery green. |
| B→C | Post-A numbers recorded in client-passivity §5g. |
| C→D | C1 verdict ruled by the owner-facing memo; C2 negotiating end to end under a red-first gate. |
| D→E | Client stops running standing work for claimed actions, with counters proving it. |
| E→F | Cold-start cliff measured, not asserted. |
| F | P6 bar: fully-engaged ≤ flag-off on interaction AND boot, at protocol n, k∈{3,10}. If it fails → D7 says ESCALATE TO OQ5, do not ratify non-parity. |

---

## 6. Log

Append one line per landed item: date, item, commit, one-sentence outcome.

- 2026-07-28 — plan created (`docs/specs/server-side-execution/passivity-arc-orchestration.md`);
  wave A next, A1 pre-diagnosed in §2.8.
- 2026-07-28 — A1 `cfa827f82`: `llm` gets the server broker route; all three
  LLM builtins share it.
- 2026-07-28 — A2 `8cb00bbf8`: fetch broker refused as a misfit;
  `sqliteQuery`'s post-commit effect now routes through the sink-request
  suppression gate. Not blocked on D2; rest folds into A5.
- 2026-07-28 — A3 `f221411df`: `inspectConfLabel` added, 4 of 5 refused with
  evidence. Found a green test asserting a false thing; CP6 re-opened.
- 2026-07-28 — A4 `a69aec5f9`: `wish` refused a descriptor (its surface is
  misleadingly narrow) and the block is pinned. Found an egress-denial bypass.
- 2026-07-28 — arc debt `a34c15fd2` (lint pin) + `57e625424` (fmt 21 files);
  A→B gate's lint and format halves now met.
- 2026-07-28 — C1 ruled **SURVIVES**; the ×12 is unblocked as P2 work and the
  question's framing was wrong at the source. Full ruling: client-passivity §5h.
- 2026-07-28 — wave B measured: **zero movement**, every counter reproducing
  the pre-A baseline. The plan's own prediction ("expect the effect rows to
  move broker-required classes") was WRONG — group-chat exercises none of the
  four builtins wave A touched. Lesson for future waves: check that the
  measurement instrument can see the thing being built BEFORE promising a
  buy. Full numbers: client-passivity §5h.
