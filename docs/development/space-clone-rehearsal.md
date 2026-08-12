# Rehearsing a pattern update on a space clone

Updating a deployed pattern on a populated space is a rehearsal-grade event.
This is the procedure: make a writable copy of the real space, run the update
against it, judge whether content survived, reset, repeat — then do it for real.

The reasoning behind each decision (why clones keep the source DID, why
generated cells are excluded from the fingerprint, what was deliberately not
built) is in [`../plans/space-clone-rehearsal.md`](../plans/space-clone-rehearsal.md).
This document is the operating procedure.

## When a rehearsal is required

Required when updating a **populated** space and any of:

- the compat checker fails, or the update needs
  `--dangerously-allow-incompatible-schema`;
- the update changes a **result** schema a parent or sibling piece reads. This
  is the "Topics (0)" failure from the 2026-07-10 board outage: old-generation
  results lacking new fields make the *whole array* read empty, silently;
- more than one pattern generation is live in the space;
- the target is a board or collection whose children are separate pieces —
  children and parent migrate separately and can disagree mid-flight.

Not required for additive input fields with defaults, UI-only changes, or work
on a fresh/scratch space.

## Getting a snapshot

The dump endpoint is deliberately off in production, and a whole-space dump is
the entire contents of a space — a confidentiality decision, not an ergonomics
one. So acquisition is manual:

```bash
# On the server, against the live store. VACUUM INTO never mutates the source
# and emits one consistent file with no -wal/-shm companions.
sqlite3 <store>/engine-v3/engine-v3/<did>.sqlite "VACUUM INTO '/tmp/<did>.sqlite'"
# then copy it down (scp, or upload once and share the URL with the team)
```

Sharing **one** snapshot across operators is better hygiene than each taking
their own: identical baselines make fingerprints comparable between people.

On a staging host with `MEMORY_DUMP_ENABLED`, `cf inspect pull --remote <url>`
does this for you.

## The loop

```bash
# 1. Clone. --from takes a path, or an https URL (plaintext http is refused
#    outside loopback: a snapshot is the whole contents of the space).
deno task cf space clone <space-did> --from <snapshot> --to ~/clones/<name>
```

`clone` prints the exact serve command and the **working database path**. Keep
that path: every offline read below takes it explicitly, because the clone keeps
the source space's DID and lives outside the directories `cf inspect` searches.
Naming the space instead would resolve to whichever same-DID store discovery
happens to find — usually this checkout's `cache/memory`, silently.

```bash
CLONE=~/clones/<name>
DB=$CLONE/engine-v3/engine-v3/<space-did>.sqlite

# 2. Serve it. The clone keeps the source space's DID, so the host and port are
#    the ONLY things distinguishing it from production — HOST pins it to
#    loopback (the toolshed otherwise binds 0.0.0.0, putting a second store
#    answering to production's identity on the network).
HOST=127.0.0.1 MEMORY_DIR="file://$CLONE/" \
  ./scripts/start-local-dev.sh --port-offset 10
```

The toolshed prints a `SERVING A REHEARSAL CLONE` banner at startup. If you do
not see it, you are pointed at something else — stop and check before writing.

```bash
# 3. Baseline, before touching anything.
deno task cf space verify $CLONE
deno task cf inspect churn $DB --bucket 60 --until "$(date -u '+%Y-%m-%d %H:%M:%S')"

# 4. Run every authored test locally. Then update against the CLONE's api-url
#    once, with one --test flag per entry. Children first, board last, serially
#    — the parent's result recomputation is what storms.
deno task cf test <pattern.test.tsx>
deno task cf test <pattern.integration.test.tsx>
deno task cf piece setsrc <pattern.tsx> \
  --test <pattern.test.tsx> \
  --test <pattern.integration.test.tsx> \
  --api-url http://localhost:8010 …

# 5. Judge it. --expect-migration gates on removal, not on change.
deno task cf space verify $CLONE --expect-migration
deno task cf inspect churn $DB --bucket 60 \
  --since '<when you started>' --until "$(date -u '+%Y-%m-%d %H:%M:%S')"

# 6. Reset and go again. STOP THE SERVER FIRST — see below.
./scripts/stop-local-dev.sh --port-offset 10
deno task cf space reset $CLONE
```

Add one `cf test` command and one `--test` flag for every authored test entry.
Run `setsrc` once per piece with the complete flag set. Deployment packages and
type-checks the tests but does not run them.

### Stop the server before resetting

Not a tidiness rule. Unlinking a file does not reach a process that already has
it open: a running toolshed keeps reading and writing the *unlinked* database
while every new reader — including the `verify` that `cf space reset` runs
immediately afterwards — sees the restored one. Pass two would run against pass
one's state while `cf space verify` reported the clone pristine, which is
exactly what the two-pass procedure exists to rule out.

`cf space reset` refuses while anything still holds the working copy, so
forgetting is loud rather than silent. Treat that as a tripwire, not a
guarantee: it cannot stop a server that opens the store in the instant between
the check and the restore, and no external check can. **Stopping the server is
what makes the reset correct.** Restart it (step 2) before the next pass.

## Reading the verdict

`cf space verify` compares the working copy against the manifest written at
clone time:

- **`removed 0`** — the signal that matters most. Nothing was destroyed.

**Which verdict the exit code uses is your choice, because the tool cannot
infer it.** By default `cf space verify` is strict: *any* change exits nonzero,
which is right for checking a clone nobody has touched and for catching an
accidental clobber. After a migration, pass `--expect-migration`: results are
rewritten by design, so it gates on a corrupted baseline or removed entities
instead, and a two-pass rehearsal can actually be scripted.

Its blind spot is worth stating plainly: `--expect-migration` **cannot see a
clobber**, because overwriting authored content is a *change*, not a removal —
and nothing hash-shaped can tell a rewritten result from a destroyed body. That
is exactly why authored content is checked separately below, and why that check
is not optional.
- **`content CHANGED` with `removed 0`** — **the expected result of a
  successful migration.** A schema update rewrites every piece's result value,
  and results are part of the fingerprint, so it cannot match afterwards.
  Check that `changed` is confined to pieces and their derived cells (the
  per-kind tally shows this), then verify authored content separately — no
  whole-store fingerprint can tell you titles and bodies survived.
- **`removed` above zero** — durable content was destroyed. Stop and
  investigate before anything else.
- **`content unchanged`** — nothing moved at all. Correct for a clone that has
  not been migrated yet; suspicious after one that has.
- **`baseline CORRUPTED`** — the pristine snapshot no longer matches the
  manifest. Do not reset to it; re-clone.

If `verify` reports entities it **could not hash** or ids it calls **ambiguous**,
those are absent from the verdict — it is speaking for less than the whole
store, and how much less is the number it printed.

Per-entity hashes, when you need to see exactly which entities moved:

```bash
deno task cf space fingerprint $DB --per-entity
```

### Checking authored content — the step that is not optional

`--expect-migration` **cannot** do this, and no whole-store hash can: overwriting
a title is a *change*, indistinguishable from the result rewrite every successful
migration performs. So compare the authored cells directly, pristine against
working. They are the same fingerprint, restricted to the entities you authored:

```bash
PRISTINE=$CLONE/pristine/<space-did>.sqlite

# Every entity hash on each side, generated cells excluded (--json always
# carries the per-entity list).
deno task cf space fingerprint $PRISTINE --json > /tmp/before.json
deno task cf space fingerprint $DB       --json > /tmp/after.json

# The entities that changed, by kind — the list `verify` only counts.
jq -r --slurpfile b /tmp/before.json '
  ($b[0].perEntity | map({key: (.id+" "+.scope), value: .hash}) | from_entries) as $was
  | .perEntity[] | select($was[.id+" "+.scope] != null and $was[.id+" "+.scope] != .hash)
  | "\(.kind)\t\(.id)"' /tmp/after.json | sort | uniq -c
```

A piece's **argument** cell holds what a human typed; its **result** and owned
cells hold what the pattern computed. A migration rewrites the second group and
leaves the first byte-identical, so the reading is:

- `owned-cell` — expected. The migration doing its job.
- `free-cell` — **investigate.** Argument cells are not owned by a piece and
  land here, so a changed one is a clobber rather than a migration.

Resolve which entity is a given piece's argument with:

```bash
deno task cf inspect piece $DB <piece-fid>    # prints `input:` and `result:`
```

Worked example, on a clone where one authored input was overwritten and one
derived cell legitimately migrated:

```
$ cf space verify $CLONE --expect-migration   # exit 0 — it cannot see this
$ …the jq above…
   1 free-cell   of:input       ← the clobber
   1 owned-cell  of:named       ← the migration
```

For a board of like-shaped children, the cheap version is a count and a spot
check: every child still present, comment and link totals unchanged, and two or
three bodies read back in full — including one with Markdown, since trimming is
the failure that hides best.

Compiler-generated internal cells are excluded by default, because a pattern
update rotates their identities on purpose. Including them (`--include-generated`)
answers "what moved at all?", never "did content survive?".

`cf inspect churn` reports rates and never judges them. What you are looking for
is the storm shape: a jump to a **sustained plateau**, not a spike. The July 2026
incident ran at ~1,300 commits/minute for twenty minutes. A settle means the rate
returns to baseline *and stays there*.

Pass `--until` with the moment you stopped watching, as the loop above does.
Without it the curve ends at the last write, which for a storm that has just
stopped is its busiest bucket — so it can show a storm but never a settle. With
it, the trailing quiet minutes are reported, and the footer prints `last commit`
against `observed through`: the gap between them is the evidence. A mistyped
bound is refused rather than silently matching no commits, which would otherwise
report the window as quiet.

## Driving the migration

Migrate serially, and make the driver **fail loudly when the server goes away**.
In the first real rehearsal the toolshed wedged under memory pressure and every
subsequent `setsrc` hung: no error, no log line, no progress — an operator
watching a frozen log with no signal, mid-migration.

Do **not** implement that check as a wall-clock probe. The same rehearsal showed
`/api/meta` intermittently taking over 60 s while the server was healthy and
still completing writes, so a `curl --max-time 15` liveness check would abort a
working migration. Prefer a state check that carries no timing assumption —
whether the server process is still alive — or classify *after* a failure
rather than probing before every write.

Budget resources before starting: serving a 1 GB store while compiling and
deploying 74 patterns exhausted a laptop's memory and pushed swap to 95%, which
is what wedged the server. Migrations survive it (the clone is durable and
already-migrated pieces stay migrated), but the run stops.

## Things that will mislead you

These are all failures that actually happened, not hypotheticals:

- **A cold browser load takes ~20 s.** A production attempt was rolled back on
  this false negative. Wait before concluding the board is broken.
- **An unstepped CLI read of a computed result looks empty.** Use `--input` for
  what durably committed and `--step` for computed results. An empty
  `index --step` next to a non-empty `topics --input` is a
  result-materialization problem, not an empty board.
- **Never trust a fresh-replica read.** From the 2026-07-10 outage record:
  "every wrong turn in this investigation traces to trusting a fresh-replica
  read."
- **Cross-space links resolve to empty, not to an error.** The memory server
  creates space stores on demand, so a link to another space silently
  manufactures an empty local one. A pattern with cross-space reads will look
  cleaner on a clone than in production.
- **A clone tests the store and the runtime, not the deployment.** CDN and shell
  versions, and concurrent human traffic, are all absent.

## Before going live

- Two consecutive clean passes on the clone, **stopping the server, resetting,
  and restarting between them**. A pass is clean when all four hold: `verify
  --expect-migration` exits zero, the authored-content check above shows no
  changed argument cells, churn settles within an observed window, and the
  semantic acceptance checks for the specific board pass.
- A rollback manifest written down *before* the live attempt: the pristine
  snapshot path and the exact reset command.
- Then repeat steps 3–5 against production, with that manifest in hand.

A note on what a clean pass is *not*: `cf space verify --expect-migration` exits
zero on an untouched clone, on a half-finished migration, and on one that
overwrote every authored title in place. It is a removal alarm, not a migration
verdict — the other three items are what make a pass mean something.
