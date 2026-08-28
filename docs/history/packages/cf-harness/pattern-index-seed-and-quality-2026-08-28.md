---
status: historical
created: 2026-08-28
archived: 2026-08-28
reason: "Report on a completed pass: seeding the pattern index with curated atoms, gardening its corpus, and giving its publish path a rendering gate."
---

# Seeding and gardening the pattern index, August 2026

A record of one evening's pass over the pattern index feedback loop — the
Firestore-backed catalog of Common Fabric patterns that cf-harness publishes to
and searches. The pass had one goal: make the corpus something composition can
draw on, and make the loop able to tell a working pattern from a broken one.

For how the loop works now, read the live documents:
[`docs/pattern-index-measurement.md`](../../../../packages/cf-harness/docs/pattern-index-measurement.md)
for how a measurement run is conducted, and the `pattern-index` repository's
`ONBOARDING.md` and `docs/gardening.md` for the index service itself.

## What the corpus looked like going in

29 entries. Two carried a positive quality score; the rest sat at zero or
below. Reading all 29 programs — rather than their metadata — found three
distinct problems.

**About a third were near-duplicates**, because a `pattern-author` child that
iterates published one entry per successful `run_pattern` rather than one per
session: four "Child interactive packing list app test", three grocery
checklists, three doublers, two reading lists, two sortable tables.

**Descriptions did not describe the programs.** Search ranks on description, so
this is the more damaging of the two:

| id | description says | source actually is |
|---|---|---|
| `JUHPJFzz…` | grocery checklist, quantities, remaining counter | a counter button (287 B) |
| `lKwZG1Z5…` | grocery checklist, quantities, remaining count | a doubler button (268 B) |
| `A1nMYjX3…` | reading list: title entry, toggles, finished/unread counts | no UI at all; returns `total` (232 B) |
| `unUSV9vN…`, `6aOfqRGP…`, `POygPwCF…` | "packing list app" | `computed(() => 2)` and `computed(() => items.length)` |
| `smoketest…001` | doubles a number | never imports `pattern`; could not compile |

A model searching "grocery checklist", finding `JUHPJFzz…` and running it gets
a counter — and no rendering check catches that, because the counter renders
perfectly well.

**Both sortable tables rendered every cell as `[object Object]`**, from
`String(row[column])` indexing a reactive row by a reactive key. One ranked
first for its query, and `lcGr-KTV…` imported one of them, so the defect had
already propagated across a composition edge.

## The composition graph, mapped for the first time

Four edges across 29 entries — and two of the four were aliases rather than
composition:

| importer | dependency | kind |
|---|---|---|
| `xZbe3l…` | `FgL8kX…` | bare re-export |
| `sS8nqs…` | `9lNyUb…` | near-alias (quadrupler over doubler) |
| `AgaGn7…` | `fJFEm…` | real composition (three dice plus a total) |
| `lcGr…` | `HOS6wW…` | real composition (expense summary over a sortable table) |

`xZbe3l…` was two lines — `import PackingList from "cf:pattern:FgL8kX…";
export default PackingList;` — re-exporting a fixture that had been thumbed
down, and outranking its own source by three points. Quality signal does not
cross a composition edge in either direction: a negative judgement does not
reach an alias, and a good atom earns nothing from what composes it.

## What the pass changed

**A curated seed.** Six parameterized atoms — Counter, CheckList,
SortableTable, AmountLedger, DiceRoller, OptionPicker — authored fresh in
current idiom and published discoverable. They were chosen against demand read
out of the corpus itself: every shape the 29 entries had rebuilt from scratch.
Two candidates proposed on evidence were cut on a different bar, expense to
rebuild: a component whose whole body is four lines of `computed` will not be
adopted however well evidenced its demand, because rebuilding it is cheaper
than importing it.

The seed was *not* taken from the `MODULE_METADATA` components in
`packages/patterns`. Those are tiered **legacy** in
[`packages/patterns/index.md`](../../../../packages/patterns/index.md) — "a
parallel composition system; do not copy it" — and seeding them would have made
the index's exemplary building blocks a set the repository tells authors not to
imitate.

**Discoverability split from publication.** An entry can now be recorded in
full — `getPattern` answers it, `cf:pattern:` resolves it — while being absent
from search. Publishing and surfacing had been the same act.

**A rendering gate on the publish path.** A second, detached probe instance of
the compiled pattern is built from a synthetic instance of its own
`argumentSchema` and rendered host-side through the same reconciler and
applicator pair a browser mounts. Output carrying a default-`toString` marker
is recorded non-discoverable rather than refused, so nothing is lost and a
wrong call costs a field flip.

Two defects in that generator were invisible to inspection and surfaced only by
running it against the live broken table's real schema: honoring `default: []`
builds a table with no rows, which renders cleanly and passes; and drawing row
keys and column strings from two vocabularies makes every lookup miss, which
renders empty cells and also passes. Both would have shipped a gate that passes
the exact pattern it exists to catch.

**Gardening.** 16 of the 29 entries hidden from discovery, none deleted, each
carrying a stored reason. `getPattern` returns all 16 byte-for-byte unchanged
and all four composition edges still resolve — verified against the deployed
service, including by hiding a dependency while leaving its importer
discoverable and confirming the importer's closure still resolved.

## Corpus after the pass

36 entries: 19 discoverable, 17 withheld. Two `proven`, 17 `unproven` among the
discoverable set. The seeded atoms sit in `unproven` — demoted in ranking,
never excluded, which is the intended treatment of an entry with no evidence
either way.

The query that had returned two `[object Object]` tables:

```
"sortable table rows columns click header to sort"   candidates 36
  7/8  1iaNBnIV…  Renders rows in a table and sorts them when a column header is clicked…
  6/8  wwVyvVWD…  Shows fixed monthly expenses in a polished USD table…
```

## Measurement corrections

Three counts reported during the preceding phase were wrong, all in the same
direction, and none because of a defect in the tooling:

- **"Zero empty searches across the six post-fix runs."** There was one. The
  extraction script printed it (`[child:1] search 'sortable table component
  columns rows' -> 0 hits`, run `cfc6cc76`) and it was lost summing per-run
  totals by eye. The corrected figures: 10 searches, 9 with hits, one empty,
  none refused — against 46 searches, 33 empty and 8 refused across the twelve
  runs of the preceding day. The empty rate fell from roughly 72% to 10%, which
  is the finding; "zero" was not.
- **"Eight refusals"** read as a background rate. All eight belong to one run
  family (`a2e29091`) where the index answered `403: DID is not allowlisted` to
  every query. The index was never consulted, and a total authorization failure
  recorded as an empty corpus.
- **"`read_skill_resource` 20 for 20"** counted calls where the interesting
  number was results: all 20 returned `status: "error"` with
  `skill_registry_missing`. The conclusion it was offered for still holds on
  different evidence — skill registries are present on exactly the 14 post-fix
  run directories, and all 20 failing calls came from runs predating that fix.

A fourth, found by review of the new extractor: `assign_slug` refusals counted
as assignments, so a reported 17 slugs was 13 assigned and 4 refused.

Each of these passed inspection and failed only when someone re-derived it from
the raw data. Each is now pinned by a test.

## What this pass did not establish

- **That any of it makes composition happen.** Seeding made the parts
  findable, gardening made the corpus honest, and the gate made publication
  conditional. None of that makes importing cheaper than writing, which is the
  thing that decides whether a session composes. The strong form of that
  experiment had already been run: a parameterized sortable table, ranked
  first, with its import specifier attached to the search hit, and the session
  rebuilt it from scratch anyway. A later measurement showing better search
  hits and a little more reuse-by-id, with composition still at zero, is that
  same result and not evidence of progress on it.

- **That an entry is what it claims to be.** The rendering gate certifies that
  a pattern produced a non-empty DOM containing no default-`toString` marker,
  for one synthetic instance of its declared argument schema. It cannot
  certify that a program matches its description, and search ranks on
  description.
- **That a person found any of this useful.** Every event the index holds was
  emitted by the harness about its own run. `record_feedback` has never been
  called, so the thumbs weights are inert, and "unproven" means no evidence
  rather than unpopular.
- **Rendering, for eight of the sixteen hidden entries.** They were hidden on a
  structural or rendering claim read from source rather than observed. This is
  disclosed in the index repository's `docs/gardening.md`; nothing was deleted,
  and reversing a wrong call costs one API call.

## The failure this pass kept finding, including in itself

One shape recurred often enough during the pass to be worth stating on its own,
because the corpus defect and the tooling defects turned out to be the same
thing:

> A check that does no work reports the same thing as a check that ran and
> found nothing. Only a case where you already know the answer separates them.

Every instance below passed inspection first, and each was caught by
re-deriving a result from its source rather than by reading the code that
produced it.

- A search that returned `403: DID is not allowlisted` counted as a search that
  returned no results, so a run family that never reached the index at all
  recorded as an empty corpus.
- Twenty `read_skill_resource` calls that all returned
  `skill_registry_missing` were counted as twenty successful reads, which
  inverted the health of the one input surface that was working.
- A composition proof run in the space that already held its dependencies
  returned `materialized: []`: three ids requested, zero fetched, everything
  rendering, nothing exercised.
- The rendering gate tested for `$UI` on an unschema'd read, which does not
  follow the link that reaches it, so twenty of twenty-four patterns recorded
  as "nothing to check" while the run looked like a pass.
- A blanket `catch` in that same gate converted a defect in its own code into
  the gate's ordinary "probe failed" outcome.
- A test asserting only a refusal's header — printed for every refusal — stayed
  green while the code beneath it was failing for an unrelated reason. It was
  written to satisfy a coverage gate, which is the pressure that produces
  exactly this.
- One reported figure ("no empty searches across six runs") was contradicted by
  the tool's own printed output, and lost in a total summed by eye.
- The sandbox transport guard checked that two directories were *named* in a
  runtime's configuration, never that the runtime read them, and then reported
  `invocationContextTransport: "sidecar"` into the run's policy snapshot on the
  strength of that name. A test asserted the same claim from a bare
  configuration with no runtime present, so the behavior was pinned rather than
  merely unnoticed.

The seeded atoms mattered here beyond the corpus. The rendering gate's
`no-ui` result had an alibi: the pre-existing corpus genuinely is full of
entries with no meaningful UI, so "nothing to check" was a plausible reading of
real data. A set of entries whose UI is known to work removed that alibi. The
same is true of the composition proof: only a space known not to hold the
dependencies could distinguish a fetch that succeeded from a fetch that never
ran.

The practical rule this leaves: when a check reports an absence, establish that
the check would have reported a presence. That takes a case whose answer is
known independently, which is a different and more expensive thing than a test
that passes.

## Conditions worth knowing about the environment of this pass

- The local toolshed serving `:8000` was running a commit that is not an
  ancestor of `main`, from a different working tree, having been started the
  previous day. A live `computed:` entity-id error against it was cleared as an
  environment fault only by standing up a matched server and reproducing there.
- A toolshed reporting `cfcFlowLabels: "off"` over `/api/meta` is not a
  misconfiguration: that is the core default, and `MAX_ENFORCEMENT_CFC_OPTIONS`
  is applied by the `remoteClient` and `browserWorker` presets — which is what
  cf-harness's fabric session uses. The console's posture line describes its own
  runtime; `/api/meta` describes the server's. Two presets, not a contradiction.
- Across 44 console runs, all 38 `bash` calls were denied for want of trusted
  CFC mediation metadata, and `read_file` never once returned a file. A child's
  read-and-inspect fallback was unavailable for the whole corpus.
- The `pattern-index` repository has no continuous integration. Nothing runs on
  a pull request or on merge there.

## Open work

CT-2107 (an entry is not certified to be what it claims), CT-2109 (no signal
that a person opened a pattern), CT-2114 (quality signal does not cross a
composition edge), CT-2115 (what earns discoverability, and what search should
answer when a query matches only withheld entries), CT-2116 (invocation-context
files written and never read, so input labels were dropped while enforcement
was reported), and CT-2105 (bash observation denials).
