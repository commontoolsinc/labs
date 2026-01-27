<!-- @reviewed 2025-12-10 docs-rationalization -->

# Home Space and User Identity

## Overview

The **home space** is a special space where the space DID equals the user's
identity DID. Every user has exactly one home space that is automatically
available when they authenticate.

```
Home Space DID = User Identity DID = runtime.storageManager.as.did()
```

## Purpose

The home space provides a persistent, user-owned storage location for:

- **Favorites** - A singleton list of favorited charms that works across all
  spaces
- Future user-level preferences and settings

## Favorites

Favorites are stored in the home space's `spaceCell.favorites` field. This
design means:

1. **Singleton per user** - There is ONE favorites list per user, regardless of
   how many spaces they access
2. **Cross-space** - Favorites persist and are accessible from any space the
   user visits
3. **Identity-tied** - Favorites are tied to the user's identity, not any
   particular space

### Accessing Favorites

Via `CharmManager`:

```typescript
const manager = new CharmManager(session, runtime);
await manager.addFavorite(charm);
await manager.removeFavorite(charm);
const isFav = manager.isFavorite(charm);
const favoritesCell = manager.getFavorites();
```

Via the favorites functions directly:

```typescript
import {
  addFavorite,
  removeFavorite,
  isFavorite,
  getHomeFavorites,
} from "@commontools/charm";

await addFavorite(runtime, charm);
await removeFavorite(runtime, charm);
const isFav = isFavorite(runtime, charm);
const favoritesCell = getHomeFavorites(runtime);
```

## Implementation Details

### Runtime Configuration

The runtime accepts `userIdentityDID` in its options, which is the user's actual
identity DID (distinct from the current space DID):

```typescript
const runtime = new Runtime({
  apiUrl,
  storageManager,
  userIdentityDID: storageManager.as.did(), // User's identity
});
```

### ACL Initialization

The home space requires special ACL handling since there's no separate space
identity to delegate from. When `space === runtime.userIdentityDID`, the
CharmManager detects this as a home space and uses `runtime.getHomeSpaceCell()`.

See `packages/charm/src/manager.ts` (home space detection) and
`packages/runner/src/runtime.ts` `getHomeSpaceCell()` for implementation.
