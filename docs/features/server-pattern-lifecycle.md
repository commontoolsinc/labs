# Pattern lifecycle verbs on the serving runtime

Under server execution, the two verbs that give a space a pattern — upload
a program, and instantiate a piece from it — run on the space's serving
runtime. The client's part is to resolve the program from disk and request;
the serving side compiles, materializes, and commits. This document is the
contract for that: the route a client calls, the authority it needs, where
the verb runs, what comes back, and what still happens on the client.

Replacing a piece's source is not a served verb. A source update carries
module-update authority, and [`module-loading.md`](../specs/module-loading.md)
requires that authority to be published from an owned setup transaction that
commits to storage itself; a serving wave's acceptance is withdrawable until
the wave commits, so the runner refuses a source update sealed into a wave.
`cf piece setsrc` therefore performs the update in its own process on every
deployment. Serving it needs the loop to register the update's authority at
the wave's settlement, which is the follow-up this document does not cover.

The verbs run only when `EXPERIMENTAL_SERVER_EXECUTION` selects the ON arm
([`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md#serverexecution)).
Off the flag a deployment has no serving loop, the route answers 503, and
`cf` performs each verb in its own process as it always has. `cf test` runs
a whole stack in memory and is untouched either way.

## The route

Two POST endpoints under `/api/pattern-lifecycle`, mounted by
`packages/toolshed/routes/pattern-lifecycle/`. Every body carries `space`,
the DID of the space acted in. A verb that takes a pattern takes it one of
two ways, and exactly one: `program` — the program as the client resolved
it, every file by name, with `main`, an optional `mainExport`, optional
`sourceRoots`, and optional `dataFiles` — or `pattern`, a
`{ identity, symbol }` pointer to a closure the space already holds. A body
naming both or neither fails validation.

| verb          | body                                                                                              | receipt                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `upload`      | `program`                                                                                         | `{ pattern }` — the pointer the space now holds the program under                  |
| `instantiate` | `program` or `pattern`; optional `argument`, `repository`, `slug`, `force`, `register`, `start`   | `{ pieceId, pattern, slug? }`                                                      |

A refusal is a JSON body `{ error, code }`. `code` is stable and is what a
client branches on; `error` is prose for a person.

| status | code                                   | meaning                                                                      |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------- |
| 401    | `unauthorized`                         | no valid first-party request proof                                           |
| 403    | `forbidden`                            | the caller is not a writer of the space, or there is no such space           |
| 404    | `pattern-not-found`                    | the named pattern is not in the space                                        |
| 409    | `slug-taken`                           | the slug names something and `force` was not set                             |
| 413    | `payload-too-large`                    | the body exceeds the limit, checked before authentication                    |
| 422    | `compile-failed`, `setup-failed`, `no-space-root` | the program did not compile; setup refused the pattern or the argument; nothing to register the piece with |
| 429    | `rate-limited`                         | the caller's request budget is spent, checked before authentication         |
| 500    | `internal`                             | the serving side failed for a reason it does not name                        |
| 503    | `server-execution-off`, `space-not-served` | no serving loop on this deployment; the space's lease is held elsewhere |

Body validation runs after authentication and answers 422 with the
validator's own body — a body naming both `program` and `pattern`, or
neither, fails there — so a client that sends what the schema describes never
sees it.

## Authority

Every call carries the CF1 first-party request proof
([`toolshed-access-control.md`](../specs/toolshed-access-control.md)), signed
with the caller's own identity key; `cf` signs with the identity it connects
as. The route then requires that DID to hold WRITE or OWNER on the space's
ACL, resolved the way the memory server resolves an authored commit — the
wildcard grant and the service principals count — so a caller the memory
server would admit writing directly is admitted here, and no other. A
deployment with ACL enforcement off admits every authenticated caller, as its
memory server does. One denial covers a malformed DID, a space the deployment
does not host, an absent ACL, and a caller without a grant, so the route is
not an existence oracle over the deployment's spaces.

The verb's own writes are the serving loop's, under the space's lease. The
instantiation transaction carries the requester's CFC trust snapshot, so a
label setup mints attributes to the requester rather than to the serving
identity.

## Where a verb runs

`ExecutorHost.runLifecycleVerb` hands a verb to the space's `SpaceServer`,
activating the space if it is parked. A verb request is an activation trigger
of its own: the requester holds no session on the space, so the criteria the
session-open and admission hooks consult do not apply. The `SpaceServer`
queues the verb and runs it as a step of its next wave cycle, after the
root ensure and ahead of the event drain, awaited in full, so every
transaction the verb seals joins that cycle's wave. The request settles once
the wave has committed and the verb's `confirm` step — a read of the durable
state the verb was to leave — has passed. A seal's acceptance is not
durability, since the wave commit can withdraw a contribution, and this is
what keeps a receipt from naming a piece that is not there. A space that
parks before a queued verb runs rejects it, and the host queues the verb
once more on the successor tenure.

A verb that stages a piece names the piece's root as its demand
(`LifecycleVerb.demandRoots`), and the loop takes every document the verb's
transactions wrote — the root, its argument, and the documents its computed
values live in — as warm demand for the tenure: the identity-less root key
the explicit warm request uses, which is what gets a piece derived that no
session demands. The verb's commit is the loop's own and never its input,
so once the wave has committed the loop re-announces those documents to
itself as a warm-marked notice, the carrier provisioning uses for the setup
it stages in another space; the next cycle takes it as input, its demand
pass loads the piece from the now-committed store, and the piece's first
runs seal into that cycle's wave.

The receipt does not wait for that derivation. It returns once the verb's
own wave has committed and `confirm` has read the piece back, which is the
point at which the piece is durable and can be resumed; the loop owes its
first run and serves it in the cycle after. A reader that needs the derived
value pulls it, which is demand the loop serves, rather than expecting a
creation to have run the graph.

The served creation takes the whole creation act into one transaction:
with `register`, the piece joins the space root's registry, and with `slug`
it is named — a name already pointing somewhere refuses the creation
outright unless `force` is set, so a refused creation leaves nothing
behind. `cf piece new` asks for both.

That seat rules out two things the client-side operations do. A transaction
the runtime seals into a wave cannot mint a durability receipt of its own, so
the runtime refuses `runSyncedWithCommit` while a seal destination is
installed; and the storage manager's full `synced()` waits on the wave commit
the verb is inside of and would deadlock. The served operations in
`packages/piece/src/ops/served-lifecycle.ts` therefore compose the lower
runner calls — `compileAndSavePattern`, and `setup` with a transaction the
verb stamps — and mint their receipts from what they wrote.

The `servingLoop.lifecycleVerbs` block of `/api/health/stats` counts verbs
whose run completed (`runs`) and verbs whose run threw or whose durable
confirmation failed (`failures`).

## What the client still does

The seed this implements records the direction as "client speculative-local,
server-state wins", and for `cf` there is nothing to speculate: the CLI
resolves the program locally — reading the files, pinning fabric imports —
and sends it. What `cf piece new` still does in its own process after the
receipt is what any client does when it opens a piece: it starts the piece,
which under the flag runs the graph as speculation while the serving loop
serves the derived values. `--no-start` skips that and sends `start: false`,
which leaves the piece set up and undemanded on the serving side too: the
loop derives it when something first demands it, not in the cycle after
the creation. The registry entry and the slug are part of the served
creation, and so is the space root the registry lives in: the serving loop
ensures the root on activation, ahead of the verb, so the client no longer
initializes it in its own process; a creation that finds no root is refused
with `no-space-root`. The request is awaited without a wall-clock bound,
since a creation the server is still committing lands whether or not the
client waits; the bound the client keeps is on its own start.

Other clients of the piece controller — the browser shell, the background
piece service — keep the client-side shape. Moving each is its own change;
the served operations and the route are what they move onto.

## Tests

- `packages/runner/test/executor-lifecycle-verbs.test.ts` — the queue: a verb
  activates a sessionless space and resolves once its write is durable, a
  failed run or a failed confirmation rejects and is counted, queued verbs run
  in order, and an inactive server refuses.
- `packages/piece/test/served-lifecycle.test.ts` — the served operations
  against a real memory server and serving host, read back through a client
  runtime opened afterwards.
- `packages/toolshed/routes/pattern-lifecycle/` — the writer check against
  a real ACL document, the status each refusal maps to, and the middleware
  order in front of the handler.
- `packages/cli/test/pattern-lifecycle.test.ts` — the client's signing and
  refusal handling against a stubbed fetch; `packages/cli/test/piece-integration.test.ts`
  and `packages/cli/integration/integration.sh` drive the real verbs against
  a toolshed in both CI arms.
