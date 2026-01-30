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

- **Favorites** - A singleton list of favorited pieces that works across all
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

Via `PieceManager`:

```typescript
const manager = new PieceManager(session, runtime);
await manager.addFavorite(piece);
await manager.removeFavorite(piece);
const isFav = manager.isFavorite(piece);
const favoritesCell = manager.getFavorites();
```

Via the favorites functions directly:

```typescript
import {
  addFavorite,
  removeFavorite,
  isFavorite,
  getHomeFavorites,
} from "@commontools/piece";

await addFavorite(runtime, piece);
await removeFavorite(runtime, piece);
const isFav = isFavorite(runtime, piece);
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
PieceManager detects this as a home space and uses `runtime.getHomeSpaceCell()`.

See `packages/piece/src/manager.ts` (home space detection) and
`packages/runner/src/runtime.ts` `getHomeSpaceCell()` for implementation.
