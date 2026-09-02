---
status: historical
created: 2026-08-25
archived: 2026-08-25
reason: "Investigation record: OW61's shipping side re-examined at 9e9562177, falsifying the prior localization and boarding the ensure-ON lanes."
---

# OW61 shipping side, re-examined (2026-08-25, tip `9e9562177`)

A record of what was measured while re-examining the read-side `cid:`
closure delivery guarantee, on PR #6265. It corrects the localization the
row's successors were carrying, states what the delivery-invariant probe
found, and boards the ensure-ON lanes.

## The prior localization does not hold

The brief this session started from placed the defect in
`assembleSchemaDocClosures` (`packages/memory/v2/query.ts`): its
`while (pending.length > 0)` walk was said never to complete one
iteration, leaving `additions` permanently empty and the closure pass
silently dead. Instrumenting the loop says otherwise.

| Measurement | Result |
| --- | --- |
| `runner/test/executor-space-root-ensure.test.ts` | 156 calls, 168 pops, 22 calls staging 2 additions each |
| whole `packages/runner` unit suite | up to 8 additions per call |

The loop runs and the pass stages.

Three further claims, each checked directly:

**The named reproduction does not reproduce anything.** All four
`schema-doc-quarantine` lines that
`grep schema-doc-quarantine` finds in that file come from the one step
that deliberately drops every `cid:` upsert at the reader replica — this
row's own containment pin, whose interceptor reads
`if (upsert.id.startsWith("cid:")) { droppedCids += 1; return false; }`.
Changing that single `return false` to `return true`, and nothing else,
takes the count from 4 to 0. The step's own `droppedCids > 0` wait exists
to keep the pin from going vacuous, so the grep measures the simulation
and will print four lines whatever the server does.

**The delivery invariant holds everywhere it could be probed locally.** A
temporary per-session probe at all four server frame-emission points
(`watch.set`, `watch.add`, push, full re-evaluation) checked that every
`cid:` a delivered document references was carried by that frame or by an
earlier frame of the same session, crediting the CT-1965 own-write echo
elision, whose writer supplied the bytes:

| Surface | Ref-carrying frames | Violations |
| --- | --- | --- |
| whole `packages/memory` suite | 0 | 0 |
| whole `packages/runner` unit suite | 118 | 0 |
| `packages/runner` + `packages/runtime-client` integration, ensure ON | 260 | 0 |

The integration runs used a source-run toolshed with
`EXPERIMENTAL_SERVER_EXECUTION=true` and the space-root ensure enabled
(`rootEnsure.created` reached 37), and logged zero client quarantines.

**The row's own "Cz/Nz/xz reference g2" is wrong.** Dumping the four
documents shows all of them are leaf schemas with no external refs, so
that sentence describes the client validator's quarantine fixpoint over
*referrers*, not a schema-ref edge.

## The coverage hole, and the pin that closes it

The `packages/memory` row of the table above is the finding: zero
ref-carrying frames, because no test in the package drove a
`cid:`-mentioning document through a session frame at all. Neither half
of the guarantee — ship the closure, elide what the session already
holds — had memory-package coverage, which is why a defect in it could
only ever surface as a cross-package integration mystery.

`packages/memory/test/v2-schema-doc-closure-delivery.test.ts` pins seven
properties over one scenario driven through the real session machinery.
Every watch uses the selects-nothing selector, the space-cell-only
subscriber shape this row names as the trigger: that walk never descends
through a link, so the closure pass is the only route a mentioned schema
can arrive by. Under a walking selector the traversal loads them anyway
and every assertion passes with the closure pass entirely disabled —
which is exactly the "reaches the client by incidental graph traversal"
observation, and the reason the first draft of the pin was worthless.

| Mutation | Result |
| --- | --- |
| closure pass stages nothing | all seven red |
| its transitive dep walk removed | exactly the transitivity leg and the whole-guarantee leg red |
| push path's `sameSnapshot` elision removed | exactly the elision leg red |
| push path emits no frame | the drain throws, naming what it waited for |
| closure pass's `tracker.has(key)` staging gate removed | **all green** |

The last row is worth keeping. That gate changes no wire frame, so it is
not what protects the ruling against retransmitting schemas: the
anti-retransmission guarantee lives in the frame builders' session-cache
diff, and the gate is CPU saving over a redundant predicate.

## The ensure-ON board

The four `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false` lines removed, so
the ON lanes run the production posture. Two boards, and they disagree.

**Local**, a `build-binaries`-built toolshed carrying an ON shell
(`shellServerExecutionDefine` `"true"`), serving loop up, ensure enabled
and running (`rootEnsure.created` reached 88 across 11 active spaces,
1113 waves), shards run one at a time against it:

| Shard | Result | `schema-doc-quarantine` |
| --- | --- | --- |
| 1/10 | 9 passed | 0 |
| 2/10 | 7 passed, 1 failed | 0 |
| 3/10 | 3 passed | 0 |
| 4/10 | 7 passed | 0 |
| 5/10 | 10 passed | 0 |

**Continuous integration**, run 32868098064, same posture:

| Shard | Result | `schema-doc-quarantine` | Distinct `cid:` ids |
| --- | --- | --- | --- |
| 1/10 | 6 passed, 3 failed | 245 | 18 |
| 2/10 | 7 passed, 1 failed | 105 | 18 |
| 4/10 | 6 passed, 1 failed | 84 | 57 |

Nine of ten shards failed there. The quarantined document is the one this
row named from the original board —
`computed:fid1:7BycCyHc2yDDzr17jnXayWZMxpweSGk2JcGKILKguvo`, the
default-app root's computed cell — reported against a missing
`cid:fid1:zgJY1m9lR0Dh7z3JibtgiCszZhZ2aLfzIC0zPjoIqTQ`.

So the class is real and reproduces at the ensure-ON posture, and the
local board does not reach it: same tip, same posture, same shard files,
zero quarantines locally against 245 in shard 1 alone. That is the
delivery-window timing the row already recorded ("CI hit it consistently;
one local run at the same head did not"), now with both sides measured at
one tip. The one failure the local board does reproduce is
`patterns/integration/shared-profile.test.ts`, "uses each user's home
profile when rendering a shared pattern", which times out with the pane
reading `No profile` and fires no quarantine — a separate question from
this row's class.

## The window, settled: the server delivers the closure

The probe was carried into a CI pattern lane (PR #6276, a throwaway
diagnostic branch: shard 1 only, ensure ON, `OW61_PROBE=1`, and a step
dumping the verdict from the toolshed log), because the class does not
reproduce on demand locally. One run answers it.

In that single run, the same lane produced both halves:

| Side | Measurement |
| --- | --- |
| client | 103 `schema-doc-quarantine`, 13 distinct missing `cid:` ids |
| server | 136 ref-carrying frames, **0 delivery violations**, 0 held-cid elisions |

The quarantined pairs include this row's own document —
`computed:fid1:7BycCyHc2yDDzr17jnXayWZMxpweSGk2JcGKILKguvo` against
`cid:fid1:zgJY1m9lR0Dh7z3JibtgiCszZhZ2aLfzIC0zPjoIqTQ` — five times,
alongside seven sibling documents naming the same missing hash.

Zero violations means every `cid:` a delivered document referenced had
been put on the wire for that session, in that frame or an earlier one,
and none was elided as an own-write. So the closure WAS shipped and the
receiving replica still could not resolve it. That is the owner's
2026-08-24 ruling in measured form: "if we saw this in CI — earlier
frame delivered cid doc, later frame didn't see it — then that's the
actual bug", and the bug is client-side absorb or retention, not
server-side under-delivery.

The bound on that claim: the probe observes what the server puts into a
frame for a session, not what the socket carried or what the replica
applied. It therefore locates the loss at or after the client's receipt
and rules out the shipping side; it does not distinguish a frame lost in
transport from one received and not absorbed.

A second theory was tested and falsified on the way. Under server
execution the server computes on behalf of a client session and carries
that client's session id (`space-server.ts` passes
`sessionId: record.sessionId` into `noteExecutorCommit`), which would be
a leak if it reached the dirty-origins table the push path's own-write
echo elision reads: a document elided from the wire would still commit
into `session.entities`, the table of what the client holds. It does not
reach it — `noteExecutorCommit` calls `markSpaceDirty(space, keys)` with
no origin argument, which actively DELETES any origin on those keys, so
server-computed writes fan out authoritatively to every session
including the one they were computed for. Only two call sites set an
origin, and neither is server-side compute: `transact`, whose session id
is the committing client's own, and the ingest append, which classifies
`"patch"` — the never-elide shape. The engine's confinement of `cid:`
documents to space scope is a third guard. The probe agrees: 0 cid
documents elided as own-writes across every frame it observed. That
invariant is implicit today — threading `record.sessionId` through to
`markSpaceDirty` would read like an improvement and would silently
create the leak — so it is worth a guard.
