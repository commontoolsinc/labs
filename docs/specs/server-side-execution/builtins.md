# v2 detail: built-in contracts

Normative expansion of [README.md](README.md) §3.5. One entry per
built-in family; an implementer should be able to port a built-in to the
serving loop from its row plus the referenced sections.

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Inventory: `packages/runner/src/builtins/` (registered via
  `registerBuiltins(runtime)` in `index.ts`).
- Raw builtin shape (from `navigate-to.ts`): a factory
  `(inputsCell, sendResult, addCancel, cause, parentCell, runtime) =>
  RawBuiltinResult` whose `action(tx)` runs under the scheduler. Served
  built-ins keep this shape — the serving loop hosts the same runtime.

## 1. Pure structural — serve as-is, speculable

`map`, `filter`, `flatmap`, `if-else`, `when`, `unless`,
`list-element-link`, `list-op-argument-usage`, `list-result-schema`,
`op-pattern-ref`, `inspect-conf-label`, `scope-policy`, `wish`.

Contract: deterministic functions of their resolved inputs; no memo, no
authority, no outbox. They run wherever the graph runs (server
authoritatively, client speculatively) with zero code difference. Port
cost: none beyond running the existing registration server-side.

`wish` note: destination-fixedness (v1 task) is subsumed — a wish
resolves to data; any enactment goes through the client-effect channel
if it ever needs one.

## 2. Effectful — server-only, memoized, outbox-driven

Common contract (serving-loop.md §4–5): memo key from resolved request;
hit ⇒ stored result is the value; miss ⇒ outbox; result + key in one
derived commit; error results advance the same way; in-flight dedupe by
key; client speculation reads through (speculation.md §2).

| built-in | request inputs (memo key basis) | result cell | authority | notes |
| --- | --- | --- | --- | --- |
| `fetch` (`fetchData`) | url, method, headers (allowlisted), body, response schema | `{ result?, error?, pending, requestHash }` | capability handle bound at wiring (README §3.8) | redirects/deadlines per existing `fetch-request-deadlines` doc |
| `fetch-program` | program source ref + integrity | compiled program ref | same | feeds `compile-and-run` |
| `llm` (`generateText` / `generateObject`) | model, messages/prompt, schema, params | settled result only (protocol.md §6 — no partial commits in v2) | broker-held provider keys; grant from handle | temperature etc. are inputs, so nondeterminism is memo-stable by construction |
| `llm-dialog` | dialog state + params | settled turns | same | multi-turn = new key per turn |
| `sqlite*` | database link, statement, params, **reader principal** | cleared rows per reader | read served under the reader's clearance | reader in the key is what "per-reader row admissibility" means mechanically (Phase 5 gate) |

FORBIDDEN: any of these executing in a client runtime under the flag;
result caches outside the cell (no process LRU that survives the memo
rule); streaming partial commits.

## 3. Compile / instantiate — server-side, sandboxed

`compile-and-run`: compiles + instantiates patterns (charm creation),
including when invoked from a handler's consequences. Runs in the
SpaceServer's runtime; compilation itself already happens server-side in
toolshed — reuse that path. Async work stays on the post-commit outbox
(the v1 lesson that ported: never block the loop on compilation).
Instantiated pieces join the space's graph and are served like any other.

## 4. Client-enacted — `navigate-to`

Split contract (protocol.md §5): the SERVED half computes the target
(existing `navigate-to.ts` logic minus any client assumption) and writes
`{ nonce, kind: "navigate", args: { target } }` to the firing session's
effects doc as part of the wave's derived commit. The CLIENT half
subscribes to its effects doc, enacts, acks by nonce. Optimistic
enactment from the speculative handler run is allowed; the nonce
reconciles it.

Implementation note: the served half needs the firing session's identity
— it comes from the event (`firedAt.session`, events.md §1). A
navigation computed outside any event context (pure derivation) has no
session and is a pattern error: navigateTo MUST be reachable only from
handler consequences. Enforce with a runtime check, not a type dance.

## 5. Deferred / excluded

- `stream-data`: disabled under the flag (owner, 2026-08-02 — unused;
  low-latency UI wants a different mechanism). A pattern using it under
  the flag gets a clear runtime error naming this section.
- `resume-recover`, `resume-republish`: v1-era compensation machinery.
  Do not port. If something seems to need them, that something is a bug
  in the serving loop's recovery (serving-loop.md §6) — fix it there.

## 6. Adding a new built-in under v2 (checklist for future work)

1. Classify: pure / effectful / client-enacted. There is no fourth class.
2. Pure ⇒ nothing else. Effectful ⇒ define the memo-key basis in §2's
   table via spec edit, wire the outbox, never the loop. Client-enacted ⇒
   new `kind` in protocol.md §5 via spec edit.
3. If the built-in seems to need per-run persisted provenance, a claim,
   or its own commit class — it does not; re-read README §2.
