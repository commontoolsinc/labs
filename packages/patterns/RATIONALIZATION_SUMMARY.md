# Pattern Library Rationalization Summary

## Overview

Reviewed 66 patterns in `packages/patterns/` to ensure examples serve as accurate guides for future pattern development. Updated patterns to current best practices and deprecated obsolete ones.

## Changes Made

### Deprecated (moved to `deprecated/`)
- `charm-ref-in-cell.tsx` - obsolete Cell reference pattern
- `charms-ref-in-cell.tsx` - obsolete Cell reference pattern
- `linkedlist-in-cell.tsx` - obsolete linked list pattern
- `voice-note-simple.tsx` - incomplete voice note example
- `calendar-v512.tsx` - superseded by calendar.tsx (7000+ lines → 220 lines)
- `array-in-cell-ast-nocomponents.tsx` - consolidated into editable version
- `array-in-cell-with-remove-ast-nocomponents.tsx` - consolidated into editable version
- `ct-checkbox-handler.tsx` - redundant with ct-checkbox-cell.tsx

### Updated to Modern APIs
- `aside.tsx` - recipe() → pattern()
- `array-in-cell-with-remove-editable.tsx` - recipe() → pattern()
- `suggestion.tsx` - derive() → ternary in JSX
- `suggestion-test.tsx` - derive() → ternary in JSX
- `multi-option-selection.tsx` - recipe() → pattern()
- `scrabble-game.tsx` - derive() → lift() with explicit types

### Verified Modern (no changes needed)
- `drag-drop-demo.tsx`, `card-piles.tsx` - drag-drop examples
- `cell-link.tsx` - ct-cell-link demo
- `wish.tsx`, `wish-note-example.tsx`, `arbitrary-wish-example.tsx` - wish API examples
- `ct-checkbox-cell.tsx` - bidirectional binding demo
- `write-and-run.tsx` - LLM code generation example

---

## Open Questions (Pending Review)

### Component Support Questions
These patterns demonstrate components that may or may not be actively supported:

1. **`ct-list.tsx`** - Is the `ct-list` component still supported?
2. **`ct-tags.tsx`** - Is the `ct-tags` component still supported?
3. **`ct-picker.tsx`** - Is the `ct-picker` component still supported?

### Pattern Value Questions
4. **`llm.tsx`** - Is a simpler LLM example valuable alongside the more complete chatbot patterns?
5. **`tool-call-examples.tsx`** - Related to llm.tsx - keep or deprecate?
6. **`list-operations.tsx`** - Is the `[ID]` symbol pattern still needed/recommended?

---

## Bugs Discovered (Pre-existing)

These issues were found during manual testing. They are pre-existing bugs, not caused by this rationalization effort.

### 1. `chatbot-note-composed.tsx` - Blank Screen
**Symptom:** Pattern deploys but shows blank screen with no UI.

**Suspected Cause:** Uses `wish()` calls that depend on other charms existing in the space (backlinks, mentionable items). When those dependencies don't exist, the pattern fails silently.

**Impact:** Pattern unusable as standalone example.

---

### 2. `compiler.tsx` - Navigation Button Not Working
**Symptom:** "Navigate To Charm" button appears after compilation succeeds, but clicking it does nothing.

**Suspected Cause:** The `visit` handler calls `navigateTo(result)` but the result cell may not be ready when the button is shown.

**Impact:** Core functionality broken.

---

### 3. `suggestion.tsx` / `suggestion-test.tsx` - $alias Not Resolving
**Symptom:** When Suggestion pattern returns a Counter or other pattern via `fetchAndRunPattern`, cell values show as raw `$alias` objects instead of resolved values.

**Example:** Shows `"Counter is the {"$alias":...} number"` instead of the actual count.

**Suspected Cause:** Issue with how patterns are dynamically instantiated through the LLM tool call flow in `fetchAndRunPattern`.

**Impact:** Suggestion pattern doesn't work correctly.

**Note:** Fixed a related null-check bug in `compile-and-run.ts:182` (`file?.name` instead of `file.name`).

---

## Technical Finding: `computed()` Type Limitation

When pattern inputs are typed as `Cell<T>`, using them inside `computed()` causes type vs runtime mismatch:

- **Without `.get()`:** TypeScript error (Cell<T> not assignable to T)
- **With `.get()`:** Runtime error (values already unwrapped, no `.get()` method)

**Root Cause:** `lift()` has `StripCell<T>` to transform types, but `computed()` cannot transform closure capture types.

**Workaround:** Use `lift<InputType, OutputType>()` with explicit types instead of `computed()` when working with Cell-typed pattern inputs.

**Full details:** See `session_outputs/2025-12-16_patterns-rationalization/04_computed-type-limitation.md`
