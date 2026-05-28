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

## Slice 5: `wish()` Profile Behavior

### Ambiguity or Incorrect Spec

- Existing `wish()` tests use nested BDD steps, and `deno test --filter profile`
  does not select the nested `wish.test.ts` profile cases. The full
  `wish.test.ts` file is the reliable focused verification for this slice.
- Profile elements need an explicit schema when reading `elements`; otherwise
  `element.cell` can materialize as plain data instead of a cell link.

### Decision

- Added `"profile"` to `WishParams.scope` and excluded it from arbitrary DID
  scope parsing.
- `#profile` and `#profileDefault` resolve to
  `homeSpaceCell.profileSpace.defaultPattern`.
- `#profileName`, `#profileAvatar`, and `#profileSpace` resolve explicitly.
- `scope: ["profile"]` searches profile default `elements`, checking
  `userTags` before `tag`.
- Missing `homeSpaceCell.profileSpace` returns a normal `WishState` error.

### Tests Added

- `packages/runner/test/wish.test.ts`
  - Well-known profile target resolution.
  - Profile-scoped hashtag search by `userTags` and `tag`.
  - `"profile"` scope is not treated as an arbitrary DID.
  - Missing profile link produces an error state.

### Spec Correction Needed

- None for behavior. Test command expectations should mention that the nested
  profile wish cases require running `packages/runner/test/wish.test.ts` or the
  broader `--filter wish`, not only `--filter profile`.

## Slice 6a: PatternFactory.inSpace Runtime Primitive

### Ambiguity or Incorrect Spec

- `PatternFactory.inSpace(spaceName)` cannot synchronously derive a named-space
  DID because the existing derivation path is async. Random DID generation is
  also async because it creates a key pair.
- Starting a child pattern in another space cannot happen in the same
  transaction that writes the source-space link; storage transactions only allow
  one writer space.
- Pattern-call output cells are opaque proxies, so runtime-only annotations must
  be keyed through the underlying cell rather than public proxy methods.

### Decision

- Added `PatternFactory.inSpace(space?: string | AnyCell<unknown>)`,
  analogous to `.asScope()`.
- DID strings and `AnyCell` arguments resolve synchronously at factory-call time.
  Cell arguments use the referenced cell's current space.
- Non-DID strings and omitted spaces are resolved during async action/handler
  post-run. Non-DID strings use the existing named-space session derivation;
  omitted spaces generate a fresh identity DID.
- Cross-space child pattern starts are deferred until after the source-space
  transaction commits, so the source link write and target-space pattern writes
  happen in separate transactions.

### Tests Added

- `packages/runner/test/pattern-scope.test.ts`
  - `.inSpace(did)` routes a child pattern result to that DID space.
  - `.inSpace(name)` resolves the name during action post-run and stores the
    child link to the derived space.
  - `.inSpace(cell)` routes a child pattern result to the cell's space.
  - `.inSpace()` without an argument generates a fresh DID during action
    post-run.

### Spec Correction Needed

- The home/profile creation flow should use `PatternFactory.inSpace(...)` from a
  trusted handler/action boundary rather than expecting named-space derivation to
  be available during ordinary synchronous pattern graph construction.

## Slice 6b: Home Profile Creation Flow

### Ambiguity or Incorrect Spec

- The earlier spec expected a host/runtime operation to write
  `homeSpaceCell.profileSpace`. With `PatternFactory.inSpace(...)`, the home
  pattern can create a profile default pattern directly and store the resulting
  profile link on its own durable output.
- The current home implementation pattern for durable well-known fields matches
  favorites: fields live on `homeSpaceCell.defaultPattern`, not directly on the
  root home space cell.
- `profile-home.tsx` could not initialize its owned `name` cell from a reactive
  input directly. Owned writable cells must start from static values.

### Decision

- Home now exports `profile?: ProfileHomeOutput` and `createProfile`.
- The profile tab accepts a name via `cf-message-input`; the handler stores the
  requested name in a durable `requestedProfileName` cell.
- A lift reacts to `requestedProfileName` and returns
  `ProfileHome.inSpace(name)({ initialName: name })`. The returned profile
  default-pattern link becomes `home.defaultPattern.profile`.
- `profile-home.tsx` accepts `initialName?: string` and applies it through a
  small lift that writes the owned `name` cell once when it is empty.

### Tests Added

- `packages/patterns/system/home.test.tsx`
  - Home starts with no profile.
  - Sending a profile name creates a profile link.
  - The linked profile exposes the submitted name.

### Spec Correction Needed

- The primary durable link is `homeSpaceCell.defaultPattern.profile`, not
  `homeSpaceCell.profileSpace`.

## Slice 5b: Wish Resolution From Home Profile Link

### Ambiguity or Incorrect Spec

- Earlier spec and runner tests still used `homeSpaceCell.profileSpace` as the
  profile link source after the home implementation moved the durable link to
  `homeSpaceCell.defaultPattern.profile`.
- Backward compatibility for `homeSpaceCell.profileSpace` is no longer required
  for this feature.

### Decision

- `wish()` now resolves profile targets from
  `homeSpaceCell.defaultPattern.profile`.
- `#profile` and `#profileDefault` return the linked profile default pattern.
- `#profileName` and `#profileAvatar` read fields on that linked profile
  default pattern.
- `#profileSpace` derives the profile space from the linked profile default
  pattern's normalized link and returns that space cell.
- Profile-scoped hashtag search reads
  `homeSpaceCell.defaultPattern.profile.elements`.

### Tests Added

- `packages/runner/test/wish.test.ts`
  - Well-known profile targets resolve from the home default-pattern profile
    link.
  - Profile-scoped hashtag search reads profile elements through that link.
  - Missing profile returns an error `WishState` containing `profile`.

### Spec Correction Needed

- Remove `homeSpaceCell.profileSpace` compatibility language from the spec.

## Slice 7: Browser Integration For Shared Profile Names

### Ambiguity or Incorrect Spec

- The home profile controls needed stable test selectors. The spec described the
  flow but did not name the UI hooks.
- A profile-aware demo pattern renders data from the viewer's home space, so its
  result needs user scope even though the piece is opened from a shared space.
- Persistent piece creation uncovered two runner/piece timing issues:
  `PatternManager.getPatternMeta()` did not accept compiled pattern factories
  because they are functions, and a saved pattern meta cell can exist before its
  value is loaded locally.

### Decision

- Added `#home-profile-name-input` and `#home-profile-summary` to the home
  profile UI.
- Added `packages/patterns/shared-profile-demo/main.tsx`, a minimal user-scoped
  demo pattern that renders `wish({ query: "#profileName" })`.
- Added browser coverage that opens one shared piece as two different
  identities and verifies each identity resolves its own home profile.
- Fixed `PatternManager.getPatternMeta()` to look up function pattern factories
  and to fall back to in-memory metadata when the cached metadata cell exists
  but has not loaded a value yet.
- Moved persistent setup's known-pattern-id lookup before runtime setup so
  source sync can use the already-registered pattern id reliably.

### Tests Added

- `packages/patterns/integration/shared-profile.test.ts`
  - First identity sees no profile, creates a home profile, and sees that name
    in the shared demo piece.
  - Second identity opens the same shared piece, sees no profile, creates its
    own home profile, and sees the second name.
- `packages/runner/test/pattern-manager.test.ts`
  - Registered compiled pattern factories return metadata by factory object.

### Spec Correction Needed

- The spec should call out that profile-aware shared patterns may need
  user-scoped results when rendered output directly depends on the viewer's
  profile.
