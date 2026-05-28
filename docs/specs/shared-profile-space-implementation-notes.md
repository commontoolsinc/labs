# Shared Profile Space Implementation Notes

These notes track implementation decisions that were ambiguous, wrong, or
underspecified in the spec. Each slice records the tests added and the decision
made before committing.

## Slice 1: Spec and Notes

### Ambiguity or Incorrect Spec

- The draft spec preserved the old `wish({ query: "#profile" })` behavior,
  where it resolved to `home.defaultPattern.learned.summary`. The locked plan
  requires `#profile` to resolve to `profileSpace.defaultPattern`.
- The draft spec described broad storage-level owner authorization, including
  `homeSpaceCell.profileSpace`. The locked plan narrows v1 protection to
  profile default fields and element mutations.

### Decision

- `#profile` is now the well-known target for the profile default pattern.
- `#profileName`, `#profileAvatar`, `#profileDefault`, and `#profileSpace` are
  explicit profile targets.
- Profile owner protection is CFC-enforced for `name`, `avatar`, `elements`,
  and trusted add/remove element mutation paths.
- `homeSpaceCell.profileSpace` is a durable link written by the authenticated
  creation flow, but it is not CFC owner-protected in v1.

### Tests Added

- None. This slice only locks the spec before code changes.

### Spec Correction Needed

- Completed in `docs/specs/shared-profile-space.md`.

## Slice 2: CFC Owner Policy

### Ambiguity or Incorrect Spec

- Existing `RepresentsCurrentUser<T>` only resolves to the transaction's acting
  principal. That is not enough for profile fields because Bob using a trusted
  surface against Alice's profile must not relabel Alice's profile as Bob's.
- Existing CFC enforcement deliberately rejected literal DID subjects in
  `represents-principal` atoms, so the profile schema factory needed a narrow
  host-authored escape hatch for exact owner-DID policy.

### Decision

- Added `ifc.ownerPrincipal` as a stable CFC policy claim for host-created
  schemas. A protected profile field embeds both `ownerPrincipal: ownerDid` and
  `addIntegrity: [{ kind: "represents-principal", subject: ownerDid }]`.
- `ownerPrincipal` requires a trust snapshot, an acting principal matching the
  owner DID, `writeAuthorizedBy`, and `uiContract`.
- Literal DID principal atoms remain rejected when `ownerPrincipal` is absent,
  preserving the existing pattern-authored fail-closed behavior.

### Tests Added

- `packages/runner/test/profile-owner-cfc.test.ts`
  - Alice-created protected profile fields persist Alice owner integrity.
  - Bob cannot write Alice's protected profile fields through the trusted
    profile writer.
  - Missing trust snapshot and missing trusted writer both fail.

### Spec Correction Needed

- The spec said a profile schema factory may be needed. Implementation confirms
  that need and uses `ifc.ownerPrincipal` as the internal policy marker.
