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
