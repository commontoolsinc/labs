# Topics board migration — the rehearsal script

**Status:** proposed, unexecuted. The concrete plan for rehearsing a `setsrc`
of the Estuary Topics board against a clone, and then doing it live.

Three documents already exist and none of them is this one:

- [`../development/space-clone-rehearsal.md`](../development/space-clone-rehearsal.md)
  is the **generic loop** — clone, serve, verify, reset. It cannot say which
  pieces to migrate or what to assert.
- [`space-clone-rehearsal.md`](space-clone-rehearsal.md) is the **design** of
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
| Children | 73 topic pieces, each its own piece |
| Store size | ~1.0 GB, ~200k commits |

The space DID is not recoverable from the store — it has no ACL doc — so it
must be supplied explicitly. Passing the wrong one produces a clone that serves
an empty space rather than an error.

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

1. **Starting state.** The Risks section says rehearse **old→populate→new**.
   A clone of today's board is already mid-state: 73 legacy-schema topics under
   a pre-rework board. Options: (a) migrate the clone as-is, which rehearses the
   *actual* transition that will happen live; (b) build a synthetic old→new
   sequence in a scratch space, which tests the transition in isolation but not
   against real data. **(a) is what #4997's rehearsal did** and what the tooling
   is built for. Confirm this reading before running.
2. **Which pattern revision** to `setsrc` — the phase currently landing, or
   latest `main`. Phase-scoped is what "continuous dogfood" implies.
3. **Whether one clean pass is enough.** The generic runbook asks for two
   consecutive clean passes; a 1.0 GB clone makes each attempt ~15 s of clone
   plus the migration itself. Cheap enough to keep the bar at two.

## The script

Clone and serve per the generic runbook. Then:

### Baseline

```bash
deno task cf space verify <clone>                    # record fingerprint + counts
deno task cf inspect churn <did> --bucket 60         # confirm a quiet window
```

Record: topic count (expect 73), comment and link totals, the content
fingerprint, and `max(seq)`.

### Migrate — children first, board last, serially

The order is not stylistic. The board's result recomputation is what storms,
and a board pointing at half-migrated children is the "Topics (0)" failure from
the 2026-07-10 outage: old-generation results lacking new fields make the whole
array read empty, silently.

```bash
# each of the 73 topics, one at a time, against the CLONE's api-url
deno task cf piece setsrc packages/patterns/topics/topic.tsx \
  --piece <topic-fid> --api-url http://localhost:8010 --space <did> …
# then, last:
deno task cf piece setsrc packages/patterns/topics/main.tsx \
  --piece fid1:jtdD-… --api-url http://localhost:8010 --space <did> …
```

Expect the compat checker to fail on the legacy→current transition and to need
`--dangerously-allow-incompatible-schema`. That is the documented state of this
migration, not a surprise — but it means the checker is *not* protecting this
run, and the verification below is the only thing that is.

### Verify

```bash
deno task cf space verify <clone>                    # nonzero exit if content moved
deno task cf inspect churn <did> --bucket 60 --since '<start>'
```

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
  not a spike.

`cf space verify` reporting `content unchanged` while commit counts grow is the
expected result: a migration writes, and generated cells are excluded from the
fingerprint precisely because they rotate.

### Reset and repeat

```bash
deno task cf space reset <clone>
```

Two consecutive clean passes before going live.

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
