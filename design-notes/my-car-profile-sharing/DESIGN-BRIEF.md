# Design Brief — "My Car(s)" × Parking, a CFC worked example

Canonical, locked decisions for this design exploration. Both the naming agent
and the design-doc/explainer agent build from this. Companion research lives
beside it: `codebase-research.md`, `cardweb-synthesis.md`, `ux-journeys.md`.

## Scope (this pass)

- **Deliverable:** design doc + an EXPLAINER ("why this is cool"). No code yet.
- **Actors:** employees only, single organization. One shared org/parking space
  running `parking-coordinator` + `lot-watch`, fed by many employee profile
  spaces.
- **Foundation:** build on the shared-profile / `wish()` substrate (PR #3762).
- **Examples use Alice / Bob / Carol** etc. — NOT "Gideon".

## The spine: attributable claims (trust travels with the claim)

The parking system does not trust _a car_; it trusts **a claim made by someone
trusted to make it**. "Take a picture" is just the ergonomic way to author the
claim; the security substance is **whose identity the claim is attached to**.

The allow-rule: **the org allows any vehicle whose claim was authored by a
current employee.** No admin-maintained roster of plates — the admin's only
residual job is the tail of cars with _no_ claim. Expressible directly in
existing CFC provenance (`authored-by` / `represents-principal` atoms;
`CURRENT_PRINCIPAL_CLAIM_KINDS`): the allow decision is a provenance check, i.e.
"policies on data, not apps" (c-573).

### Two claim types, one primitive

`{ claimant DID, Vehicle, claimType: self | guest, ... }`

1. **Self-claim** ("this is my car, affiliated with me, allow it") — lives **on
   the claimant's profile**, owner-protected
   (`represents-principal =
   claimant`), portable across orgs, discovered
   org-side via a profile-scoped wish.
2. **Guest-vouch** ("this is a legitimate guest's car") — any employee may
   vouch. Authored **into the org/parking space** (authored-by = voucher), not
   portable. Mirrors the existing `lot-watch` `assignToPerson` precedent
   (employee writes into the space-local shared cell), which sidesteps
   cross-space writes entirely.

This claim model **dissolves the central tension** the codebase research flagged
(a foreign pattern can't write your owner-protected profile): nobody writes
where they aren't entitled; parking-coordinator/lot-watch only **read + check
provenance**.

## Trust anchor for "current employee"

A root **lot-owner / company-owner principal** attests the set of
current-employee DIDs allowed to vouch — "the owner says these DIDs are
employees." We **cheat the last mile** via an oracle/convention (a signed
attestation list), not a full org directory. Revocation falls out: drop a DID →
all their claims (self + guest) silently stop counting as "ours". (Honest
caveat: vouching gives **attribution, not prevention** — a careless employee can
vouch badly; we know _who_ vouched. Scaled trust, not trustlessness — c-757.)

## Visibility / confidentiality

- **Vouches are visible to an org admin**, NOT to every other employee. The
  admin sees the resolved identity — "this is Alice's car" / "guest car Bob
  vouches for" — so they know whom to follow up with.
- **Private owner note:** the claimant may attach a private note (e.g. who the
  guest is, or a personal reminder) that is **NOT visible to the admin by
  default**. The admin can _request_ a reveal; the claimant approves to
  disclose. Selective disclosure / reveal handshake → maps to CFC
  `Confidential` + a consent step.

## Deferred (mark the seam, don't build)

- **Granularity ladder** (owner → description → description+plate): still future
  work. Specify the rung names and where the control lives on the card; no
  policy engine.

## Naming convention

Personas: **Alice, Bob, Carol, Dave**. Avoid "Gideon".
