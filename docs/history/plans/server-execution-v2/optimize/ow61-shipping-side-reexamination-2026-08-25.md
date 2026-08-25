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

## What this leaves open

The shipping side has no demonstrated defect on any path reachable
without the CI timing window, and a defect in it now fails at the memory
layer instead of cross-package. What is not settled is the window
itself: whether the frames CI's replicas receive are under-delivered by
the server, or delivered and not absorbed. Answering that needs the
per-session frame probe running inside a CI lane, not a local one.
