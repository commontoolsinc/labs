# Bug Report: Mentionables Dropdown Empty Until Page Refresh

**Status:** Still occurs after wish() and derive() fixes
**Severity:** High - Core feature requires page refresh to work
**Date:** November 13, 2025

---

## Simple Reproduction

1. Create fresh space, click **Go!**
2. Click **📄 Note** button to create a note
3. Type `[[` in the note editor
4. **Bug**: Dropdown is empty ❌
5. Refresh page (F5)
6. Type `[[` again
7. **Works**: Dropdown shows charms ✅

---

## Symptom

The `[[` mention dropdown shows no items when first creating a note in a fresh space. After refreshing the page, the dropdown correctly shows all mentionable charms.

---

## Context: Recent Fixes

Your recent commits **almost** fixed this issue:

1. **Commit `6c198d5b9`**: Changed `wish()` to always return a cell, even if value doesn't exist yet
   - This fixed the issue where `wish()` with defaults would return undefined
   - ✅ Now `wish("#mentionable")` returns a cell that can update reactively

2. **Commit `b20f7d173`**: Changed `BacklinksIndex` from `lift()` to `derive()`
   - This fixed the issue where mentionable was computed once and never updated
   - ✅ Now `derive(allCharms, ...)` reactively tracks when allCharms changes

However, the bug **still occurs** in a fresh space, suggesting a third issue.

---

## Root Cause Analysis

The issue appears to be with **pattern composition breaking reactivity when passing property-accessed Cells**.

In `default-app.tsx` (line 103-104):
```typescript
const { allCharms } = wish<{ allCharms: MentionableCharm[] }>("/");
const index = BacklinksIndex({ allCharms });
```

**What happens:**

1. Fresh space created → `wish("/")` returns space root where `allCharms = []` (empty initially)
2. `const { allCharms } = wish(...)` destructures the property
3. `BacklinksIndex({ allCharms })` receives the value as a parameter
4. Inside BacklinksIndex: `derive(allCharms, ...)` sets up reactive tracking
5. DefaultCharmList charm is added → space root's `allCharms` becomes `[DefaultCharmList]`
6. **Problem**: BacklinksIndex never sees the update ❌

**Why reactivity breaks:**

Even though:
- `wish()` returns a cell (✅ thanks to `6c198d5b9`)
- `derive()` tracks changes reactively (✅ thanks to `b20f7d173`)

The reactive connection is lost when **passing a property-accessed value through pattern composition**.

When `default-app` calls `BacklinksIndex({ allCharms })`, BacklinksIndex receives what appears to be a **snapshot of the value at that moment**, not a reactive reference that updates when the space root changes.

**After page refresh:**
- `allCharms` is already populated when patterns initialize
- BacklinksIndex receives the populated array
- Everything works ✅

---

## Attempted Fix (That Works)

Having BacklinksIndex call `wish("/")` directly instead of receiving `allCharms` as a parameter:

```typescript
const BacklinksIndex = recipe("BacklinksIndex", () => {
  const spaceRoot = wish<{ allCharms: MentionableCharm[] }>("/");
  const allCharms = spaceRoot.allCharms;

  const mentionable = derive(allCharms, (charmList) => {
    // ... compute mentionable
  });

  return { mentionable };
});
```

This **does fix the bug** ✅ but:
- Violates the original design intent (BacklinksIndex was extracted as a reusable component)
- Makes BacklinksIndex tightly coupled to space root structure
- Suggests a framework limitation with composition

---

## Design Note

BacklinksIndex was originally designed (commit `f984331f036`, Oct 2025) to receive `allCharms: Cell<MentionableCharm[]>` as input, making it reusable and composable. The current issue suggests that **pattern composition may not properly preserve reactivity when passing Cell references between patterns**.

---

## Questions

1. Is there a way to pass Cell references between patterns that maintains reactivity?
2. Should destructuring be avoided when working with wished values?
3. Is this a known limitation of pattern composition?

Thanks for looking into this!

---
Alex
