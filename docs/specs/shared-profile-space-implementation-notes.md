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
- `#profileName`, `#profileAvatar`, and `#profileSpace` are explicit profile
  targets.
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
- `#profile` resolves to `homeSpaceCell.profileSpace.defaultPattern`.
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
- The profile tab accepts a name and the trusted profile-creation handler writes
  `ProfileHome.inSpace(name)({ initialName: name })` directly to
  `home.defaultPattern.profile`.
- The handler also mirrors the requested name into `home.defaultPattern.profileName`
  so profile-name wishes can update before the profile default pattern finishes
  materializing.
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
- `#profile` returns the linked profile default pattern.
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

## Slice 8: Common Docs Cleanup

### Ambiguity or Incorrect Spec

- `HOME_SPACE.md` still described favorites as `spaceCell.favorites`, while the
  implementation stores durable home fields on `homeSpaceCell.defaultPattern`.
- `wish.md` only documented favorites and mentionables, so profile scope and
  well-known profile targets were invisible outside the feature spec.

### Decision

- Updated `wish.md` with `scope: ["profile"]`, well-known profile targets, and
  the user-scoped rendering rule for shared pieces that display viewer profile
  data.
- Updated `HOME_SPACE.md` to document `defaultPattern.profile`, the home
  profile-name creation flow, and profile default-pattern selection.

### Tests Added

- Documentation-only slice. Validation is by docs review plus the previously
  green focused tests and browser integration.

### Spec Correction Needed

- None.

## Slice 9: Profile Wish Persona UI

### Ambiguity or Incorrect Spec

- The original browser flow assumed profile creation required navigating to the
  home profile tab. The desired persona wish UI should create the profile in
  place from any pattern rendering `wish({ query: "#profile" })[UI]`.
- Existing result UI forwarding used the wished result cell's own `[UI]`. For
  `#profile`, that would render the full profile default pattern UI rather than
  a compact persona link.

### Decision

- `wish({ query: "#profile" })[UI]` now renders `cf-cell-link` when a profile
  exists.
- If the profile is missing, the wish renders a `cf-message-input` wired to
  `homeSpaceCell.defaultPattern.createProfile`. Submitting a name creates the
  profile without navigating away from the current view.
- The shared-profile demo renders both `#profileName` and the `#profile` wish UI
  so integration coverage exercises the inline creation surface directly.

### Tests Added

- `packages/runner/test/wish.test.ts`
  - `#profile` wish UI renders a profile link when the profile exists.
  - `#profile` wish UI renders the profile creation input wired to the home
    create-profile handler when the profile is missing.
- `packages/patterns/integration/shared-profile.test.ts`
  - Each identity creates its profile from the shared demo piece's inline wish
    UI.
  - The inline wish UI reacts into a profile link after profile creation.

### Spec Correction Needed

- The spec and `wish.md` now document that profile persona wish UI is
  non-navigating and reactive.

## Slice 10: Remove #profileDefault Alias

### Ambiguity or Incorrect Spec

- `#profileDefault` and `#profile` resolved to the same profile default-pattern
  link, which made the explicit alias redundant.

### Decision

- Removed `#profileDefault` as a well-known wish target.
- `#profile` is now the only well-known target for the current user's profile
  default pattern.
- A `#profileDefault` query now falls through to ordinary hashtag search
  semantics instead of resolving the profile link.

### Tests Added

- `packages/runner/test/wish.test.ts`
  - `#profileDefault` no longer resolves through the home profile link.

### Spec Correction Needed

- The spec and `wish.md` now list only `#profile`, `#profileName`,
  `#profileAvatar`, and `#profileSpace`.

## Slice 11: Protect Profile Link and Trusted Wish Create UI

### Ambiguity or Incorrect Spec

- The earlier v1 boundary treated `homeSpaceCell.defaultPattern.profile` as a
  durable but unprotected link. The requested behavior now requires protecting
  that link with integrity too.
- The persona wish UI initially could be implemented as raw runner markup. That
  would make it hard to trust the UI surface that starts profile creation.
- A direct handler that both writes the home link and starts the profile pattern
  in a new space would cross spaces in one write transaction. The existing
  runtime write isolation rejects that shape.
- The wish-created UI needs to vend the same trusted profile-creation action as
  the home tab so CFC authorizes writes to the protected home profile link.

### Decision

- `homeSpaceCell.defaultPattern.profile` now has static `"profile-link"`
  add-integrity and is `WriteAuthorizedBy` the home pattern's profile-link
  creation flow.
- Profile creation uses the trusted `submitProfileCreation` handler directly:
  it writes the `.inSpace(name)` profile default-pattern link and the
  `profileName` projection.
- The missing-profile `#profile` wish UI now loads
  `packages/patterns/system/profile-create.tsx` and renders that trusted
  surface via `cf-render`. The pattern sends the same create-profile stream used
  by the home profile tab and does not navigate.
- The protected durable surface in this slice is the resulting
  `homeSpaceCell.defaultPattern.profile` link; the `profileName` projection is
  support state for immediate well-known wish resolution.

### Tests Added

- `packages/runner/test/profile-owner-cfc.test.ts`
  - The home profile link schema carries `"profile-link"` add-integrity and a
    `writeAuthorizedBy` claim.
  - Direct untrusted writes to the home profile link fail.
- `packages/runner/test/wish.test.ts`
  - Missing `#profile` UI is rendered through a `cf-render` profile-create
    pattern placeholder instead of raw runner input markup.
- `packages/patterns/integration/shared-profile.test.ts`
  - The inline wish creation flow waits for the trusted
    `ProfileCreateSurface` before submitting profile names for both identities.

### Spec Correction Needed

- The spec, `wish.md`, and `HOME_SPACE.md` now document that the home profile
  link is CFC-protected and that persona wish creation UI is a trusted pattern
  surface.

## Slice 12: Headless Wish Persona UI Test Stabilization

### Ambiguity or Incorrect Spec

- The integration spec said to exercise the browser flow, but did not say how
  to synchronize around a missing-profile wish that intentionally launches a
  child pattern asynchronously.
- After identity switching, old rendered wish-create surfaces can remain in the
  document while the new identity's view settles. A selector-only synthetic
  submit can hit a stale input.

### Decision

- The shared-profile integration now runs in headless mode for UI verification.
- The test synchronizes on visible profile text and trusted profile-create
  selectors instead of waiting for global runtime idle, because the wish-created
  child pattern can keep the runtime from satisfying the generic idle probe.
- The synthetic submit helper dispatches `cf-send` to all matching pierced
  profile-create inputs so the active identity's trusted create surface receives
  the event even when stale render trees are still present.

### Tests Added

- `packages/patterns/integration/shared-profile.test.ts`
  - Verified with `HEADLESS=true deno task --cwd packages/patterns integration
    --filter "shared profile"`.

### Spec Correction Needed

- None.

## Slice 13: Trusted Wish Profile Creation Follow-Up

### Ambiguity or Incorrect Spec

- The plan said the wish persona UI should create the profile without
  navigating, but it did not specify how a wish-launched child pattern should
  cross from the shared pattern space into the user's home/profile spaces.
- Passing a protected profile link as a protected pattern argument caused CFC to
  reject setup of the trusted create surface. The protected data is the home
  profile field, not the transient pattern argument that carries a handle to it.
- A handler that creates `ProfileHome.inSpace(name)` and writes the home profile
  link returns `undefined`, but still has opaque refs that must be materialized.
  Materializing those refs in the handler transaction can violate single-writer
  transaction isolation.
- The profile default pattern's initialized name is not synchronously available
  to `#profileName` in the browser flow. The home default pattern needs a small
  colocated profile-name projection for immediate persona wishes.

### Decision

- `ProfileCreate` accepts a plain writable profile handle and optional
  `profileName` projection, while the home `profile` field remains the
  CFC-protected durable link.
- The wish launcher passes full sigil links for `profile` and `profileName` so
  they are resolved in the user's home space, not relative to the shared
  pattern's process cell.
- `undefined` handler results that only materialize `.inSpace(...)` opaque refs
  now run that materialization pattern after the handler transaction commits;
  this avoids cross-space writes in one transaction.
- Wish-created profile-create result cells are keyed by current user DID to
  avoid stale shared result cells after identity switches.
- `#profileName` prefers the home default `profileName` projection and falls
  back to the profile default pattern's `initialNameApplied` projection.

### Tests Added

- `packages/runner/test/pattern-scope.test.ts`
  - Reproduces a handler side effect that writes a linked `.inSpace(...)` child
    into a cell in another space.
- `packages/patterns/integration/shared-profile.test.ts`
  - Verifies the wish-created profile UI creates names for two identities in
    headless browser mode.

### Spec Correction Needed

- Document the home default `profileName` projection as v1 support state for
  immediate `#profileName` wishes after profile creation.

## Slice 14: Named `.inSpace()` Annotation Replacement

### Ambiguity or Incorrect Spec

- The post-run design said `.inSpace(name)` names are resolved after an async
  handler call, but did not explicitly say whether the runtime-only annotation
  should also be rewritten from the name to the resolved DID.

### Decision

- Treat unresolved names as a handler-frame-only intermediate value. Post-run
  resolution must replace the annotation itself with the resolved DID, not just
  retarget the cell link and pattern module.

### Tests Added

- `packages/runner/test/pattern-scope.test.ts`
  - Reproduces a named `.inSpace(...)` annotation surviving post-run as the
    human-readable space name.

### Spec Correction Needed

- Document that `.inSpace(name)` names must not survive post-run processing;
  all durable links, target spaces, and runtime annotations should contain the
  resolved DID.

## Slice 15: Identity Switch Runtime Boundary

### Ambiguity or Incorrect Spec

- The shared-profile browser test switched identities in the same page. That
  exposed that pattern/runtime closures can outlive `app.setIdentity(...)` when
  a test jumps directly from one identity to another.
- Too much runtime state assumes the authenticated identity is stable for the
  lifetime of the runtime connection.

### Decision

- `App.setIdentity(...)` now rejects changing from one logged-in DID directly to
  another. Callers must clear the identity first.
- The integration shell login helper logs out and waits for
  `globalThis.commonfabric.rt` to clear before logging in as a different DID.
  This keeps identity changes on the same browser page, but forces a new
  runtime instance and connection.
- Do not special-case `wish()` caches for identity switching; runtime teardown is
  the boundary.

### Tests Added

- `packages/shell/test/app-state.test.ts`
  - Verifies `App.setIdentity(...)` rejects direct cross-DID switching and
    allows login after logout.
- `packages/patterns/integration/shared-profile.test.ts`
  - Continues to verify two identities in headless browser mode through the
    normal shell login helper.

### Spec Correction Needed

- Document that shell identity changes are logout/login transitions. Direct
  cross-DID mutation of an active app identity is unsupported.

## Slice 16: Review Follow-Up Hardening

### Ambiguity or Incorrect Spec

- The profile default-pattern helper promised a profile default, but the spec
  did not state how to repair a profile space that already had an ordinary
  default pattern.
- `ownerPrincipal` was only exercised together with explicit integrity atoms,
  leaving the no-integrity failure mode unspecified in tests.
- Profile hashtag search had no loaded-state distinction, unlike mentionables.
- The initial-name projection was both support state for `#profileName` and a
  write-capable lift, which made blank names ambiguous.

### Decision

- `ensureProfileDefaultPattern()` validates an existing default pattern by
  `[NAME]` and repairs non-profile defaults by unlinking them before creating
  `ProfileHome`.
- `ownerPrincipal` without a matching `represents-principal` integrity claim is
  rejected even when the schema has no other integrity arrays.
- Profile hashtag search now returns a loaded flag and waits for profile
  elements to load before throwing a no-match error.
- The initial-name value is applied only by the writable's initial value.
  Clearing the profile name to blank is a valid owner action.
- The `.inSpace(name)` link rewrite must match unresolved named-space links in
  handler side effects; checking only for links without a space leaves durable
  profile links pointed at the unresolved name instead of the derived DID.
- Pattern-level rendering of the `#profile` wish UI must keep using the
  `WishState` UIRenderable path. Extracting `$UI` directly rendered the visual
  wrapper but lost the embedded trusted profile-create action wiring in the
  browser integration.

### Tests Added

- `packages/piece/test/profile-default-pattern.test.ts`
  - Verifies profile default creation repairs a pre-existing ordinary default.
- `packages/patterns/system/profile-home.test.tsx`
  - Verifies clearing the initial profile name remains blank.
- `packages/runner/test/profile-owner-cfc.test.ts`
  - Verifies `ownerPrincipal` schemas without matching integrity claims fail.
- `packages/patterns/integration/shared-profile.test.ts`
  - Headless browser coverage caught the `$UI` extraction regression and
    verifies the trusted wish-created profile flow still creates both users'
    profile names.

### Spec Correction Needed

- The data model should keep documenting `profileName` and
  `initialNameApplied` as implementation support for immediate profile-name
  wishes.
