---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Investigation of the tenfold step in the immutable-cell storage-manager benchmark, and what the fix for it left unguarded."
---

# What made constructing a storage manager ten times slower, August 2026

## Result

The benchmark `Immutable cell - storage manager setup and cleanup only`, in
`packages/runner/test/cell-immutable.bench.ts`, rose about tenfold between the
benchmark runs for `ae805e236` and `de7465bb3` on 3 and 4 August 2026. It is
the largest single step in the window the dashboard's benchmark headline was
decomposed over, recorded in
[`2026-08-benchmark-headline-decomposition.md`](2026-08-benchmark-headline-decomposition.md).

Each row below is the nearest benchmark run either side of the boundary on
that processor. The runners take turns, so the two runs in a row are days
apart on the thinner lines.

| Processor | Before | After |
| --- | ---: | ---: |
| AMD EPYC 7763 | 1.34 µs | 10.83 µs |
| AMD EPYC 9V74 | 1.35 µs | 10.51 µs |
| Intel Xeon Platinum 8573C | 0.79 µs | 7.78 µs |

The cause is [#5173](https://github.com/commontoolsinc/labs/pull/5173),
`fix(storage): keep the first accepted space host route`, which is `87beb5f78`
and the fourth of the twenty commits in that range. The commit named as the
first suspect, `de7465bb3`, is the twentieth, and is not involved.

The regression was already fixed on `main` when this investigation ran, by
[#5428](https://github.com/commontoolsinc/labs/pull/5428), `perf(runner):
resolve the default storage route when it is read`, which is `09970c125` and
landed on 6 August 2026. Nothing pinned the behavior that fix restored, and
that is what this change adds.

## What the benchmark actually exercises

Its name overstates it. The body constructs an emulated storage manager and
closes it:

```ts
const storageManager = StorageManager.emulate({ as: signer });
await storageManager.close();
```

`close()` returns immediately when the manager holds no providers, and this
manager never opens one. The emulated memory server is built on first use by
the session factory, so it is never built either, and `EmulatedStorageManager.close()`
finds nothing to shut down. The benchmark therefore times the constructor and
nothing else.

That is why a tenfold rise here does not imply anything dramatic happened.
Constructing a manager costs about a microsecond, so a few microseconds of new
work in the constructor is a tenfold rise. It is also why the change that
touches the immutable-cell path was the wrong first suspect: no value walking
happens in this benchmark at all.

## Cause

`#5173` added this to the `StorageManager` constructor:

```ts
try {
  const resolveDefault = createStorageAddressResolver(options.memoryHost);
  this.#defaultStorageRoute = toWebSocketAddress(
    resolveDefault("did:key:route-comparison" as MemorySpace),
  ).toString();
} catch {
  // A custom session factory may use a non-network memoryHost placeholder.
}
```

The memory host is turned into the WebSocket storage endpoint that an
unseeded, unhinted space would open against. Doing that parses the host, joins
the storage path onto it, copies the result, parses that copy once more to
swap the scheme, and stringifies it. Four URL parses in all. The answer has
exactly one reader: the comparison in `registerSpaceHost()` that decides
whether a late host hint replaces the default route. Most managers never call
`registerSpaceHost()`, so for them the address was resolved and thrown away.

The emulated manager pays twice over. `EmulatedStorageManager.emulate()`
passes `memory://` as its memory host, a placeholder that exists only because
`Options` requires one; its sessions are loopback and resolve no address. The
resolver rejects that scheme, so every construction built a `TypeError`,
captured a stack trace for it, unwound two frames, and discarded it.

Measured on an Apple M5 Max, one run each of the benchmark on its own:

| Constructor | Time |
| --- | ---: |
| without the eager resolution | 463 ns |
| with it, against a host that resolves | 2.0 µs |
| with it, against the `memory://` placeholder | 4.9 µs |

So the URL work accounts for about a microsecond and a half, and the rejected
placeholder for about three more. For comparison, on the same machine,
building a `TypeError` and discarding it costs about 1.2 µs, and resolving a
host that parses costs about the same.

## How the commit was found

Each of the twenty-one commits from `ae805e236` through `de7465bb3` was
checked out in turn and measured with a bench file cut down to this one
benchmark, which takes under two seconds per commit. The step is a single
clean boundary:

```
a3dcbb28b       448 ns  test(memory): allow commit bursts before fan-out (#5292)
87beb5f78      4929 ns  fix(storage): keep the first accepted space host route (#5173)
7cc8a4077      5068 ns  feat(cli): toggle Markdown and test files in cf view (#5293)
```

Removing the eager resolution at `87beb5f78` and measuring again returned the
benchmark to 463 ns, which attributes the whole step to that block rather than
to anything else in the commit.

## The fix, and what it left unguarded

`#5428` moved the resolution into a private method that runs on the first read
and keeps its answer, and it holds the memory host as text so the answer comes
from the host the manager was constructed with. In the benchmark artifacts the
step disappears at the first run to carry it, on 6 August 2026 at 20:59 UTC:
the Intel Xeon Platinum 8573C reads 1.08 µs, against 7.76 µs in its previous
run, and the AMD EPYC 7763 reads 1.34 and 1.38 µs on 7 August against 11.42 µs
on 6 August. The one other run in that stretch, an Intel run 48 minutes after
the first recovered one, reads 1.91 µs off 36 iterations where the runs either
side of it get several hundred thousand, so it says nothing either way.
Running the benchmark locally at `ae805e236` and at `65d34e146`, alternating
between them so machine drift could not favour either side, gives 650, 696 and
717 nanoseconds against 681, 702 and 1132 — the level before the regression,
with no residue.

What `#5428` did not leave behind is anything that fails when the resolution
moves back into the constructor. It could not, through the ordinary surface:
the two shapes agree on every value they produce. Both compute the same route
from the same host, both swallow a resolution failure and leave the route
undefined, and both read the caller's host object exactly once — the eager
shape to parse it, the lazy shape to snapshot it as text. A test that counts
those reads passes either way, which is what the first attempt at this test
did.

What separates them is work rather than results, so the test counts the work.
It installs a `URL` subclass over the global for the duration of the
constructor call, counts the parses, and requires zero. The lazy shape parses
none; the eager shape parses four. The test then opens a provider and hints
the space at the default host, and requires the hint to read as a confirmation
that leaves the replica in place — a route that was never resolved would
compare unequal, and the hint would be taken as a replacement. That second
half is what keeps the test from passing on an implementation that deferred
the resolution by deleting it.

Verified in both directions: the test passes on `main`, and on `main` with the
production half of `#5428` reversed it fails with four parses where it wants
none.

## One thing found along the way, not changed here

This benchmark's name promises cleanup it does not measure, as described
above. Correcting the body would put a step into the series the dashboard
reads, and the series is what makes a regression like this visible in the
first place, so the name is left as it is. A benchmark that covers tearing
down a manager that has actually opened something would have to be a new
entry under its own name.
