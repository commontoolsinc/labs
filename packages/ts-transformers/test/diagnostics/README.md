# Diagnostic probes

This directory holds one-shot diagnostic scripts used during transformer
investigations. **They are not tests.** They don't assert anything and they
don't run in CI. They walk the fixture tree, ask focused questions, and emit
TSV/CSV summaries you can re-slice with `awk` / `grep` / spreadsheet tools.

The probes are kept in-tree because:

- They proved useful enough during their original investigation that we'd like
  the next person facing a similar question to have a head start.
- The setup boilerplate (loading fixtures into a `ts.Program` via
  `batchTypeCheckFixtures`, walking expected files with the TS parser,
  classifying identifier positions) is non-trivial to reproduce from scratch
  each time.
- They serve as worked examples of the "investigate at population scale before
  changing code" technique.

The probes are **allowed to bit-rot.** They might break when fixture loaders
change, when import paths move, or when the analyzer interface evolves. We're
not promising they'll always work — only that if a similar question arises,
they're a starting point you can revive or copy-paste from.

If you find yourself updating a probe to keep it running, ask first whether the
question it answers is still active. If yes, fix it. If no, delete it.

## Running them

From `packages/ts-transformers/`:

```sh
deno run --allow-read --allow-env test/diagnostics/probe-element-param-analyzer.ts > /tmp/probe.tsv
deno run --allow-read --allow-env test/diagnostics/probe-derive-closure-captures.ts > /tmp/probe.tsv
deno run --allow-read --allow-env test/diagnostics/probe-derive-callback-captures.ts > /tmp/probe.tsv
```

Each prints a header row to stdout, then one data row per finding. A summary
goes to stderr.

## What's here

### `probe-element-param-analyzer.ts`

For each `arr.map((p, …) => …)` callback in fixture inputs, asks the dataflow
analyzer what it reports for every read of `p`, `p.x`, `p.x.y`, etc. inside the
body. Output classifies each access by:

- `kind` — identifier-only vs property-access
- `in_jsx`, `in_method_call` — syntactic position
- `opaque`, `requires_rewrite`, `dataflows` — analyzer verdict
- `reactive_map` — heuristic: does the corresponding `.expected.*` file contain
  `mapWithPattern` / `filterWithPattern` / `flatMapWithPattern`?

Used during the element-binding analyzer fix (PR #3550) to scope the bug:
identified 16 cases the analyzer was silent on across the fixture suite, of
which PR #3539 covered only 1.

### `probe-derive-closure-captures.ts`

Walks every `.expected.jsx` / `.expected.js` fixture, finds every
`__cfHelpers.derive(...)` call, and reports any identifiers its callback body
references via closure capture (not destructured from its parameters, not
module-scope, not a known runtime helper).

Used during PR #3550 to audit a class of closure-capture correctness bugs in
expected fixtures: derive callbacks that close over reactive (opaque) values not
declared in their inputs object. Surfaced 5 bugs across 5 fixtures, all
confirmed with the transformer area owner.

After PR #3550 lands, the probe still has 4 hits: plain-JS captures
(`const suffix = "!"`, primitive elements from non-reactive `.map`s, etc.).
Berni confirmed those are _also_ a real bug class — derive callbacks shouldn't
close over plain-JS values either; they should be passed in as explicit inputs
so the callback stays self-contained. Fixing that is a separate follow-up; see
`probe-derive-callback-captures.ts` for the post-pipeline view.

### `probe-derive-callback-captures.ts`

Runs the full transformer pipeline on every fixture input and walks the
_emitted_ `__cfHelpers.derive(...)` calls in the output. Reports every free
identifier in the callback body that isn't covered by the destructured params,
inner locals, output module scope, or a known runtime helper.

Differs from `probe-derive-closure-captures.ts` in that this one operates on the
post-pipeline AST (clean symbol resolution; no original-node provenance
confusion from source-side rewrites) and runs the actual pipeline rather than
walking pre-baked expected files. Both probes converged on the same 4-fixture
population for the plain-JS-captures bug class, which is a useful cross-check.

Used during PR #3550 follow-up planning to scope the plain-JS-captures fix: 4
hits across 3 fixtures, all real instances of the bug. Will be the test
population for the follow-up wrap-path fix.

## When to add a new probe

Good candidates:

- The question has a measurable answer across many similar instances (fixtures,
  files, occurrences of a pattern).
- You catch yourself wanting to "spot-check a few cases" — that's the signal.
- The investigation would otherwise produce a tiny biased sample.

Bad candidates:

- One-off questions answerable by reading 2-3 files.
- Things that should be real tests with assertions.
- Things that need ongoing CI enforcement (promote those to real tests).
