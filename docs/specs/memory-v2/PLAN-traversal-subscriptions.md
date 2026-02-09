# Plan: Schema-based traversal subscriptions + notification rename

## Context

After switching default memory to v2, `ReplicaV2.setupSubscription()` uses a wildcard
`{ "*": {} }` subscription — fetching ALL entities in the space. This is inefficient.
v1 uses `SchemaObjectTraverser` (in `traverse.ts`) to walk entity graphs via schemas,
discovering exactly which related entities are needed. The user wants to reuse this same
traversal code in v2, because it's shared with higher-layer client code and must behave
identically.

Additionally, the internal event system (`IStorageSubscription`) that fires
commit/integrate/reset events should be renamed to "notification" terminology to
distinguish from v2 data subscriptions.

---

## Part 1: Schema-based traversal subscriptions

### Design overview

After entity data arrives from the server, run `SchemaObjectTraverser` over the local
state using the cell's `SchemaPathSelector`. The traverser discovers linked entities via
`followPointer()` and records them in `schemaTracker`. Subscribe to any newly discovered
entities. Repeat until no new entities are found.

### Step 1: Create v2 read-only transaction adapter

**File: `packages/runner/src/storage/v2/provider.ts`** (add new class)

Create `V2ObjectStorageManager` implementing `ObjectStorageManager` (from traverse.ts):

```typescript
class V2ObjectStorageManager implements ObjectStorageManager {
  constructor(
    private spaceId: MemorySpace,
    private localState: Map<string, Revision<State>>,
  ) {}

  load(address: BaseMemoryAddress): IAttestation | null {
    const state = this.localState.get(address.id);
    if (!state || state.is === undefined) return null;
    return {
      address: { space: this.spaceId, id: address.id, type: address.type, path: [] },
      value: { value: state.is },  // wrap in v1 { value: ... } envelope
    };
  }
}
```

Create `V2ReadOnlyTransaction` implementing `IExtendedStorageTransaction`:

```typescript
class V2ReadOnlyTransaction implements IExtendedStorageTransaction {
  tx: IStorageTransaction;
  private managed: ManagedStorageTransaction;

  constructor(manager: V2ObjectStorageManager) {
    this.managed = new ManagedStorageTransaction(manager);
    this.tx = this.managed;
  }

  // Delegate read methods to ManagedStorageTransaction
  read(address, options?) { return this.managed.read(address, options); }
  status() { return this.managed.status(); }

  // readOrThrow: unwrap Result, return undefined for NotFound, throw for other errors
  readOrThrow(address, options?) {
    const result = this.read(address, options);
    if ('error' in result) {
      if (result.error.name === 'NotFoundError') return undefined;
      throw new Error(result.error.message);
    }
    return result.ok.value;
  }

  readValueOrThrow(address, options?) {
    return this.readOrThrow({ ...address, path: ['value', ...address.path] }, options);
  }

  // Write/commit methods throw (read-only adapter)
  addCommitCallback() {}
  writer() { throw new Error("Read-only"); }
  write() { throw new Error("Read-only"); }
  writeOrThrow() { throw new Error("Read-only"); }
  writeValueOrThrow() { throw new Error("Read-only"); }
  reader() { throw new Error("Read-only"); }
  abort() { throw new Error("Read-only"); }
  commit() { throw new Error("Read-only"); }
}
```

Key imports to add: `SchemaObjectTraverser`, `ManagedStorageTransaction`,
`ObjectStorageManager`, `MapSet` from `../../traverse.ts`.
Also `deepEqual` from `@commontools/utils/deep-equal`.
Note: `getTrackerKey` is not exported — just replicate its format: `"${space}/${id}/${type}"`.

### Step 2: Add traversal-based entity discovery

**File: `packages/runner/src/storage/v2/provider.ts`** (new method on `ReplicaV2`)

```typescript
/**
 * Run SchemaObjectTraverser over localState for all root selectors.
 * Returns entity IDs discovered that are not yet subscribed.
 */
private discoverLinkedEntities(): Set<string> {
  const manager = new V2ObjectStorageManager(this.spaceId, this.localState);
  const tx = new V2ReadOnlyTransaction(manager);
  const discovered = new Set<string>();

  for (const [rootEntityId, selector] of this.rootSelectors) {
    const schemaTracker = new MapSet<string, SchemaPathSelector>(deepEqual);
    // Pass schemaTracker as 4th arg; undefined for 3rd (use default cycle tracker)
    const traverser = new SchemaObjectTraverser(
      tx, selector, undefined, schemaTracker,
    );

    // Build attestation for root entity from localState
    const rootState = this.localState.get(rootEntityId);
    if (!rootState || rootState.is === undefined) continue;
    const rootDoc = {
      address: { space: this.spaceId, id: rootEntityId, type: V2_MIME, path: ['value'] },
      value: rootState.is,
    };

    // Traverse — this populates schemaTracker with all linked entities
    traverser.traverse(rootDoc);

    // Extract entity IDs from schemaTracker keys
    // getTrackerKey format: "${space}/${id}/${type}" — but type is
    // "application/json" which contains "/" so use prefix/suffix matching
    const prefix = `${this.spaceId}/`;
    const suffix = `/${V2_MIME}`;
    for (const key of schemaTracker.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        const entityId = key.slice(prefix.length, key.length - suffix.length);
        if (entityId && !this.subscriptionIds.has(entityId)) {
          discovered.add(entityId);
        }
      }
    }
  }
  return discovered;
}
```

### Step 3: Rewrite `setupSubscription()` — per-entity with traversal expansion

**File: `packages/runner/src/storage/v2/provider.ts`**

Replace wildcard subscription with per-entity subscriptions that expand via traversal.

New fields on `ReplicaV2`:
```typescript
private rootSelectors = new Map<string, SchemaPathSelector>(); // root entity → selector
private activeSubscriptionId: InvocationId | null = null;      // single consolidated sub
private pendingNewEntityIds = new Set<string>();                // entities to add on next flush
private flushScheduled = false;
```

Remove: `hasWildcardSubscription`.

Change `setupSubscription(entityId: string)` signature to accept optional selector:
```typescript
setupSubscription(entityId: string, selector?: SchemaPathSelector): void
```

Flow:
1. Store selector in `rootSelectors` if provided (root entity from `sync()`)
2. Add entityId to `pendingNewEntityIds` if not already subscribed
3. Call `scheduleFlush()` to batch subscription creation

New methods:
- `scheduleFlush()` — uses `queueMicrotask` to batch multiple discoveries in one tick
- `flushSubscription()` — unsubscribes old consolidated subscription, creates new one
  with all tracked entity IDs using multi-entity selector `{ "a": {}, "b": {}, ... }`.
  After initial data arrives, runs `discoverLinkedEntities()` and recurses if new
  entities are found.

### Step 4: Wire traversal into data ingestion

In `applyFactSet()` and `handleSubscriptionUpdate()`, after updating localState and
notifying scheduler:
- Call `discoverLinkedEntities()` to find new references
- For each new entity, call `setupSubscription(entityId)` (without selector — these
  are linked entities discovered by traversal, not roots)

### Step 5: Pass selector through `sync()`

**File: `packages/runner/src/storage/v2/provider.ts`** (method `ProviderV2.sync()`)

Currently `sync()` receives `selector?: SchemaPathSelector` but ignores it.
Change to pass it to `replica.setupSubscription(uri, selector)`.

### Step 6: Update `synced()` for cascading readiness

```typescript
async synced(): Promise<void> {
  while (this.pendingReady.length > 0) {
    const batch = [...this.pendingReady];
    this.pendingReady = [];
    await Promise.all(batch);
  }
}
```

### Step 7: Update `reset()` and `close()`

- `reset()`: clear `rootSelectors`, `activeSubscriptionId`, `pendingNewEntityIds`, `flushScheduled`
- `close()`: unsubscribe `activeSubscriptionId` if set

---

## Part 2: Rename storage subscriptions → notifications

### Renames

| Current | New |
|---------|-----|
| `IStorageSubscription` | `IStorageNotificationSink` |
| `IStorageSubscriptionCapability` | `IStorageNotificationSource` |
| `StorageSubscription` class | `StorageNotificationRelay` |
| Field `subscription: IStorageSubscription` | `notifications: IStorageNotificationSink` |
| Method param `subscription` | `sink` |

No changes to: `StorageNotification`, `ICommitNotification`, etc. (already correct).
The `subscribe()` method name stays — "subscribe to notifications" is fine.

### Files to update

| File | Change |
|------|--------|
| `packages/runner/src/storage/interface.ts` | Rename interfaces |
| `packages/runner/src/storage/subscription.ts` | Rename class + params |
| `packages/runner/src/scheduler.ts` | Update `createStorageSubscription()` return type |
| `packages/runner/src/runner.ts` | Update `createStorageSubscription()` return type |
| `packages/runner/src/storage/cache.ts` | Update field names + types |
| `packages/runner/src/storage/cache.deno.ts` | Update override signature |
| `packages/runner/src/storage/v2/provider.ts` | Rename `subscription` → `notifications` field |

---

## Verification

1. `deno test -A packages/memory/v2/test/*.ts --no-check` — all v2 tests pass
2. `cd packages/runner && deno test -A --no-check` — all 205+ tests pass (known v1-specific failures only)
3. `HEADLESS=1 deno test -A packages/shell/integration/piece.test.ts` — shell piece test passes
4. `cd packages/generated-patterns && deno task integration` — 144/144 pass
5. `deno fmt --check` — formatting clean
