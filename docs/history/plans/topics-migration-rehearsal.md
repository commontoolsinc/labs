---
status: historical
created: 2026-07-29
archived: 2026-08-28
reason: "The rehearsal script for the Estuary Topics board migration, executed on 2026-08-27/28. What the run found, including where this script was wrong, is recorded in ../topics-board-migration-2026-08-28.md."
superseded-by: ../topics-board-migration-2026-08-28.md
---

# Topics board migration — the rehearsal script

**Status:** proposed, unexecuted. The concrete plan for rehearsing a `setsrc`
of the Estuary Topics board against a clone, and then doing it live.

Three documents already exist and none of them is this one:

- [`../development/space-clone-rehearsal.md`](../../development/space-clone-rehearsal.md)
  is the **generic loop** — clone, serve, verify, reset. It cannot say which
  pieces to migrate or what to assert.
- [`space-clone-rehearsal.md`](../../plans/space-clone-rehearsal.md) is the **design** of
  that tooling.
- [`pattern-verb-contract-implementation.md`](pattern-verb-contract-implementation.md)
  holds the **live-acceptance checklist** and the **write-storm gate**, spread
  across its Testing and Risks sections.

This assembles them into an ordered script for one specific board, with the
open decisions named rather than assumed.

## The board

| | |
| --- | --- |
| Space | `topics-dev-476ea34f` = `did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk` |
| Board piece | `fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34` |
| Children | one topic piece per topic, across **two** deployed generations |
| Store size | ~1.0 GB, ~200k commits |

The board is in use, so its topic count rises between any snapshot and any
run. Every count below is what the 2026-07-22 snapshot held — 73 topics then,
113 on the live board as of 2026-08-26 — and none of them is a figure to
assert against. The pre-flight reads the counts, and the verification compares
them to what that same run recorded, never to a number written here.

The space DID is not recoverable from the store — it has no ACL doc — so it
must be supplied explicitly. Passing the wrong one produces a clone that serves
an empty space rather than an error.

## What is being upgraded from

The topics are **not** on one version, and that is the durable fact. How many
versions, which identities, and how many pieces on each are NOT durable — a
run reads them for itself, because every one of them has already turned over
once.

The 2026-07-22 snapshot held 73 topics on two generations. The 2026-08-27
snapshot held 125 on **three**, and not one identity from the earlier reading
survived — the board's included, which had been redeployed in between. Any
identity written into this document is a fact about the day it was written.

Read the split with a survey, which enumerates the collection and groups it by
the identity each piece is actually on:

```bash
deno task cf piece survey --piece of:fid1:jtdD-… --path topics \
  --api-url http://localhost:<port> --space <did> --identity <key> --quiet \
  > survey-before.jsonl
grep -o '"patternIdentity":"[^"]*"' survey-before.jsonl | sort | uniq -c
```

The plan header row carries the cross-check that matters —
`enumerated: {collection, registry, registeredOutside}`. A non-zero
`registeredOutside` is a piece the registry knows and the collection does not,
which is the shape a migration silently skips.

The topic generations are legacy — `createdByName` present, no
`rejectMutation`, no body-at-create. The board's `main.tsx` mentions
`AddTopicEvent.body` but not `rejectMutation`, so it predates #4991 as well.

(The space holds 319 pieces across 150 pattern identities in total; only the
board and its topics are in scope.)

**This is the condition that makes the rehearsal mandatory**, not incidental:
"more than one pattern generation is live in the space" is a trigger in the
generic runbook, and multiple live generations is what the incident record ties
to cross-version write storms. The run is therefore *two* legacy→current
transitions, and #4997's dangling-author fix has to hold for both.

Reproduce the grouping — and get the FID list itself — from the snapshot. This
is the migration manifest: run it before pass one, check the output in, and diff
against it before the live attempt.

```bash
# every piece in the space, with the pattern identity it currently carries.
# The scan is captured on its own, NOT piped: a pipeline reports its LAST
# command's status, so a refusal in the first stage would leave `sort` writing
# an empty manifest and reporting success.
pieces=$(deno task cf inspect entities $DB --kind piece --require-complete --json) &&
  jq -r '.[].id' <<<"$pieces" \
  | while read -r id; do
      deno task cf inspect piece $DB "$id" --json \
        | jq -r '[.id, (.pattern.identity // "unresolved"), (.pattern.filename // "-")] | @tsv'
    done | sort -k2 > topics-manifest.tsv

# everything in scope: the board plus every generation its children are on.
# The filter comes from the survey above, never from identities written down
# here — a grep for a retired identity matches nothing and prints nothing,
# which is indistinguishable from a clean manifest.
grep -o '"patternIdentity":"[^"]*"' survey-before.jsonl \
  | sed 's/.*:"//;s/"//' | sort -u > in-scope-identities.txt
grep -F -f in-scope-identities.txt topics-manifest.tsv \
  | cut -f2 | sort | uniq -c
```

`--require-complete` is load-bearing, not decoration: the piece listing is
capped like every space-wide scan, and a manifest short by a topic reads exactly
like a complete one. The flag makes a capped scan exit nonzero — but an exit
status only travels as far as the shell carries it, which is why the scan runs
on its own line and the manifest is written under `&&`. A refused scan then
never reaches the redirect, so it leaves the previous manifest untouched rather
than replacing it with an empty one.

The count check is the point: the space holds 319 pieces across 150 identities,
so "did I migrate the right set?" is a question the manifest answers and a
hand-copied list does not. It is also the rollback record — the second column is
the identity each piece has to be returned to, and the Going-live section says
what can take a piece back there and what else must be captured before
starting.

**Upgrading to:** `packages/patterns/topics/{topic,main}.tsx` at current `main`
(#4997's legacy-safety fixes plus #4991's body-at-create and thrown
rejections). The target identity is computed at `setsrc` time and does not need
to be known in advance — the acceptance check below is the better test.

## Gate 0 — prerequisites

The write-storm gate (implementation plan, Risks) requires the generated-cell
identity fix to be an ancestor of the **deployed** revision, not of `main`.

```bash
DEPLOYED=$(curl -s https://estuary.saga-castor.ts.net/api/meta | jq -r .gitSha)
git merge-base --is-ancestor cb2876927 "$DEPLOYED" && echo "#4659 ok"
git merge-base --is-ancestor b3825717e "$DEPLOYED" && echo "#4956 ok"
```

**Checked 2026-07-29 against deployed `b2213af8b`: both pass.** Re-run before
the live attempt — Estuary redeploys, and a rollback could move it backwards.

`#4916` (cross-version generated-cell identities) remains open. The board's
own tracking topic records it as **no longer a prerequisite** for this
migration: old/new overlap alone produced a finite write burst, not the
sustained storm. That judgment is Gideon's; revisit it if the rehearsal shows
a sustained plateau rather than a burst.

## Open decisions — resolve before running

1. ~~**Starting state.**~~ **Resolved: (a), migrate a clone of the current
   production snapshot as-is.** The Risks section says rehearse
   **old→populate→new**, but a clone of today's board is already mid-state:
   legacy-schema topics under a pre-rework board. Migrating it rehearses the
   *actual* transition that will happen live, which is what a rehearsal is for;
   it is what #4997's rehearsal did and what the tooling is built for. A
   synthetic old→populate→new sequence in a scratch space is worth having as
   compatibility coverage, but it cannot substitute — it tests the transition in
   isolation and not against real data, and the failures this migration is
   guarding against (two live generations, results read by a parent) are
   properties of the real store.
2. ~~**Which pattern revision** to `setsrc`.~~ **Resolved 2026-07-29: latest
   `main`.** It is the transition that will actually happen, and #4997's
   legacy-safety fixes are what make the legacy→current jump survivable.
   **Pin the SHA at pass one and reuse it** for pass two and the live run
   (`git rev-parse HEAD`, recorded beside the manifest). "Latest `main`" moves,
   and two passes against different sources are not two passes of the same
   rehearsal — the whole point of resetting between them is that the only thing
   varying is the attempt.
3. **Whether one clean pass is enough.** The generic runbook asks for two
   consecutive clean passes; a 1.0 GB clone makes each attempt ~15 s of clone
   plus the migration itself. Cheap enough to keep the bar at two.

## The script

Clone and serve per the generic runbook. Then:

### Baseline

```bash
CLONE=~/clones/topics
DB=$CLONE/engine-v3/engine-v3/did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk.sqlite

deno task cf space verify $CLONE                     # record fingerprint + counts
deno task cf inspect churn $DB --bucket 60 \
  --until "$(date -u '+%Y-%m-%d %H:%M:%S')"          # confirm a quiet window
```

The churn read takes the clone's **database path**, not the DID: the clone lives
outside the directories `cf inspect` searches, and naming the space would
resolve to whichever same-DID store discovery finds — usually this checkout's
`cache/memory`, silently. `--until` is what makes a quiet window observable
rather than assumed (generic runbook, "Reading the verdict").

Record: the topic count this run reads, comment and link totals, the content
fingerprint, and `max(seq)`. The first two come from the baseline fingerprint
dump the generic runbook's authored-content check already produces:

```bash
deno task cf space fingerprint $CLONE/pristine/<did>.sqlite --json > /tmp/before.json
jq '[.perEntity[] | .kind] | group_by(.) | map({(.[0]): length}) | add' /tmp/before.json
```

Take the **content export** here too — every topic's authored content as one
portable JSON file, read offline from the pristine snapshot:

```bash
scripts/topics-export.ts $CLONE/pristine/<did>.sqlite --out topics-export.json
```

The export prints the topic count, comment and link totals, and the selected
pattern identities — cross-check them against the migration manifest before
trusting anything downstream of it. It is the restore payload for the drill
below and the recourse for a live incident, and it survives even the space
becoming unusable. Keep the snapshot's filename `<did>.sqlite`: the export
records the space DID from it, and `topics-restore.ts` defaults its `--space`
to that record.

### Migrate — board first for this break, then children, serially

**The ordering follows from which side can read the other, and it inverts when
the board's own demand changes.**

The rule that produced "children first" is about keeping the whole setup
functional at every step: a board pointing at half-migrated children is the
"Topics (0)" failure from the 2026-07-10 outage, where old-generation results
lacking new fields make the whole array read empty, silently. That reasoning is
correct whenever the board's demand stays put — the children have to catch up
to what the board already requires.

This break moves the board's demand, which reverses it. Measured on
2026-08-26, from the board piece's latest stored revision in a snapshot of the
live topics space — what the deployed board actually demands, not what a
recompile of its source would produce:

- **The deployed board demands `createdByName` required, with no default**, and
  this break retires that field. It is not alone: eleven of the board's sixteen
  demanded members carry no default, `title`, `body`, `comments`, `links` and
  `createdAt` among them. Only five are defaulted.
- **The narrowed board reads OLD topics cleanly.** `createdAt` is the only
  member of its eight-member demand without a default, and all 113 topics
  provide it; `mentions` is absent on every one and carries `Default<[]>`.

An absent default is evidence rather than silence here: 76 `default` keys
survive that serialization, five of them inside the board's own demand, so the
format plainly preserves them.

So the new board is **itself** the both-shapes board — it reads the old topics
and the new ones — and moving it first keeps the setup functional at every
step, with no intermediate artifact. Children-first would do the opposite:
new-shape topics landing under a board that still demands `createdByName`, the
array reading empty while the count still looks right. That is the same silent
failure the 2026-07-10 outage taught, arriving from the other direction.

Move the board, then all of generation A, then all of generation B. Keeping the two
child transitions separable means that if one storms you know which;
interleaving them blurs that signal for no benefit. The board's recomputation
still storms, so it is watched as closely as before — it is the ordering that
changed, not the risk.

Run every authored test against the migration source before changing the clone.
Stop if any test fails. Keep the complete flag set on every topic and board
revision:

```bash
deno task cf test packages/patterns/topics/multi-user.test.tsx
deno task cf test packages/patterns/topics/render-shape.test.tsx
deno task cf test packages/patterns/topics/topics-rejections.test.tsx
deno task cf test packages/patterns/topics/topics.test.tsx

TOPICS_TEST_ARGS=(
  --test packages/patterns/topics/multi-user.test.tsx
  --test packages/patterns/topics/render-shape.test.tsx
  --test packages/patterns/topics/topics-rejections.test.tsx
  --test packages/patterns/topics/topics.test.tsx
)
```

The quoted `"${TOPICS_TEST_ARGS[@]}"` expansion repeats every `--test` entry.
Deployment packages and type-checks attached tests but does not run them.

The board goes FIRST, and the order in this block is the order to run them.
The `--api-url` port is whatever the clone was served on — `--port-offset 10`
gives 8010, but a second clone served alongside it will be somewhere else, and
the two are told apart by nothing except that port.

```bash
# the board first: it is the both-shapes board, and moving it first is what
# keeps the setup readable at every intermediate step
deno task cf piece setsrc packages/patterns/topics/main.tsx \
  "${TOPICS_TEST_ARGS[@]}" \
  --piece fid1:jtdD-… --api-url http://localhost:8010 --space <did> …
# then each topic, one at a time, generation A before generation B
deno task cf piece setsrc packages/patterns/topics/topic.tsx \
  "${TOPICS_TEST_ARGS[@]}" \
  --piece <topic-fid> --api-url http://localhost:8010 --space <did> …
```

Expect the compat checker to fail on the legacy→current transition and to need
`--dangerously-allow-incompatible-schema`. That is the documented state of this
migration, not a surprise — but it means the checker is *not* protecting this
run, and the verification below is the only thing that is.

### Verify

```bash
# --expect-migration is REQUIRED here: without it, verify is strict and exits
# nonzero on any change at all — which every successful migration is, because
# each piece's result value is rewritten.
deno task cf space verify $CLONE --expect-migration
deno task cf inspect churn $DB --bucket 60 \
  --since '<start>' --until "$(date -u '+%Y-%m-%d %H:%M:%S')"
```

Then the authored-content check from the generic runbook ("Checking authored
content — the step that is not optional"). It is not optional here either:
`--expect-migration` gates on removal, and overwriting a topic body is a change,
so this run's own gate cannot see the failure mode that matters most.

Then the acceptance items from the implementation plan's live checklist, which
`cf space verify` cannot cover because they are semantic:

- every topic the pre-flight counted is present; comment and link totals
  unchanged;
- a **cold** board read returns all of them (wait ≥20 s; a cold load is slow and a
  premature check caused a production rollback);
- a cold index read resolves a linked topic;
- `createdBy` / `bodyUpdatedBy` attribution survived;
- body Markdown preserved **exactly** — no trimming;
- a returned reference renders to a fid that opens the canonical child, not an
  intermediate wrapper;
- an undeclared field fails with a nonzero exit;
- the deployed verb schema matches the skill driving it (`cf piece verbs`);
- churn returns to baseline **and stays there** — a storm is a steady state,
  not a spike;
- **the topics report exactly ONE pattern identity afterwards**, not two.
  This is the cheapest proof the migration converged rather than half-landing,
  and neither `cf space verify` nor the content fingerprint would catch a
  half-migration on its own: leaving generation B behind changes no authored
  content, so the fingerprint is unmoved and the counts merely grow.

The expected `cf space verify` result is **`content CHANGED` with `removed 0`**,
and the per-kind tally confined to pieces and their derived cells. Generated
cells are excluded from the fingerprint because they rotate, but *results* are
not — and a schema update rewrites every piece's result — so `content unchanged`
after this migration would mean the migration did not land, not that it landed
cleanly.

### The restore drill — part of a clean pass

A restore mechanism that has never been exercised is not a mechanism, so each
rehearsal pass ends by proving it: deliberately clobber one topic on the
clone, restore it from the baseline export, and re-run the authored-content
check. The whole loop also exists as one self-contained command against any
toolshed — it deploys its own board into a fresh space, so it needs nothing
from the pass it runs beside:

```bash
API_URL=http://localhost:8010 CF_DRILL_STORE_DIR=<the server's MEMORY_DIR> \
  packages/cli/integration/topics-restore-drill.sh
```

CI runs that same loop in the `piece-call` CLI-integration shard, so the
restore path is exercised on every pull request rather than only when someone
rehearses. What CI cannot do is rehearse against real data, which is what the
clone pass above is for.

```bash
# Damage one topic the worst way a bad migration would.
echo '{"title":"CLOBBERED","body":"","comments":[]}' | \
  deno task cf piece apply --piece <topic-fid> --api-url http://localhost:8010 …
# Restore it, and read every field back against the export.
scripts/topics-restore.ts topics-export.json --piece <topic-fid> \
  --api-url http://localhost:8010
```

The restore writes content, never verbs — a verb would stamp its own write
time and author over the history being restored — and lands in the same
piece, so identity and crossref edges survive. Three measured facts shape how
it works, none guessable from the command names:

- **`cf piece apply` replaces the whole input document.** A partial document
  zeroes every field it omits, structural links included. The clobber above
  is realistic for exactly this reason, and the restore therefore always
  writes the complete content and then re-establishes the board link with
  `cf piece link` — the pre-apply state of that link is irrelevant, because
  the apply just destroyed it.
- **`cf set` cannot write any field of a deployed topic.** Both of its sides
  validate the untouched remainder of the document and refuse it: the input
  side judges the stored `mentionable` link against its declared array type
  without resolving it, and the result side demands session-scoped fields no
  other session can see.
- **No CLI write path carries a `$link` value**, so comment and link elements
  restore as plain values: content, order, timestamps, and attribution are
  exact, and the element entities are minted fresh. A stored reference to an
  individual old element is the one thing a restore does not preserve.

A pass is clean only if the drilled topic reads back byte-identical to the
export — body Markdown included — and its `mentionable` resolves through the
re-established link.

### Reset and repeat

```bash
./scripts/stop-local-dev.sh --port-offset 10     # required, see below
deno task cf space reset $CLONE
# then restart per the generic runbook's step 2 before the next pass
```

Stopping the server first is not tidiness: a reset unlinks the database, which
does not reach a process that already holds it open. A running toolshed would
keep serving pass one's state while `cf space verify` reported the clone
pristine. `cf space reset` refuses while the store is held, so a forgotten stop
fails loudly instead of silently invalidating the pass — but that check is a
tripwire, not a lock. The stop is what makes the reset correct.

Two consecutive clean passes before going live — see the generic runbook's
"Before going live" for what makes a pass clean, which is more than this
command's exit code.

### If the run stops partway

Resource exhaustion wedged the server in the first real rehearsal, and it will
happen again on a 1 GB store. The migration is durable: already-migrated pieces
stay migrated. To resume, re-read which pieces still carry an old identity and
continue from there rather than restarting the pass:

```bash
deno task cf inspect piece $DB <topic-fid>     # `pattern:` line carries the identity
```

Only start a fresh pass (stop, reset, restart) if you cannot account for every
piece — a pass whose midpoint is unknown is not one of the two clean passes.

## Going live

Only after two clean passes, and with a rollback manifest written down first:
the pristine snapshot path, the exact reset command, the prior pattern
identity of every piece (`cf inspect piece <space> <fid>` records it — capture
every one before starting) together with the source checkout that produced each
of those identities, pinned by git rev, and a **fresh content export**
taken from a snapshot of production at the start of the quiet window, so the
per-topic restore has current data rather than rehearsal-age data.

There is no `cf space reset` for production. The rollback returns each piece
to its recorded identity, and `setsrc` cannot be pointed at an identity — it
takes a source path — so a rollback by `setsrc` re-applies the legacy source
checked out at the rev that produced the identity, which is why that rev is
captured beside the manifest and not reconstructed afterwards. The runtime
also retains, on the piece, a revision for the source it was on before the
migration — when that source is still present in the space — which is what
[bulk piece operations](../../plans/piece-bulk-operations.md) builds rollback on; no
command fronts that restore yet, so until one does, the recorded-rev `setsrc`
is the rollback.
Above it sit two content tiers: `topics-restore.ts` repairs an individual
damaged topic in place from the export, and the last resort is the operator
swapping the store file back to the snapshot — which loses everything written
after it, so whether and when that tier may be used is agreed with whoever
operates the deployment before the attempt, not negotiated during an incident.

Repeat the migrate and verify steps against production, in the same order,
serially, board first — the ordering the rehearsal established, for the reason
it established it.

## What this rehearsal cannot tell you

- **Cross-space links resolve to empty on a clone**, not to an error — the
  server manufactures an empty local space on demand. If Topics gains
  profile-linked or cross-space content, the clone will look cleaner than
  production. Wilk flagged this as the thing most likely to matter as profiles
  grow.
- **Deployment differences** — CDN and shell versions, concurrent human traffic,
  and real cold-load latency are all absent.
