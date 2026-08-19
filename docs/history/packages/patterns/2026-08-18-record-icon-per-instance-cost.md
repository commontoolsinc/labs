---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Investigation finding: the reported superlinear build cost for record-icon.tsx does not reproduce; the per-instance storage cost that does exist is measured here."
---

# What a second record-icon instance actually costs

`packages/patterns/record-icon.tsx` was reported to have a build cost that
grew faster than the number of instances, and was left out of
`packages/patterns/top-level-demos.test.tsx` for that reason. The reported
measurements, on an Apple-silicon Mac, were:

- one `RecordIcon` on its own: under one second;
- `RecordIcon` plus one other trivial pattern: about 33 seconds;
- two `RecordIcon` instances: about 137 seconds.

This document records what those numbers turned out to be, and the
per-instance cost that measurement found instead.

## The reported cost does not reproduce

The test used was the one the report gives:

```tsx
import { assert, pattern, TESTS } from "commonfabric";
import RecordIcon from "./record-icon.tsx";
export default pattern(() => {
  const a = RecordIcon({ icon: "X" });
  const b = RecordIcon({ icon: "Y" });
  return { [TESTS]: [{ assertion: assert(() => a != null && b != null) }] };
});
```

run as the report gives it:

```
deno run --allow-net --allow-ffi --allow-read --allow-write --allow-env \
  --allow-run packages/cli/mod.ts test --timeout 300000 \
  --root packages/patterns <the test file>
```

It takes under a second, on the same class of machine the report was made
on. Four tree states were measured, so that a fix landing in between could
be ruled out. Three are ancestors of `main`; the branch head is reachable
as `refs/pull/5982/head`, since the pull request was squashed:

| Tree state | One instance | Two instances |
| --- | --- | --- |
| `0d4bcfd85` (`main` when the measurements were taken) | 675 ms | 782 ms |
| `eff2cb07e` (#5982, where the report was made) | 698 ms | 820 ms |
| `23a0c7565` (#5982's branch head) | 689 ms | 755 ms |
| `d58f434e0` (before #5989, the nearest plausible fix) | 711 ms | 872 ms |

The larger case from the report behaves the same way. Running
`top-level-demos.test.tsx` five times with the module and five times
without, alternating, gives 3.46 to 4.70 seconds with it and 3.48 to 4.23
seconds without. The ranges overlap almost entirely, so what the module
costs is inside the run-to-run spread. The report had 34 seconds against
2.5. Adding a third,
fourth, eighth, thirty-second and sixty-fourth instance each costs between
55 and 76 milliseconds, so the growth is linear with a small constant and
nothing about the second instance is special.

The following were also measured and changed nothing: pattern coverage
collection (`--pattern-coverage-dir`), continuous UI mode
(`CF_TEST_CONTINUOUS_UI=1`), running the instances as separate test files in
one invocation rather than as one file, and each of
`EXPERIMENTAL_LAZY_MATERIALIZATION`, `EXPERIMENTAL_COMPUTED_CELL_IDS`,
`EXPERIMENTAL_MODERN_CELL_REP` and `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS`
flipped from its default.

So there is no superlinear build cost in the tree, and no mechanism was
found for the reported one. It is recorded here as unexplained rather than
as fixed.

## The cost that is real: 55 KB of durable state per instance

The report's first guess — that the emoji array is copied into storage per
instance rather than shared — is correct, and is worth recording on its own.

Measurement ran each pattern test against a file-backed store
(`openFileBackedRuntime` from
`packages/piece/test/state-continuity-harness.ts`, the same machinery the
pattern-vintage capture uses), then summed the JSON actually written:
`select sum(length(data)) from revision`.

| Instances | Durable bytes | Marginal |
| --- | --- | --- |
| 1 | 62,066 | — |
| 2 | 117,288 | 55,222 |
| 4 | 227,732 | 55,222 |

Each additional `RecordIcon` writes 55.2 KB. (The survey table below reads
55,479 for the same module, because its test also reads each instance's
rendered tree. The two are the same measurement over slightly different
tests, and they differ by 0.5%.)

The emoji list itself is 47,787 bytes of minified JSON (417 entries), so it
is 87% of that. A distinctive search alias from the list
(`"easter island"`) appears in the store exactly once per instance, and
each copy sits in a document with its own id:

```
n=1: of:fid1:jjfTyunRqsHSj1_HuOYTF8oIz4XKsYN7IQtwPgyfF7E
n=3: of:fid1:FN_vj_3JQV_e7q49d8sfQ3nwb8T9dI5Ta-LxgV6I_x8
     of:fid1:RzVnMrIbwjuiz7rfC36ScmS1gkbMmj3bSpGx6uUXIJ0
     of:fid1:9Jjdg5UjpWkHhBZqzLYphfcex-TRbOyyPwxu3OZYPh0
```

Three identical payloads, three ids, nothing deduplicating them. Breaking
one of those documents down by key: 50,586 of its 53,456 bytes are under
`value`, the instance's rendered `[UI]` tree, which carries the array
inline because `emoji-picker.tsx` passes it as a JSX prop
(`items={EMOJI_ITEMS}`).

Resident memory tells the same story: 64 instances reach 1,051 MB against
571 MB for 64 instances of a trivial pattern, about 7.5 MB more per
instance.

## Whether the shape bites elsewhere

Two questions were asked separately, and they have different answers.

**Does another pattern embed a large module-scope constant that reaches
storage?** One other does. Twelve module-scope object or array literals of
2 KB or more exist under `packages/patterns`, and `EMOJI_ITEMS` at 57 KB of
source is the largest by a factor of three and a half. The second is
`RESTRICTION_GROUPS` in `dietary-restrictions.tsx` at 16 KB, and it has the
same fate for a reason that a search of the source does not show: the
constant is never named in a JSX prop, but `buildAutocompleteItems()`
reshapes it in the pattern body and the result goes to
`items={autocompleteItems}` on the same `cf-autocomplete` the emoji picker
uses. That lands 41,898 bytes in each instance's document, and a
distinctive member string from the list (`"deli meats"`) appears in the
store once per instance, exactly as the emoji alias does.

So the test to apply is what reaches a component prop, not what the
constant literal is bound to. Of the other ten, the derived item lists are
small: `self.tsx` maps its prompts down to labels and ids, and the parking
coordinator's model list is the models for one make. The largest word list
in the package, Scrabble's dictionary of 178,691 words, is no longer a
module-scope constant at all: `scrabble.tsx` reads it through
`dataFile("words.txt")` and keeps it in a `Set` that only a function
consults, so it costs nothing durable and nothing at module scope either.

**Is `record-icon.tsx` unusually expensive per instance?** It is the most
expensive of the record modules, but not by the margin the emoji list
alone would suggest. Measuring the same way across them, and across the
picker one of them composes:

| Module | Durable bytes per instance |
| --- | --- |
| `record-icon.tsx` | 55,479 |
| `emoji-picker.tsx` | 51,640 |
| `dietary-restrictions.tsx` | 47,615 |
| `relationship.tsx` | 35,471 |
| `custom-field.tsx` | 18,692 |
| `giftprefs.tsx` | 12,431 |
| `birthday.tsx` | 9,335 |
| `social.tsx` | 6,549 |
| `gender.tsx` | 5,121 |
| `status.tsx` | 4,202 |
| a trivial one-element pattern | 2,300 |

The top three are the two patterns that hand a large list to
`cf-autocomplete` and the picker one of them composes. Below them,
`relationship.tsx` costs 35 KB an instance with no large constant at all,
and its bulk is spread over many more documents (156 revision rows against
record-icon's 68, for three instances) because its view tree is larger.
What every row of that table has in common is that an instance stores its
whole rendered view tree, which is a property of the runtime rather than of
any one pattern.

So the framing "a pattern that embeds a large module-scope constant" picks
out `record-icon.tsx` and `dietary-restrictions.tsx`, and it does pick the
expensive ones. But the framing does not explain the whole cost: strip the
list out of record-icon and 7.7 KB an instance remains, which is more than
`custom-field.tsx` spends in total, and `relationship.tsx` spends four
times that with no constant to blame.

## What was changed

`record-icon.tsx` was added to `top-level-demos.test.tsx`, which was what
the reported cost had blocked. The test's running time does not move
outside its own run-to-run spread.

Reading the module's name from a test needed `RecordIconModule` to declare
what it returns. It declared its input shape as its output, so `[NAME]` was
absent from its type even though it returns a name, and the transformer
refuses the double cast that would have worked around that. It now declares
a `RecordIconModuleOutput` carrying `[NAME]` as a string and the `icon`
field.

`[UI]` is deliberately left out of that interface, and the reason is worth
recording because it is not obvious. A result schema that names `$UI` is
one the runner takes as already covering the view tree, so it skips the
pre-sync in `packages/runner/src/runner.ts` — the branch under the comment
beginning "If the result has a UI and it wasn't already included in the
result schema" — that exists to stop the view flashing and losing a write
on resume. Declaring `[UI]: unknown`
gets the worst of both: the branch is skipped, and an `unknown` schema
descends into nothing, so the tree is not synced by the declared schema
either. Declaring `[UI]: VNode` does not work at all here — the module
returns a composed sub-pattern rather than a bare view node, so validating
it against the recursive `VNode` schema yields nothing and the field reads
back undefined. Omitting the key leaves the pre-sync in place and leaves
the runtime's own check of `[UI]` at the return position, which is where
the shape is enforced whether or not the output type lists it.

Declaring `[NAME]` changes the module's result schema, so a new baseline is
recorded and `deno task pattern-compat` proves the new contract applies
over the old one. That is compatibility, not rollout: the automatic
updater at `packages/runner/src/pattern-updater.ts:544-561` compares the
two result schemas with `deepEqual` and declines any source update that
changes either schema, logging `incompatible-source-update`. A running
record-icon piece therefore stays on the source it has until something
re-points it, which is true of every contract change and is why
`record.tsx` carries three baselines of its own.

Ten other patterns in the package were in that state while this was being
measured, and have since been repaired the other way, by #6019 and #6098:
each declares the screen it builds as the `VNode` it is, and a new
transformer diagnostic, `pattern-result:opaque-reserved-key`, refuses
`unknown` under a reserved key at the root of a result so the shape cannot
recur. One `[UI]: unknown` survives on purpose, and it is on the argument
side rather than the result side — the `BackwardsCompatibleProfile` seam in
`system/profile-home.tsx`, which has to keep accepting stored pieces of
every vintage.

That repair and this one agree on the diagnosis and differ on the remedy,
because the two cases differ. A pattern that builds its own tree can name
it `VNode`, which both satisfies the new rule and covers the tree for the
pre-sync. A pattern whose `[UI]` holds a composed sub-piece, as
`record-icon.tsx` does, has no such type available — `VNode` reads back
undefined, measured — and the rule permits omission, which is what it does.
`docs/history/development/pattern-typecheck-standalone-2026-08-14.md`
reaches the same key from a third direction, as a type-level
under-specification the standalone check catches, and records that
tightening one to `VNode` broke the pattern-update gate.

The 55 KB per instance was not addressed. Removing it means either a
runtime that stores one copy of an immutable value referenced from many
instances, or a `cf-autocomplete` contract that does not require the full
item list to be part of each instance's view tree. Both are design
decisions rather than repairs.
