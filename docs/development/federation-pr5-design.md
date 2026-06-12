# Federation PR5 — audience-bound `session.open` + space lifecycle

Status: **design / needs Berni's input.** Last of the §14 federation arc
(PR1–PR4 + site-table v0 landed). This is the *forcing function* for making the
site table's host hints trustworthy: until the open authorization is
audience-bound, a host hint is a replay surface, so the site table stays "v0
unverified hints."

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

**Today.** PR2/PR2.5 made page-ops carry an optional `space?` and bound
`RuntimeInternals` to `(identity, host)` with space-first methods. Berni's
review ask (acknowledged on #3995): *"make every `space?` required, remove the
implicit spaces"* — i.e. a space is always part of the address, never inferred.
Plus a **refcount / lifecycle**: when is a space's per-space context
(`PieceManager`/`PiecesController`, storage session) created and, crucially,
**torn down**? Today opened spaces accumulate; nothing closes them.

**Proposed shape (for Berni to confirm).**
- Make `space` required across the page-op protocol + `RuntimeProcessor.spaces`
  entry points; delete the home-defaulting fallbacks.
- Add refcounted space contexts: open on first use, dispose when the last
  page/cell referencing the space goes away (with a grace window to avoid
  thrash on navigation). Ties into audience-binding: a closed space re-opens
  with a fresh audience-bound handshake.

**Open questions for Berni**
- Refcount granularity (per page? per cell subscription?) and the
  close grace-window.
- Does "remove implicit spaces" land as one mechanical PR, or staged behind the
  refcount work?

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
