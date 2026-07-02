# Ingest-channel branch: critique + executable fix list

**Branch:** `location-ingest` · **Reviewed:** 2026-07-02, three independent review passes
(implementation/idiom, loom ambient-context design alignment, prior-art/subsumption audit).

**Verdict: sound, no blockers.** The write path (`custodyIngest.update`, one mark per POST),
auth contract (dummy-hash-equalized 401s, 502-vs-401 separation), golden-id pinning, and
tri-state absent≠empty schema are all correct and well-tested (all 20 test steps pass). The
"primitive archeology" holds up: webhooks are correctly explained as *channel + `stream` sink*,
OAuth/Plaid as *channel + single-cell `set`/`update` sink* (already retrofitted onto
`custodyIngest` by #4392); nothing structural blocks their eventual subsumption. The fixes
below are generalization seams that are cheap now and expensive after the first real channel
is provisioned, plus operational hardening on the provisioning script.

**One framing correction:** the branch does **no** server-side record dedup — by design.
`@commonfabric/content-hash` is used only for token hashing and the derived channel id.
Idempotency is loom's, on `point_id`, at read/import time. Do not "fix" this.

---

## How to use this document

Each fix is self-contained: files, why (one sentence), exact instructions, acceptance check.
Do the P1 fixes on this branch before merge. P2 items are fast-follows with named triggers —
do not fold them into this PR. The Guardrails section lists things you must NOT do while
executing; read it first.

---

## P1 — fix on this branch before merge

### 1. Add `sink: "journal"` to the channel registration

**Files:** `packages/toolshed/routes/ingest/ingest.utils.ts`,
`packages/toolshed/scripts/provision-ingest-channel.ts`,
`packages/toolshed/routes/ingest/ingest.utils.test.ts`

**Why:** this is the one field the proposal names as the generic-channel seam (webhooks
become `sink: "stream"` later); adding it as a required field *after* real channels exist
forces a registry migration, adding it optional forever weakens the union.

**Instructions:**
- In the `IngestRegistration` interface (ingest.utils.ts:42-55) add `sink: "journal";` with a
  doc comment: the sink discriminator; `"stream"` (today's webhook dispatch) joins when
  webhooks are subsumed.
- In `RegistrationSchema` (ingest.utils.ts:57-81) add `sink: { type: "string" }` to
  `properties` and `"sink"` to `required`.
- In `provision-ingest-channel.ts` add `sink: "journal"` to the registration object passed to
  `saveRegistration` (~line 67-77).
- In `processIngest` (ingest.utils.ts, after the `!registration || !registration.enabled`
  check at ~line 258): treat `registration.sink !== "journal"` exactly like a disabled
  channel — call `verifyIngestSecret(token, DUMMY_HASH)` and return the identical
  `{ status: 401, body: { error: "Invalid request" } }`. Rationale: a future stream-channel id
  POSTed here must never silently get journal semantics, and the equalized 401 keeps the
  response indistinguishable (no oracle).
- Update test fixtures in `ingest.utils.test.ts` to include `sink: "journal"`, and add one
  test: a registration with `sink: "stream"` gets the same 401 body as a wrong token and
  writes nothing.

**Accept:** all existing tests pass; new wrong-sink test passes.

### 2. Make registrations enumerable (service-space index)

**Files:** `packages/toolshed/routes/ingest/ingest.utils.ts`,
`packages/toolshed/routes/ingest/ingest.utils.test.ts`

**Why:** registrations are content-addressed cells with no index, so an operator cannot audit
which channels exist, and any future list/self-serve/audit endpoint is blind to every
iteration-1 channel; webhooks already solved this shape (`webhooks.utils.ts:184-202`).

**Instructions:**
- In `saveRegistration` (ingest.utils.ts:165-175), after the registration `durableSet`,
  maintain an index cell: `runtime.getCell<string[]>(serviceSpace as MemorySpace,
  "cf:ingest:index", <array-of-string schema, no default>)`. Use `durableUpdate` from
  `@/lib/custody-ingest.ts` with a mutate that appends `registration.id` only if
  `!ids.includes(registration.id)` (mirror the guard at `webhooks.utils.ts:197`).
- Wrap the index write in try/catch: log a warning and continue on failure — index-write
  failure must not fail provisioning (mirror `webhooks.handlers.ts:81-88`).
- Add a test: provisioning two channels yields both ids in the index; re-provisioning the
  same channel does not duplicate its id.

**Accept:** index cell lists all provisioned ids exactly once.

### 3. Validate `--space` and `--install-id` in the provisioning script

**File:** `packages/toolshed/scripts/provision-ingest-channel.ts` (~lines 31-51)

**Why:** a typo'd space mints a channel that durably writes marked data into a garbage space
(loom's reader silently orphaned), and `--install-id` is both the mark's `audience` and — with
`\n` as separator — an input to the `channelId` derivation, so whitespace/newlines corrupt
the cross-repo join key.

**Instructions:**
- After the existing missing-flag check: exit 2 with a clear message unless
  `space.startsWith("did:")`.
- Exit 2 unless `isValidSegment(installId)` (already exported from ingest.utils.ts and
  imported for the causePrefix check; reuse the same error-message format as lines 46-51).

**Accept:** script rejects `--space example.com` and `--install-id "a b\n"` with exit 2.

### 4. Guard re-provisioning against a silent causePrefix repoint

**File:** `packages/toolshed/scripts/provision-ingest-channel.ts` (~lines 61-77)

**Why:** `channelId` derives from `(space, installId)` only, so re-running with the same
install but a different `--cause-prefix` rotates the token AND silently moves where data
lands, orphaning the existing loom read path.

**Instructions:**
- Before `saveRegistration`, call `getRegistration(runtime, identity.did(), id)`.
- If a registration exists and `existing.causePrefix !== causePrefix`: print both values and
  exit 2, unless a new `--force` boolean flag is passed.
- If it exists with the same causePrefix: print `rotating token for existing channel <id>`.

**Accept:** changing cause-prefix without `--force` exits 2; same-prefix re-run prints the
rotation notice and succeeds.

### 5. Pin `channelId` to a golden literal

**File:** `packages/toolshed/routes/ingest/ingest.utils.test.ts` (~lines 200-206)

**Why:** rotate-in-place is a security property — if the derivation drifts (hash format,
separator), "rotation" mints a NEW registration and leaves the old token live, and the
current determinism-only test would not notice.

**Instructions:** in the existing `channelId` test, compute
`channelId("did:key:space1", "install-1")` once, paste the literal, and assert equality with
a comment mirroring the `GOLDEN_ID` one at line 23 (a failure means the derivation drifted —
coordinate, never just update the literal).

**Accept:** test asserts the exact `ing_…` string.

### 6. Track `lastSeenAt` per channel (dropped loom requirement)

**Files:** `packages/toolshed/routes/ingest/ingest.utils.ts`,
`packages/toolshed/routes/ingest/ingest.utils.test.ts`

**Why:** loom's design and plan explicitly require per-install last-seen so a dead beacon is
visible (TestFlight re-sign treadmill makes beacons die silently — a loom acceptance
criterion, not polish); the branch silently dropped it.

**Instructions:**
- Add a dedicated status cell per channel — NOT a field on the registration (that would make
  every POST contend with token rotation on one document):
  `runtime.getCell<string>(serviceSpace, "cf:ingest:last-seen:" + id, <string schema>)`.
- In `appendToJournal` (or `processIngest` after a successful append): `durableSet` the cell
  to the same operator wall-clock timestamp style used elsewhere (`new Date().toISOString()`).
  This is an operator status write, not ingest — no mark (same rationale as the
  registration-write comment at ingest.utils.ts:173).
- Failure to bump last-seen must log a warning but not fail the POST.
- Add a test: after a successful `processIngest`, the last-seen cell reads a parseable
  ISO timestamp; after a 401, it is unchanged.

**Accept:** successful ingest bumps the cell; failed auth does not.

### 7. Fix the `custody-ingest.ts` docstring overclaim

**File:** `packages/toolshed/lib/custody-ingest.ts` (header comment, ~lines 14-19)

**Why:** the header claims this "replaces … the webhook's fire-and-forget `sendToStream`" —
it does not; `sendToStream` (`webhooks.utils.ts:225-240`) still hand-rolls `editWithRetry`,
unmarked, and the comment records an intention as a fact, which will mislead the next reader
into believing webhook data is provenance-marked.

**Instructions:** reword to state that webhook `sendToStream` is NOT yet migrated and that
the webhook provenance retrofit is the planned `stream`-sink follow-on of the ingest-channel
work (cite `docs/development/proposals/ingest-channels-journal-sink.md`).

**Accept:** comment no longer claims sendToStream is replaced.

### 8. Pin the `audience` convention in the `VouchedChannel` docstring

**File:** `packages/toolshed/lib/custody-ingest.ts` (`VouchedChannel.audience`, ~lines 36-44)

**Why:** two conventions now coexist at rest — OAuth/Plaid use a fixed
`did:web:commonfabric.org#<integration>` URI, ingest channels use the per-install
`installId` — and un-documented divergence becomes expensive to reconcile once marks with
inconsistent audiences are durable.

**Instructions:** add two sentences to the docstring: audience is the stable per-source
identifier — the channel's `installId` for minted (token-bearing) ingest channels, a fixed
`did:web:…#<integration>` URI for token-less integration channels (OAuth:
`oauth2-common.utils.ts:165`, Plaid equivalent) — and new channels must follow one of these
two forms.

**Accept:** docstring names both forms and the rule.

---

## P2 — fast-follows with named triggers (do NOT fold into this PR)

### 9. Extract the shared bearer-secret crypto — trigger: next change touching either file

`randomBase62`/`BASE62` are copied verbatim between `webhooks.utils.ts:19,31-48` and
`ingest.utils.ts:26,92-110`; secret-gen/timing-safe-verify/dummy-hash are near-verbatim. The
proposal deliberately defers this (§152) to avoid churning shipped webhook code, so honor
that — but it is the FIRST change the next PR touching either file makes. Shape: a
`packages/toolshed/lib/channel-secret.ts` with `generateChannelSecret(prefix, hashFn)` /
`verifyChannelSecret(provided, storedHash, hashFn)`; webhooks pass their async hex sha256
from `@/lib/sha2.ts` so stored webhook hashes keep verifying unchanged; ingest passes its
sync base64url content-hash. Keep both routes' exported function names as thin wrappers so
tests don't churn. The two stored-hash encodings (hex vs base64url) must be format-tagged or
migrated before any registry merge.

### 10. Per-partition element-count backstop — trigger: before any always-on beacon ships

`appendToJournal` re-serializes the whole array per write; sustained appends to one partition
are O(N²) and unbounded (proposal §151 acknowledges). Inside the `custodyIngest.update`
mutate closure, reject when `(current?.length ?? 0) + records.length` exceeds a cap
(~50,000): throw a typed error that `processIngest` maps to a 413-shaped error, loudly.
Never "fix" this by server-side re-partitioning — partitioning stays client-named.

### 11. Revocation path — trigger: before loom's control-surface "revoke beacon token" lands

`enabled: boolean` exists but nothing flips it; today revocation = re-provision to rotate.
Add a `--disable` flag to `provision-ingest-channel.ts` that reads the registration and
`durableSet`s it with `enabled: false`. Loom's "Turn on Ambient Context" page expects a
revoke affordance; operator-only is fine for iteration 1.

### 12. Test gaps — trigger: opportunistic, next test-touching PR

- **bodyLimit 413:** POST a >1 MB body through `app.request` in `ingest.routes.test.ts`,
  assert 413 + `{ error: "Payload too large (max 1MB)" }`.
- **Second-append mark behavior:** in `ingest.utils.test.ts`, append a second batch to the
  same partition and assert the expected `ingestMarks(...).length` and that the surviving
  mark's `valueDigest` matches the final array — pins whether the labelMap coalesces per
  (path, origin) (`prepare.ts:2915`) so a coalescing regression surfaces here.
- **Dedup the `ingestMarks` helper** copied from `custody-ingest.test.ts:49-57` into a shared
  test-support module.

### 13. Per-install rate limiting — decision needed, not silently dropped

loom's plan.md (Workstream D build-step 3) specifies a per-install rate limit returning 429;
the branch has only the body cap + `MAX_BATCH`. Fine at ~10 users. Record the decision
explicitly (in the proposal doc or a ticket): either "deferred until self-serve create" or
implement a simple in-memory token bucket per channel id in `processIngest`.

### 14. Provisioning-script identity footgun — one-sentence doc fix

The script writes the registration into the service space keyed by whatever identity its
`.env` yields; a mismatched identity provisions into the wrong space and every POST 401s
with no diagnostic. Add one sentence to the script's usage header: "run with the same
.env/identity as the target toolshed."

---

## Guardrails — do NOT do these while executing the fixes

1. **Never parse record contents server-side.** Routing/validation stays on `partition` +
   record-is-a-plain-object. The moment the server reads `point.ts` (or any payload field) to
   route, dedup, or rate-limit, the "zero labs-side location code" layering dies.
2. **Golden-id tests are cross-repo compatibility contracts.** A failing `GOLDEN_ID` (or the
   new channelId golden) means "coordinate a loom-side change" — never update the expected
   literal to make CI green. Same for `SEGMENT_RE` and the `${causePrefix}/${partition}`
   cause format: frozen.
3. **Keep `JournalSchema` default-free and open.** No `default` (ABSENT `undefined` ≠ EMPTY
   `[]` is a loom read-side contract) and no property constraints (payload purity: records at
   rest deep-equal the wire bytes).
4. **Keep the foreign-space write test** (`ingest.utils.test.ts:146`) exactly as a
   cross-space write — never "simplify" it to same-space; it is the CI canary for the
   `MEMORY_ACL_MODE=enforce` latent dependency.
5. **Self-serve create stays out** until real caller auth exists (confused-deputy: an
   unauthed create + journal sink = writing legitimately-marked data into someone else's
   space). Keep `channelId(space, installId)` deterministic so future self-serve create stays
   idempotent/rotating.
6. **Retention = drop whole partition cells, never prune arrays in place** (in-array pruning
   fights append-only provenance and the mark's valueDigest anchoring). Keep partition names
   lexically sortable dates.
7. **Never approximate per-record marks by splitting batches into 1-record POSTs** (O(N)
   marks + O(N²) writes). Per-record attestation is the flagged `custodyIngest.append` fork.
8. **Deploy gate for the ACL flip** (ops checklist, not code): before Estuary sets
   `MEMORY_ACL_MODE=enforce`, run `observe` and grep `wouldDeny` for the ingest operator DID,
   and ensure the operator DID is in `MEMORY_SERVICE_DIDS` (or a per-space grant exists).

---

## What's already good — do not churn

- **Canonical hashing:** `sha256` from `@commonfabric/content-hash` + `toUnpaddedBase64url` —
  the same pair `custody-ingest.ts` uses; not a local fork.
- **Write path:** one `custodyIngest.update` per POST; concurrency inherited from
  `editWithRetry`, not re-implemented. Mark fields match the OAuth/Plaid precedent exactly,
  and `channelId = hash(space, installId)` means a mark's `{channel, audience}` recovers its
  registration — that's a feature.
- **`processIngest` split** (pure function, unit-tested against a real emulated runtime,
  including the timing-equalized 401 triple and no-write-on-wrong-token) is *better* than the
  webhook handler it mirrors.
- **Registry addressing** via `runtime.getCell(space, "cf:ingest:" + id, schema)` is more
  idiomatic than webhooks' hand-built `of:${await sha256(...)}` entity ids.
- **Confused-deputy handled conservatively:** no create endpoint at all in iteration 1.
- **Tests guard principles** (golden id, tri-state, payload purity, cross-space + mark,
  concurrency, hostile partitions, auth contract), not implementation mirroring.
- **Layering:** nothing named "location" in labs; lean records verbatim; loom wraps on read.
  The subsumption story (webhooks → `stream` sink; OAuth/Plaid → set/update sinks over an
  implicit token-less channel) requires nothing structural beyond fixes 1-2 above.
