# Topics board migration — the rehearsal script

**Status:** proposed, unexecuted. The concrete plan for rehearsing a `setsrc`
of the Estuary Topics board against a clone, and then doing it live.

Three documents already exist and none of them is this one:

- [`../development/space-clone-rehearsal.md`](../development/space-clone-rehearsal.md)
  is the **generic loop** — clone, serve, verify, reset. It cannot say which
  pieces to migrate or what to assert.
- [`space-clone-rehearsal.md`](space-clone-rehearsal.md) is the **design** of
  that tooling.
- [`pattern-verb-contract-implementation.md`](../history/plans/pattern-verb-contract-implementation.md)
  holds the **live-acceptance checklist** and the **write-storm gate**, spread
  across its Testing and Risks sections.

This assembles them into an ordered script for one specific board, with the
open decisions named rather than assumed.

## The board

| | |
| --- | --- |
| Space | `topics-dev-476ea34f` = `did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk` |
| Board piece | `fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34` |
| Children | 73 topic pieces, each its own piece, across **two** deployed generations |
| Store size | ~1.0 GB, ~200k commits |

The space DID is not recoverable from the store — it has no ACL doc — so it
must be supplied explicitly. Passing the wrong one produces a clone that serves
an empty space rather than an error.

## What is being upgraded from

Read out of the 2026-07-22 snapshot rather than assumed. The 73 topics are
**not** on one version:

| | pieces | pattern identity |
| --- | ---: | --- |
| topic generation A | 39 | `PB0GumS5vkDPyKAWciwh-4UtypoJwKFUXcDj3SsspHY` |
| topic generation B | 34 | `-85Wmyd9iwUjbpwnTYR2YolxkMUHup9WHY6YsRUDA1E` |
| board | 1 | `WpIRvAWL_WW45Q89ekZAlHWLObhQ16NDmQzvv_q2aI8` |

Both topic generations are legacy — `createdByName` present, no
`rejectMutation`, no body-at-create — and differ only slightly (681 vs 686
authored lines of `topic.tsx`). The board's `main.tsx` mentions
`AddTopicEvent.body` but not `rejectMutation`, so it predates #4991 as well.

(The space holds 319 pieces across 150 pattern identities in total; only these
74 are in scope.)

**This is the condition that makes the rehearsal mandatory**, not incidental:
"more than one pattern generation is live in the space" is a trigger in the
generic runbook, and multiple live generations is what the incident record ties
to cross-version write storms. The run is therefore *two* legacy→current
transitions, and #4997's dangling-author and recursive-crossref fixes have to
hold for both.

Reproduce the grouping — and get the FID list itself — from the snapshot. This
is the migration manifest: run it before pass one, check the output in, and diff
against it before the live attempt.

```bash
# every piece in the space, with the pattern identity it currently carries
deno task cf inspect entities $DB --kind piece --json \
  | jq -r '.[].id' \
  | while read -r id; do
      deno task cf inspect piece $DB "$id" --json \
        | jq -r '[.id, (.pattern.identity // "unresolved"), (.pattern.filename // "-")] | @tsv'
    done | sort -k2 > topics-manifest.tsv

# the 74 in scope: the board plus everything on either topic generation
grep -E 'PB0GumS5vkDPyKAWciwh-4UtypoJwKFUXcDj3SsspHY|-85Wmyd9iwUjbpwnTYR2YolxkMUHup9WHY6YsRUDA1E|WpIRvAWL_WW45Q89ekZAlHWLObhQ16NDmQzvv_q2aI8' \
  topics-manifest.tsv | cut -f2 | sort | uniq -c   # expect 39 / 34 / 1
```

The count check is the point: the space holds 319 pieces across 150 identities,
so "did I migrate the right 74?" is a question the manifest answers and a
hand-copied list does not. It is also the rollback record — the second column is
the source id to `setsrc` back to, which the Going-live section requires be
captured before starting.

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
sustained storm. That judgement is Gideon's; revisit it if the rehearsal shows
a sustained plateau rather than a burst.

## Open decisions — resolve before running

1. ~~**Starting state.**~~ **Resolved: (a), migrate a clone of the current
   production snapshot as-is.** The Risks section says rehearse
   **old→populate→new**, but a clone of today's board is already mid-state: 73
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

Record: topic count (expect 73), comment and link totals, the content
fingerprint, and `max(seq)`. The first two come from the baseline fingerprint
dump the generic runbook's authored-content check already produces:

```bash
deno task cf space fingerprint $CLONE/pristine/<did>.sqlite --json > /tmp/before.json
jq '[.perEntity[] | .kind] | group_by(.) | map({(.[0]): length}) | add' /tmp/before.json
```

### Migrate — children first, board last, serially

The order is not stylistic. The board's result recomputation is what storms,
and a board pointing at half-migrated children is the "Topics (0)" failure from
the 2026-07-10 outage: old-generation results lacking new fields make the whole
array read empty, silently.

Do generation A's 39 first, then generation B's 34, then the board. Keeping
the two transitions separable means that if one storms you know which;
interleaving them blurs that signal for no benefit.

Run every authored test against the migration source before changing the clone.
Stop if any test fails. Keep the complete flag set on every topic and board
revision:

```bash
deno task cf test packages/patterns/topics/multi-user.test.tsx
deno task cf test packages/patterns/topics/topics-rejections.test.tsx
deno task cf test packages/patterns/topics/topics.test.tsx

TOPICS_TEST_ARGS=(
  --test packages/patterns/topics/multi-user.test.tsx
  --test packages/patterns/topics/topics-rejections.test.tsx
  --test packages/patterns/topics/topics.test.tsx
)
```

The quoted `"${TOPICS_TEST_ARGS[@]}"` expansion repeats every `--test` entry.
Deployment packages and type-checks attached tests but does not run them.

```bash
# each of the 73 topics, one at a time, against the CLONE's api-url
deno task cf piece setsrc packages/patterns/topics/topic.tsx \
  "${TOPICS_TEST_ARGS[@]}" \
  --piece <topic-fid> --api-url http://localhost:8010 --space <did> …
# then, last:
deno task cf piece setsrc packages/patterns/topics/main.tsx \
  "${TOPICS_TEST_ARGS[@]}" \
  --piece fid1:jtdD-… --api-url http://localhost:8010 --space <did> …
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

- all 73 topics present; comment and link totals unchanged;
- a **cold** board read returns all 73 (wait ≥20 s; a cold load is slow and a
  premature check caused a production rollback);
- a cold crossref read resolves a linked topic;
- `createdBy` / `bodyUpdatedBy` attribution survived;
- body Markdown preserved **exactly** — no trimming;
- a returned reference renders to a fid that opens the canonical child, not an
  intermediate wrapper;
- an undeclared field fails with a nonzero exit;
- the deployed verb schema matches the skill driving it (`cf piece verbs`);
- churn returns to baseline **and stays there** — a storm is a steady state,
  not a spike;
- **the 73 topics report exactly ONE pattern identity afterwards**, not two.
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
the pristine snapshot path, the exact reset command, and the prior source ids
for every piece (`cf inspect piece <space> <fid>` records the current pattern
identity — capture all 74 before starting).

There is no `cf space reset` for production. The rollback is a `setsrc` back to
the recorded source ids, which is why capturing them beforehand is not optional.

Repeat the migrate and verify steps against production, in the same order,
serially, board last.

## What this rehearsal cannot tell you

- **Cross-space links resolve to empty on a clone**, not to an error — the
  server manufactures an empty local space on demand. If Topics gains
  profile-linked or cross-space content, the clone will look cleaner than
  production. Wilk flagged this as the thing most likely to matter as profiles
  grow.
- **Deployment differences** — CDN and shell versions, concurrent human traffic,
  and real cold-load latency are all absent.
