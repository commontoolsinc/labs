---
status: historical
created: 2026-08-17
archived: 2026-08-17
reason: "Investigation record: the two uncovered lines that moved the `packages/memory` coverage count between two runs of the same pull request."
---

# The patch-rejection line that only a race reached, August 2026

## Conclusion

[PR #5827](https://github.com/commontoolsinc/labs/pull/5827) changed no source
file under `packages/memory`, and its Coverage Check job reported that group at
643 uncovered lines against a `main` baseline of 641.

The two lines are 257 and 258 of `packages/memory/v2/patch.ts`: the throw
inside `removeAtPath()` that reports a `remove` op naming a key its base object
does not have.

```ts
if (!Object.hasOwn(container, key)) {
  throw new PatchApplyError(`missing object key at ${encodePointer(path)}`);
}
```

Nothing in the unit suites reached that throw. The only coverage report that
ever recorded a hit came from the runner package's integration run, where
reaching it takes two writers racing. Whether the race happens is decided by
the order in which the server delivers frames, so the lines were covered on
some runs and not on others, and the group sat at its baseline with no headroom
for the difference.

## What the runs measured

The pull request ran twice against the same baseline. Run
[31848603757](https://github.com/commontoolsinc/labs/actions/runs/31848603757)
measured the group at 641 and passed; run
[32058834063](https://github.com/commontoolsinc/labs/actions/runs/32058834063)
measured 643 and failed. `packages/memory/v2/patch.ts` is byte-identical
between the two commits, so their line numbers and counts compare directly.

Both runs upload 38 coverage artifacts. In the passing run, exactly one of them
records a hit on line 257: `coverage-profile-package-runner`, the "Package
Integration Tests (runner)" job, which counts two. In the failing run, all 32
artifacts that measured the file report zero.

Reading that job's report around the object branch of `removeAtPath()` — line
255 counts arrivals at the branch, 257 the rejections, and 259 the deletions
that went through:

| Run | Arrivals (255) | Rejections (257) | Deletions (259) |
| --- | ---: | ---: | ---: |
| 31848603757, the passing run | 111 | 2 | 109 |
| 32058834063, the failing run | 109 | 0 | 109 |

The same 109 removals succeed in both. What moves is whether two further
removes arrive naming a key that is already gone.

## Where those two arrivals come from

The client replays a pending layer's ops over whatever base the server
delivered, rather than combining values:
`applyPendingVersion()` in `packages/runner/src/storage/v2.ts` calls
`applyPatchToDocument()` and catches `PatchApplyError`, which renders the layer
skipped. A `remove` whose key a winning writer has already dropped is one of
the ops that cannot apply, and it reaches this throw.

So the branch runs when a layer holding a `remove` is replayed over a base that
retired the key first. That ordering is a property of when frames arrive, which
nothing in the integration suite asserts and nothing about it fixes.

## What the unit suites reached

Running the whole `packages/memory` suite with coverage left 29 lines of
`patch.ts` uncovered, 257 and 258 among them. The rest were the module's other
rejection paths — the spine checks in `thawSpine()` and `validateAddSpine()`,
the root-path guards in `removeAtPath()` and `moveValue()`, the `splice` bounds
checks, the array-index checks — along with the `remove` descriptor's `apply`,
which no unit test had ever driven: every arrival at `removeAtPath()` in the
suite came through `move`.

## What was done

`packages/memory/test/v2-patch-errors.test.ts` states one case per
`PatchApplyError` the module raises, plus the root-path cases where an op
returns a value rather than raising. Each case asserts the exact message, so a
report that changes which pointer it names, or which of two nearby conditions
it came from, fails rather than passing on the class alone.

That takes `patch.ts` from 29 uncovered lines under the memory suite to 2. The
two that remain are the rethrow of a non-`CloneForMutationError` out of the
clone machinery, at lines 140 and 141. No input to `applyPatch()` produces one:
every value that `cloneForMutation()` refuses — a primitive, a
`FabricPrimitive`, a `Date`, a `Map`, a `Set`, a `RegExp` — it refuses with a
`CloneForMutationError`, which the branch above that rethrow already handles.
Those two lines are uncovered on every run rather than on some of them, which
is what the ratchet needs of them.
