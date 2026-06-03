---
name: cf-review
description: Review a changeset for the Common Fabric repo — the local branch diff vs main, or a GitHub PR. Flags correctness and regression bugs loudly, checks that runtime-semantics changes stay coherent across docs/comments/examples, catches duplicated hashing/ID/serialization logic and LLM "fighting the framework" anti-patterns, and scrutinizes which tests are the right tests. Produces a ranked, report-first review. Use when asked to review code, review a PR, review the current branch or diff, or self-review before pushing. Invoke as /cf-review, /cf-review <PR#>, or add --comment to post inline PR comments.
---

# Common Fabric Code Review

This skill frames **what we care about** when reviewing changes in this repo. It
assumes you already know how to read code — it does not teach review mechanics.
It tells you where this repo's value and its footguns actually are.

All paths below are relative to the repo root.

## What this review is (and is not)

- It is **changeset-scoped**: review the diff and its immediate ripple, not the
  whole repo. Do not start an open-ended repo audit — that broader sweep is a
  separate, heavier effort. This review is fast.
- It is **loud on what matters** and **quiet on what doesn't**. Flag bugs,
  regressions, and broken principles unmistakably. Keep nits to a short,
  clearly-optional list — or omit them when there are real issues to focus on.
- It is **report-first**. Produce the ranked report. Only touch the PR when the
  invoker passes `--comment`, and only after showing the report.
- It accepts that **the codebase is in semi-coherence under churn**. The goal is
  not a pristine merge on the first cycle. The goal is: no regressions, no
  silent principle violations, and nobody gets misled later by stale docs the
  change should have updated.

## The north star for coherence

> When someone — human or LLM — searches for the words they've heard and lands
> on a doc, comment, or example, they must not be **misled** and trip over
> something that no longer matches how the runtime actually works.

That is the bar. It is **not** "every file uses identical vocabulary." Line-by-
line vocabulary unification is a slow, opportunistic, Boy-Scout activity — nudge
nearby drift with small edits, propose big sweeps as follow-ups, never block a
PR on it. Block only when a change leaves an authoritative source actively
wrong.

## Why this repo is easy to get wrong

Programs ("patterns") are authored as TypeScript, **transformed** by a custom
TS-transformer toolchain (CTS) into plain JS that **builds a reactive graph**
evaluated under live subscriptions. So the source you read is two abstraction
levels above what runs. The principles are logical once read end-to-end, but
miss a piece and the behavior looks inexplicable. Two consequences drive this
review:

1. **LLMs fight the framework** when they can't find the idiom — they reach for
   try/catch, singletons, manual subscriptions, `async/await` in handlers, or
   `/// <cf-disable-transform />`. See Dimension 4.
2. **LLMs duplicate core machinery** — re-deriving hashing, serialization, or
   cloning instead of reusing the one canonical home. These are the subtle,
   expensive footguns. See Dimension 3.

---

## Step 1 — Establish scope and context

**Auto-detect the target.**

- No argument → review the **local branch** against `main`:
  ```bash
  git fetch origin main --quiet
  BASE=$(git merge-base HEAD origin/main)
  git log --oneline "$BASE"..HEAD     # commit messages = stated motivation
  git diff --stat "$BASE"             # what changed (incl. working tree)
  git diff "$BASE"                     # full diff to read
  git status --short                   # stray/uncommitted files
  ```
- A number argument (`/cf-review 3789`) → review that **PR**:
  ```bash
  gh pr view <N> --json title,body,files,additions,deletions,headRefName,baseRefName,author
  gh pr diff <N>
  # gh pr checkout <N>   # only if you need to run checks/tests locally
  ```

**Understand before judging.** From the commit messages / PR body, state in 2–3
lines: _what does this change do, and why?_ Then assess **scope**: does the diff
do one coherent thing, or has unrelated work leaked in?

If the motivation is genuinely unclear, do **not** block — add a short
**Questions for the author** list. Missing context is a question, not a defect.

---

## Step 2 — Review across these dimensions

Order findings by impact, not by dimension. The dimensions are a checklist of
where to look, not the structure of the report.

### 1. Correctness & regressions

The loudest category. A confirmed bug or regression is **Blocking**.

- Logic errors, wrong conditionals, off-by-one, unhandled empty/error states.
- **Regression smell in tests**: was an existing test _weakened or retrofitted_
  to make new (possibly wrong) behavior pass? Diff the test changes against the
  behavior change and check they agree on purpose. Tests edited to assert a bug
  are Blocking.
- **Reactivity correctness** (this repo): reactive self-feedback loops (a `cf-*`
  control already bound via `$value`/`$checked` whose handler writes the same
  cell back), `.get()` on computed/lift results, `new Writable(reactiveValue)`,
  nested `Writable`. Defer to `docs/common/ai/pattern-critique-guide.md` for the
  full pattern ruleset — don't restate it; cite it.
- **Determinism / SES**: direct `Date.now()`, `Math.random()`, or authored
  timers in pattern code; `safeDateNow()`/`nonPrivateRandom()` used inside a
  re-running `computed()`/`lift()`.

### 2. Coherence ripple

Apply the north-star test above. Bounded to what the diff touches.

- If the change alters **runtime semantics** — a primitive's behavior, a
  transformer rule, a public API signature, the name/meaning of a core concept —
  find the sources that still describe the OLD behavior and flag them:
  - `docs/common/` (concepts, capabilities, patterns, conventions)
  - example patterns in `packages/patterns/` and the catalog index
    `packages/patterns/index.md`
  - catalog + stories under `packages/patterns/catalog/`
  - **JSDoc on the changed symbols** and the package `README.md`
  - normative specs, e.g. `docs/specs/ts-transformer/` and
    `docs/common/concepts/reactivity.md`
- If the change **violates a documented invariant** (transformer target-language
  boundary, module-graph cleanliness, "make invalid states unrepresentable"),
  flag it **loudly** with the doc reference. A silent principle break is
  Blocking even if the code "works."
- **Don't boil the ocean.** Fix what the diff touches. Propose wider doc sweeps
  as follow-ups; never balloon the PR chasing every minor mention.

### 3. Anti-duplication

LLM-generated code silently forks core machinery. In a few domains this is a
hard footgun because divergence is brutal to debug. **Re-implementing one of
these is Blocking; reuse the canonical home.**

| Concern                                   | Canonical home                                                                                                             | Do not                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHA-256 bytes/hex (content addressing)    | `@commonfabric/content-hash` (`sha256`, `createHasher`)                                                                    | hand-roll, call `crypto.subtle.digest("SHA-256", …)` directly, or import `@noble/hashes` / `hash-wasm` / `node:crypto` / `@std/crypto`                                                         |
| hash of a fabric value or schema          | `@commonfabric/data-model` → `hashOf` / `hashStringOf` / `taggedHashStringOf` (`value-hash`), `hashSchema` (`schema-hash`) | re-derive value or schema hashing                                                                                                                                                              |
| clone a fabric value                      | `@commonfabric/data-model` `value-clone` (`cloneIfNecessary`, `cloneForMutation`, `shallowMutableClone`)                   | `structuredClone()` or `JSON.parse(JSON.stringify(...))` on fabric/cell data — it drops cell links and dies on circular `$UI` trees                                                            |
| (de)serialize fabric values / wire format | `@commonfabric/data-model` `json-wire` (+ `fabric-value`, `fabric-type-tags`, `deep-freeze`)                               | invent a parallel `serialize` / `toJSON` for fabric values                                                                                                                                     |
| cell ↔ link conversion                    | `convertCellsToLinks` in `packages/runner/src/cell.ts`                                                                     | re-implement link conversion (note: `traverseAndSerialize`/`traverseAndCellify` in `packages/runner/src/builtins/llm-dialog.ts` are private and a known smell — see CT-1205 — don't copy them) |
| identity / DID / keypairs                 | `@commonfabric/identity`                                                                                                   | generate DIDs or keys ad hoc                                                                                                                                                                   |
| LEB128 varint encoding                    | `@commonfabric/leb128`                                                                                                     | hand-roll varint encode/decode                                                                                                                                                                 |
| merkle references                         | `refer()` in `packages/memory/consumer.ts`                                                                                 | re-derive reference hashing                                                                                                                                                                    |

**`hash`, `serialize`, and `clone` are the three we re-fork most**, and
divergence in any of them yields bugs that are miserable to trace. The tree
_already_ contains several SHA-256 implementations (e.g. `content-hash` vs
`packages/toolshed/lib/sha2.ts` vs inline `crypto.subtle.digest` calls) — so
steer new code to the canonical home; **do not cargo-cult a nearby fork**. When
the diff adds or edits any of these, scan it explicitly:

```bash
# new hash/serialize/clone defs, or raw crypto / structuredClone / JSON-clone
PATTERN='^\+.*((export )?(async )?(function|const) (hash|sha256|serialize|deserialize|clone|deepClone)\b|crypto\.subtle\.digest|structuredClone\(|JSON\.parse\(JSON\.stringify)'
git diff "$BASE" -- '*.ts' '*.tsx' | grep -nE "$PATTERN"                                # local branch
gh pr diff <N> | awk '/^\+\+\+ b\//{ts=($0 ~ /\.(ts|tsx)$/)} ts' | grep -nE "$PATTERN"  # PR (scoped to .ts/.tsx)
```

A new definition is not automatically wrong — but the PR must justify why the
canonical home doesn't fit. A **silent** fork of hashing, serialization, or
cloning is Blocking. Beyond these three: before any new helper lands, grep for
an existing one; a util that duplicates an existing concept is at least an
**Improvement** finding — point at the instance to reuse or the abstraction to
extract.

### 4. Framework-fit

Spot code where the author (often an LLM) is **fighting the framework**. Each
finding has two outputs: (a) the code fix toward the idiom, and (b) — when the
confusion was avoidable — _the doc or structure gap that caused it_, proposed as
a follow-up. (b) is how we stop the same mistake recurring.

Tells, drawn from `docs/development/DEVELOPMENT.md`:

- **Over-eager try/catch** that swallows errors. Throwing is fine here; fatal
  errors (invalidated assumption, missing capability) _should_ propagate. LLMs
  over-handle.
- **New singletons / module-global mutable state** — infectious; breaks multiple
  instances and tests.
- **Ambiguous `any`** away from serialization boundaries; **representable
  invalid states** (optional fields that admit invalid intermediates).
- **Working around the transformer**: stray `/// <cf-disable-transform />`,
  manual graph wiring CTS would do, imperative escapes from the target language.
- **Async escapes in patterns**: `async/await` in handlers,
  `await
  generateText/Object(...)` (use `.result`), `new Stream()` /
  `.subscribe()`, manual subscription bookkeeping instead of
  `computed`/`lift`/`handler`.

When a transformer behavior is in question, inspect the **emitted output**
before reasoning from source:

```bash
deno task cf check <pattern-or-fixture>.tsx --show-transformed --no-run
```

### 5. Changeset hygiene

Fast pass; stray cruft is **Blocking** to merge but trivial to fix.

- Dev-time leftovers: `console.log`/debug logging, `*.log` files, scratch design
  notes / planning markdown committed by accident, commented-out code, `.only`
  on tests, "temp"/"HACK" workarounds added to get green.
- New TODO/FIXME — is it tracked, or abandoned?
- New workspace package added correctly? It **must** register in root
  `deno.json` `workspace` and have its own `tasks.test` — a missing test task
  makes the root runner recurse and time out CI. (See DEVELOPMENT.md.)
- Formatting: `deno fmt --check` on touched files.

### 6. Craft & conventions

Mostly Improvement / Nit. Don't drown the report in these.

- Dead code, unused exports/imports, superfluous abstraction, unclear names.
- Types: no needless `any`; export types with `export type { ... }`; JSDoc on
  public interfaces; **named exports over default**.
- Imports grouped (std → external → internal); import from `@commonfabric/api`
  **xor** `@commonfabric/api/interface`, not both.
- Module-graph hygiene: leaf utils stay dependency-light; no new cycles;
  module-specific deps go in that module's `deno.json`, not the root.

### 7. Test rigor — the special-attention area

We have many tests and modify them often, but frequently can't say _why_ a given
test exists. Bring rigor here:

- For each touched or added test, ask: **what principle or behavior does this
  guard?** If you can't name it, that's a finding — it may be testing an
  implementation detail or be incidental.
- Are these the **right cases**? Do they cover the actual semantic change and
  its edge/empty/error states — not just the happy path?
- Right **level**? Behavior over internals; integration where integration is the
  real contract.
- **Removed** tests: justified (dead feature) or a silent coverage drop?
- Reference `docs/common/ai/pattern-testing-guide.md`, and run targeted tests
  rather than the whole suite while reviewing: `deno test path/to/file.test.ts`.

---

## Step 3 — Verify claims, don't speculate

Run only what's needed to confirm a finding. CI already guarantees `main`
type-checks and passes, so you're checking the _delta_.

- Types: `deno task check`
- Lint: `deno lint`
- Targeted tests: `deno test path/to/file.test.ts` (whole suite:
  `deno task
  test` — NOT `deno test`)
- Integration (needs servers): `deno task integration <package> [filter]`
- Transformer output: `deno task cf check <f>.tsx --show-transformed --no-run`

Label each finding as **verified** (you ran it / read the exact line) or
**suspected** (needs the author to confirm). Never present a guess as a bug.

---

## Step 4 — Rank and report

Reuse the canonical severity taxonomy from
`docs/common/ai/pattern-critique-guide.md`: `critical` / `major` / `minor` /
`info`. Present findings in three buckets so bugs are never confused with taste:

- **🔴 Blocking (must-fix)** — `critical`/`major`: correctness bugs,
  regressions, weakened tests hiding a regression, broken documented principles,
  duplicated hashing/serialization/cloning, semantic changes that leave an
  authoritative doc actively wrong, stray dev cruft.
- **🟡 Improvements (noted, non-blocking)** — `major`/`minor`: reuse over
  duplication, framework-fit fixes, simplifications, better abstractions, test
  coverage gaps.
- **⚪ Nits / Boy-Scout (optional)** — `minor`/`info`: small vocabulary drift,
  polish. Keep this list short. Omit it entirely if there are Blocking items.

**Report shape:**

```
## cf-review: <branch or PR #N>

**Change:** <2–3 lines: what it does and why>
**Scope:** <clean / scope creep noted> · **Verification:** <checks run>

### 🔴 Blocking
1. [file.ts:line] <what> — <why it matters>. Fix: <concrete>. (verified)

### 🟡 Improvements
- [file.ts:line] <what> — <why>. Suggest: <concrete>.

### ⚪ Nits  (omit if Blocking items exist)
- [file.ts:line] <one-liner>

### Questions for the author
- <only if motivation/scope is genuinely unclear>

### Possible follow-ups (proposals, not tickets)
- <larger doc sweeps / framework-fit doc gaps that depend on a human answer>

**Verdict:** <Ready to merge / Merge after Blocking fixed / Needs a conversation>
```

**Bandwidth discipline (read this every time):**

- Lead with the worst thing. If there are Blocking issues, trim or drop Nits.
- Don't manufacture findings to look thorough. **If the change is clean, say so
  in two lines and stop.**
- Don't demand pristine. We ship many PRs; iterative improvement is expected.
- Follow-up suggestions are **proposals contingent on human answers**, never
  tickets you create. If you have Linear access, offer to file — don't
  auto-file.

---

## Step 5 — Optional: post to the PR (`--comment` only)

Only when the invoker passed `--comment`, and only after presenting the report.
Prefer one structured review carrying inline comments:

```bash
gh api --method POST repos/{owner}/{repo}/pulls/<N>/reviews \
  -f event=COMMENT \
  -f body='<the summary + verdict>' \
  -f 'comments[][path]=path/to/file.ts' -F 'comments[][line]=42' \
  -f 'comments[][body]=<finding + fix>'
  # repeat the comments[][...] triple per inline finding
```

Fallback for a single summary comment: `gh pr comment <N> --body '<report>'`.
Map only Blocking and Improvements to inline comments; leave Nits in the summary
body. Never post without the report shown first.

---

## Canonical references

- Pattern rules / severity taxonomy: `docs/common/ai/pattern-critique-guide.md`
- Design principles & idioms: `docs/development/DEVELOPMENT.md`
- Transformer semantics:
  `docs/specs/ts-transformer/ts_transformers_review_guide.md`
- Reactivity model: `docs/common/concepts/reactivity.md`
- Pattern intro & catalog: `docs/common/INTRODUCTION.md`,
  `packages/patterns/index.md`
- Debugging & gotchas: `docs/development/debugging/README.md`
