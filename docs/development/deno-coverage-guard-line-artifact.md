# deno coverage: one-line guard reported uncovered when its branch is not taken

A one-line conditional guard — `if (cond) return …;`, `if (cond) throw …;`, or
`if (cond) continue;` — is reported by `deno coverage` as **0 hits** whenever the
function runs but the guarded branch is never taken, even though the `cond`
condition is evaluated on every call. The line is attributed to the (untaken)
branch statement rather than to the condition that actually ran.

This note records the behaviour because several deliberately-unreachable
invariant guards in the runtime are marked uncovered solely because of it, and
provides a minimal reproduction to submit upstream.

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

## Minimal reproduction

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

- Expected: line 2 is covered, because the `if (!x)` condition runs on every
  call.
- Actual: line 2 reports 0 hits; adding any trailing token after the statement
  flips it to 1.

## Impact and handling

We do not work around this with trailing comments — that would make a comment
load-bearing for coverage. The affected guards are left as plain one-liners.
Writing each invariant guard on a single line keeps the artifact to one line per
guard rather than three (the `if`, the body, and the closing brace of a block
form). The remaining uncovered guard lines are tracked here rather than chased
with contrived error-injection tests, since the branches are unreachable by
construction.
