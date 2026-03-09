# Pattern Maker Fix Pass

**Pattern**: Parking Coordinator
**File**: workspace/2026-02-24-parking-coordinator-k21l/pattern/main.tsx
**Critic review**: workspace/2026-02-24-parking-coordinator-k21l/reviews/critic-001.md
**Date**: 2026-02-24

## Changes Made

### MAJOR Fix: Add edit-person UI for default spot and preferences (Priority 1)

**Problem**: Spec interactions 10 and 11 (assign default spot, set spot preferences) had working actions (`setDefaultSpot`, `setSpotPreferences`) but no UI to trigger them. The allocation preference features were inaccessible to users.

**Solution**: Added an "edit-person" view accessible from the admin persons list via an "Edit" button on each person card.

**New UI state** (pattern body):
- `editPersonId: Writable<string>` -- ID of the person being edited
- `editPersonDefaultSpot: Writable<string>` -- form state for default spot select
- `editPersonPrefs: Writable<string[]>` -- form state for preference list (editable copy)
- `editPersonAddPrefSpotId: Writable<string>` -- select state for adding a new preference

**New actions** (pattern body):
- `openEditPerson({ personId })` -- loads current person data into form state, switches to edit-person view
- `saveEditPerson()` -- commits both default spot and preferences via existing `setDefaultSpot.send()` and `setSpotPreferences.send()`
- `addPrefSpot()` -- adds selected spot to preference list (local form state)
- `removePrefSpot({ spotId })` -- removes spot from preference list (local form state)
- `movePrefUp({ spotId })` -- moves spot up in preference list (local form state)
- `movePrefDown({ spotId })` -- moves spot down in preference list (local form state)

**New computed values**:
- `isEditPerson` -- view flag
- `editPersonName` -- displays the name of the person being edited
- `availablePrefSpots` -- spots not already in the preference list (for the "add" select)
- `editPersonPrefDetails` -- preference list with spot number/label details for display

**UI structure**:
- Default spot: `ct-select` bound to `editPersonDefaultSpot`, using `spotOptions` (includes "None" option)
- Preferences: list of cards with Up/Down/Remove buttons, plus an "add" row with select + Add button
- Save/Cancel buttons: Save commits both fields, Cancel returns to admin-persons without saving

**Design decisions**:
- Used local form state (`Writable`) rather than direct mutation, so the user can cancel without saving partial changes
- The preferences editor operates on a local copy; only on Save are both `setDefaultSpot` and `setSpotPreferences` called
- The "add preference" select filters out spots already in the list to prevent duplicates
- Preference ordering uses Up/Down buttons consistent with the priority list UI pattern

### MINOR Fix: Extract duplicate hasActiveRequest predicate (Priority 3)

**Problem**: Lines 400-407 and 643-650 contained identical logic for checking duplicate active requests.

**Solution**: Extracted to module-scope helper:
```typescript
const hasActiveRequest = (
  allRequests: readonly SpotRequest[],
  personId: string,
  date: string,
): boolean =>
  allRequests.some(
    (r) => r.personId === personId && r.date === date &&
      (r.status === "allocated" || r.status === "pending"),
  );
```
Used in both `requestParking` and `submitRequest` actions.

### MINOR Deferred: Inline arrow functions in .map() (Priority 2)

**Problem**: 6 inline arrow functions in `.map()` loops violate the handler binding convention.

**Decision**: Deferred. Converting these to module-scope `handler()` instances requires either:
1. Duplicating all action logic (since handlers cannot close over pattern-scope actions)
2. Restructuring all affected actions as module-scope handlers with full Writable bindings

Both approaches carry significant regression risk and add complexity. The exemplar patterns (habit-tracker) also use inline arrows in `.map()`. Documented as a known convention deviation.

### NOTEs Not Addressed (per instruction to focus on MAJOR)

- Static `TODAY` (Priority 4) -- not addressed, accepted as known limitation for short-session use
- Date input constraints (Priority 5) -- not addressed, server-side validation exists on submit

## Verification

- Compilation: `deno task ct check main.tsx --no-run` -- passes cleanly (no errors)
- Tests: `deno task ct test main.test.tsx` -- 61 passed, 3 failed
  - All 3 failures are pre-existing `editSpot` reactive detection timeout issues (same-length array mutation harness limitation)
  - No regressions introduced by fix pass changes
