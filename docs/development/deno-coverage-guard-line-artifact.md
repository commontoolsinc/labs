# deno coverage: one-line guard reported uncovered when its branch is not taken

A one-line conditional guard — `if (cond) return …;`, `if (cond) throw …;`, or
`if (cond) continue;` — is reported by `deno coverage` as **0 hits** whenever the
function runs but the guarded branch is never taken, even though the `cond`
condition is evaluated on every call.

This is expected. V8 collects coverage at block (byte-range) granularity rather
than per line: the guard's body (`throw …`, `return …`, `continue`) is its own
range with its own execution count, and a branch that is never taken legitimately
has a count of 0. The V8 blog post
["JavaScript code coverage"](https://v8.dev/blog/javascript-code-coverage)
describes this directly — "block coverage could detect that the `else` branch …
is never executed." A whole-line hit count is a projection of those block ranges
onto lines, and the blog does not specify how that projection should work; it is
the coverage tool's job. When a single line holds both the executed condition and
the un-taken body, projecting it to 0 is a defensible choice, not a bug.

This note records the behavior because several deliberately-unreachable
invariant guards in the runtime are marked uncovered by it.

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

## Reproduction

```ts
// guard.ts
function guarded(x: unknown): number {
  if (!x) throw new Error("e");
  return 1;
}
if (import.meta.main) {
  guarded({}); // truthy argument: the `if (!x)` branch is never taken
}
```

```
deno run --coverage=cov guard.ts
deno coverage cov --lcov | grep '^DA:'
```

```
DA:2,0   // if (!x) throw new Error("e");
DA:3,1   // return 1;
```

Line 2 holds both the condition, which is evaluated, and the `throw`, which is
not reached. The line count reports the un-taken range.

## Impact and handling

The affected guards are left as plain one-liners. Writing each invariant guard
on a single line keeps the artifact to one line per guard rather than three (the
`if`, the body, and the closing brace of a block form). The uncovered guard
lines are tracked here rather than chased with contrived error-injection tests,
since the branches are unreachable by construction.

A guard line is one of two cases where an uncovered line is expected to stay
uncovered; a block that is never invoked at all is the other, below. Everywhere
else, a line whose coverage moves between runs or between shard layouts is a
defect in the tests — see [COVERAGE.md](COVERAGE.md) for what to do about it.

## A block that is never invoked: `deno-coverage-ignore`

A guard line's condition at least runs. A block that is never entered at all is
a different case, and `deno` has a directive for it. The
`FabricKeyPair` / `@commonfabric/api` constructor drift guard is the worked
example: a closure that is built, discarded, and never called, whose body
exists only so that the compiler checks each construct form the api
declaration promises.

Four spellings exist — `deno-coverage-ignore`,
`deno-coverage-ignore-start`, `deno-coverage-ignore-stop`, and
`deno-coverage-ignore-file`. **The bare form takes only the line that follows
it**, which is easy to get wrong: applied to the head of a six-line closure it
removes one line and leaves five. A block wants the `-start` / `-stop` pair.

```ts
// Shown for illustration only.
// deno-coverage-ignore-start
(() => {
  neverCalled();
})();
// deno-coverage-ignore-stop
```

The directive reaches the lcov report and not merely the terminal one, which
is what makes it usable here: the ignored lines carry no `DA:` records at all,
so `LF` falls while `LH` stays put — the lines removed were uncovered ones,
never counted in `LH` to begin with — and the CI ratchet sees nothing
uncovered rather than seeing a gap it has been told to forgive.

Measure a "before" figure while the source still lacks the directive. The
ignore directives are applied when `deno coverage` builds the **report**, not
when `deno test` writes the profile, so re-running `deno coverage` over a
profile collected earlier still reports the post-directive numbers.

**What this is not for.** It suppresses a measurement, so it is only honest
where the measurement is meaningless — code that *cannot* execute, by
construction, in any test. A branch that is merely hard to reach, expensive to
set up, or currently untested is a gap, and marking it ignored converts a
number someone would have chased into silence. The bar is that no test could
cover the lines without changing what they are: if a test could reach them,
write the test.
