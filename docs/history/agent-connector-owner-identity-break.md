---
status: historical
created: 2026-08-25
archived: 2026-08-25
reason: "Decision record for the connector-managed agent sessions debug
  pattern's owner-scoped input contract before its first deployment."
---

# Agent connector owner-scoped input contract break

The agent connector and its debug view now receive an explicit owner DID and
one authoritative command cell. The owner participates in every deterministic
cell identity and stored protocol value. Common Fabric labels restrict session
discovery and command submission to that owner.

## The decision

The debug pattern's argument contract now requires `ownerDid` and a writable
`commandsCell`. The host is the only supported deployer of this pattern. It
always supplies its configured identity and the owner-protected command queue.
The earlier recorded contract was created before the connector was deployed
and has no running pieces to update.

The owner cannot have a safe default. An empty or shared default would either
mislabel private agent state or make command authorization ambiguous. Making
the field optional would move the same ambiguity into every read and write.
The command cell cannot remain an optional opaque input because the pattern
writes commands through it. The contract break is therefore accepted for the
single earlier baseline.

## What broke, on purpose

The compatibility checker reports at most one issue for each contract role. It
currently reports the first argument issue:

- `argument.ownerDid`: a newly required argument has no default.

Holding `ownerDid` compatible in a separate proof reports the second argument
issue:

- `argument.commandsCell`: the earlier optional opaque cell is replaced by a
  required writable array cell.

The legacy required `commands` argument is also removed. It duplicated the
command data instead of naming the cell the pattern writes. Extra argument
properties remain acceptable, so its removal does not produce a separate
compatibility finding.

The new contract is recorded as a baseline after this exemption. Later changes
must remain compatible with the owner-scoped shape.

## Disposition of deployed pieces

There are no deployed pieces using the earlier contract. The connector host
creates a fresh owner-scoped debug piece and passes the owner DID with the
owner-protected index, health, receipt, and command cells.
