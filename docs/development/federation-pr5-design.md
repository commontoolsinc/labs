# Federation PR5 — audience-bound `session.open` + space lifecycle

> Historical note: this document records an older PR design and is not the
> current source of truth for memory WebSocket authentication. Current behavior
> is documented in
> [`docs/specs/memory-v2/04-protocol.md`](../specs/memory-v2/04-protocol.md).
> In the current protocol, memory servers advertise `sessionOpen.audience` and a
> one-time challenge in `hello.ok`; clients sign `aud`, `challenge`, `iat`, and
> `exp` into `session.open`; and protected toolshed session opens require those
> checks.

Status: **Part A mechanism implemented; one decision needs Berni.** Last of the
§14 federation arc (PR1–PR4 + site-table v0 landed). This is the *forcing
function* for making the site table's host hints trustworthy: until the open
authorization is audience-bound, a host hint is a replay surface, so the site
table stays "v0 unverified hints."

## Implemented in this PR

The `session.open` verification was a byte-identical copy in two places
(`packages/memory/v2/standalone.ts` and `packages/toolshed/routes/storage/memory.ts`).
This PR factors it into a single shared helper —
`packages/memory/v2/session-open-auth.ts` `verifySessionOpenAuthorization()` —
both now call, and adds two anti-replay checks on top of the signature:

- **Expiry — complete, end-to-end.** The client (`v2-remote-session.ts`) now
  stamps `iat` + `exp` (a 5-min `SESSION_OPEN_TTL_SECONDS` window) onto every
  `session.open`; the helper rejects an expired open with a clock-skew grace.
  Before this the open carried no expiry and was replayable forever. Backward
  compatible: `exp` rides in the signed invocation hash, older servers ignore
  it, and an open without `exp` is still accepted.
- **Audience — mechanism + tests, gated on one decision.** The helper rejects an
  open whose `aud` ≠ this server's configured `audience` (cross-host replay).
  Opt-in on both sides (no `aud` or unconfigured server → skip), so it can't
  break anything today. Covered by `test/session-open-auth-test.ts` (8 cases:
  valid / tampered / expired / skew-grace / aud-match / aud-replay-rejected /
  opt-in).

**The one decision for Berni** (everything above is inert without it): the
`Invocation` `aud` field is typed `DID`, so a proper audience is the memory
server's **own identity DID** — which the memory server does not have today.
Decisions: (1) provision a server identity DID; (2) how the client learns it to
set `aud` (site-table host DID? a `/.well-known` on the host? handshake?); (3)
when to flip server enforcement from opt-in to required. Once decided, wiring it
is a config/plumbing change, not a protocol change — the enforcement path and
tests are already here. Part B (below) is unchanged: still design-only.

## Two parts

### Part A — audience-bind the open authorization (security-critical)

**Today (the replay surface).** `packages/memory/access.ts`:

- `authorize(access, as)` (≈L110) builds `proof = { [invocationHash]: {} }` and
  signs `hashOf(proof).bytes` — *only* the invocation hashes. There is **no
  audience, no nonce, no expiry** in the signed payload.
- `claim(access, authorization, serviceDid, acl)` (≈L26) verifies that signature
  over `hashOf(authorization.access)` and checks issuer = space owner / service
  DID / ACL — but never checks *who the authorization was for*.

So a captured `{signature, access}` is valid at **any** host that serves the
space, **forever**, and can be **replayed**. With site-table host hints (PR3′),
a hostile or compromised host hint can route a client's signed open to an
attacker, who replays it to the real host and acts as the user. This is exactly
the pre-audience-binding hole flagged when PR1 landed.

**Proposed shape (for Berni to confirm).**

1. Bind the audience into the signed payload:
   `sign(hashOf({ proof, aud, nonce, exp }))` where
   - `aud` = the target provider/service DID (the host the client *intends* to
     talk to),
   - `nonce` = per-open random,
   - `exp` = short expiry (open is a live handshake, not a durable grant).
2. `claim` additionally enforces `aud === thisProviderDid`, `exp > now`, and
   nonce-not-seen (a small bounded replay cache, TTL = `exp` window).
3. Wire-format/version: this changes the `Authorization` shape over the wire.
   Need a compat story — version tag + dual-accept window, or a hard cut keyed
   to a memory-protocol version. **Decision for Berni.**

**Open questions for Berni**
- Is `aud` the **service/provider DID** (the toolshed's identity) or the
  **host URL**? DID is replay-proof across URL changes; URL is what the site
  table stores. (Likely DID, with the site table resolving URL→DID.)
- Expiry window + clock-skew tolerance for `exp`.
- Compat: dual-accept window vs. hard protocol-version cut. Any non-loom
  consumers of `authorize`/`claim` to migrate?
- Where does the provider's expected `aud` come from — config, or derived from
  the connection's own identity?

### Part B — space lifecycle: make `space` required, drop implicit spaces

**Make-`space`-required: essentially done.** Verified against current main:
#3995 already made all page-op protocol types, the `RuntimeProcessor` handlers,
`lib-shell/runtime.ts`, and `RuntimeClient` methods take a required `space: DID`
and ripped out the implicit current-space. The only remaining "optional" sites
are (a) the **link/data-model layer** (`runner/link-types.ts`
`NormalizedLink.space?`, sigil-link `space ?? from.space` in `cell-handle.ts`),
which is **intentional relative-link inheritance** — making it required would
break relative links — and (b) a couple of defensive runtime fallbacks
(`pieceCreatedCallback`'s home-manager fallback, the redirect-link
`space ?? requesting`). Those aren't the implicit-space Berni meant; forcing
them strict risks breaking existing data, so leave as-is unless Berni wants them
tightened.

**The real gap is teardown — and the labs code already flags it.**
`v2.ts` `registerSpaceHost` says an opened space can't be re-pointed because
"re-pointing requires an explicit close, *which is lifecycle follow-up work*"
(v2.ts:~587). Today `StorageManager` holds a per-space `#providers` map and only
ever closes *all* of them (`close()`/`closeNow()`); per-space contexts
accumulate for the worker's lifetime.

**Implemented in this PR — `StorageManager.closeSpace(space)`** (the named
follow-up): the per-space counterpart to `close()` — flush, `provider.destroy()`,
forget; a later `open(space)` re-establishes a fresh provider; other spaces
untouched; no-op when not open. (`PieceManager`/`PiecesController` hold no
persistent `.sink` of their own — just a one-shot `spaceCell.sync()` — so the
`RuntimeProcessor` `SpaceContext` is GC-safe to drop; the storage *connection*
was the only real per-space resource needing an explicit close.) Tests in
`storage-close.test.ts`.

**Remaining — the refcount that drives it (a separate, design-gated step).** A
`RuntimeProcessor` refcount retains a space on `PageStart` + `CellSubscribe`,
releases on `PageStop` + `CellUnsubscribe`, and on zero-after-grace evicts the
`SpaceContext` + calls `closeSpace`. **Open questions for Berni** (why this is
split out): refcount granularity (per page? per cell subscription? a
combination?) and the close grace-window — getting them wrong prematurely tears
down a live space. The teardown primitive is now in; the policy is the call to
make.

## Sequencing
- **A before B**: audience-binding is the security gate that lets the site
  table graduate from "unverified hints" to a trustable lookup; it's also
  smaller and self-contained. B (lifecycle) is the cleanup Berni wants and
  pairs naturally with the re-open-with-fresh-audience flow.
- Loom side: once A lands and the site table is trustable, the loom
  `registerSpaceHost` "never silently re-point" guard can soften (a verified
  host hint is no longer a replay surface). No loom change needed for A itself.

## Test plan (A)
- Unit: `claim` rejects an authorization whose `aud` ≠ provider DID, whose `exp`
  is past, and a replayed nonce. `authorize`→`claim` round-trip passes only for
  the intended audience.
- Integration: two memory providers; an open authorized for provider 1 is
  rejected by provider 2 (the replay that works today).

---
_Grounded in `packages/memory/access.ts` (authorize/claim) on labs main
`4d22dcdc5`. Filed from the loom federation workstream; pairs with the loom
site-table v0 (PR3′) and CommonTools CT-1731 context._
