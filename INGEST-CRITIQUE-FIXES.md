# Ingest-channel branch: remaining fast-follows

**Branch:** `location-ingest`. All **P1** fixes from the original critique are now
implemented on this branch (sink discriminator, enumeration index, provisioning
`--space`/`--install-id` validation + causePrefix `--force` guard, golden
`channelId` literal, per-channel `lastSeenAt`, and the two `custody-ingest.ts`
docstring corrections) — all tests pass (20 util + 3 route steps).

What remains are **P2 fast-follows with named triggers** — do NOT fold into this
PR. They are being moved into
`docs/development/proposals/ingest-channels-journal-sink.md`, after which this
file is deleted.

**Framing correction (still applies):** the branch does **no** server-side record
dedup, by design. Idempotency is loom's, on `point_id`, at read/import time. Do
not "fix" this.

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
