---
name: cf-review
description: Review a changeset for the Common Fabric repo — the local branch diff vs main, or a GitHub PR. Flags correctness and regression bugs loudly, checks that runtime-semantics changes stay coherent across docs/comments/examples, catches duplicated core machinery (hashing, serialization, cloning, identity) and code fighting the transformer/reactive model, and scrutinizes whether the tests guard the right principles. Report-first; offers to post a self-signed PR review. Use when asked to review code, review a PR, review the current branch or diff, or self-review before pushing. Invoke as /cf-review or /cf-review <PR#>.
---

# Common Fabric Code Review

This skill is a **map and a statement of values**, not a recipe. It assumes you
already know how to read and review code; it tells you the things about _this_
repo you cannot derive — where its value and its footguns are, and how we like
review done.

All paths are relative to the repo root.

## What we value in a review

- **Changeset-scoped.** Review the diff and its immediate effects — for a large
  change, its blast radius — not a repo-wide audit. Focus on the changeset; keep
  it fast.
- **Loud, with intention.** Flag bugs, regressions, and broken principles
  unmistakably; let nits stay quiet. We ship many PRs — aim for sound, not
  pristine.
- **Report-first, then offer to post.** Always show the report, then offer to
  post it — **signed as yourself** (the agent and model, on the human's behalf).
  Skip posting when it isn't worth it.
- **An aid to thinking.** Help people decide with eyes open: surface what
  matters — especially a spec or principle a change violates — clearly enough to
  act on. The human owns the merge.

## The north star for coherence

> When someone — human or LLM — searches for the words they've heard and lands
> on a doc, comment, or example, they must not be **misled** by something that
> no longer matches how the runtime works.

That is the bar — not uniform vocabulary. Wording drift is a slow Boy-Scout fix:
nudge what you touch, propose big sweeps as follow-ups. When a change leaves an
authoritative source _actively wrong_ — a normative spec especially — surface it
loudly; that it is known matters more than which bucket it lands in.

## Two kinds of change — know which you're reviewing

This repo holds both the **platform** (the runtime and packages that execute
programs — ordinary, untransformed TypeScript) and **patterns** (the programs
themselves, the semantic equivalent of apps). They review differently:

- **Patterns** are authored in TypeScript, then **transformed** by an extensive
  pipeline of custom transformers into a much more complex form that satisfies
  the framework's structure, so the pattern can build a reactive graph evaluated
  under live subscriptions. The source is far from what runs, so a change — to a
  pattern _or to the runtime code that executes it_ — can span many abstraction
  levels with implications that aren't obvious in isolation.
- **Platform code** (most of `packages/**`) is plain TypeScript: review it as
  you would any TS codebase, plus this repo's conventions and the
  anti-duplication map below.

Two failure modes recur when moving fast without the whole picture:

1. **Fighting the framework** (patterns, and the runtime that serves them) —
   when the idiom is hard to find, code reaches for try/catch, singletons,
   manual subscriptions, `async/await` in handlers, or a transformer escape
   hatch. (Dimension 4.)
2. **Re-forking core machinery** (platform and patterns alike) — re-deriving
   hashing, serialization, cloning, or identity instead of reusing the one
   canonical home. The subtle, expensive footguns. (Dimension 3.)

---

## Step 1 — Establish scope, then pick your depth

Auto-detect the target: no argument → the local branch vs `main`
(`BASE=$(git merge-base HEAD origin/main)`, then read `git diff "$BASE"` and
`git log "$BASE"..HEAD` for intent); a number → that PR (`gh pr view <N>`,
`gh pr diff <N>`). Say in a couple of lines what the change does and why, and
whether its scope is coherent or has leaked. Unclear motivation is a **question
for the author**, not a defect.

**Then pick depth from the diff size** — reading a large change set file-by-file
burns context and loses the forest:

- **Detail mode** (small/medium — a package or two): read the changed code.
- **Scope-and-theory mode** (large — many files, several packages): build a
  top-down **theory of intent and blast radius** rather than reading every file.
  Deep-read only the load-bearing files (core abstraction, API / signature
  changes, hashing / serialization / cloning / identity), and **fan out
  read-only subagents** to search the rest — callers the diff missed, docs /
  examples for touched concepts, prior art it may be forking. Synthesize into
  one report, test the change against that theory, and state your coverage
  (deep-read / sampled / delegated).

---

## Step 2 — Where to look

Order findings by impact. Each dimension is a generative principle plus _seed_
tells — examples to prime you, not a checklist to stop at. The space is larger
than any list here.

### 1. Correctness & regressions — the loudest category

A confirmed bug or regression is Blocking. Watch especially for:

- **Tests bent to fit a regression** — an existing test weakened or retrofitted
  so new (possibly wrong) behavior passes. A test edited to assert a bug is
  Blocking.
- **Reactivity hazards _(patterns)_** — reactive self-feedback (a `cf-*` control
  bound via `$value` / `$checked` whose handler writes the same cell back),
  `.get()` on computed / lift results, `new Writable(reactiveValue)`. Defer to
  `docs/common/ai/pattern-critique-guide.md` for the full ruleset; cite it.
- **Determinism _(patterns)_** — `Date.now()` / `Math.random()` / authored
  timers in pattern code; use `safeDateNow()` / `nonPrivateRandom()`, never
  inside a re-running computation.
- **Time-based waits _(any code)_** — `sleep` / `setTimeout` used to "wait for"
  a result instead of awaiting the actual event or signal. Almost never
  justified (animations aside) and a prime source of CI flakiness: what takes X
  today takes 10X under load someday.

### 2. Coherence ripple

Apply the north-star test, bounded to what the diff touches. If the change moves
**runtime semantics** — a primitive's behavior, a transformer rule, a public
signature, the meaning of a core concept — find what still describes the old
behavior (docs under `docs/common/`, example patterns and the catalog, JSDoc on
the changed symbols, package READMEs, normative specs) and flag it. A change
that **violates a documented invariant** (transformer target-language boundary,
module-graph cleanliness, "make invalid states unrepresentable") is a loud,
Blocking finding even if the code "works." Fix what the diff touches; propose
wider sweeps as follow-ups — don't boil the ocean.

### 3. Anti-duplication

We move fast; under that pressure core machinery gets silently re-forked, and in
a few domains that is brutal to debug because divergence stays invisible until
it isn't. **Re-implementing one of these is Blocking; reuse the canonical
home.** Point to the module rather than trusting a symbol name remembered here —
names drift, so confirm against the package's actual exports when you rely on it
(this table is the highest-value _and_ highest-rot content in the skill):

| Concern                                     | Canonical home                                                                                                | Do not                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| stringifying fabric values for debug/log    | `@commonfabric/data-model/value-debug`                                                                        | `JSON.stringify()` on fabric data; it stringifies most non-plain objects as literally `{}`                                                        |
| sorting strings for cross-platform          | `@commonfabric/utils/utf8`                                                                                    | use JavaScript `string1 < string2` (incorrect given UTF-16 surrogate code points), hand-roll or import a different sorting function               |
| SHA-256 / content addressing                | `@commonfabric/content-hash`                                                                                  | hand-roll, call `crypto.subtle.digest("SHA-256", …)` directly, or import `@noble/hashes` / `hash-wasm` / `node:crypto` / `@std/crypto`            |
| hashing a fabric value or schema            | `@commonfabric/data-model/value-hash`, `@commonfabric/data-model/schema-hash`                                 | re-derive value / schema hashing, or use `JSON.stringify()` to "simulate" a hash — it erases type identity and most contents of non-plain objects |
| cloning a fabric value                      | `@commonfabric/data-model/value-clone`                                                                        | `structuredClone()` or `JSON.parse(JSON.stringify(...))` on fabric / cell data — drops cell links, dies on circular `$UI` trees                   |
| cloning a schema (for modification)         | `@commonfabric/data-model/schema-utils`, several useful functions available                                   | `structuredClone()` or `JSON.parse(JSON.stringify(...))`                                                                                          |
| (de)serializing fabric values / wire format | `@commonfabric/data-model/codec-json`                                                                         | invent a parallel serializer / `toJSON` for fabric values                                                                                         |
| cell ↔ link conversion                      | `convertCellsToLinks` (`packages/runner/src/cell.ts`)                                                         | re-implement link conversion (don't copy the internal `traverse*` helpers in `llm-dialog.ts`)                                                     |
| identity / DID / keypairs                   | `@commonfabric/identity`                                                                                      | mint DIDs or keys ad hoc                                                                                                                          |
| variable-length integer encoding            | `@commonfabric/leb128` (LEB128 or similar)                                                                    | hand-roll varint encode / decode                                                                                                                  |
| Merkle-tree hashing                         | **N/A — we don't do Merkle-tree hashing** (we have content hashes in `data-model`, not a classic Merkle tree) | invent or import a Merkle-tree library unless specifically asked                                                                                  |

`hash`, `serialize`, and `clone` are the three we re-fork most — the tree
_already_ carries several SHA-256s (e.g. `content-hash` vs
`packages/toolshed/lib/sha2.ts` vs inline `crypto.subtle.digest`), so steer new
code to the canonical home rather than cargo-culting a neighbor. A new such
definition isn't automatically wrong, but the PR must justify why the canonical
home doesn't fit; a _silent_ fork is Blocking.

### 4. Framework-fit

Spot code fighting the framework instead of using it, and give two outputs: the
fix toward the idiom, and — when the confusion was avoidable — _the doc or
structure gap that caused it_ (a follow-up; that is how the mistake stops
recurring). Tells (seeds, drawn from `docs/development/DEVELOPMENT.md`):

- over-eager try/catch that swallows errors a caller should see (throwing is
  fine; fatal errors _should_ propagate);
- new singletons / module-global mutable state (breaks multiple instances +
  tests);
- ambiguous `any` (or abuse of `unknown`) away from a serialization boundary;
  types that admit invalid intermediate states;
- working around the transformer (stray `/// <cf-disable-transform />`, manual
  graph wiring the transformers would do, imperative escapes from the target
  language);
- async escapes in patterns (`async/await` in handlers; awaiting `generateText`
  / `generateObject` instead of using `.result`; `new Stream()` /
  `.subscribe()`).

When a transformer behavior is in doubt, read the **emitted output** before
reasoning from source:
`deno task cf check <file>.tsx --show-transformed [--no-run]`. If the
transformer is the real culprit, the fix is to diagnose it and file a
transformer bug with a repro — not to hand-build a workaround.

### 5. Changeset hygiene

Stray cruft is trivial to fix but shouldn't merge: leftover debug logging /
`*.log` / scratch notes, commented-out code, `.only` on tests, "temp" / "HACK"
stopgaps, abandoned TODOs. A new workspace package must register in the root
`deno.jsonc` and carry its own `tasks.test` (a missing one makes the root runner
recurse and time out CI). Run `deno fmt` and `deno lint` on touched files.

### 6. Craft & conventions

Mostly Improvement / Nit — don't drown the report in these. Dead code, unused
exports, superfluous abstraction, unclear names. Types: no needless `any`; no
needless casts (an `as Something` that isn't required for correctness) and no
unjustified `as unknown as Something`, especially one erasing `Immutable<T>` /
`Readonly<T>`. For the rest — named exports, JSDoc on exports and public
members, import grouping, `@commonfabric/api` xor `/interface`, module-graph
hygiene — follow `docs/development/DEVELOPMENT.md` and point to it rather than
relisting it.

### 7. Test rigor — the special-attention area

We modify tests constantly but often can't say _why_ a given test exists. For
each touched or added test, name the principle it guards; if you can't, that's a
finding (likely incidental, or testing an implementation detail). A good test
exposes the intended behavior and reads like a sentence — a user story, not an
assertion on internals; prefer BDD style (`@std/testing/bdd` `describe` / `it`
that read as sentences) and `expect()` over `assert*()` — a direction we apply
inconsistently today, so nudge toward it rather than treat it as a gate. Check
the cases cover the actual semantic change and its edge / empty / error states,
and that a removed test dropped dead coverage, not real coverage. Follow the
repo's testing conventions (`docs/common/ai/pattern-testing-guide.md`); run
targeted tests while reviewing.

---

## Step 3 — Verify, don't speculate

Run only what confirms a finding (CI already keeps `main` green, so you're
checking the delta): `deno task check` (types), `deno lint`, `deno test <file>`
(targeted; whole suite is `deno task test`), `deno task integration <pkg>`, and
`--show-transformed` for transformer questions. Tag each finding **verified**
(you ran it / read the line) or **suspected** (needs author confirmation). Never
present a guess as a bug.

---

## Step 4 — Rank, report, offer to post

Use the repo's severity taxonomy (`docs/common/ai/pattern-critique-guide.md`:
critical / major / minor / info). The report's only required shape:

- a one-line header — scope · coverage (deep-read / sampled / delegated) ·
  checks run;
- **🔴 Blocking** (resolve or consciously accept before merge), **🟡
  Improvements** (non-blocking), **⚪ Nits** (optional; omit if Blocking exists)
  — each finding gives location · what · why it matters · concrete fix ·
  verified/suspected;
- **Questions for the author** only if motivation or scope is unclear;
- **Possible follow-ups** as proposals, for a human to file;
- a one-line **verdict**.

Let the findings drive the format — don't pad to fill a template. Lead with the
worst thing; if the change is clean, say so in two lines and stop.

**Then offer to post** (after showing the report), signed as yourself: a body
opening with self-attribution — e.g. _"cf-review via Claude `<model>`, on behalf
of @`<handle>`"_ (use the human's real GitHub handle from `gh` / the PR context;
omit the `@` if unsure) — via `gh pr review --comment`, or inline comments
through the reviews API for Blocking / Improvements with Nits left in the
summary. Skip posting when it isn't worth it.

---

## Canonical references

- Skill-authoring philosophy (why this skill is shaped this way):
  `docs/development/skill-authoring.md`
- Pattern rules + severity taxonomy: `docs/common/ai/pattern-critique-guide.md`
- Design principles & idioms: `docs/development/DEVELOPMENT.md`
- Transformer semantics:
  `docs/specs/ts-transformer/ts_transformers_review_guide.md`
- Reactivity model: `docs/common/concepts/reactivity.md`
- Debugging & gotchas: `docs/development/debugging/README.md`
