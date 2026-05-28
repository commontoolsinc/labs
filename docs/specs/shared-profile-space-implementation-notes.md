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

## Slice 3: Profile Schemas and Default-Pattern Controller

### Ambiguity or Incorrect Spec

- The plan named `ensureProfileDefaultPattern(profileSpaceDID)`, but the
  existing `PiecesController` is already bound to a single `PieceManager` and
  space. Passing a DID into that controller would fight the local shape of the
  API.
- The profile default pattern file does not exist yet in this slice. The
  controller can still be tested by mocking pattern fetches and proving URL
  selection.

### Decision

- Added `deriveProfileSpaceDID(identity)` in `packages/piece/src/profile-space.ts`
  using the stable derivation name `common-fabric-profile`.
- Added `ensureProfileDefaultPattern()` on the current-space
  `PiecesController`. Callers create a `PieceManager` for the derived profile
  DID, then call this explicit method.
- Left `ensureDefaultPattern()` behavior unchanged for home and ordinary spaces.
- Added `profileSpace` to `spaceCellSchema` and exported profile data types from
  the runner runtime surface.

### Tests Added

- `packages/piece/test/profile-default-pattern.test.ts`
  - Profile spaces fetch `/api/patterns/system/profile-home.tsx` via
    `ensureProfileDefaultPattern()`.
  - Ordinary spaces still fetch `/api/patterns/system/default-app.tsx`.
  - Home spaces still fetch `/api/patterns/system/home.tsx`.
- `packages/runner/test/space-cell.test.ts`
  - The default space-cell schema exposes `profileSpace` as a cell-valued field.

### Spec Correction Needed

- The implementation uses `ensureProfileDefaultPattern()` on a profile-space
  manager rather than passing a profile DID into a controller for another space.

## Slice 4: Profile Default Pattern

### Ambiguity or Incorrect Spec

- The plan said the default pattern lets the owner add elements from a fixed
  catalog or a pattern URL. Pattern handlers cannot instantiate patterns from
  inside standalone helpers, and compiling an arbitrary URL into a durable new
  piece is a runtime/piece-controller operation rather than a pure pattern-local
  mutation.
- The spec listed `name` and `avatar` as fields but the slice called out edit
  streams. The pattern needs both readable fields and explicit streams so tests
  and trusted UI actions can mutate through named boundaries.

### Decision

- `profile-home.tsx` owns writable `name`, `avatar`, and `elements` cells.
- It exports `setName`, `setAvatar`, `addElement`, and `removeElement` streams.
- Fixed catalog addition currently creates a simple profile card element.
- URL addition creates a durable URL-reference element with the supplied URL,
  title, tag, and user tags. Actual compile-and-run URL creation is deferred to
  the profile creation/runtime operation layer.

### Tests Added

- `packages/patterns/system/profile-home.test.tsx`
  - Initial name/avatar/elements state.
  - Name and avatar edit streams update exported fields.
  - Catalog add/remove streams update `elements`.

### Spec Correction Needed

- URL element creation needs a host/runtime operation if it must compile the URL
  into a real piece immediately. The pattern-local v1 stores a URL-backed
  element record instead.
