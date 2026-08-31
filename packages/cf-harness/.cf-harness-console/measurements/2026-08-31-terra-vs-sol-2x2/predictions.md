# Terra vs. Sol, pre-registration

Written 2026-08-31 before any Phase 2 provider turn. This is a 2×2 comparison
of `gpt-5.6-terra` and `gpt-5.6-sol` under two console configurations. Each
cell runs the standing six-task suite for discovery/reuse and the four-task
composition suite for composition. A separate console and an admissibility
read occur before every batch.

## Fixed conditions and provenance

- Console source: `origin/main` at `5f406cd608e735ab39bec53b61559b287c26e3f6`
  (CT-2138 merge).
- Fabric: the brief's `http://127.0.0.1:8060` was checked before setup and had
  no listener. It is not substituted for or treated as a measurement server.
- Toolshed: this experiment deliberately starts an isolated current-main
  toolshed on `http://127.0.0.1:8061`. Its fresh store is the CT-2146 fork:
  it uses the same requested space name but initializes on demand, so it is a
  deliberate corpus fork rather than a continuation of any old server. Its
  `/api/meta` reports `gitSha`
  `5f406cd608e735ab39bec53b61559b287c26e3f6`, supplied through
  `TOOLSHED_GIT_SHA` for this raw source run. That is operator-supplied
  source-run metadata, not a build-time define; the value is nevertheless
  checked with `--expect-git-sha` on every batch.
- The V2 prompt is `parent-composition-prompt.txt`, copied byte-for-byte from
  `/Users/ben/.bb/worktrees/env_7qpzey268d/labs/packages/cf-harness/.cf-harness-console/measurements/2026-08-28-thread-i-incentive/parent-composition-prompt.txt`.
  SHA-256: `8397301c2d057d1c325164f30435fe382fec38781da6519673fe2ade3fadb219`.
  It is 13 lines; this artifact is now committed with this measurement.
- Publication regime: this is the first measurement after recorded-only
  publishing became the default (#6598). Searches are therefore expected **not**
  to see output from earlier cells; per-cell before/after corpus snapshots are
  still recorded rather than assumed equal.

## Variants

| Variant | Parent prompt | Child composition guidance | Flags |
| --- | --- | --- | --- |
| V0 | absent | default | none |
| V2 | copied historic prompt | withheld | `--system-prompt-file=parent-composition-prompt.txt --no-child-composition-guidance` |

The models are `gpt-5.6-terra` and `gpt-5.6-sol`, supplied explicitly with
`--model`. Every cell records console commit, fabric meta/git SHA, model,
flags, and index corpus readings before and after both batches.

## Predictions and falsifiers

| Cell | Prediction | Falsifier |
| --- | --- | --- |
| terra/V0 | Mostly source authoring, low spontaneous composition; by-id reuse may occur. | ≥2 distinct tasks import distinct atoms, or a task is answered whole. |
| terra/V2 | Parent guidance raises parent searches and reaches the composition bar. | Fewer than 2 distinct composing tasks/atoms. |
| sol/V0 | Sol may change authoring/error mix, but V0 remains below the composition bar. | ≥2 distinct composing tasks/atoms. |
| sol/V2 | Sol with V2 has at least as much composition as terra/V2, with fewer compile errors. | It misses the bar, or has more compile errors than terra/V2. |

The traps are fixed before results: `run_pattern` **by id is reuse, not
composition**. The composition bar is **at least two distinct tasks importing
distinct atoms**, and applies **only to composition-suite cells**; repeated
calls by one task do not clear it.

## Per-cell ledger

No cell has run. Before every batch this table receives the live admissibility
read and full provenance; after it, extractor counts (searches/hits,
`run_pattern` by id/source/composing, outcomes, distinct composing tasks) and
anomalies. A provider error stops the experiment; it is never retried.

| Cell | Suite | Admissibility / corpus before | Corpus after | Extractor counts / anomalies |
| --- | --- | --- | --- | --- |
| terra/V0 | standing six | not yet read | not yet read | not run |
| terra/V0 | composition four | not yet read | not yet read | not run |
| terra/V2 | standing six | not yet read | not yet read | not run |
| terra/V2 | composition four | not yet read | not yet read | not run |
| sol/V0 | standing six | not yet read | not yet read | not run |
| sol/V0 | composition four | not yet read | not yet read | not run |
| sol/V2 | standing six | not yet read | not yet read | not run |
| sol/V2 | composition four | not yet read | not yet read | not run |

## Amendment before the first provider turn: standing-suite purpose

The first admissibility read found whole answers for all six standing tasks.
That disqualifies them from composition measurement, but not from the other
half of this A/B: discovery and whole-reuse under the corpus's permanent
whole-answer condition. The cells are reinstated before any provider turn with
this purpose: searches per task, by-id rate, first-try success, source rebuilds
despite a whole answer, and compile-error burn. The known terra baseline is the
2026-08-29 V0 control: six of six by id, zero source, zero compile errors.

For standing-suite cells, Terra/V0 predicts that baseline shape; Sol cells
predict either the same shape or fewer searches/errors. A standing-suite cell
is falsified by source rebuilding of a whole-answered task, a lower by-id rate,
or greater search/error burn than the terra baseline. It is never scored
against the composition bar.

## Admissibility read, before the first provider turn

Read through the current-main console's read-only index proxy against the
deployed index. Every standing task has a single whole application in its
top-five result set. That is recorded as the condition of its reuse cells, not
as a composition claim.

| Whole-answered reuse-cell id | Answering pattern |
| --- | --- |
| `counter` | `U5g1VlAb1uFmmec7D-fzPXZy0erldi7inqmXN8j7Vi0` |
| `reading-list` | `FimzoBmTy8QTJQOjaKpsHPjmyMCUJFAGCXoO2vKJMDc` |
| `friends-birthdays` | `2QGxpAuh-TxmV1Em462NcFiWDa9AnBjrJpBZbSnmZS0` |
| `project-notes` | `GWkpTfEhKE5hScyU_ddiKVPmUlZw7xm5pbFyl6-yCDA` |
| `trip-timeline` | `2h0TVvTMdhGlcFhGubyLvQ1IZhSF5FS5QkgM10aQQTc` |
| `monthly-expenses` | `DWl3kXPQc1qRvGZaG_rkLEkpOuea6oh2k_CIm62Rf6c` |

The composition suite remains admissible in this read: `dice-tally`,
`party-prep`, `team-picker`, and `workout-streak` each have separate relevant
parts or only partial applications; no result answers the whole task. This
does not authorize a later batch without repeating the same read immediately
before it.
