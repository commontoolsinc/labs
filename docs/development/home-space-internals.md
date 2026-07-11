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

The home space has no separate derived space signer: the active user identity
is itself the space identity. `StorageManager` recognizes
`space === storageManager.as.did()`, checks the space's ACL document, and—when
it is absent—uses a temporary space-authenticated session to write
`{ [space]: "OWNER" }`. It closes that bootstrap session and mounts a fresh
normal session so local sequence numbers and user/session scope partitions are
not shared with bootstrap work.

Unlike named-space bootstrap, the home path also claims a populated legacy
space with no ACL. `session.open` remains read-only; the claim is an ordinary,
conflict-checked ACL transaction. See `packages/runner/src/storage/v2.ts`.
The home ACL is owner-only. Fresh named spaces use the rollout default
`{ [activeUser]: "OWNER", "*": "WRITE" }` until ACL management has a UI.
