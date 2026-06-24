# Home Space Runtime Internals

Implementation details behind the home-space behavior described in
[`docs/common/conventions/HOME_SPACE.md`](../common/conventions/HOME_SPACE.md).

## Runtime Configuration

The runtime exposes `userIdentityDID`, the user's actual identity DID (distinct
from the current space DID). It is not a constructor option — the runtime
derives it internally from the storage manager's identity:

```typescript
// Shown inside a pattern body.
const runtime = new Runtime({
  apiUrl,
  storageManager,
});
// Derived internally: runtime.userIdentityDID === storageManager.as.did()
```

## ACL Initialization

The home space requires special ACL handling since there's no separate space
identity to delegate from. When `space === runtime.userIdentityDID`, the
PieceManager detects this as a home space and uses `runtime.getHomeSpaceCell()`.

See `packages/piece/src/manager.ts` (home space detection) and
`packages/runner/src/runtime.ts` `getHomeSpaceCell()` for implementation.
