# CT-823 Iteration 10 - Confirmed Deletion Race Condition

## Key Discovery: We Can See The Exact Objects Being Deleted

### The 41 Objects Being Reverted (15:48:21.711)
All are `application/json` type objects with IDs like:
- `of:baedreih4aou2o2re3hfukdurcyda5ihorexq6bf2673lxjpuktqdmvurhu`
- `of:baedreickbe4zb647efwbfyolo5arn4237ts55x2fxb2stvmsispge7gsm4`
- `of:baedreibbqbksayvt6dvstsi5z7n7uvghgcxrls2bki5srlua6kyqzq5m6m`
- ... (38 more)

### Proof of Deletion Race Condition

**Object: `of:baedreickbe4zb647efwbfyolo5arn4237ts55x2fxb2stvmsispge7gsm4`**

1. **15:48:21.711**: Object is reverted (deleted) as part of 41-change rollback
2. **15:48:22.474**: Action tries to update this object, fails with "does not exist"

This pattern repeats for multiple objects from the reverted set.

## The Race Condition Timeline

```
15:48:21.709 - Conflict occurs ("already exists")
15:48:21.711 - System reverts 41 changes, deleting objects
15:48:21.712 - Remote update received with same 41 changes
15:48:21.712 - Actions triggered for the (now deleted) objects
15:48:22.474 - Actions execute, find objects don't exist
15:48:24.615 - More "does not exist" errors cascade
```

## What The Objects Represent

The reverted objects are all `application/json` type, suggesting they are:
- Message data structures
- UI component state
- Reactive binding configurations
- VDOM elements

Each object had `beforeValue: 'object'` and `afterValue: 'undefined'`, confirming they were being deleted (changed from existing objects to undefined).

## Root Cause Confirmed

The bug is definitively a **deletion race condition**:

1. Tab2 receives remote updates creating 41 objects
2. Tab2 registers actions to be triggered by these objects
3. A conflict occurs when Tab2 tries to create an already-existing object
4. The conflict resolution reverts (deletes) all 41 objects
5. Previously registered actions still execute
6. Actions fail because they're trying to update deleted objects

## Why This Causes UI Flicker

When the 41 objects are deleted:
- UI elements bound to these objects disappear
- Actions fail to update them
- The system may retry or re-create them
- UI elements reappear

This create → delete → recreate cycle causes the visible flicker.

## Solution Approach

To fix this, the system needs to:
1. **Cancel pending actions** when objects are reverted
2. **Check object existence** before executing actions
3. **Batch reverts and action execution** to be atomic
4. **Prevent actions on tombstoned objects** until they're recreated

The key insight is that the revert operation and action execution are not coordinated, leading to actions operating on stale object references.