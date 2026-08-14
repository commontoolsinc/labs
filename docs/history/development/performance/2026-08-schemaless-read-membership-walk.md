---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Investigation of the schemaless fresh-transaction read regression, traced to the fabric membership walk on the storage read path."
---

# What a schemaless read was spending its time on, August 2026

## Result

Two benchmark files stepped together on one run of the `Benchmarks` workflow,
on 29 or 30 July 2026 depending on the processor.

`packages/runner/test/cell-set-flat-index-list.bench.ts`, the
`flat list read - fresh-tx schemaless get()` group:

| Benchmark | Step |
| --- | ---: |
| 3000 items | 2.14 to 2.69 times |
| 1000 items | 2.34 to 3.10 times |
| 100 items | 1.29 to 1.53 times |

The range in each row is across the three processors the workflow's runner
group draws from. On the AMD EPYC 7763 the 3000-item case went from about
2.5 ms to about 5.8 ms.

`packages/runner/test/cell-schema-read-depth.bench.ts`, the benchmark named
`schema read depth - schemaless - fresh-tx get() (1000 items)`: 2.19 to 2.63
times on each of the three processors with enough runs to say, and about
1.1 ms to about 3.0 ms on the AMD EPYC 7763.

Both are the same measurement of the same thing: one whole-array `get()` of a
stored list, through a cell with no schema, in a transaction that has not read
it before. Neither bench file changed over the range, so both are real moves
in the code being measured.

The commit behind the step is `9212d6550`,
[#5191](https://github.com/commontoolsinc/labs/pull/5191), `Reject
unrepresentable keys on plain objects`. It gave the plain-object arm of
`isFabricValue()` a check on the shape of the object's keys, and a schemaless
whole-array read runs `isFabricValue()` over every record in the list.

## Where a schemaless read spends its time

`Cell.get()` on a schemaless cell reads the document once and wraps it in a
query-result proxy. The read goes through `V2StorageTransaction.read()`, whose
last step is `freezeReadValue()`. That function called `cloneIfNecessary()`.

`cloneIfNecessary()` returns its input by identity when the input is already
in the frozen state the caller asked for. Its test for that,
`canReturnAsIs()`, asks `isDeepFrozenFabricValue()`, which asks two questions
in turn and answers true only when both do. The first is `isDeepFrozen()`,
which answers from a cache for anything it has seen and memoizes every subtree
it walks. The second is `isFabricValue()`, an uncached recursive membership
walk of the whole value, and that is where the time went.

Removing the second conjunct entirely, as a diagnostic, took the 1000-item
benchmark from about 600 µs to about 113 µs. The membership walk was about
four fifths of what the whole read cost.

Neither of the two caches the walk could have used ever helps here. The
objects a read walks are made by the storage layer as the document lands, not
by the write that produced the value. The check was instrumented to record
every object it saw before the read and to report how many it met again during
it: all 3000 objects the read walked were new to it. Memoizing the membership
proof for every subtree, rather than only for the root as
`isDeepFrozenFabricValue()` does, made the benchmark slower — about 1192 µs
against about 600 — because it added a `WeakSet` write per node to a walk
whose every lookup misses.

## What the step added

Bisecting the 18 commits in the range, three runs of the 1000-item benchmark
at each and the smallest per-iteration minimum of the three, in microseconds
and oldest first:

| Commit | µs | Commit | µs |
| --- | ---: | --- | ---: |
| `030668b61` | 472 | `78fa35f5c` | 440 |
| `19a1f28b6` | 487 | `ed5e6f33a` | 485 |
| `01677be37` | 458 | `b084955be` | 466 |
| `4fa2c826c` | 442 | `9d95830b4` | 493 |
| `c79adcd41` | 433 | `6f15d6bce` | 429 |
| `6ab07f6d9` | 472 | **`9212d6550`** | **705** |
| `fbdd14d3f` | 443 | `5d6da27d2` | 623 |
| `11981f9f9` | 443 | `d0ae7c4e2` | 797 |
| `85c16dd2a` | 418 | `7be2650c1` | 722 |
| `44f94ba99` | 449 | | |

Fifteen commits sit between 418 and 493, and the sixteenth is 705.

`fbdd14d3f` in that list is the roll from Deno 2.8.1 to 2.9.4, which is the
one change in the range that could move every benchmark at once. It does not
move this one. Running `030668b61`, the commit before the range, alternately
under each pinned version, three rounds of the 1000-item benchmark, gives
per-iteration minima of 826, 798 and 753 µs under 2.8.1 against 771, 834 and
693 µs under 2.9.4.

Timing `isFabricValue()` on its own, over the 1000-record tree the benchmark
materializes, alternating between the two trees so machine drift cannot favour
either:

| Tree | Minimum of 200 calls |
| --- | ---: |
| before the step | 0.267, 0.276, 0.267 ms |
| after the step | 0.515, 0.524, 0.509 ms |

The check the step added tests the shape of every plain object's keys.
`isFabricValue()`'s plain-object arm had been a prototype comparison followed
by a walk of `Object.keys()`. The step added a call to
`isPlainObjectWithOnlyEnumerableStringKeys()`, which compared the length of
`Reflect.ownKeys()` against the length of `Object.keys()`. That function has
since become `isInertPlainObject()`, which asks three narrower key questions
instead of the one broad one, and also takes a property descriptor for each
key so that an accessor is rejected along with an unrepresentable key.

Costs of each part of the version on `main`, over the 2000 plain objects that
tree holds, smallest of 300 rounds:

| Cumulative check | Cost |
| --- | ---: |
| prototype comparison | 0.022 ms |
| plus `Object.keys()` — what the arm did before the step | 0.038 ms |
| plus `Object.getOwnPropertyNames()` | 0.052 ms |
| plus `Object.getOwnPropertySymbols()` | 0.093 ms |
| plus a descriptor per key | 0.232 ms |
| plus the reserved-name test and the walk's own key read | 0.340 ms |

The descriptor read is the largest single part and it cannot be dropped: a
descriptor is the only thing in the language that answers whether a property
holds data or an accessor, and inertness turns on that question.
[`2026-08-fabric-value-validation-cost.md`](2026-08-fabric-value-validation-cost.md)
established that already, along with the finding that the three narrow key
reads beat the one `Reflect.ownKeys()` call the step originally used, which is
why `main` today reads 548 µs where `9212d6550` read 705.

## Fix

`freezeReadValue()` asks the question it has. What it owes its caller is a
value that later writes cannot change underneath it, and `isDeepFrozen()`
answers exactly that: a deep-frozen value goes back by identity, and anything
else goes to `cloneIfNecessary()` as before. The membership half of
`cloneIfNecessary()`'s own identity test is not a question the read path has.
The write paths in the same file hand every value to `cloneIfNecessary()`
themselves, which either accepts it as a deep-frozen `FabricValue` or rebuilds
it as one, so what the replica holds is a `FabricValue` before any read looks
at it.

Interleaved between three trees, the per-iteration minimum in microseconds for
three of the benchmarks that stepped, four rounds of the first and three of the
others:

| Tree | `flat list read`, 1000 items |
| --- | --- |
| before the step (`030668b61`) | 848, 712, 665, 684 |
| `main` (`65d34e146`) | 676, 780, 541, 641 |
| with the fix | 94, 97, 87, 98 |

| Tree | `schema read depth`, 1000 items |
| --- | --- |
| before the step (`030668b61`) | 546, 554, 584 |
| `main` (`65d34e146`) | 569, 559, 741 |
| with the fix | 97, 110, 132 |

| Tree | `flat list read`, 3000 items |
| --- | --- |
| `main` (`65d34e146`) | 1908, 1909, 1839 |
| with the fix | 125, 128, 120 |

Those runs were taken while the machine was loaded, which is why the first two
rows of the first two tables overlap where the bisect above separates them
cleanly. The last row of each does not depend on separating them.

With the walk gone, a 3000-item read costs barely more than a 1000-item one.
On `main` the 3000-item benchmark costs about fifteen times what it costs with
the fix. What is left on the read path is the `isDeepFrozen()` walk, which
memoizes every subtree it proves.

## What the test pins

A whole-list read now takes a fixed number of property descriptors rather than
one per own property of every record.
`packages/runner/test/v2-transaction.test.ts` reads a 20-record list and a
200-record list and counts the descriptors each read takes: 80 and 800 before
the fix, 0 and 0 after. The test asserts the two
counts are equal and that both are smaller than the shorter list, so neither a
count that grows nor a count that grows slowly passes it. A second test holds
the read to still returning a deep-frozen value, which is what the count must
not be bought with.

## The memory benchmark at the same boundary

`packages/memory/test/v2-entity-id-list.bench.ts`'s `current live-1k-small`
stepped in the same commit range, and the cause above does not explain it. It
runs `listEntityIds()` against a prepared SQLite database and touches no
data-model code at all. Measured across the range, twice at each commit, the
per-iteration minimum of each run in microseconds:

| Commit | Runs |
| --- | --- |
| `030668b61` | 109, 121 |
| `6f15d6bce` | 121, 120 |
| `9212d6550` | 115, 135 |
| `5d6da27d2` | 129, 110 |
| `7be2650c1` | 103, 113 |
| `65d34e146` (`main`) | 128, 127 |

No step reproduces, at `9212d6550` or anywhere else in the range. Whatever
moved that benchmark is still to be found, and it is not this.
