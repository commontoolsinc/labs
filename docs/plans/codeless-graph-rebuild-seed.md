# Seed: codeless graph rebuild (parked arc)

A design seed for a **parked** arc — recorded 2026-08-27 from the
server-execution v2 coordination chat so the facts that make the arc possible
are written down while they are fresh. Nothing here is scheduled; the
keyless close-out (L3(a)) explicitly deferred handler-replay–class recovery
to this arc rather than building it.

## The owner's framing (2026-08-27, quoted)

> "the graph is already serialized into scheduler state by definition."

## The facts the arc stands on

Each of these is true of the current runtime, and together they make a
running piece's graph durably reconstructible without any keyless loading:

- **All source-authored code is module-addressed.** The transformer hoists
  every source-authored `lift()`/`handler()` body to a content-addressed
  `cf:module` (CT-1644/CT-1655). The runtime keyless population is therefore
  runtime-built pattern VALUES only — their *producing code* always has a
  durable address.
- **`scheduler_basis` holds restart-stable action fingerprints and observed
  read sets.** What ran, keyed stably across restarts, with what it read.
- **Piece materialization durably carries `(pattern identity, argument
  doc)`.** The instantiation inputs of a piece are already in the store.
- **Outputs are cause-derived.** Result/output doc ids derive from their
  causes, so the output *addresses* are reconstructible from the inputs —
  they do not need to be remembered independently.
- **The known gap: first-run nodes lack basis rows** (the D3 shape recorded
  in the register: a dropped first-ever run leaves no basis rows to re-run
  from). Everything that has run **once** has its `(code, inputs, outputs)`
  triple durably reconstructible; a node that never ran has only its
  pattern-side description.

## What the arc would build (when unparked)

Rebuild a runnable graph from durable state alone: walk `scheduler_basis` +
piece materialization records, resolve module-addressed code, re-derive
outputs by cause — no session-side artifacts required. That is the recovery
story for the class the keyless close-out ruled out of contract
(handler-created state outliving its session must instantiate from
content-addressed artifacts), and it would also close the D3 first-run gap
if basis rows gain a written-at-materialization form.

## Boundary with the keyless close-out

L3(a) (RULED 2026-08-27) made keyless identities never-durable and made
recovery semantics explicit: reactive producers re-derive on demand (run the
producing lift); handler-created-outliving-session is out of contract until
this arc exists. This seed is the placeholder that keeps that deferral
honest.
