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
# 1. Clone. --from takes a path or an https URL.
deno task cf space clone <space-did> --from <snapshot> --to ~/clones/<name>

# 2. Serve it — note the port offset; the clone keeps the source space's DID,
#    so the port is what distinguishes it from production.
MEMORY_DIR="file://$HOME/clones/<name>/" \
  ./scripts/start-local-dev.sh --port-offset 10
```

The toolshed prints a `SERVING A REHEARSAL CLONE` banner at startup. If you do
not see it, you are pointed at something else — stop and check before writing.

```bash
# 3. Baseline, before touching anything.
deno task cf space verify ~/clones/<name>
deno task cf inspect churn <space> --bucket 60      # confirm a quiet window

# 4. Run the update against the CLONE's api-url. Children first, board last,
#    serially — the parent's result recomputation is what storms.
deno task cf piece setsrc … --api-url http://localhost:8010 …

# 5. Judge it.
deno task cf space verify ~/clones/<name> --expect-migration   # nonzero = baseline corrupt or entities REMOVED
deno task cf inspect churn <space> --bucket 60 --since '<when you started>'

# 6. Reset and go again.
deno task cf space reset ~/clones/<name>
```

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

Per-entity hashes, when you need to see exactly which entities moved:

```bash
deno task cf space fingerprint <clone>/engine-v3/engine-v3/<did>.sqlite --per-entity
```

To compare **authored** content directly, read each topic's *input* (argument)
cell from the pristine and working stores and diff titles, bodies, and comment
and link counts. That is what "durable content fingerprint unchanged" meant in
#4997, and it is a different check from `cf space verify` — the one that
actually answers whether the content survived.

Compiler-generated internal cells are excluded by default, because a pattern
update rotates their identities on purpose. Including them (`--include-generated`)
answers "what moved at all?", never "did content survive?".

`cf inspect churn` reports rates and never judges them. What you are looking for
is the storm shape: a jump to a **sustained plateau**, not a spike. The July 2026
incident ran at ~1,300 commits/minute for twenty minutes. A settle means the rate
returns to baseline *and stays there*.

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
  `crossrefs --step` next to a non-empty `topics --input` is a
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

- Two consecutive clean passes on the clone, resetting between them.
- A rollback manifest written down *before* the live attempt: the pristine
  snapshot path and the exact reset command.
- Then repeat steps 3–5 against production, with that manifest in hand.
