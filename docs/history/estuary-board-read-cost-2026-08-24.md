---
status: historical
created: 2026-08-24
archived: 2026-08-24
reason: "Investigation record: why the Estuary topic board resisted CLI projection, what it actually costs to traverse, and the schema-duplication leads for the OOM that preceded the rollback."
---

# Estuary topic board: read cost, and leads for the OOM

Investigation of 2026-08-24, prompted by CLI reads of the Estuary topic board
returning nothing. It ran while Estuary sat rolled back to
`a667cf56a744c3e13c6e29592fc5b6b73965cf92` (#5878, content-addressed schemas
Phase 1) after OOMing on a newer build. The rollback's owner was away, so this
records the state for whoever picks it up.

Subject: board `fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34` in
`did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk`, 113 topics.

## What was measured

The board is readable. What is expensive is reading *through a projection*.

| Read | Result |
| --- | --- |
| `topics --input` (bulk, no projection) | 824,587 bytes, all 113 topics, prompt |
| `topics --input --select '@'` | 113 addresses |
| `index --step` (the compact survey) | succeeds, 2m09s |
| `topics --input --select <field>` | refuses without `--step`; with `--step`, exceeds 10 minutes |

The projection refusal is the same for every field tried — `title`, `body`,
`commentCount`, `$NAME`, `createdAt` — including fields present in all 113
stored elements. The message is
`Cannot read selected value: the filter/schema expression did not materialize a
JSON-renderable value. This is not JSON null.`

A census of the bulk dump against the board's full demanded field set found
**no deficient element**: every one of the 113 carries `$NAME`, `title`,
`body`, `createdAt`, `createdBy`, `createdByName`, `commentCount`,
`lastActivityAt`, `comments`, `links`, and all three verb streams.

`index --step` emitted the traverse instrument (`maybeReportSlowTraverse`,
`packages/runner/src/traverse.ts`), under `CF_TRAVERSE_DIAGNOSTICS=1`. One
traverse:

```text
traverseSchema=34826   anyOfBranches=52029   anyOfFastRejects=39631
uniqueDocs=2267        uniquePaths=14040     maxDepth=36
schemaMemo=0           schemaMemoHits=0
topDocs=data:application/vnd..=722 ..=475 ..=189 ..=126 ..=124
```

Three readings of that:

- **The schema memo never engages on this path.** `traverseWithSchema`
  (`packages/runner/src/traverse.ts`) gates memoization on
  `if (this.traverseCells)` — the query path, where `StandardObjectCreator`
  ignores the link param so the result is determined by address plus schema.
  A read that is not on that path is uncached, and `schemaMemo` reports the
  map's size while `schemaMemoHits` reports hits: both zero means nothing was
  ever cached, not merely that lookups missed. All 34,826 schema walks and
  52,029 `anyOf` branch evaluations were fresh, and 39,631 of those branches
  were fast-rejects — work done only to be discarded.
- **The hottest documents are `data:` immediates.** `topDocs` truncates ids at
  20 characters, so all five entries show as `data:application/vnd..`; that is
  `DATA_URI_MEDIA_TYPE` (`application/vnd.common-fabric.data`,
  `packages/data-model/src/data-uri-codec.ts`) — cells whose identifier carries
  its own frozen value. No fetch, no sync; but each of the 722 visits to the
  top one re-walks the schema.
- **Depth 36, 14,040 unique paths, in a single traverse.**

## What was ruled out

- **Version skew.** cf warns that it is 137 commits ahead of the server and
  names that as a possible cause. It is not: cf built at the server's own
  commit reproduces the projection failure identically.
- **A stale pattern generation.** The topic carrying the older `uqb-Pnk`
  identity answers every field the board demands.
- **A single deficient element voiding the array.** That mechanism is real and
  was measured separately on scratch spaces, but it is not what is happening
  here; see the census above.
- **A demand/holding shape mismatch.** The demand is satisfied by all 113.

## Leads for the OOM

Not measured — mechanism reasoning from the code and spec, offered as leads.

The live spec `docs/specs/content-addressed-schemas.md` names three surfaces
on which a schema is duplicated because nothing deduplicates it at rest. Two
bear directly on an OOM:

- **Per watch, client to server.** `refreshWatchSet`
  (`packages/runner/src/storage/v2.ts`) sends one watch spec per
  (doc, selector), each carrying the full inline selector schema, with no
  compression in that direction — and reconnect re-sends the whole accumulated
  watch set, so the payload *grows monotonically with the session's document
  count*.
- **Per link, at rest.** Every schema-bearing link carries a full `$defs`
  closure, and narrowing multiplies it: `schemaAtPath` re-attaches the
  reachable closure to every narrowed variant, so N views into one type store
  N overlapping closures.

The second describes this board's shape exactly. Each card is a narrowed view
into `TopicPiece`, over 113 topics, at the depth the traverse reports.

Two further facts about the pin:

- **The rollback target predates the fan-out fix.** #6020 (`61ab0e895`) is
  inside the 137-commit gap. Its own message describes the behavior it
  removed: a proof that an identical content-addressed re-set is unchanged was
  discarded "while a fresh revision fanned the unchanged document out to every
  watcher on every blind closure re-install." The version now serving still has
  that.
- **The mitigation is present but disabled.** `contentAddressedSchemas` is off
  by default (`docs/development/EXPERIMENTAL_OPTIONS.md`), and its Phase 2
  (#6011, `40baf1d60`) is also inside the gap.

## Not measured

Server-side memory, CPU, or write volume, before or after the rollback.
Nothing here establishes what the OOM actually was, nor whether the rollback
helped, hurt, or was orthogonal to it. The symptom shape — what grew, and over
what period — is the fact that would decide among the leads above, and it was
not available to this investigation.

## Incidental

No deployed topic carries a `setTitle` stream, while all 113 carry
`addComment`, `addLink`, and `setBody`. Verb streams do materialize in the
stored document, so the natural reading is that the Stage A topic update has
not reached the deployed topics.
