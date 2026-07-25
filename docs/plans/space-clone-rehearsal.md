# `cf space clone` — rehearsal-grade space copies

**Status:** proposed. Research complete; not yet agreed. Written 2026-07-24
against the July Estuary Topics migration, which established that updating a
deployed pattern on a populated space is a rehearsal-grade event. Decides
whether the hand-built clone rehearsal becomes a command, and what shape.

**Provisional pending interview.** Wilk built the rehearsal setup with Gideon.
Everything below is derived from the code, the PR record, and the board; the
questions his answers settle are listed in [Open questions for
Wilk](#open-questions-for-wilk) and marked *(W)* inline. Nothing here should be
implemented before that pass.

## Why

The July Topics migration exposed the whole failure surface of a live pattern
update, and every mitigation that worked was hand-built:

- the legacy→current transition **fails the compat checker**, forcing
  `--dangerously-allow-incompatible-schema` plus manual validation;
- a first production attempt was **rolled back on false-negative health
  checks** — cold browser loads take ~20 s, and unstepped CLI reads look empty;
- historical pattern updates produced **generated-cell write storms**: per the
  board's incident record, 20 generated cells produced 192,381 revisions —
  90.3% of every revision and 96.0% of all commits in the 2026-07-22 snapshot,
  peaking at 1,598 commits/minute;
- the thing that actually worked was a **copy-on-write clone rehearsal**: copy
  the space's SQLite store, serve it from a local toolshed, migrate all 73
  topics serially, verify counts / fingerprint / cold reads / write settlement,
  reset, repeat.

That rehearsal caught two data-corrupting schema bugs ([#4997]) that static
checking could not — a dangling legacy `createdByName` author link and a
recursive `TopicPiece` crossref that made validation stop making progress. It
also demonstrated the fix for the write storm: "current-main clients against
the local clone become completely quiet."

The verb-contract arc commits to continuous dogfood on this board — every phase
implies another rehearsal — and its Risks section already names the gate:
"before any live `setsrc`, rehearse old→populate→new in a scratch space watching
commit rates." Today that instruction has no executable form. This document
decides what to build so it does.

[#4997]: https://github.com/commontoolsinc/labs/pull/4997

## Recommendation in one paragraph

Build a **thin, offline `cf space clone`** — the store-path knowledge, the
crash-consistent copy, the pristine/working split, and a manifest — plus **`cf
inspect churn`**, the time-bucketed commit-rate query that makes the write-storm
gate executable. Clone **same-DID**. Reset by **APFS clonefile from a pristine
snapshot**. Leave server-side acquisition, toolshed orchestration, and the
migration driver **manual**. Roughly 400 lines across two layer-4 packages,
against a practice the team is already committed to repeating every phase.

## What exists (verified)

| Fact | Where |
| --- | --- |
| Crash-consistent snapshot via `VACUUM INTO`; never mutates source, never runs the engine's DDL-on-open path; produces one file with no `-wal`/`-shm` | `packages/memory/v2/dump.ts` |
| A space is one SQLite file whose name encodes its DID; directory mode nests under `engine-v3/` with the **literal** DID as the stem, single-file mode percent-encodes it | `packages/memory/v2/storage-path.ts` |
| The store dir defaults to `./cache/memory/` relative to cwd — so storage is already isolated per checkout | `packages/toolshed/env.ts` (`MEMORY_DIR`) |
| The dump endpoint is hard-off in production: fail-closed env allowlist, no override, and "a prod form is a separate mechanism" | `packages/toolshed/routes/storage/memory/memory-dump-policy.ts` |
| `cf inspect --remote` fetches snapshots into `~/.cache/cf-inspect/<host>/` | `packages/state-inspector/remote.ts` |
| Genesis/ACL ride inside the store (`of:<space>` doc), so existing team keys authorize on a copy | `packages/memory/v2/server.ts` |
| `cf inspect` is read-only by contract — "it explains, it never reproduces or replays" | `skills/state-inspector/SKILL.md` |

## Identity: same-DID, and it is not close

The clone keeps the source space's DID. Re-keying is not a rename; it is an
unbounded data migration, and it degrades exactly the fidelity the rehearsal
exists to buy.

**What would survive a re-key.** Entity ids are content-addressed from
`{source, cause}` and do **not** include the space DID (`createRef` in
`packages/runner/src/create-ref.ts`), so the document graph is space-agnostic.
Same-space links elide the `space` field entirely when it matches the base
(`packages/runner/src/link-utils.ts:232-243`). On those two dimensions a re-key
is a no-op.

**What would break.**

1. **CFC labels name the space.** `CfcSpaceAtom` and `HasRole` carry a space
   DID (`packages/api/cfc.ts`), and `space` is a *commitment* field —
   equality-consumed (`packages/runner/src/cfc/label-field-classification.ts`).
   At render the runtime mints `HasRole(actingPrincipal, space, reader)` from
   the **actual** space and correlates it against the stored label
   (`render-ceiling.ts`, `space-membership.ts`). A stored `Space(did:PROD)` atom
   under a `did:CLONE` runtime never correlates, and the ceiling **fails
   closed** — content silently over-blocks. A rehearsal that over-blocks is
   worse than no rehearsal: it manufactures failures the live update won't have.
2. **The ACL doc is keyed by the DID.** `aclDocId(space) === "of:" + space`
   (`server.ts:262`). Re-keying orphans it, and the clone falls through to
   `#resolveCapability`'s legacy-compat branch — a populated space with no ACL
   grants WRITE to any authenticated principal (`server.ts:1002-1006`). That
   branch is explicitly "temporary pre-launch compatibility" and is on its way
   out. Rehearsing on it means rehearsing a different authorization world.
3. **History can't be re-signed.** Every `invocation` row records `sub` (the
   space DID) and links to an `authorization` row holding the signed UCAN
   (`engine.ts:323-334`). Re-keying makes every historical row inconsistent with
   its signature, and we cannot re-sign them.
4. **Cross-space links are unfixed either way.** Links to *other* spaces keep
   their DIDs under both schemes, so re-keying buys nothing there.

**The residual same-DID risk is real, and belongs at the endpoint layer.** Two
stores now claim one identity, so a mis-pointed client is the hazard. The fix is
not to change the identity — it is to make the clone unreachable at the prod
address and loudly labelled at its own. See [Safety rails](#safety-rails).

*(W)* Did the July rehearsal in fact use same-DID, and did it cause any
near-miss — a `cf` invocation or browser tab that hit the wrong endpoint?

## Write semantics and the reset mechanism

All of this is measured, not assumed. The probe below ran against a 124 MB
WAL-mode SQLite store shaped like a space file, with a writer connection held
open throughout — the live-server condition.

| Step | Result |
| --- | --- |
| `VACUUM INTO` with the writer open | 176 ms → 124.3 MB, **no `-wal` companion** |
| `cp -c` (APFS clonefile) of the snapshot | **8.9 ms**, no additional disk |
| plain `cp` of the same file | 24.1 ms |
| open clone + engine pragmas + idempotent DDL + write | 126 ms; creates `-wal` |
| source byte-identical afterwards | **yes** |
| pristine snapshot byte-identical afterwards | **yes** |
| reset (`rm` working set incl. `-wal`/`-shm`, re-clone) | **3.5 ms**, rehearsal write gone |

**Migration-on-open is safe on a copy.** `Engine.open` is forward-only and
idempotent: `CREATE TABLE IF NOT EXISTS` plus a fixed list of guarded
`migrate*` steps, all applied under `create: true`
(`packages/memory/v2/engine.ts`). Running it against a VACUUM-INTO copy is the
ordinary path — the copy is a complete database, not a partial one. This is
precisely why `dump.ts` refuses to run it against the *source*.

**WAL is handled by the copy primitive, not by us.** `VACUUM INTO` checkpoints
into the destination, so the pristine snapshot has no companions to ship or to
get out of sync. The *working* copy grows a `-wal` as soon as the engine opens
it, which is why reset must delete the companions and not just the `.sqlite`.

**"Copy-on-write / reset per attempt" concretely** — a three-file discipline:

```
<clone-dir>/
  clone.json                        # manifest: source, fingerprint, counts
  pristine/<did>.sqlite             # VACUUM INTO output; never opened rw
  engine-v3/<did>.sqlite            # the working copy; toolshed serves this
```

Reset = delete `engine-v3/<did>.sqlite{,-wal,-shm}`, `cp -c` from `pristine/`.
Not `sqlite3 .backup` (needs a live connection, slower, no advantage here). Not
re-running `VACUUM INTO` (needs the source, which may be a laptop-local scp'd
file or offline). Clonefile falls back to a plain copy off APFS — same
semantics, one-time cost proportional to size, which matters on Linux/CI but not
on the operator laptops where rehearsals happen.

*(W)* Did the rehearsal reset per attempt, and roughly how many attempts did the
73-topic migration take before it was clean?

## Acquisition: scp-then-clone is the honest scope

The production dump refusal is deliberate and well-reasoned, and this proposal
does not touch it. `memory-dump-policy.ts` fails closed on an env allowlist
specifically so an alias or typo can't enable it, states "there is intentionally
no override to turn raw whole-space dumps on in production," and the route
carries an unresolved capacity caveat — no size or concurrency cap, which the
comment names as a prerequisite before wider availability. Underneath both:
**a dump is the entire contents of a space**, which is a confidentiality
decision, not an ergonomics one.

So:

- **Staging** (`MEMORY_DUMP_ENABLED`, tailnet, allowlisted DID): `cf space clone
  --from-remote <url>` reuses the existing `cf inspect pull` path verbatim. No
  new server surface.
- **Production**: the operator runs `VACUUM INTO` server-side and scp's the file
  down; `cf space clone --from <path>` takes it from there. The command's job is
  to document that one-liner in its error message when `--from-remote` hits a
  404, so the manual path is discoverable rather than folklore.

If prod acquisition later deserves automating, it is a separate mechanism with
its own access-control design — as the existing comment already says. Bundling
it into this command would relitigate a decision that was made correctly.

## Layering: `cf space`, over `state-inspector`

Per the pace layers in `AGENTS.md`, `cli` and `state-inspector` are both
Operation (layer 4), and memory is Foundation (layer 1). Operator tooling over
the memory layer is exactly what layer 4 is. `state-inspector` already imports
`@commonfabric/memory/v2/dump` and already owns remote acquisition and the cache
layout, so the mechanism goes there and the command surface goes in
`packages/cli/commands/space.ts`.

Two rejected alternatives:

- **A script in `scripts/`.** It would have to reimplement `resolveSpaceStoreUrl`'s
  mode-dependent filename encoding — the one thing in this whole area that is
  genuinely non-derivable, and whose comment says changing it "silently forks
  data into new per-space files." A script copy of that logic drifts silently.
- **A `cf inspect` subcommand.** `inspect`'s contract is its value: read-only,
  offline, "it explains, it never reproduces or replays." A clone exists to be
  written to. Filing it under `inspect` costs the one boundary that makes the
  skill trustworthy. A new `cf space` noun keeps that line sharp and gives
  future space-level operations a home.

## Safety rails

The write-storm history and the mis-pointed-client hazard drive four rails.

1. **Refuse the dangerous targets.** `cf space clone` fails if the resolved
   target directory is the store dir the local toolshed is configured to serve
   (`MEMORY_DIR` / `DB_PATH` from the environment), or is the source directory.
   Both are cheap path comparisons and both are the accidents worth blocking.
2. **A manifest, and `--verify`.** `clone.json` records source host/path, source
   DID, VACUUM timestamp, sha256 of the pristine snapshot, `max(seq)` and commit
   count, and the tool revision. `cf space clone --verify` re-checks the working
   copy's fingerprint against it. This is the executable form of Gideon's
   "snapshot manifest + content fingerprint," and it is what turns "did the
   migration preserve everything" from a judgment call into a diff.
3. **Make the clone unmistakable at the endpoint.** The clone directory carries
   a `.cf-clone` marker; the toolshed prints a startup banner naming the clone
   and its source when its store dir contains one. This is a ~7-line toolshed
   change (layer 5) and I recommend it as a second increment rather than a
   blocker — but a printed hint from `cf space clone` alone is weak, and "make
   prod-vs-clone unmistakable" was the explicit ask. The clone launches on an
   offset port via the existing `start-local-dev.sh --port-offset`, so the
   api-url differs by construction.
4. **`cf inspect churn`.** A time-bucketed commit/revision rate query —
   commits and revisions per bucket over `commit.created_at`, plus the top
   entities in the hottest bucket. **This does not exist today**:
   `hotEntities` (`packages/state-inspector/queries.ts:183`) gives all-time
   write counts per entity with no time dimension, which cannot show a storm
   starting or a settle completing. Churn is what makes "watch commit rates"
   executable, and it earns its keep on live spaces independent of cloning —
   it is the query that would have caught the July storm in minutes.

## Fidelity caveats the practice must state

A clone is not the production system, and two gaps are worth naming so a
rehearsal isn't over-trusted:

- **Cross-space references resolve to empty, not to an error.** The memory
  server creates space stores on demand (`server.ts:3411-3420`, `ensureDir` +
  `Engine.open` with `create: true`), so any link to another space silently
  manufactures an empty local one. A fresh space grants READ only, so the read
  succeeds and returns nothing. Rehearsing a pattern with cross-space reads will
  look cleaner than production.
- **A clone tests the durable store and the runtime, not the deployment.**
  Cold-load timing, CDN/shell versions, and concurrent human traffic are all
  absent. The ~20 s cold-load patience rule exists because of the deployment,
  and a fast clone cold load does not retire it.

## Scope cut

**Build (increment 1).**

- `cf space clone <did> --from <path|dir> | --from-remote <url> --to <dir>` —
  resolve the store path, `VACUUM INTO` to `pristine/`, clonefile to
  `engine-v3/`, write `clone.json`, write `.cf-clone`, print the launch command.
- `cf space clone --reset` — restore the working copy from pristine.
- `cf space clone --verify` — fingerprint check against the manifest.
- `cf inspect churn <space> [--bucket 1m] [--since …] [--top N]`.

**Build (increment 2, optional).** Toolshed clone banner.

**Explicitly not building.**

- Re-keyed clones. See the identity section.
- Production dump automation. See acquisition.
- A rehearsal orchestrator that starts the toolshed, drives the migration, and
  verifies. `start-local-dev.sh --port-offset` already starts an isolated
  server, and the migration driver is pattern-specific — a `topics`-shaped
  driver would not generalize, and generalizing it prematurely is how operator
  tooling turns into a framework nobody trusts.
- Automatic prod detection by heuristic. Explicit path refusal (rail 1) is
  honest; guessing "this looks like production" is not.

**The honest "don't build it" case.** If the July rehearsal turns out to have
been one afternoon of `cp` and a `README`, and if the verb-contract arc lands in
two more `setsrc` events rather than five, then a runbook in
`docs/development/` plus `cf inspect churn` is genuinely sufficient — churn is
the only piece with no existing substitute. What tips it toward building is the
repeat count: continuous dogfood means every phase rehearses, and each hand-built
rehearsal re-derives the `engine-v3/` filename encoding and the WAL companion
rule from scratch. Those are the two facts people get wrong, and both are silent
when wrong. *(W)* is the deciding input here — how much of the setup was fiddly
versus obvious.

## Blessed practice

### When a clone rehearsal is required

Required when updating a **populated** space and any of:

- the compat checker fails, or the update needs
  `--dangerously-allow-incompatible-schema`;
- the update changes a **result** schema that a parent or sibling piece reads
  (the "Topics (0)" failure mode from the 2026-07-10 board outage: old-generation
  results lacking new fields make the *whole array* read empty, silently);
- more than one pattern generation is live in the space;
- the target is a board or collection whose children are separate pieces —
  children and parent migrate separately and can disagree mid-flight.

Not required for additive input fields with defaults, UI-only changes, or work
on a fresh/scratch space.

### Acceptance checklist

Gideon's runbook, made checkable:

1. **Baseline.** `cf space clone … --verify`; record fingerprint, topic/comment/
   link counts, `max(seq)`. `cf inspect churn` shows a quiet window.
2. **Serial batches, children first, board last.** Never parallel; the board's
   result recomputation is what storms.
3. **Step and verify each batch.** `--input` for what durably committed,
   `--step` for computed results. An unstepped result read that looks empty is
   not evidence of anything.
4. **Trust no fresh-replica read.** The 2026-07-10 outage record is explicit:
   "every wrong turn in this investigation traces to trusting a fresh-replica
   read." Confirm from the store or from a stepped read, not from a first read
   on a cold client.
5. **≥20 s cold-load patience** before calling a health check failed. A first
   production attempt was rolled back on this false negative.
6. **Post-run.** Counts match; content fingerprint of durable topic content
   unchanged; a cold board read returns every child; a cold crossref read
   resolves a linked child; churn returns to baseline and *stays* there — a
   storm is a steady state, not a spike.
7. **Rollback manifest.** The pristine snapshot path and the exact reset command,
   written down before the live attempt, not improvised during it.
8. **Two consecutive clean passes** before the live `setsrc`. Reset between
   them.

The live run then repeats 2–6 against production, with the rollback manifest in
hand.

## Open questions for Wilk

1. **What did the rehearsal actually do end to end** — from acquiring the
   Estuary store to a verified pass? Especially: how the store came off the
   server, and whether the toolshed was `start-local-dev.sh` with an offset or
   something bespoke.
2. **Same-DID or re-keyed?** And did same-DID produce any near-miss — a `cf`
   command or browser tab that hit the wrong endpoint?
3. **What was the reset?** `cp -c`, a fresh copy, something else — and how many
   attempts did the 73-topic migration take before it was clean?
4. **What was fiddly versus obvious?** This is the load-bearing question for
   build-vs-runbook. Specifically: did the `engine-v3/<did>.sqlite` path
   encoding, or WAL companions on reset, cost you time?
5. **How were counts and the content fingerprint computed** — ad-hoc SQL, `cf
   inspect`, or by hand? That determines how much of the manifest is new code.
6. **Was commit rate watched during the rehearsal, and how?** If there is
   already a query, `cf inspect churn` should adopt it rather than invent one.
7. **Anything that made the clone lie** — behaved differently from production in
   a way that mattered?

## References

- Gideon's migration writeup, 2026-07-25 (Discord).
- Board topics: "Cross-version generated-cell identity collisions cause Topics
  write storms"; "Pattern verb contract…" (Deployment section); "Board outage
  2026-07-10…".
- PRs [#4997] (migration-safe legacy Topics; the rehearsal that caught it),
  [#4916] (generated-cell identity versioning), [#4991] (verb contract WS-A).
- `docs/plans/pattern-verb-contract-implementation.md` — Risks, the write-storm
  gate.
- `docs/development/LOCAL_DEV_SERVERS.md` — toolshed over a store dir, port
  offsets.

[#4916]: https://github.com/commontoolsinc/labs/pull/4916
[#4991]: https://github.com/commontoolsinc/labs/pull/4991
