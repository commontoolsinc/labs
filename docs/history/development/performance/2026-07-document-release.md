---
status: historical
created: 2026-07-29
archived: 2026-07-29
reason: "Measurement record: what a space replica holds as a view pages through a collection, before and after documents could be released."
---

# Releasing documents bounds what a paging view retains, July 2026

The mechanism measured here is described in
[document release](../../../development/document-release.md), and is implemented
behind `experimentalDocumentRelease`.

## Result

A replica that starts empty, sliding a window of live subscriptions across a
thousand-document collection twenty-five at a time — the shape of any view paging
through more data than fits on screen:

| After forty pages    | Off   | On   |
| -------------------- | ----- | ---- |
| Documents held       | 1,000 | 0    |
| Documents watched    | 1,000 | 0    |
| Post-collection heap | 45 MB | 39 MB |

Off, the replica gains exactly one page of documents and one page of watched
identifiers per page turned, and gives back none of it: the count after page *n*
is 25(*n*+1), all the way to the whole collection. Heap climbs monotonically with
it, about 0.18 MB per page.

On, the count returns to zero after every page. Nothing is read at the point of
measurement — each page's subscriptions are cancelled before it is taken — so
zero is the correct answer, and the contrast is the point: the same walk either
accumulates the entire collection or holds nothing. Heap growth over the forty
pages falls from 7.1 MB to 0.7 MB, and what remains is not document retention,
since the document count is flat.

| Page | Off: docs / heap | On: docs / heap |
| ---- | ---------------- | --------------- |
| 0    | 25 / 38.2 MB     | 0 / 38.1 MB     |
| 9    | 250 / 40.0 MB    | 0 / 38.5 MB     |
| 19   | 500 / 41.8 MB    | 0 / 38.6 MB     |
| 29   | 750 / 43.7 MB    | 0 / 38.8 MB     |
| 39   | 1,000 / 45.3 MB  | 0 / 38.8 MB     |

## How it was measured

`packages/runner/test/measure-document-retention.ts`, run as

```
deno run -A --v8-flags=--expose-gc \
  packages/runner/test/measure-document-retention.ts --pages 40 --page-size 25
```

and again with `--release`. It populates a space from one replica, then opens a
second replica against the same in-process server that starts empty and has to
pull whatever it reads. Rows are two kilobytes of text plus sixteen tags each, so
retaining one costs enough to show in the heap column. Two full collections are
forced before each reading, so every number is retained heap rather than
allocation noise, and the counts come from the replica itself through
`ISpaceReplica.retentionStats()`.

Both runs were taken on the same machine with nothing else running, back to back.

`packages/runner/test/document-release.test.ts` pins the same property as an
assertion rather than a reading: bounded with release, strictly monotonic
without.

## Where the numbers came from originally

The same growth was first seen at a much larger scale in an experimental view
that paged through several hundred records of live agent data, each with a nested
raw-data projection. There a page turn cost about five hundred documents and five
hundred watched identifiers, and twenty page turns took the client to fifteen
thousand documents and 438 MB of retained heap — enough to exhaust a browser
renderer's heap and kill the tab. That view is exploratory and may never land, so
the measurement above deliberately reproduces the effect with nothing but the
runner and the memory server. The per-page ratios agree; the absolute numbers
scale with how much each record carries.

## What this does not yet do

The mechanism is off by default because it breaks the runner suite. Forcing
`experimentalDocumentRelease` on in `defaultSettings` and running all 539 runner
test files gives three hangs and eleven failing cases across ten files; the same
suite is clean with the flag off. A list projection whose elements were released
comes out with an empty aggregate in all three builtins, and conflict handling
can wait forever for a sync frame that only arrives over a watch the release
gave up.

The retention figures above are unaffected by that — they measure what the
replica holds, which is the thing this changes — but they are not a readiness
claim. The experimental options registry carries the reproducers.

## What the shrink verb is worth

`session.watch.remove` was added for this change rather than reusing
`session.watch.set`, whose request has to carry every watch spec that survives.
Logging both request bodies at each shrink over a paging walk with roughly
thirteen hundred live watches, a replacement carried 590 to 757 kB and a removal
0.5 to 36 kB — and the replacement's size tracks what survives, so it does not
fall as the working set settles. Two shrinks land per page turn.
