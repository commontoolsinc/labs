# deno coverage: one-line guard reported uncovered when its branch is not taken

A one-line conditional guard — `if (cond) return …;`, `if (cond) throw …;`, or
`if (cond) continue;` — is reported by `deno coverage` as **0 hits** whenever the
function runs but the guarded branch is never taken, even though the `cond`
condition is evaluated on every call.

Most of this is expected. V8 collects coverage at block (byte-range)
granularity rather than per line: the guard's body (`throw …`, `return …`,
`continue`) is its own range with its own execution count, and a branch that is
never taken legitimately has a count of 0. The V8 blog post
["JavaScript code coverage"](https://v8.dev/blog/javascript-code-coverage)
describes this directly — "block coverage could detect that the `else` branch …
is never executed." A whole-line hit count is a projection of those block ranges
onto lines, and the blog does not specify how that projection should work; it is
the coverage tool's job. When a single line holds both the executed condition and
the un-taken body, projecting it to 0 is a defensible choice, not a bug.

One projection behaviour is not defensible, and it is the only part worth
reporting upstream: a trailing comment on the guard line flips the reported line
count from 0 to 1, even though a comment changes nothing about what executes. The
reproduction below isolates it.

This note records the behaviour because several deliberately-unreachable
invariant guards in the runtime are marked uncovered solely because of it.

## Where it bites us

The mergeable-write record methods in
`packages/runner/src/storage/v2-transaction.ts` guard invariants that every
caller already establishes (each writes through the same transaction before
recording, so the target is always editable and writable):

```ts
// Shown for illustration only.
if (ready.error) throw ready.error;
if (!doc) throw new Error("append target is not writable");
```

The `buildReads` space filter in `packages/runner/src/storage/v2.ts` skips
mergeable ops belonging to another space, which only happens under multi-space
writes:

```ts
// Shown for illustration only.
if (op.space !== this.#space) continue;
```

These conditions are evaluated on every call, but their branches are not taken
in single-space, healthy-transaction tests, so deno reports each guard line as
uncovered.

## Isolating the line-attribution quirk

```ts
// guard.ts
function noComment(x: unknown): number {
  if (!x) throw new Error("e");
  return 1;
}
function withComment(x: unknown): number {
  if (!x) throw new Error("e"); // a trailing comment
  return 1;
}
if (import.meta.main) {
  noComment({}); // truthy argument: the `if (!x)` branch is never taken
  withComment({});
}
```

```
deno run --coverage=cov guard.ts
deno coverage cov --lcov | grep '^DA:'
```

Observed on deno 2.8.3:

```
DA:2,0   // if (!x) throw new Error("e");
DA:3,1   // return 1;
DA:6,1   // if (!x) throw new Error("e"); // a trailing comment
DA:7,1   // return 1;
```

`noComment` and `withComment` contain identical executable code and are each
called once with a truthy argument. Line 2 (no trailing comment) is reported as
0 hits; line 6 (the same statement with a trailing comment) is reported as 1
hit. A comment cannot change what executes, so the difference is purely a
line-attribution artifact: deno credits the line to whatever byte range ends it
— the untaken branch statement when nothing follows, the covered trailing
comment when one does.

## Expected vs actual

The block-level fact — the un-taken `throw` executes 0 times — is correct and
expected. The defect is only in how that projects onto a line count:

- Expected: two lines containing identical executable code report the same line
  hit count.
- Actual: line 2 reports 0 hits while line 6 — the same statement with a
  trailing comment — reports 1. A comment, which does not execute, decides the
  count.

## Reporting upstream

Only the trailing-comment line-attribution flip is worth reporting; the un-taken
branch reporting 0 hits is documented V8 block-granularity behaviour and should
not be filed as a bug. A search of deno's open issues found no existing report of
comment-sensitive line coverage or `deno coverage` line attribution. The closest
match, [denoland/deno#9865](https://github.com/denoland/deno/issues/9865)
("`deno coverage` line and branch counts are incorrect"), is closed and covers a
different case — off-by-one line and branch counts around an `if`/`else` block,
not a comment changing a line's hit count — so a focused report on the
comment-sensitivity would not duplicate it.

## Impact and handling

We do not work around this with trailing comments — that would make a comment
load-bearing for coverage. The affected guards are left as plain one-liners.
Writing each invariant guard on a single line keeps the artifact to one line per
guard rather than three (the `if`, the body, and the closing brace of a block
form). The remaining uncovered guard lines are tracked here rather than chased
with contrived error-injection tests, since the branches are unreachable by
construction.
