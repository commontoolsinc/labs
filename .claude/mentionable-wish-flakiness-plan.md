# Fix Plan: Flaky `#mentionable` Wish Behavior

**Created:** 2025-12-21
**Updated:** 2025-12-21 (added deeper root causes from labs-3 investigation)
**Branch:** `debug-mentionable-wish-flaky`
**Status:** Analysis Complete - **PR #2325 is NOT sufficient**

---

## Executive Summary

The `#mentionable` wish functionality is flaky due to **multiple layers of issues**. PR #2325 fixes one layer (defaultPattern linking for CLI spaces), but **flakiness persists** even with that fix because of deeper architectural issues:

1. **Handler unwrapping** - Handlers unwrap OpaqueRefs to snapshots, breaking reactivity
2. **Pattern initialization race** - Sub-patterns call wish() before parent's BacklinksIndex computes
3. **Silent failures** - MentionController returns empty array instead of waiting/retrying

The labs-3 branch investigation (members-fix-plan.md) confirms these issues persist with PR #2325.

---

## Root Causes (Priority Order)

### 0. ~~CRITICAL: Path Traversal Doesn't Register Intermediate Dependencies~~ ALREADY FIXED

**Status:** ✅ ALREADY FIXED in commit `5903de72e` (November 24, 2025)
**Severity:** N/A - Not a bug
**Confidence:** VERIFIED by Oracle investigation

**Original Theory (WRONG):**
We believed `resolvePath()` in wish.ts needed to call `.sample()` on intermediate paths to register dependencies.

**Reality:**
The reactive dependency system in `packages/runner/src/reactive-dependencies.ts` (lines 162-185) ALREADY handles intermediate path changes correctly. The fix was implemented in commit `5903de72e` which added:
- Reachability tracking for paths
- Detection of intermediate path segment appearance/disappearance
- Test coverage in `reactive-dependencies.test.ts` lines 1616-1711

**Evidence:**
- Test "bug: action should trigger when intermediate path appears" is PASSING
- The fix distinguishes three cases for path reachability changes
- No changes needed to `resolvePath()`

**Conclusion:** This was a red herring. The reactive system works correctly.

---

### 0b. HIGH: MentionController Missing Cell Subscription

**Status:** ✅ FIXED in this branch
**Severity:** HIGH
**Confidence:** VERY HIGH (confirmed by code analysis and Oracle investigation)

**The Problem:**

The UI layer didn't subscribe to Cell value changes.

**The Fix (implemented):**

Added Cell subscription in MentionController (`packages/ui/src/v2/core/mention-controller.ts`):
- Added `_mentionableUnsubscribe` private field
- Updated `setMentionable()` to subscribe via `.sink()`
- Added cleanup in `hostDisconnected()`
- Added re-subscribe in `hostConnected()`

The fix follows the established pattern from `CellController` (lines 266-280).

---

### 0c. MEDIUM: Handler Unwrapping Breaks Reactivity (MembersModule-specific)

**Status:** Workaround exists (call wish() directly)
**Severity:** MEDIUM (only affects patterns passing mentionable through handlers)
**Confidence:** HIGH

**Note:** This does NOT affect Omnibot/Chatbot - they call wish() directly in pattern body.

**The Problem:**
When a handler executes, it unwraps OpaqueRefs to plain values. If you pass `mentionable` through a handler to create a sub-pattern, the sub-pattern receives a frozen snapshot.

**Workaround:** Sub-patterns should call `wish("#mentionable")` directly.

**Key Files:**
- `packages/runner/src/runner.ts:1003-1016` - Handler execution unwraps

### 0d. MEDIUM: CharmManager Parallel Promise Race

**Status:** ✅ FIXED in this branch
**Severity:** MEDIUM
**Confidence:** HIGH (confirmed by Oracle investigation)

**The Problem:**

In CharmManager constructor, `linkSpaceCellContents` read `this.charms.get()` before
`syncCharms(this.charms)` completed, potentially capturing an empty array.

**The Fix (implemented):**

Changed from parallel Promise.all to two-phase sequential execution:
```typescript
this.ready = Promise.all([
  this.syncCharms(this.charms),
  this.syncCharms(this.pinnedCharms),
  this.syncCharms(this.recentCharms),
  syncSpaceCellContents,
]).then(() => linkSpaceCellContents).then(() => {});
```

This ensures all syncs complete BEFORE `linkSpaceCellContents` reads the data.

---

### 0e. HIGH: spaceCell.allCharms Not Reactive to Charm Additions

**Status:** ✅ FIXED in this branch
**Severity:** HIGH
**Confidence:** VERY HIGH (confirmed by multiple Oracle investigations)

**The Problem:**

Line 129 called `.get()` on the charms cell, creating a static snapshot:
```typescript
allCharms: this.charms.withTx(tx).get() as Cell<never>[],  // WRONG: snapshot
```

When users created new charms, they wouldn't appear in the mentionable list because
`spaceCell.allCharms` was a frozen copy from initialization.

**The Fix (implemented):**

Remove `.get()` to create a reactive link instead:
```typescript
allCharms: this.charms.withTx(tx) as unknown as Cell<never>[],  // CORRECT: reactive link
```

This matches the pattern used by:
- `linkDefaultPattern()` (line 215) - sets cells directly
- All wish.test.ts test cases - set cells directly
- The Cell system design - `convertCellsToLinks()` handles the conversion

Now `wish("/").allCharms` stays in sync when charms are added/removed.

---

### 1. defaultPattern Not Linked Before Wishes Execute (CT-1133)

**Status:** PR #2325 pending - will land soon
**Severity:** HIGH (was CRITICAL, now one of several issues)
**Confidence:** VERY HIGH

**Location:** `packages/shell/src/lib/pattern-factory.ts:39-50`

```typescript
const charm = await cc.create(program, { start: true }, config.cause);
await runtime.idle();
await manager.synced();
await manager.linkDefaultPattern(charm.getCell());  // ← Happens AFTER pattern starts!
```

**The Race:**
1. Default-app charm starts immediately (`{ start: true }`)
2. Other patterns call `wish("#mentionable")`
3. Wish tries to resolve `spaceCell.defaultPattern.backlinksIndex.mentionable`
4. `linkDefaultPattern()` hasn't completed yet
5. Resolution fails silently → returns `undefined`

**Fix:** PR #2325 adds `ensureDefaultPattern()` with mutex-based synchronization for CLI-created spaces. The Shell path in pattern-factory.ts is already correct (waits for idle/synced before linking).

**Action Required:** Wait for PR #2325 to merge, then verify fix works.

---

### 2. home.tsx Missing BacklinksIndex Export (CT-1131)

**Status:** Low priority - theoretical edge case
**Severity:** LOW (home space not used for pattern development)
**Confidence:** HIGH

**Location:** `packages/patterns/home.tsx`

**Problem:** The home space uses `home.tsx` as its defaultPattern, but unlike `default-app.tsx`, it does NOT export `backlinksIndex`. The wish runtime hardcodes:

```typescript
// packages/runner/src/builtins/wish.ts:154-158
case "#mentionable":
  return [{
    cell: getSpaceCell(ctx),
    pathPrefix: ["defaultPattern", "backlinksIndex", "mentionable"],
  }];
```

**Current home.tsx (broken):**
```typescript
export default pattern((_) => {
  const favorites = FavoritesManager({});
  return {
    [NAME]: `Home`,
    [UI]: (<ct-screen>...</ct-screen>),
  };
  // ❌ Missing: backlinksIndex export
});
```

**Fixed home.tsx:**
```typescript
/// <cts-enable />
import { NAME, pattern, UI, wish } from "commontools";
import FavoritesManager from "./favorites-manager.tsx";
import BacklinksIndex, { type MentionableCharm } from "./backlinks-index.tsx";

type HomeOutput = {
  backlinksIndex: {
    mentionable: MentionableCharm[];
  };
};

export default pattern<void, HomeOutput>((_) => {
  const { allCharms } = wish<{ allCharms: MentionableCharm[] }>("/");
  const index = BacklinksIndex({ allCharms });
  const favorites = FavoritesManager({});

  return {
    backlinksIndex: index,  // ✅ Now wish("#mentionable") works in home space
    [NAME]: `Home`,
    [UI]: (
      <ct-screen>
        <h1>home<strong>space</strong></h1>
        <ct-card>{favorites}</ct-card>
      </ct-screen>
    ),
  };
});
```

**Action Required:** None for now - users don't deploy patterns to home space. Fix only if a use case emerges.

---

### 3. Cell.get() Doesn't Await sync() (CT-1126)

**Status:** PR #2299 MERGED
**Severity:** HIGH
**Confidence:** HIGH

**Location:** `packages/runner/src/cell.ts:531-534`

```typescript
get(): Readonly<T> {
  if (!this.synced) this.sync(); // ← NO AWAIT! Fire-and-forget
  return validateAndTransform(...);
}
```

**The Issue:** 12 Cell methods call `sync()` without await. The sync flag is set immediately, but the actual network fetch returns an unwaited Promise. This caused cross-space favorites to have empty tags.

**Fix:** PR #2299 (merged) adds:
1. Explicit `await charm.sync()` in `addFavorite()` before computing tag
2. Lazy fallback in `wish.ts` to compute tag if missing
3. Auto-sync in `asSchemaFromLinks()` (defensive)

**Action Required:** None - already merged.

---

### 4. Stale Closure in chatbot-outliner.tsx

**Status:** Low priority - not actively used
**Severity:** LOW (example pattern only, not imported anywhere)
**Confidence:** HIGH

**Location:** `packages/patterns/chatbot-outliner.tsx:55-58`

**Problematic Code:**
```typescript
function getMentionable() {
  const mentionable = wish<MentionableCharm[]>("#mentionable");
  return computed(() => mentionable);  // ❌ BREAKS REACTIVITY
}
```

**Why It Breaks:**
- `wish()` already returns a reactive `OpaqueRef<T>`
- Wrapping in `computed(() => mentionable)` captures the reference in a closure
- Per CELLS_AND_REACTIVITY.md: "Never nest computed() - returns OpaqueRef, not value"
- Updates to mentionable data won't propagate through the stale closure

**Fix:**
```typescript
// DELETE the getMentionable() function entirely

export const Page = pattern<PageInput>(({ outline }) => {
  const mentionable = wish<MentionableCharm[]>("#mentionable");  // ✅ Direct usage

  return {
    [NAME]: "Page",
    [UI]: (
      <ct-outliner
        $value={outline as any}
        $mentionable={mentionable}  // ✅ Reactive binding works correctly
        oncharm-link-click={handleCharmLinkClick({})}
      />
    ),
    outline,
  };
});
```

**Action Required:** None - example pattern only, not used in production. Document the anti-pattern for future reference.

---

### 5. Wish Resolution Returns Undefined Silently

**Status:** Fixed in PR #2325 (pending)
**Severity:** MEDIUM
**Confidence:** HIGH

**Location:** `packages/runner/src/builtins/wish.ts:507-509`

**Current (labs-2 main):**
```typescript
catch (_e) {
  sendResult(tx, undefined);  // Silent failure - no feedback
}
```

**Fixed (in PR #2325):**
```typescript
catch (e) {
  if (wishTarget.startsWith("#mentionable") || wishTarget.startsWith("#default")) {
    const errorMsg = `${wishTarget} failed: ${e.message}. ` +
      `This usually means the space's defaultPattern is not initialized. ` +
      `Visit the space in browser first, or ensure ensureDefaultPattern() is called.`;
    console.warn(errorMsg);
    sendResult(tx, { error: errorMsg, [UI]: errorUI(errorMsg) });
    return;
  }
  const errorMsg = e instanceof Error ? e.message : String(e);
  sendResult(tx, { error: errorMsg, [UI]: errorUI(errorMsg) });
}
```

**Action Required:** Will be fixed when PR #2325 merges.

---

## Why It's Flaky (Not Always Broken)

The flakiness comes from **timing-dependent race conditions**:

| Scenario | Result |
|----------|--------|
| Fast machine / warm cache | `linkDefaultPattern()` completes before patterns call wish → Works ✓ |
| Slow machine / cold cache | Pattern calls wish before link completes → Fails ✗ |
| Home space | Always fails (architectural gap - missing backlinksIndex) |
| CLI-created space | Always fails until PR #2325 lands |
| Subsequent updates | May work if reactive subscriptions happen to fire |

---

## Implementation Plan

### Phase 1: Wait for PR #2325 (CT-1133)

**Timeline:** Imminent (PR ready, checks passing)

- [ ] Monitor PR #2325 for merge
- [ ] After merge, pull changes to labs-2
- [ ] Verify CLI-created spaces now have working `wish("#mentionable")`

### Phase 2: Fix home.tsx (CT-1131)

**Timeline:** Can start immediately

**Files to modify:**
- `packages/patterns/home.tsx` - Add BacklinksIndex export

**Steps:**
1. Create branch from main (after PR #2325 merges)
2. Apply the home.tsx fix shown above
3. Test:
   - Deploy pattern in home space
   - Verify `wish("#mentionable")` returns data
   - Verify chatbot autocomplete works in home space
4. Create PR: "feat(home): Add BacklinksIndex export for wish('#mentionable') support"

### Phase 3: Verification & Documentation

**Timeline:** After all fixes merged

- [ ] Create integration test that:
  - Creates a space via CLI
  - Deploys a pattern using `wish("#mentionable")`
  - Verifies mentionable data is returned
  - Tests home space specifically

- [ ] Update documentation:
  - Document that defaultPattern MUST export `backlinksIndex` for `wish("#mentionable")`
  - Add warning about computed() closure anti-pattern
  - Document the wish error messages for debugging

---

## Files Summary

| File | Change | PR/Status |
|------|--------|-----------|
| `packages/charm/src/ops/charms-controller.ts` | Add `ensureDefaultPattern()` | PR #2325 (pending) |
| `packages/cli/lib/charm.ts` | Call `ensureDefaultPattern()` | PR #2325 (pending) |
| `packages/runner/src/builtins/wish.ts` | Better error handling | PR #2325 (pending) |
| `packages/charm/src/favorites.ts` | Await charm.sync() before tag | PR #2299 (merged) |
| `packages/patterns/home.tsx` | Add BacklinksIndex export | Needs PR |
| `packages/patterns/chatbot-outliner.tsx` | Remove computed() wrapper | Needs PR |

---

## Related Linear Issues

- **CT-1133**: CLI space creation doesn't wire defaultPattern (PR #2325)
- **CT-1131**: home.tsx missing BacklinksIndex export (needs PR)
- **CT-1126**: Race conditions in favorites system (PR #2299 merged)
- **CT-1121**: Pattern library runtime bugs (includes wish() silent failures)

---

## Testing Checklist

After all fixes are merged:

- [ ] CLI: `ct charm new` creates space with working `wish("#mentionable")`
- [ ] Shell: Regular space has working `wish("#mentionable")`
- [ ] Shell: Home space has working `wish("#mentionable")`
- [ ] Omnibot: Autocomplete shows mentionable items
- [ ] chatbot-outliner: Autocomplete updates reactively
- [ ] Error case: Clear error message when defaultPattern missing

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| PR #2325 introduces regressions | Low | Has mutex protection, tests passing |
| home.tsx change breaks existing spaces | Low | Only adds exports, backward compatible |
| chatbot-outliner fix affects other behavior | Low | Simple removal of unnecessary wrapper |
| Other patterns have same computed() anti-pattern | None found | Grep search found no other instances |

---

## Appendix: Oracle Investigation Sources

This plan synthesizes findings from:

1. **Oracle: wish flow** - Traced complete wish resolution chain
2. **Oracle: mentionable resolution** - Analyzed BacklinksIndex computation
3. **Oracle: reactivity** - Identified computed() closure anti-pattern
4. **Oracle: omnibot/input** - Analyzed MentionController timing
5. **Oracle: labs/labs-3 diff** - Compared pending fixes across repos
6. **Oracle: PR status** - Verified PR #2325 and #2299 status
7. **Oracle: home.tsx design** - Designed fix for CT-1131
8. **Oracle: chatbot-outliner** - Designed fix for stale closure
9. **Oracle: defaultPattern linking** - Deep analysis of race condition
10. **Oracle: Cell.get sync** - Analysis of CT-1126 mechanics
