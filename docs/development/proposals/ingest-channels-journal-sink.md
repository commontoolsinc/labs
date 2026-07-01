# Ingest Channels and the Journal Sink

*A minted, bearer-authed inbound endpoint whose payload can be durably accumulated as a provenance-marked, append-only record log — the generic capability behind webhooks, the location beacon, and any DID-less external source.*

**Status:** proposed · design-only · **gated on the cross-space-commit authorization check (see [The cross-space commit gate](#the-cross-space-commit-gate-blocker-a))** · **Updated:** 2026-07-01

Builds directly on the landed vouched-ingest primitive (labs #4392): the runtime-minted `ExternalIngest` mark + `custodyIngest`. See `vouched-ingest-channel-mint-design.md` for the split-mint seam this stands on.

---

## Why

An outside source with no runtime of its own — a phone location beacon, a GitHub webhook, an OAuth refresh, a wearable, an inbound-mail gateway — needs to durably deposit data into your fabric while your laptop is closed. Today every version of this is half-built and inconsistent:

- **Webhooks** take the POST but `sendToStream`-**dispatch** it (a transient event; `cell.ts:1235` queues a scheduler event and notifies in-memory listeners — it never persists a readable history). Consumers that want the *history* of what arrived have nothing to read.
- **OAuth and Plaid** each hand-rolled a durable write, now unified onto `custodyIngest` — but by direct library calls, not a general inbound endpoint.
- **Nothing** that arrives over any of these paths is marked as having come from outside — once it lands it is indistinguishable from data your own patterns wrote.

The forcing case is the **ambient-context location beacon**: the phone posts location points over HTTP because it has no runtime, and an agent reading your data must be able to tell "a third party sent this over the phone" apart from "I computed this myself." But the *need* is general — it is "durably ingest a sequence of externally-sourced records, with attached provenance, addressable by consumers as an accumulated log."

The missing piece is one generic capability. We already have the trust primitive (`ExternalIngest` + `custodyIngest`); what's missing is the **inbound endpoint that mints a durable, marked log** and a name for it that isn't tied to any one source.

## The shape — what you mint

You mint an **ingest channel**: a bearer-authed inbound HTTP endpoint bound to a target cell you provide (in your own space). This reuses the existing webhook registration/auth machinery verbatim — the registry in the toolshed service space, `wh`-style id + secret generation, SHA-256 hash, timing-safe verify with the dummy-hash timing-oracle guard, and the create/list/delete lifecycle (`webhooks.handlers.ts`, `webhooks.utils.ts`).

An ingest channel has a **sink** — where an inbound POST lands.

## Sinks: `stream` vs `journal`

| | `stream` (today's webhook) | `journal` (new) |
|---|---|---|
| Write | `sendToStream` → `.send()` | `custodyIngest.update` append |
| Semantics | transient event dispatch to handlers | durable, append-only record log |
| Readable history | no (fire-and-react) | yes (an accumulated array cell) |
| Provenance mark | none | `ExternalIngest`, minted per POST |
| Good for | "notify me when X arrives" | "keep the marked history of what arrived" |

`stream` and `journal` are genuinely different artifacts — a CF `stream` does not accumulate a readable history, so "just read the stream" is not an option for a consumer that needs the trail. `journal` is **additive**: existing `stream` consumers are untouched, so this is a non-breaking way to also deliver the long-deferred webhook provenance retrofit.

## The `journal` sink — how it works

One inbound POST → exactly one governed durable write:

```
custodyIngest.update(targetCell, current => [...(current ?? []), ...records], channel)
```

- `custodyIngest.update` (`custody-ingest.ts:169-180`) runs its mutate **inside** `editWithRetry`, re-reading the current array on every retry — no lost update under concurrent POSTs.
- It mints one `ExternalIngest` mark per POST, bound to the digest of the written value, anchored at the target cell root (works for array appends, which diff element-wise and never touch the array path itself).
- The mark records `{ channel, audience, receivedAt, valueDigest }`; `channel` = the target cell's space, `audience` = a fixed source string. `receivedAt` is operator wall-clock captured before the write (never from the payload).
- The sink does **no deduplication** — it appends. Idempotency is a consumer/read-side concern (see [Cross-repo contract](#cross-repo-contract-loom-read-side)).

**Partitioning is a client concern, not server logic.** For a high-volume trail (Berni's steer: "array-push isn't the right abstraction for a large continuous trail"), the caller addresses a **leaf** under the channel's registered base cell — e.g. one cell per UTC day. The client (which knows each record's timestamp) names the leaf; a batch spanning a partition boundary is split client-side into one POST per leaf. The server never parses payload fields to route. The leaf is **validated** (fixed charset / pattern, no traversal, strictly confined to the registered base path and space) — see [Security](#security-model--the-create-authorization-gap).

## Location is a consumer — zero labs-side location code

The location beacon is *not* a feature in labs. It is an ingest channel with a `journal` sink:

1. A `journal` ingest channel is registered, its target base a cell in the user's location space.
2. The iOS beacon batches `location.point` records and POSTs each UTC day's batch to that day's leaf (`.../<YYYY-MM-DD>`), one POST per day.
3. The `journal` sink durably appends the lean points, marked, into the day cell.
4. loom's read side wraps the lean points into `loom.source-record.v1` envelopes **on read** and dedups on `point_id`.

Nothing named "location", "trail", or any loom schema lives in labs.

## Layering — labs stores lean, loom wraps on read

labs stores the **lean** records byte-identical to the wire payload, with zero labs-added fields. The `loom.source-record.v1` envelope — its `recordId` convention, `canonical_json`, and `versionId` — stays entirely in loom, on its read/import side, which already owns that schema and its Python hashing. This keeps the dependency direction correct (labs is upstream of loom; loom vendors labs) and deletes the TS↔Python `canonical_json` parity burden entirely: with no second serializer, there is nothing to keep byte-identical.

Provenance at rest is the runtime-minted `ExternalIngest` mark — stronger and fabric-native — not the envelope.

## What's reused vs. new (minimized surface)

**Reused verbatim (zero new runtime primitives):**
- `custodyIngest.update` — the entire write path.
- The webhook bearer-auth flow: Bearer-present→401, registration lookup→502-on-storage-error, missing/disabled→dummy-hash-equalized verify→401, timing-safe verify→401 (`webhooks.handlers.ts:106-135`).
- The service-space registry: get/save/delete + per-space index, keyed by `identity.did()` (`webhooks.utils.ts`).
- The caller-cell resolution idiom (`getCellFromLink → asSchema → sync → synced`) and the `VouchedChannel` shape (OAuth precedent, `oauth2-common.utils.ts`).

**Genuinely new, and small:**
- A `sink: "stream" | "journal"` field on the channel registration and one write-branch on ingest.
- Validated **leaf-addressing**: a POST names a sub-path leaf appended to the registered base (charset/pattern-checked, traversal-guarded, confined to base+space).
- The `journal` write itself (one `custodyIngest.update` per POST).

## Naming

- **ingest channel** — the capability. Aligns with the existing vocabulary: the mark is `ExternalIngest`, the primitive `custodyIngest`, the mark records a `channel`, and the umbrella proposal is "vouched ingest channel." Replaces both "webhook" and any "location endpoint" as the umbrella concept.
- **`journal`** — the durable sink. Chosen over "trail" (a location-domain leak from "location trail") and over "log" (which collides with the toolshed's pervasive logger vocabulary). "journal" carries the right connotation — durable, ordered, append-only, integrity-flavored.
- **`stream`** kept for the existing dispatch sink; it accurately names what it is.

## Security model & the create-authorization gap

- **Blast radius is the registered target.** A channel's bearer token can only write within its registered base cell + space (plus a validated leaf under it) — the same blast radius as a webhook today.
- **The mark cannot be forged.** The payload is written under the ordinary member identity and gated (`gateRuntimeMintedIntegrity` strips any smuggled `ExternalIngest`); the trusted mark comes only from the runtime's builtin mint step. Sandboxed pattern code cannot mint it.
- **Open gap — confused-deputy on create.** Channel creation is currently unauthed and `createdBy` is self-asserted (inherited from webhooks). Harmless-ish for a `stream` webhook; **not** acceptable for a `journal` sink, which writes *provenance-marked* data into a caller-named user space — anyone reaching create could register a channel targeting *another* user's space and get legitimately-minted marks written there. **v1 must gate `journal`-sink creation on a real authenticated caller principal.**
- **Honest limit.** The toolshed runtime is `as: identity` and sees plaintext; the split-mint protects the *mark*, not the *bytes*. Estuary now holds and appends over plaintext record data as an operator-trusted process; a signer-key compromise is a cross-user breach + the ability to write marked fabricated records. Document in the custody/data-flow docs; treat the signer key as high-value.

## The cross-space commit gate (blocker A)

"No laptop in the write path" requires the toolshed operator identity to `merkle-causal-commit` into the **user's** space (a different DID than the operator's own). This is the load-bearing gate for the whole architecture, and it is **being verified** (an investigation is in flight):

- The toolshed runs CFC `cfcEnforcementMode: "enforce-explicit"` (`runtime.ts:495` default; toolshed passes no override). CFC enforcement is about integrity/confidentiality **labels**, not space ownership — marks mint fine — but it *can* abort a tx.
- The distinct, decisive gate is the **memory-layer** write authorization (likely a `MEMORY_ACL_MODE` disabled/observe/enforce): does the memory service authorize a non-owner signer to commit into a space?
- Current expectation (to be confirmed): permissive today — Berni's "webhooks run under a system DID today" implies the system identity is broadly authorized, which is exactly what the deferred grant work was meant to tighten. If a deployment enforces the memory ACL without a grant, the hosted-write path needs that deferred grant/delegation work and no `journal` channel into a user space ships.

Every `custody-ingest` test writes into `signer.did()` (its own space); there is **zero** cross-space test coverage. The cheapest definitive confirmation is an operator probe against the real Estuary deployment: operator signer `custodyIngest.update` into a different user's space under the deployment's real ACL mode, read back from a third host.

## Cross-repo contract (loom read side)

The seam requires these changes on loom's side (Workstream A/D-read):

1. **Wrap on read, in memory.** `readStableCellValue` → `build_location_record(point, install_id)` per lean point, fed to the resolver directly; **do not** materialize into the local `SqliteSourceStore`.
2. **Delete plan invariant 2** (TS↔Python `canonical_json` parity + the lat/lng float pin); resolve open question #6 as "wrap on loom import side." `versionId` is Python-only.
3. **Tri-state read seam** (for the absent/empty/has-points honesty rule): labs guarantees a day cell exists only after the first real point (never pre-created empty), so cell-resolves-to-`undefined` = ABSENT ("never captured"), value-is-`[]` = EMPTY ("no signal at T"). The resolver must distinguish them (today it collapses both → unknown).
4. **`install_id` join** comes from the channel registration at read time, never from the lean point; a missing `install_id` is a hard error in production, not a `local-dev` fallback.
5. **Dedup on read** — the `journal` sink appends; `point_id` idempotency is loom's on import.
6. **Day-cell addressing** — day = UTC date of `point.ts` (`YYYY-MM-DD`); one point → one cell; midnight-spanning batches split client-side (one POST per UTC day). The read helper enumerates the same day cells.

## Open decisions

1. **Packaging** — a generically-named `POST /api/ingest` carrying `sink: "stream" | "journal"` (recommended; `/api/webhooks` misdescribes the general capability) vs. extending the webhook route in place. Either way the auth/registry helpers are shared.
2. **Journal-creation auth** — require a real caller principal for `journal` creation (recommended, given the confused-deputy gap) vs. ship with the inherited soft check documented.

## Acceptance / test plan

- **Laptop-out-of-the-loop:** with any user runtime stopped, a `curl` POST to the endpoint durably appends, verified by reading the cell from a *different* host.
- **Absent ≠ empty:** a never-written day cell reads back as `undefined` (ABSENT), not `[]`; the create path writes no day cell.
- **Mark present (hard gate):** after ingest the appended records carry the `ExternalIngest` mark; fail the build if absent.
- **Payload purity:** records at rest deep-equal the POSTed body with no labs-added fields.
- **Auth contract:** identical 401 body across missing-token / missing-registration / disabled / wrong-token; storage-error → 502 (not 401); resolve/commit failure → 502.
- **Hostile leaf:** `../`, empty, malformed → 400, no write.
- **Concurrency:** concurrent POSTs to the same day cell all land (no lost update); retry-exhaustion returns a loud retryable error, never a silent 200.

## Alternatives considered & rejected

- **A dedicated `routes/location/` route** (a 14-agent workflow's initial pick) — bakes location/loom concepts into labs and duplicates the webhook auth/registry. Rejected: nothing is irreducibly location-specific once per-day and dedup move to the client/reader.
- **Extend webhooks with an overloaded `cellLink`** (a "namespace prefix" for trails vs "fixed leaf" for streams) — flagged by security + cross-repo review as a write-scope/provenance-anchor hazard (`remove`'s `extractSpaceFromCellLink` mis-resolves). Rejected in favor of a uniform target + a separate validated leaf.
- **Build the `loom.source-record.v1` envelope at write time in labs** — inverts the labs→loom dependency and imposes TS↔Python hash parity. Rejected: loom wraps on read.
- **Call the durable sink `stream`** — a CF `stream` is transient dispatch with no readable history (`cell.ts:1235`); conflating them would mislead consumers.

## Out of scope

- Per-service identities / owner-granted, revocable access (the deferred grant/delegation work).
- Ingest where the runtime never sees the raw bytes (Estuary is operator-trusted v1).
- Per-record (vs per-POST) provenance attestation — would need `custodyIngest.append` (N marks); a future fork.
- Retention/GC of old journal partitions (a future generic trail-management concern).
