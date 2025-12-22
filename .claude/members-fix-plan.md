# Plan: Fix MembersModule mentionable Data Flow

## Date: 2025-12-21
## Branch: feat/members-module
## Related Issues: CT-1130 (pattern instantiation RFC), CT-1131 (home.tsx backlinksIndex)

---

## Problem Summary

Members module search shows "No matching options" because `mentionable` data isn't flowing correctly to MembersModule. Four Oracle investigations found:

1. **FALSE ASSUMPTION in commit `cbe571b57`**: The commit message says "sub-charms run in their own space context" but this is INCORRECT. Sub-patterns share the SAME MemorySpace as their parent (`parentCell.space` is the MemorySpace DID).

2. **THE REAL BUG**: Handlers unwrap OpaqueRefs to plain values. When `addSubCharm` handler executes and creates `MembersModule({mentionable})`, it passes a **snapshot** of the array at handler binding time, NOT a reactive reference.

3. **Evidence**:
   - Line 395 record.tsx: `wish<Default<MentionableCharm[], []>>` returns `OpaqueRef`
   - Line 253 handler type: `mentionable: MentionableCharm[]` (unwrapped!)
   - Line 46 members.tsx input: `Default<MentionableCharm[], []>` (expects OpaqueRef)

4. **Pattern bodies run immediately during compilation**. When `MembersModule()` is called in handler, pattern body executes immediately with the snapshot value.

---

## Root Cause

MembersModule is instantiated inside a handler (`addSubCharm`). By then:
- The OpaqueRef has been unwrapped to a plain array
- A snapshot value (likely empty) is passed
- MembersModule's `lift()` receives a plain array, not an OpaqueRef
- No reactivity - mentionable is frozen at whatever value it had when handler was bound

---

## Solution Options

### Option A: Use initializeRecord Pattern (RECOMMENDED)

MembersModule should be created in `initializeRecord` (lines 143-209) like Notes, not in the handler. The initializeRecord lift() has access to the reactive context and can pass OpaqueRefs properly.

**Changes needed:**
1. Move MembersModule creation from `addSubCharm` handler to `initializeRecord`
2. Create a "members" entry in subCharms during initialization when type === "members" is added
3. The createModule() call in initializeRecord already has proper reactive context

**Pros:**
- Follows existing working pattern (Notes module works)
- Maintains reactivity properly
- Less architectural change

**Cons:**
- Members would be initialized at Record creation, not on-demand

### Option B: Have MembersModule Call wish() Directly

Revert to MembersModule calling `wish("#mentionable")` directly. Oracle 1 found sub-charms share the same space.

**Changes needed:**
1. Revert changes from commit `cbe571b57`
2. Add `wish` import back to members.tsx
3. Call `wish("#mentionable")` in MembersModule pattern body

**Pros:**
- Simplest fix
- Direct access to reactive data
- Self-contained - MembersModule gets its own data

**Cons:**
- Oracle 1 noted this still might not work if allCharms is empty
- Need to verify sub-charms truly share parent space context

### Option C: Pass Cell Wrapper Instead of Value

Wrap mentionable in a Cell in record.tsx and pass that Cell to MembersModule.

**Changes needed:**
1. In record.tsx: `const mentionableCell = Cell.of(mentionable)`
2. Pass `mentionableCell` to handler state
3. In MembersModule: accept Cell and use it directly

**Pros:**
- Maintains explicit data flow
- Handler can pass Cell without unwrapping

**Cons:**
- Extra indirection
- Need to verify Cell survives handler execution

---

## Recommended Approach: Option B First

1. **Test if sub-charms can use wish() directly** by reverting to have MembersModule call `wish("#mentionable")` in its own pattern body

2. **If that fails**, investigate WHY - is it:
   - Empty allCharms? (check space data)
   - Space context mismatch? (verify parentCell.space)
   - Timing/reactivity? (add logging)

3. **If Option B doesn't work**, fall back to Option A (initializeRecord pattern)

---

## Implementation Steps

### Step 1: Revert to Direct wish() in MembersModule

```typescript
// packages/patterns/members.tsx
import { wish } from "commontools";

// In MembersModule pattern body:
const mentionable = wish<Default<MentionableCharm[], []>>("#mentionable");
```

### Step 2: Remove mentionable from Record->Members prop passing

```typescript
// packages/patterns/record.tsx
// Remove mentionable from handler state (line 554)
// Remove mentionable from MembersModule call (line 292)
// Remove wish("#mentionable") from Record (line 395) - unless needed elsewhere
```

### Step 3: Test

1. Deploy to test-space (not home - CT-1131 still blocks home)
2. Create Record charms
3. Add Members module
4. Search should show other Records

### Step 4: If Step 3 Fails

Add debug logging to understand what's happening:
```typescript
// In MembersModule pattern body
const mentionable = wish<Default<MentionableCharm[], []>>("#mentionable");
console.log("[MembersModule] mentionable count:", mentionable?.length ?? 'undefined');
```

---

## Files to Modify

1. `packages/patterns/members.tsx`
   - Add back `wish` import
   - Add `const mentionable = wish<...>("#mentionable")` in pattern body
   - Remove `mentionable` from input type

2. `packages/patterns/record.tsx`
   - Remove `mentionable` from handler state binding (line 554)
   - Remove `mentionable` from MembersModule call (line 292)
   - Can keep or remove the wish call depending on if it's used elsewhere

---

## Testing Checklist

- [x] Deploy Record pattern to test-space
- [x] Create 2+ Record charms with names
- [x] Add Members module to one of them
- [x] Search shows other Records (with "Everything" filter - 16 items!)
- [x] "All Records" filter shows Records (fixed: isRecord() uses subCharms check)
- [x] Selecting an item works (fixed: ct-autocomplete `data` field passes charm reference)
- [ ] Verify bidirectional linking still works (needs testing)
- [ ] Test in home space (expect failure per CT-1131)

### Session 3: Replace Hacks with Idiomatic Solutions

**Replaced hacky workarounds with proper patterns:**

1. **ct-autocomplete `data` field** ✅
   - Added `data?: unknown` to `AutocompleteItem` interface
   - `_selectItem` now includes `data` in `ct-select` event: `...(item.data !== undefined && { data: item.data })`
   - This allows passing arbitrary objects (charm references) through selection

2. **Removed multi-strategy lookup hack** ✅
   - Old: Try entity ID, then NAME, then label matching
   - New: Charm passed directly via `event.detail.data`
   - Handler simply uses `const { data: charm } = event.detail`

3. **Uses `Cell.equals()` for comparisons** ✅
   - Replaced `(m.charm as any)?.["/"] === charmEntityId` with `Cell.equals(m.charm, charm)`
   - This is the idiomatic way to compare cells/charms

4. **Simplified wish type** ✅
   - Changed from `wish<Default<MentionableCharm[], []>>` to `wish<MentionableCharm[]>`
   - Cleaner and the type system handles it correctly

## Test Results (2025-12-21)

### Session 1: Initial Option B Implementation

1. **wish("#mentionable") works in sub-charms** - The core fix is successful!
   - MembersModule now directly calls `wish<Default<MentionableCharm[], []>>("#mentionable")`
   - Returns 14+ items including all Record charms in test-space

2. **Autocomplete dropdown populates** with filter set to "Everything"
   - Shows all charms from mentionable list
   - Each item displays with 🔗 icon, name, and "linked" group

### Session 2: Bug Fixes for isRecord() and charmRef Lookup

**Fixed Issues:**

1. **"All Records" filter now works** ✅
   - Root cause: `#record` property not in RecordOutput interface, never persisted to storage
   - Fix: Changed `isRecord()` to check `Array.isArray((charm as any)?.subCharms)`
   - Now shows 12 Records in dropdown with "All Records" filter

2. **Selecting an item now works** ✅
   - Root cause: ct-autocomplete doesn't pass custom properties (charmRef) in event.detail
   - Additional issue: value received was the label format ("📋 Alice Smith") not entity ID
   - Fix: Multi-strategy lookup in addMember handler:
     1. Try matching by entity ID (`"/"`)
     2. Fallback: match by NAME
     3. Fallback: match by label (check if value contains the name)
   - Members can now be added successfully!

3. **Type errors fixed** ✅
   - Updated `Cell.equals()` comparisons to use entity ID strings instead
   - Fixed bidirectional linking code to access charm properties directly (not via `.key()`)

---

## Notes

- This investigation revealed the original commit message was based on a false assumption
- The pattern framework does support sub-charms calling wish() in the same space
- The real issue was handler unwrapping, not space context
- CT-1131 (home.tsx backlinksIndex) is a separate issue that still needs fixing
- The value/label swap in autocomplete may be a framework serialization issue worth investigating
