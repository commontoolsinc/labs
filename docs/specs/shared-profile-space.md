# Shared Profile Space

## Status

Implementation spec.

This document captures the target behavior for shared user profiles across
multi-user patterns. It is intended to drive implementation across home-space
schema, profile-space creation, default-pattern selection, `wish()` resolution,
authorization, and integration tests.

## Summary

Multi-user patterns should not ask each user for their display name and avatar
inside every pattern. A user has one shared profile space, linked from their
home space. Patterns can discover profile data and profile-hosted pieces through
`wish()` without knowing the profile space DID up front.

The profile is a real space. Its `spaceCell.defaultPattern` is a new
profile-specific default pattern, not the normal space default app. The profile
default pattern initially owns:

- the profile owner's name and avatar
- a list of profile elements, implemented as pieces in the profile space
- owner-only handlers for adding profile elements from a fixed catalog or a
  pattern URL

The user's home space links to the profile space through a well-known field on
the home space cell. If the link is missing, the home pattern renders a
"Create profile" control. Creating the profile creates or locates the profile
space, ensures its profile default pattern, then stores the link on the home
space cell.

`wish()` gains a profile search scope for hashtag queries. A profile-scoped wish
searches pieces in the current user's profile space whose descriptions or user
tags contain the requested hashtag, analogous to the existing favorites and
mentionables hashtag paths.

## Goals

- Provide one durable profile per authenticated user.
- Keep profile data separate from ordinary home-space settings and from
  per-collaboration-space data.
- Make profile discovery work from any space the user visits.
- Let profile owners add profile elements without exposing direct mutation of
  the profile element list.
- Add an integration test that creates a profile and proves a demo multi-user
  pattern can render the user's shared name.
- Make `wish({ query: "#profile" })` resolve to the current user's profile
  default pattern. Existing learned-summary consumers must migrate to a more
  explicit target before relying on this feature.

## Non-Goals

- Replacing the home space. The home space remains the user's singleton root for
  settings, favorites, spaces, and the profile-space link.
- Designing a full rich profile data model. The first profile default pattern
  only needs name, avatar, and add-element mechanics.
- Migrating every current profile-like pattern in one change.
- Making `wish()` scope strings part of the cell storage scope lattice. This
  document uses "wish scope" for search domains; it is separate from
  `space | user | session` cell instance scopes.

## Current Repo Facts

- `Runtime.getHomeSpaceCell()` creates the home space cell at
  `(space = userIdentityDID, cause = userIdentityDID)`.
- `PiecesController.ensureDefaultPattern()` links a default pattern at
  `spaceCell.defaultPattern`. Today it chooses `system/home.tsx` for the home
  space and `system/default-app.tsx` for other spaces.
- The current home pattern owns durable cells such as `favorites`, `journal`,
  `learned`, `spaces`, and `defaultAppUrl` on the home default pattern.
- The current docs say favorites are on `spaceCell.favorites`, but current code
  uses `homeSpaceCell.defaultPattern.favorites`. This spec follows the user's
  requested profile link shape: the profile-space link is a field on the home
  space cell itself.
- `wish()` currently supports scope values `"~"` for home favorites, `"."` for
  current-space mentionables, and arbitrary DIDs for other spaces.
- The string `#profile` was previously a well-known home target that resolved
  to `home.defaultPattern.learned.summary`. This implementation intentionally
  retargets it to the profile default pattern so profile-aware patterns have a
  direct well-known profile entry point.

## Data Model

### Home Space Cell

Add a well-known field to the home space cell:

```ts
type HomeSpaceCell = {
  defaultPattern?: Cell<unknown>;
  profileSpace?: Cell<ProfileSpaceCell>;
};
```

`profileSpace` is a cell link to the root space cell of the user's profile
space. It must not point directly at the profile default pattern. Linking to the
space cell keeps the profile space model parallel to all other spaces:

```ts
homeSpaceCell.profileSpace -> profileSpaceCell
profileSpaceCell.defaultPattern -> profile default pattern piece
```

The runner `spaceCellSchema` must include `profileSpace` as a cell-valued
property so traversal, pull, and cross-space link following can load the profile
space root.

### Profile Space Identity

The profile space DID must be per-user and stable. Do not use
`createSession({ spaceName: "profile" })`, because named spaces are currently
derived from a shared `"common user"` identity and would not be user-specific.

The implementation should introduce a profile-space identity helper, for
example:

```ts
const profileSpaceIdentity = await userIdentity.derive("common-fabric-profile");
```

The resulting DID is the profile space DID. The home-space `profileSpace` link
is the durable pointer and is the source of truth after creation. If a future
space-creation flow chooses a random profile space DID instead, it must still
store that link on the home space cell and must not rely on a human-readable
space name.

### Profile Default Pattern Output

The initial profile default pattern should export this contract:

```ts
type ProfileElement = {
  cell: Cell<unknown>;
  tag: string;
  userTags: string[];
  title?: string;
  source?: "catalog" | "url";
};

type ProfileDefaultPattern = {
  [NAME]: string;
  [UI]: VNode;
  name: string;
  avatar: string;
  elements: ProfileElement[];
  addElement: Stream<AddProfileElementEvent>;
  removeElement: Stream<{ cell: Cell<unknown> }>;
};
```

`avatar` starts as a string. The first implementation can use a URL, data URL,
or emoji-like text. Binary/blob avatar upload is out of scope.

`elements` is the profile-space analog of favorites and mentionables. Each
entry points at a piece that lives in the profile space. `tag` stores the
snapshot string used for hashtag search, following the favorites pattern:
explicit tag if supplied, otherwise a serialized schema/description snapshot.
`userTags` stores user-supplied tags without `#`.

The profile default pattern may also include an internal `allPieces` list if
that is useful for rendering, but external code must depend on `elements` and
`addElement`, not `allPieces`.

## Profile Default Pattern Selection

Default pattern creation needs a third case:

1. Home space: `/api/patterns/system/home.tsx`
2. Profile space: `/api/patterns/system/profile-home.tsx`
3. Other spaces: home `defaultPattern.defaultAppUrl` or
   `/api/patterns/system/default-app.tsx`

A profile space is not identified by `space === userIdentityDID`. It is
identified by the home-space `profileSpace` link or by the explicit
profile-creation path before the link exists. Implementation options:

- Add `ensureProfileDefaultPattern(profileSpaceDID)` and
  `recreateProfileDefaultPattern(profileSpaceDID)` instead of overloading
  `ensureDefaultPattern()`.
- Or add a `defaultPatternKind: "home" | "profile" | "space"` option to the
  default-pattern controller, with profile creation passing `"profile"`.

The first option is safer because opening an arbitrary non-home space should
continue to use the ordinary default app unless it is reached through the
profile-space creation/link path.

## Home Pattern Flow

The home pattern reads `homeSpaceCell.profileSpace`.

If `profileSpace` is missing:

- render a `Create profile` button in the home profile tab
- clicking it calls an owner-only host/runtime operation or stream that:
  1. derives or creates the profile space DID
  2. gets the profile space cell
  3. ensures the profile default pattern
  4. writes the profile space cell link to `homeSpaceCell.profileSpace`
  5. navigates to or renders the created profile

If `profileSpace` is present:

- render a link to the profile space
- render the profile default pattern or a compact summary based on
  `profileSpace.defaultPattern.name` and `avatar`

This write should target the home space cell, not the home default pattern, so a
custom home pattern can be replaced without losing the profile-space link.

## Adding Profile Elements

Profile elements are added through the profile default pattern's `addElement`
stream. Callers must not push to `elements` directly.

`AddProfileElementEvent` initially supports two sources:

```ts
type AddProfileElementEvent =
  | { catalogId: string }
  | { patternUrl: string; title?: string; tag?: string };
```

The fixed catalog is a small allowlist of pattern URLs or module descriptors
owned by the profile default pattern. URL-based creation compiles the supplied
pattern URL using the same resolver path as ordinary piece creation.

The handler creates the piece in the profile space, snapshots its searchable
tag, deduplicates by cell identity, and appends a `ProfileElement`.

## Authorization

The v1 protected data is the profile default pattern's owner-controlled fields
and element mutations:

- `profileDefault.name`
- `profileDefault.avatar`
- `profileDefault.elements`
- `profileDefault.addElement` / `profileDefault.removeElement` writes that
  mutate `elements`

Those protected fields must carry owner integrity shaped like:

```ts
{ kind: "represents-principal", subject: ownerDid }
```

Writes to those fields must satisfy the owner integrity and must be
`WriteAuthorizedBy` the trusted profile handlers or trusted profile UI actions.
This is CFC-enforced, not UI-only. The UI may hide editing controls for
non-owners, but that is only a convenience check.

The home link write to `homeSpaceCell.profileSpace` is durable and must still
be made by the authenticated user flow, but it is not CFC owner-protected in
v1. It is intentionally outside the protected profile data surface for this
first implementation.

The owner check should use `runtime.userIdentityDID` / `storageManager.as.did()`
as the authenticated principal. It should not use the current collaboration
space DID. If static CFC authoring aliases cannot express exact owner-DID
requirements, profile creation should use a profile schema factory that embeds
the owner DID into the profile default schema.

## Wish Scope

### Scope Value

Add a profile wish scope value:

```ts
type WishScope = "~" | "." | "profile" | DID;
```

The string `"profile"` is reserved and must be removed from the arbitrary-DID
bucket. Today `getArbitraryDIDs()` treats every non-`"~"`/`"."` value as a DID;
that must change before `scope: ["profile"]` is exposed.

### Hashtag Search

For hashtag queries, `scope: ["profile"]` searches
`homeSpaceCell.profileSpace.defaultPattern.elements`.

Matching follows the favorites behavior:

1. `userTags` exact match, lowercased, without `#`
2. `tag` hashtag match using the existing hashtag extractor

The result maps each matching `ProfileElement` to `element.cell`, then applies
the query path suffix the same way favorites and mentionables do.

Examples:

```tsx
// Search profile elements only.
const profileCard = wish({ query: "#profile-card", scope: ["profile"] });

// Search favorites, current space, and profile elements.
const person = wish({
  query: "#person",
  scope: ["~", ".", "profile"],
});
```

Search order for mixed scopes is:

1. favorites (`"~"`)
2. current-space mentionables (`"."`)
3. profile elements (`"profile"`)
4. explicit DID spaces, in caller-provided order

This preserves existing favorites-first behavior and makes profile an explicit
extension rather than a new default.

### Well-Known Profile Targets

`wish({ query: "#profile" })` resolves to the current user's
`profileSpace.defaultPattern`.

Add these explicit profile targets:

```tsx
wish({ query: "#profile" })            // profileSpace.defaultPattern
wish({ query: "#profileSpace" })       // the profile space cell
wish({ query: "#profileDefault" })     // profileSpace.defaultPattern
wish({ query: "#profileName" })        // profileSpace.defaultPattern.name
wish({ query: "#profileAvatar" })      // profileSpace.defaultPattern.avatar
```

If the old learned-summary shortcut remains useful, it should get a new explicit
target instead of overloading `#profile`.

## Integration Test Plan

Add a browser integration test with a demo pattern.

### Demo Pattern

Create a small test/demo pattern that renders the current user's shared profile
name:

```tsx
export default pattern(() => {
  const name = wish<string>({ query: "#profileName" });
  return {
    [NAME]: "Profile Name Demo",
    [UI]: <div>{name.result ?? "No profile"}</div>,
  };
});
```

The test should assert both states:

1. before profile creation, the demo renders the missing-profile state or a
   structured wish error
2. after profile creation and name entry, the demo renders the profile name

### Browser Flow

The integration test should:

1. create a fresh browser identity
2. navigate to a fresh ordinary space
3. add or open the demo pattern
4. assert the demo has no profile name yet
5. navigate to the home view
6. click `Create profile`
7. set the profile name and avatar in the profile default pattern UI
8. return to the ordinary space and open the demo pattern
9. assert the rendered text is the profile name
10. optionally create a second ordinary space with the same identity and assert
    the same profile name renders there too
11. for multi-user coverage, log in as a second identity against the same
    shared ordinary space/piece, create that user's profile, and assert the demo
    renders the second user's name without changing the first user's profile

The test should use the existing shell integration harness style from
`packages/patterns/integration/default-app.test.ts`, including fresh noble
identities and `waitForRuntimeIdle` before assertions. The CFC browser helpers
already provide useful primitives such as `waitForText`, `fillCfInput`, and
`waitForRuntimeIdle`; the CFC group-chat integration tests show the existing
shape for switching identities while keeping a shared piece under test.

### Runner-Level Tests

Add focused runner tests for `wish()`:

- `scope: ["profile"]` is not treated as a DID
- profile hashtag search reads `homeSpaceCell.profileSpace.defaultPattern`
- mixed scope ordering is stable
- missing `profileSpace` returns an empty/error `WishState` without throwing out
  of the scheduler action
- `wish({ query: "#profile" })` returns the profile default pattern

## Implementation Plan

1. Add schemas and helper types for `profileSpace` on the space cell and
   `ProfileDefaultPattern` / `ProfileElement`.
2. Add a profile-space identity helper and profile creation operation.
3. Add the profile default pattern at
   `packages/patterns/system/profile-home.tsx`.
4. Add profile default-pattern creation in `packages/piece`, preferably as an
   explicit profile-specific controller method.
5. Update the home pattern to render missing and linked profile states.
6. Update `WishParams.scope`, `wish()` parsing, and hashtag search for
   `"profile"`.
7. Add explicit profile well-known targets: `#profileSpace`,
   `#profileDefault`, `#profileName`, and `#profileAvatar`.
8. Add runner tests for wish behavior.
9. Add the browser integration test and demo pattern.
10. Update `docs/common/conventions/wish.md` and
    `docs/common/conventions/HOME_SPACE.md` after behavior lands.

## Open Questions

- Should profile spaces be readable by all collaborators by default, or private
  until explicitly shared?
- Should the profile default pattern expose `elements` only, or also a
  default-app-compatible `addPiece` stream for reuse?
- Should avatar be a string permanently, or should the first implementation
  reserve a future blob shape?
- How should a user intentionally reset or migrate their profile space if the
  home-space link points to a broken or obsolete profile?
