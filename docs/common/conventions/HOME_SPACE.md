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
- **Spaces** - A managed list of spaces the user has created or bookmarked
- **Settings** - User-level preferences including `defaultAppUrl`

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

## Spaces

The home space maintains a managed list of spaces in
`defaultPattern.spaces`. Each entry has a `name` (required) and optional `did`.
Users add spaces via the Spaces tab in the home pattern. Clicking a space link
navigates to it (creating it if it doesn't exist yet).

## Custom Home Pattern

The home space's default pattern is the home experience itself — by default,
`/api/patterns/system/home.tsx`. You can replace it with a custom pattern using
the CT CLI:

```bash
# Deploy a custom home pattern
ct piece set-home -i ./my.key -a http://localhost:8000 ./my-home.tsx

# Reset to the system default
ct piece set-home -i ./my.key -a http://localhost:8000 --reset
```

Under the hood, `set-home` calls `PiecesController.recreateDefaultPattern()`
with the compiled program. This tears down the existing default pattern, creates
a new piece from the custom source, and links it as the space's
`defaultPattern`.

### Identity Matching

The home space DID equals the user's identity DID. This means **the CLI identity
must match the browser identity** for `set-home` to affect what the browser
displays.

The browser shell derives identity from a mnemonic via
`Identity.fromMnemonic()`, while `ct id derive` uses
`Identity.fromPassphrase()`. These are different algorithms — the same input
produces different DIDs.

To share identity between browser and CLI:

```bash
# 1. Create a mnemonic in the browser (login/register screen)
# 2. Export a CLI key using fromMnemonic (not fromPassphrase):
deno eval '
import { Identity } from "./packages/identity/src/identity.ts";
const mnemonic = "your 24-word mnemonic here";
const id = await Identity.fromMnemonic(mnemonic, { implementation: "noble" });
await Deno.writeFile("./browser.key", id.toPkcs8());
'

# 3. Use that key with ct
ct piece set-home -i ./browser.key -a http://localhost:8000 ./my-home.tsx
```

Note: `ct id derive <passphrase>` will NOT produce the same identity as the
browser. You must use `fromMnemonic` with `implementation: "noble"` to get a
PKCS8 key that matches the browser's identity.

## Default App URL

The `defaultPattern.defaultAppUrl` setting controls which pattern is used as the
default app when creating new spaces. When `PiecesController.ensureDefaultPattern()`
runs for a non-home space, it reads this value from the home space. If set, the
custom URL is used; otherwise it falls back to
`/api/patterns/system/default-app.tsx`.

This enables users to maintain personal forks of the default app pattern (e.g.,
`default-app-ben.tsx`) with different features or configurations.

## How Default Patterns Work

Both the home pattern and the default app pattern follow the same mechanism:

1. When a space is opened, `PiecesController.ensureDefaultPattern()` checks if
   a `defaultPattern` piece already exists on the space cell
2. If not, it creates one:
   - **Home space** (`space === userIdentityDID`): uses
     `/api/patterns/system/home.tsx`
   - **Other spaces**: reads `defaultAppUrl` from the home space; falls back to
     `/api/patterns/system/default-app.tsx`
3. The pattern is compiled, run, and linked as `spaceCell.defaultPattern`
4. `recreateDefaultPattern()` can replace it — either with a URL-based system
   pattern or a custom `RuntimeProgram` (used by `ct piece set-home`)

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
