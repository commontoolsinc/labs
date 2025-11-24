---
date: 2025-11-24
updated: 2025-11-24
status: answered
tags: [built-ins, runtime, identity, did, signer]
related: []
supersedes: []
superseded_by: null
age_warning: false
---

# From a built-in like wish() or fetchData() how can I get the public DID of the current user? We have IRuntime which contains IStorageManager which contains ISession... or something like that. But what is the magic line of code to give me the DID (or a storage instance pointing to the space)?

## Context

When developing built-in functions, you need to access the user's **identity DID** (their keypair/signer DID) - not the space DID. This is a common source of confusion because there are TWO different DIDs in the system:

1. **User Identity DID** - The user's keypair/signer identity (what you usually want)
2. **Space DID** - A namespace for data (may be derived from or separate from the user identity)

## Question

From a built-in like wish() or fetchData() how can I get the public DID of the current user? We have IRuntime which contains IStorageManager which contains ISession... or something like that. But what is the magic line of code to give me the DID (or a storage instance pointing to the space)?

## Answer

### The Correct Answer: User Identity DID

```typescript
const userIdentityDID = runtime.storageManager.as.did();
```

Built-in functions receive `runtime: IRuntime` as a parameter. The user's identity is accessible via the `storageManager.as` signer:

```typescript
export function myBuiltin(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,  // <-- Runtime is injected
): Action {
  return (tx: IExtendedStorageTransaction) => {
    // Get the USER's identity DID (their keypair/signer)
    const userIdentityDID = runtime.storageManager.as.did();

    // Get the SPACE's DID (where data is stored - different!)
    const spaceDID = parentCell.space;

    // ...
  };
}
```

### Architecture Chain

```
IRuntime
  └─ storageManager: IStorageManager (interface.ts:66-100)
      └─ (concrete: StorageManager, cache.ts:1916)
          ├─ as: Signer  ← USER'S IDENTITY (has .did() method)
          ├─ id: string  (just a UUID for debugging - NOT a DID!)
          └─ spaceIdentity?: Signer  (optional derived identity for space)
```

From `packages/identity/src/session.ts:4-9`:
```typescript
export type Session = {
  spaceName: string;
  spaceIdentity?: Identity;  // Optional: derived identity for the space
  space: DID;                 // The space's DID
  as: Identity;              // The USER's identity ← This is what we want!
};
```

### Critical Distinctions

**User Identity DID vs Space DID:**

```typescript
// User Identity DID (the person's keypair)
const userDID = runtime.storageManager.as.did();
// Example: "did:key:z6Mkq..."

// Space DID (the namespace where data lives)
const spaceDID = parentCell.space;
// Example: "did:key:z6Mkr..." (may be same or different from user DID)

// WRONG: runtime.id is NOT a DID!
// runtime.id is just crypto.randomUUID() for debugging
```

### Real-World Example

From `packages/shell/src/lib/runtime.ts:106-128`:
```typescript
const session = await createSession({ identity, spaceName });

// Log user identity for debugging
identityLogger.log("telemetry", `[Identity] User DID: ${session.as.did()}`);
identityLogger.log(
  "telemetry",
  `[Identity] Space: ${spaceName} (${session.space})`,
);

const runtime = new Runtime({
  apiUrl: new URL(apiUrl),
  storageManager: StorageManager.open({
    as: session.as,              // <-- User identity passed to storage manager
    spaceIdentity: session.spaceIdentity,
    address: new URL("/api/storage/memory", apiUrl),
  }),
  // ...
});
```

### Why Spaces Can Be Different from User Identity

Spaces can have their own derived identities for privacy/security. From `packages/identity/src/session.ts:27-40`:

```typescript
export const createSession = async (
  { identity, spaceName }: { identity: Identity; spaceName: string },
): Promise<Session> => {
  // Derive a space-specific identity from a common root
  const spaceIdentity = await (await Identity.fromPassphrase("common user"))
    .derive(spaceName);

  return {
    spaceName,
    spaceIdentity,
    space: spaceIdentity.did(),  // Space DID (derived)
    as: identity,                 // User identity (original)
  };
};
```

This allows:
- Multiple users to share a space
- A user to have multiple spaces
- Spaces with derived identities for privacy

## Notes

### Common Mistakes

1. **Using `parentCell.space`** - This gives you the SPACE DID, not the user identity DID
2. **Using `runtime.id`** - This is just a random UUID (`crypto.randomUUID()`), not a DID at all
3. **Confusing space with identity** - A space is a namespace owned by an identity; they're different concepts

### Key Files

**Type definitions:**
- `packages/identity/src/session.ts:4-9` - Session type showing `as` (user identity) vs `space`
- `packages/runner/src/storage/interface.ts:66-100` - IStorageManager interface
- `packages/runner/src/storage/cache.ts:1916-1949` - StorageManager with `as: Signer` field

**Real usage examples:**
- `packages/shell/src/lib/runtime.ts:106-128` - Runtime creation with user identity
- `packages/identity/src/session.ts:27-40` - Session creation showing identity vs space

### The Magic Line

```typescript
runtime.storageManager.as.did()  // ← User's identity DID
```
