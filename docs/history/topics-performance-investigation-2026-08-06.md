---
status: historical
created: 2026-08-06
archived: 2026-08-06
reason: "Point-in-time handoff of Topics startup latency, scoped-write, and Rapids snapshot evidence."
---

# Topics startup performance investigation handoff

## Purpose

This report freezes the evidence collected while publishing the 2026-08-06
weekly coherence audit to the Common Fabric Topics board. It is written as a
parallel-investigation handoff: another agent should be able to verify a claim,
open the downloaded database offline, or take one bounded research lane without
reconstructing the original conversation.

This is a point-in-time report, not current system documentation. The active
working notes and hypotheses remain in
[`../plans/topics-performance-improvement.md`](../plans/topics-performance-improvement.md).

No runtime, pattern, UI, or CLI source was modified during this investigation.
The only repository changes are Markdown reports and indexes. Remote writes were
limited to the requested coherence-audit Topic and the durable state generated
by ordinary diagnostic client startup.

## Executive summary

1. A genuinely path-narrow remote read does not create a commit. Reading the
   known audit Topic's `title` and `body` took 4.03–4.25 seconds in a fresh Deno
   process. Approximately 2.5 seconds was health plus authenticated session
   setup, piece synchronization took about 0.8 seconds, and each field pull took
   about 0.2 seconds. The server sequence remained unchanged.
2. Reads described as narrow can still be structurally broad. Synchronizing a
   Topic or board input root follows the `mentionable` link into the board graph.
   Those reads took 22–27 seconds on Rapids without creating commits.
3. Normal default-app startup is broad and did coincide with commits. The first
   controlled startup advanced the global sequence by 20; the next startup
   advanced it by four. Sequence deltas alone were initially misattributed to
   one client. The snapshot proves that two writer actors and several scopes
   were interleaved.
4. Berni's scope hypothesis is confirmed for steady state. All four commits in
   the repeat window are session-scoped sets. They write the same two document
   ids into fresh concrete session scopes with identical canonical values. They
   are startup cost, but they cannot conflict across sessions.
5. The cold window contains a different anomaly. Fourteen user-scoped commits
   touch seven documents in pairs. Every document changes away from its prior
   canonical value and later returns to the exact original hash during the same
   startup. The net result is no user-scoped change, but fourteen durable
   commits were paid. Equal-value suppression at the final commit boundary
   cannot remove these individually because each intermediate value is
   genuinely different; the question is why transient derivations are published
   instead of stabilized or coalesced.
6. The oscillating user documents look like a profile-wish cluster, not Topic
   crossrefs. Offline labels include a wish-shaped object with `$UI`,
   `candidates`, and `result`; a profile name (`"Berni"`); several booleans; and
   a VDOM-shaped object. This shape matches the Topics board's three profile
   wishes and derived profile state, but exact source ownership remains to be
   proven.
7. The 2.31 GiB headline is overwhelmingly history storage, not current Topic
   prose. The actual snapshot is 2.50 GB. Its SQLite `commit` table occupies
   1.928 GB and `revision` occupies 443.6 MB. The current Topic corpus measured
   only about 210 KiB with 25 in-board prose-reference edges.
8. Crossrefs remain relevant to broad read/materialization cost, but the
   captured commits do not support calling the write churn "crossref
   recomputation." The default app recursively expands the Topics board's full
   piece-valued result surface; local profiling showed 229 documents and 318
   paths. The specific cold writes observed here instead point toward scoped
   profile/wish initialization.

## Snapshot manifest

Treat this file as the shared, immutable baseline for parallel work.

| Field | Value |
| --- | --- |
| Source host | `https://rapids.saga-castor.ts.net` |
| Space | `did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk` |
| Topics board | `fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34` |
| Audit Topic | `fid1:GvBM7LXMJJKrgPp4KVHbnnQXQ2UQUmE_89C49vc4J6s` |
| Local snapshot | `/Users/ben/.cache/cf-inspect/rapids.saga-castor.ts.net/did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk.sqlite` |
| Bytes | `2,498,560,000` |
| SHA-256 | `47a97cf28edc239d895052904b826fb7e584b4260f7786cf591f81413b10aef7` |
| Database head | commit sequence `315287` |
| Commit range | `1–315287` |
| Client/server revision at successful retry | `033deef6b0943b7eb54c7643c30320757f81b55c` |
| Local file birth | `2026-08-06T11:12:58+1000` |
| Local file completion | `2026-08-06T12:23:15+1000` |
| Successful transfer duration | approximately 70 minutes |
| Authentication key used | `/Users/ben/.cf/inspect-remote.key` (path only; do not copy its contents) |

The earlier remote space listing reported `2,476,507,136` bytes. The successful
fresh `VACUUM INTO` snapshot is `2,498,560,000` bytes. Do not assume the listing
size is an immutable content length.

The first download reached `1,506,693,106` bytes (60.8% of the earlier listed
size) before a Rapids redeploy closed the response. The inspector deleted the
partial and restarted from byte zero. The endpoint makes a fresh full
`VACUUM INTO`, streams raw SQLite without compression, and has no Range or
stable-snapshot resume protocol. The successful retry therefore required a
second complete transfer.

### Verify before using

```sh
shasum -a 256 '/Users/ben/.cache/cf-inspect/rapids.saga-castor.ts.net/did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk.sqlite'
```

Expected hash:

```text
47a97cf28edc239d895052904b826fb7e584b4260f7786cf591f81413b10aef7
```

Use `cf inspect` or `sqlite3 -readonly` directly against this file. Do not serve
or mutate it. If an experiment needs a writable database, first read
[`../development/space-clone-rehearsal.md`](../development/space-clone-rehearsal.md)
and create a separate clone. A served clone must be bound to `127.0.0.1`; it
keeps the production space DID, so host and port are the only safety boundary.

## Database inventory

`cf inspect summary` reported:

| Measure | Count |
| --- | ---: |
| Commits | 315,287 |
| Sessions | 1,197 |
| Revisions | 354,299 |
| Current entities | 23,566 |
| Patch operations | 313,534 |
| Set operations | 40,765 |
| Scheduler tables | present |
| Scheduler observations | 0 |

Revision distribution:

| Scope kind | Revisions | Distinct ids | Concrete scopes | Stored payload bytes |
| --- | ---: | ---: | ---: | ---: |
| Space | 332,980 | 21,927 | 1 | 321,048,870 |
| Session | 19,512 | 1,607 | 835 | 53,824,920 |
| User | 1,807 | 792 | 29 | 498,175 |

Largest SQLite structures (`dbstat`):

| Structure | Bytes |
| --- | ---: |
| `commit` table | 1,927,643,136 |
| `revision` table | 443,613,184 |
| `idx_commit_session_local_seq` | 37,322,752 |
| revision primary-key index | 27,754,496 |
| `idx_revision_branch_id_seq` | 27,754,496 |
| `head` table | 5,046,272 |
| live-entity-id index | 4,816,896 |

The `commit` table alone is about 77% of the snapshot. Current-entity count and
Topic text volume do not explain the file size. A useful follow-up is to break
the `commit` table into `original` versus `resolution` payload bytes and identify
which commit classes dominate retained history.

The durable board scan found 86 board entries. Seventy-nine resolved through
the expected wrapper-to-Topic chain. Their combined body/comment/link corpus
was 210,729 bytes: 209,859 body bytes, 91 comments, 78 links, 44 fid mentions,
and 25 distinct in-board edges. Seven entries remain to be classified as null,
stale, mixed-version, or scope-dependent.

## Exact startup commit analysis

### Phase and actor correction

The controlled client sampled only the global `serverSeq`; it did not prove
that every intervening commit belonged to that process. The snapshot joins each
revision to its writer session and corrects that mistake.

The first observed sequence window was `315264–315283` (20 commits, 21 revision
rows because commit `315264` contained two operations):

| Window | Timed phase | Writer | Scope result |
| --- | --- | --- | --- |
| `315264–315273` | manager load | client-timed actor | 2 session sets, 6 user patches, 3 space patches; `315264` had both session and space operations |
| `315274–315281` | default-app startup | same client actor | 8 user patches |
| `315282–315283` | before default-app phase completed | distinct actor/session | 2 session sets |

The immediate repeat window was `315284–315287`:

| Window | Timed phase | Writer | Scope result |
| --- | --- | --- | --- |
| `315284–315285` | manager load | original client session | 2 session sets |
| `315286–315287` | default-app startup | distinct actor and fresh session | 2 session sets |

The distinct actor's operational role is not yet proven. Do not call it the
server-execution actor without mapping its DID to deployment identity.

### Steady-state session writes

Sequences `315282–315287` write the same two ids into three concrete session
scopes:

- `of:fid1:LaFtomRzChrcyFJg156LkWLHrOAFm7cADdbMT1Uj-O8`
  - identical canonical document hash in all three scopes:
    `9AFfPc3QxxnsDSgf`
- `computed:fid1:Djt2mteUsPM7xYqzyAbcQZEwUhUFRtNcUu_dL2GyxUs`
  - identical canonical document hash in all three scopes:
    `j-Y98zXUxHzmRGtx`

Every concrete scope was previously absent. These are expected fresh-session
materializations under Berni's model. They cannot conflict across sessions.
They still contribute latency, history growth, and two commits per session, so
their cost can be optimized independently of conflict correctness.

### Cold user-scope oscillation

Fourteen commits affect seven user-scoped documents. Each document moves from
canonical state A to B, then returns from B to exactly A:

| Document | Away commit | Return commit | Current offline shape |
| --- | ---: | ---: | --- |
| `of:fid1:ekK9WamqRQCyUegkcvGzLUIPYqtxPzdShelfDSqOQeo` | 315265 | 315275 | wish-shaped object with `$UI`, `candidates`, `result`; links to an external profile space |
| `computed:fid1:GRYfKW9M-RhA6hsP1iFVKjLiyEhCN0twmIh1eVz58n0` | 315266 | 315276 | string labelled `"Berni"` |
| `computed:fid1:fEanBMHbu960fPII8Lrv14FlbE7xEdkBLL7TPj6mXsM` | 315267 | 315277 | boolean `true` |
| `of:fid1:Rj745zHQSVnLo4O9a4_WfmfkAkQtKS-xelShPqMm1IU` | 315268 | 315278 | VDOM-shaped object with `children`, `name`, `props`, `type` |
| `computed:fid1:1mvZkKP2xpxyQHZadpsFpxu9OezRDAIXKaylrIT9DAw` | 315270 | 315280 | boolean `false` |
| `computed:fid1:hE3og9N9lV8A1m2hjptA_B28o0lTOR8jyyfVS1JydKE` | 315271 | 315281 | boolean `false` |
| `computed:fid1:uVfM-fxemVvHDKI8qDTfRhMrKEjN4kQMnNuB3f9Po-k` | 315274 | 315279 | boolean `false` |

The commits use `replace` patches, mainly at `/value`; the wish-shaped objects
replace result/candidate/UI links together. Every individual commit changes the
canonical document hash. The anomaly is therefore not "the storage layer
committed an equal value." It is "startup exposed a transient alternate
derivation and later reversed it."

The shape strongly suggests the board-level profile wishes at
`packages/patterns/topics/main.tsx:211-226`:

- `wish({ query: "#profile" })`
- `wish({ query: "#profileName" })`
- `wish({ query: "#profileAvatar" })`
- derived `profileName`, `profileAvatar`, and `hasProfile`

This attribution is an inference from scope, timing, shape, labels, and source.
Prove it with source-location/write-callsite tracing before filing a narrowly
named bug.

Historical user-scope rewrites are not unique to this run. Across the snapshot,
1,149 `(id, user-scope)` pairs exist; 206 were rewritten and carry more than one
distinct operation payload. Some hot user documents have 20–28 revisions and
three to six distinct payloads. A parallel lane should test whether those
histories show the same A→B→A profile-wish pattern across users and sessions.

### Space writes

Three space-scoped computed documents changed once in the cold manager phase:

- `computed:fid1:rLZpkjnn2V3ZQ2dO4_4g9J2DSyPvufpEPpClMvjFwL8`
- `computed:fid1:v8cF_Wc2EeTTHNnZ_3LyMreI9gtKk5emXLgqA9i0rqQ`
- `computed:fid1:JFrjuUpUJFfE7T4zYG3GDgzCQAeUcyhrDLsYLtALAxQ`

The latter two are owned cells currently labelled with timestamp-like strings
(`" · Aug 5, 15:09"` and `"Aug 5, 15:22"`). The first is no longer visible in
the current space-scope graph. These require ownership/source-location mapping.
Unlike the seven user documents, no reversal appeared in the captured window.

## Performance measurements

### Stateless transport and true path-narrow read

Raw HTTPS timing to both `/api/meta` and `/_health`:

| Phase | Time |
| --- | ---: |
| DNS | 2–4 ms |
| TCP connected | about 185 ms |
| TLS complete | 374–382 ms |
| First byte / total | 571–580 ms |

Known-fid `title`/`body` path pull with CLI phase timing:

| Phase | Time |
| --- | ---: |
| Identity/session construction | 41 ms |
| Runtime construction | 2 ms |
| Health/version round trip | 818 ms |
| Authenticated space-session establishment | 1.672 s |
| Piece synchronization | 821 ms |
| Title field pull | 203 ms |
| Body field pull | 197 ms |
| Script total | 4.03 s |

The body was the exact expected 9,697 bytes. The server sequence remained
`315287`. A separate equivalent run took 4.25 seconds with 192/190 ms field
pulls and also created no commit.

### Accidentally broad roots

- Full board-input sync: 27.01 seconds in `boardInput.sync()`, no commit.
- Known-fid full Topic-input sync: 21.89 seconds in `topicInput.sync()`, no
  commit.
- Cause: Topic input contains the board's full `mentionable` sibling link, so
  root synchronization is graph-shaped despite a known fid.
- `PiecePropIo.get(path)` has a real narrow path implementation at
  `packages/piece/src/ops/piece-controller.ts:2294-2330`; callers must avoid
  synchronizing the root first.

### Broad default startup

Two version-controlled Rapids `piece verbs` runs against the copied corpus each
took about 108 seconds before returning useful callable metadata. One detailed
run showed:

| Phase | Time |
| --- | ---: |
| Manager initial sync | 1.90 s |
| Default-app runtime start | 47.27 s |
| Default result pull | 6.39 s |
| Nested post-start sync | 8.06 s |
| Runtime idle | 1.61 s |
| Following manager sync | 40.56 s |
| Explicit Topics board start | 2.14 s |

The exact times are sensitive to cache warmth and the concurrent snapshot
transfer. The phase shape is the evidence: the long cost is default-app graph
startup and later synchronization waves, not establishing the first connection.

Estuary earlier showed a comparable total sink but placed 92.25 seconds inside
the phase labelled `loadManager.synced`. Rapids placed only 1.90–3.38 seconds
there. Current `synced()` implementations await snapshots of pending promise
sets rather than a fixed-point quiescence barrier, so scheduling can move the
same multi-wave work among adjacent timing labels. Do not treat the phase-name
difference alone as proof that the deployments perform different work.

### Local reproduction and CPU profile

A synthetic local fixture with 85 Topics and zero prose-reference edges still
made normal callable discovery take 20.44 seconds. This proves dense crossref
text is not required for the base pathology.

After warming, a detailed local run took 4.12 seconds:

- manager sync: 49 ms
- ensure default app: 2.40 s
- explicit Topics start: 145 ms
- `syncCellsForRunningPattern` inside default start: 2.00 s
- 147 cell syncs and 103 argument-link target syncs

The matching server query expanded one default-app registry root into 229
documents and 318 paths. Its `traverse` span was 1.96 seconds. Active CPU was
dominated by deep-freeze/cache insertion, garbage collection, canonical key
sorting, codec work, and value hashing; direct schema traversal was a small
fraction. The client CPU profile was about 69% idle.

## Source-level graph reach

The default app starts these surfaces unconditionally:

- `BacklinksIndex({ pieceRegistry })`
- `SummaryIndex({})`
- `PieceGrid` views

See `packages/patterns/system/default-app.tsx:191-195`.

`BacklinksIndex.computeMentionable` recursively calls `get()` on each registry
member and follows its `mentionable` export to depth five
(`packages/patterns/system/backlinks-index.tsx:95-129`). A registry containing
only the Topics board is therefore not bounded: the board exports 86 complete
Topic piece results, and those contracts include piece-valued crossrefs.

`BacklinksIndex.computeIndex` also explicitly clears and repopulates backlinks
for pieces that expose that field (`backlinks-index.tsx:44-73`). The Topics board
does not obviously expose `backlinks`, and none of the captured startup writes
has yet been mapped to this function.

Topics computes crossrefs at two levels:

- whole-board join in `packages/patterns/topics/main.tsx:279-330`
- one sibling-wide join inside each Topic at
  `packages/patterns/topics/topic.tsx:723-779`

Both comments say the derived crossrefs are not persisted. Runtime internals
may persist computed result cells, but the exact captured writes analyzed above
do not look like Topic crossref rows. Treat crossrefs as a confirmed broad-read
reach/cost concern and an unproven write-churn cause.

## Safe starting commands for parallel agents

Run these from a checkout at the revision under investigation. They are
read-only against the cached database.

```sh
SNAPSHOT_DB='/Users/ben/.cache/cf-inspect/rapids.saga-castor.ts.net/did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk.sqlite'

deno task cf inspect summary "$SNAPSHOT_DB" --json
deno task cf inspect scopes "$SNAPSHOT_DB" --json
deno task cf inspect hot "$SNAPSHOT_DB" --limit 50 --json
deno task cf inspect conflicts "$SNAPSHOT_DB" --limit 100 --json
deno task cf inspect churn "$SNAPSHOT_DB" --bucket 60 --json
```

Exact startup revision rows:

```sh
sqlite3 -readonly -header -column "$SNAPSHOT_DB" \
  "SELECT r.commit_seq, r.op_index, r.id, r.scope_key, r.op, c.session_id,
          c.created_at
     FROM revision r JOIN \"commit\" c ON c.seq = r.commit_seq
    WHERE r.commit_seq BETWEEN 315264 AND 315287
    ORDER BY r.commit_seq, r.op_index;"
```

Snapshot size distribution:

```sh
sqlite3 -readonly -header -column "$SNAPSHOT_DB" \
  "SELECT name, sum(pgsize) AS bytes, count(*) AS pages
     FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 20;"
```

Do not use a normal `sqlite3` session that can write. Do not run `VACUUM`,
create indexes, or attach a writable journal to the shared baseline.

## Suggested parallel lanes

### Lane A: prove profile-wish ownership and transient ordering

Map the seven user document ids to pattern/source locations and transaction
callsites. Reproduce one A→B→A sequence on a loopback clone with write tracing.
Determine which dependency is unresolved when B is published and what later
event restores A.

Deliverable: id → pattern instance → source location → trigger ordering table.

### Lane B: historical oscillation census

Inspect the 206 rewritten user `(id, scope)` pairs. Detect A→B→A subsequences,
cluster by document shape and writer identity, and establish whether the same
wish cluster repeats for multiple humans and sessions.

Deliverable: counts and representative hash-only timelines; no user values.

### Lane C: local exact-clone startup profile

Create a separate writable clone following the rehearsal procedure, serve it on
loopback, and measure:

- plain health/session establishment
- true known-fid path pull
- board/Topic root sync
- default-app startup with query counts
- outgoing commit scope/id/hash trace

Do not run a migration or `setsrc`; this lane needs only startup behavior.

Deliverable: phase ledger aligned to local commit sequences and CPU/trace spans.

### Lane D: commit-table storage anatomy

The `commit` table accounts for 1.928 GB. Break its retained bytes into
`original`, `resolution`, and other columns; rank commit classes by size; check
whether read sets or resolved values duplicate revision payloads.

Deliverable: byte accounting that sums to the physical table size, with a
concrete compaction/retention question rather than a speculative fix.

### Lane E: default-app reach reduction experiment

In an isolated branch or disposable experiment, replace full piece `get()`
discovery with the smallest identity/name/mentionable projection that preserves
required behavior. Compare documents, paths, startup wall time, and writes.

Deliverable: before/after measurements. Do not propose landing the change until
humans decide which registry fields must remain live and durable.

### Lane F: snapshot acquisition ergonomics

Prototype or design resumable, compressed snapshot acquisition with a stable
snapshot token. Account for server temp-file lifetime, authentication,
integrity/hash verification, redeploys, and concurrent dump limits.

Deliverable: small design proposal; no production endpoint expansion.

## Questions for humans

1. Is publishing transient per-user wish states during startup permitted, or
   should dependent derivations become visible only after a consistent wave?
2. Is the distinct writer DID in sequences `315282–315283` and
   `315286–315287` the server-execution identity? If so, why does both client
   and server execution materialize the same two per-session documents?
3. Does default-app discovery need complete live Topic results, including
   crossrefs and UI, or only compact launch/mention metadata?
4. Should a fresh CLI that requests one known path pay a health request plus a
   separate authenticated session-open sequence every time, or can safe session
   reuse reduce the roughly 2.5-second setup floor?
5. Is `synced()` intentionally a snapshot barrier, despite its name? Which API
   represents fixed-point quiescence for diagnostics and CLI phase reporting?
6. What retention policy is intended for 315,287 commit envelopes when the
   current state is 23,566 entities and the `commit` table occupies 1.928 GB?
7. Are the seven unresolved board entries expected historical shapes, or stale
   links that should be repaired?

## Conditional issue proposals

These are not tickets to create until the relevant human answer is known.

1. Prevent or coalesce A→B→A per-user profile-wish publications during cold
   startup.
2. Add scope to the runtime write-stack trace. The current recorder drops
   `address.scope`, so it cannot distinguish shared from per-session writes.
3. Add a compact default-app piece-discovery projection and benchmark it against
   the full `get()` traversal.
4. Split CLI phase telemetry by health, session open, root sync, default start,
   result pull, and later synchronization waves; include pending promise/query
   identities at each barrier.
5. Add compressed, resumable staging snapshot acquisition with integrity
   verification.
6. Define and implement an explicit commit-envelope retention or compaction
   policy after byte accounting confirms the dominant payload.

## Artifacts and provenance

- This frozen handoff report:
  `docs/history/topics-performance-investigation-2026-08-06.md`
- Live working notes:
  `docs/plans/topics-performance-investigation.md`
- Original coherence audit and weekly automation prompt:
  `docs/history/coherence-audit-2026-08-06.md`
- Cached immutable SQLite snapshot: path and hash in the manifest above.
- Temporary diagnostic scripts were kept under `/private/tmp` and are not
  durable collaboration artifacts. Recreate a needed probe from the commands
  and semantics in this report rather than depending on those files.

The audit Topic was posted with transport identity
`/Users/ben/code/labs/claude.key`, content attribution `Ben (via Codex)`, and
stable invocation id `weekly-coherence-audit-2026-08-06`. The audit Topic fid is
listed in the snapshot manifest.
