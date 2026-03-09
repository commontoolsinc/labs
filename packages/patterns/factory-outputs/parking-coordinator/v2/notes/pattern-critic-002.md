# Working Notes: Pattern Critic Pass 2

## Session Context

This is a re-review after a fix pass. The prior critic-001 identified:

- MAJOR: Missing UI for admin interactions 10 and 11 (setDefaultSpot,
  setSpotPreferences)
- MINOR: 6 inline arrow functions in .map() loops
- MINOR: Duplicate predicate code (hasActiveRequest)
- NOTES: Static TODAY, date input constraints

The fix pass made three changes:

1. Added full edit-person view (lines ~740-800 actions, ~1426-1524 JSX)
2. Extracted hasActiveRequest to module scope (lines 128-139)
3. Inline arrow functions NOT converted (deferred — exemplar precedent)

## Line-by-line analysis of the fix pass additions

### New state (lines 221-225)

- `editPersonId`, `editPersonDefaultSpot`, `editPersonPrefs`,
  `editPersonAddPrefSpotId` — all Writable.of() with static literals. PASS.

### New actions (lines 742-800)

- `openEditPerson` (742): action closes over persons, editPersonId,
  editPersonDefaultSpot, editPersonPrefs, editPersonAddPrefSpotId — all pattern
  scope. PASS.
- `saveEditPerson` (754): closes over editPersonId, editPersonDefaultSpot,
  editPersonPrefs, calls setDefaultSpot.send() and setSpotPreferences.send().
  PASS.
- `addPrefSpot` (768): closes over editPersonAddPrefSpotId, editPersonPrefs.
  PASS.
- `removePrefSpot` (777): action with event parameter {spotId}. Closes over
  editPersonPrefs. PASS.
- `movePrefUp` (782): action with event parameter {spotId}. Closes over
  editPersonPrefs. PASS.
- `movePrefDown` (792): action with event parameter {spotId}. Closes over
  editPersonPrefs. PASS.

### New view flags (line 810)

- `isEditPerson = computed(() => currentView.get() === "edit-person")` — PASS.

### New computeds (lines 815-847)

- `editPersonName` (815): reads editPersonId.get() and persons.get() — reactive
  deps. PASS.
- `availablePrefSpots` (823): reads editPersonPrefs.get() and spots.get() —
  reactive. PASS.
- `editPersonPrefDetails` (838): reads editPersonPrefs.get() and spots.get() —
  reactive. PASS.

### JSX edit-person view (lines 1426-1524)

The new view:

- Default spot selector:
  `<ct-select $value={editPersonDefaultSpot} items={spotOptions} />` — $value
  binding on Writable. PASS.
- Preference list: `editPersonPrefDetails.map(...)` with inline arrow functions
  for `movePrefUp.send`, `movePrefDown.send`, `removePrefSpot.send`.

#### NEW inline arrow functions in .map() — lines 1462-1483

Three new inline arrow functions in the preference list map():

- Line 1464: `onClick={() => movePrefUp.send({ spotId: pref.id })}`
- Line 1471: `onClick={() => movePrefDown.send({ spotId: pref.id })}`
- Line 1478: `onClick={() => removePrefSpot.send({ spotId: pref.id })}`

These are the same category of violation as the 6 in critic-001. They are in a
new .map() loop. This means the fix pass introduced 3 NEW violations of the same
type, bringing the total to 9 (the original 6 were not fixed, plus 3 new ones).

Wait — I need to check whether the deferred decision about inline arrows applies
here too. The fix pass note says "Inline arrow functions NOT converted (deferred
— exemplar precedent)". So these 3 new ones follow the same pattern and
presumably the same decision applies. However, they are still violations per the
convention.

### openEditPerson action usage (lines 1220-1226)

In the admin-persons list, there's a new "Edit" button:

```
onClick={() => openEditPerson.send({ personId: person.id })}
```

This is another inline arrow function in priorityList.map(). That's now one
additional inline arrow in the persons list, bringing the total in admin-persons
to 4 (was 3: movePriorityUp, movePriorityDown, removePerson — now adds
openEditPerson). Total is still consistently this same pattern.

Let me count total inline arrow functions now: Old violations from critic-001:

1. Line 1101 (now 1208): movePriorityUp in priorityList.map()
2. Line 1108 (now 1215): movePriorityDown in priorityList.map()
3. Line 1115 (now 1222): removePerson in priorityList.map()
4. Line 1175 (now 1289): openEditSpot in spots.map()
5. Line 1182 (now 1296): removeSpot in spots.map()
6. Line 1055 (now 1162): cancelRequest in myRequests.map()

New violation (edit button in persons list): 7. Line 1222-1223: openEditPerson
in priorityList.map() — NEW

New violations in editPersonPrefDetails.map(): 8. Line 1464: movePrefUp in pref
list 9. Line 1471: movePrefDown in pref list 10. Line 1478: removePrefSpot in
pref list

Total: 10 inline arrow functions in .map() loops (was 6, now 10). The fix pass
added 4 more.

### Spec compliance check for the MAJOR fix

Interaction 10: "Assign a default spot to a person"

- Edit button in admin persons list at line 1222-1223 (opens edit-person view)
- Default spot selector at line 1437-1440 using $value={editPersonDefaultSpot}
  with items={spotOptions}
- "None" option included in spotOptions (line 621)
- saveEditPerson calls setDefaultSpot.send() at line 757-760
- PASS: UI exists and connects to correct action.

Interaction 11: "Set spot preferences for a person"

- Preference list editor at lines 1447-1503
- Shows ordered list of preferences (editPersonPrefDetails.map())
- Up/Down/Remove per item
- Add spot dropdown (availablePrefSpots) + Add button (addPrefSpot action)
- saveEditPerson calls setSpotPreferences.send() at line 761-764
- PASS: Full preference editing UI exists.

### hasActiveRequest extraction check (lines 128-139)

```typescript
const hasActiveRequest = (
  allRequests: readonly SpotRequest[],
  personId: string,
  date: string,
): boolean =>
  allRequests.some(
    (r) =>
      r.personId === personId &&
      r.date === date &&
      (r.status === "allocated" || r.status === "pending"),
  );
```

Now check usages:

- Line 422: `if (hasActiveRequest(currentRequests, personId, date)) return;` —
  PASS
- Line 659: `if (hasActiveRequest(currentRequests, personId, date)) {` — PASS

The duplicate code is resolved. PASS.

### Check for newly introduced issues

1. `openEditPerson` is defined as an `action` at line 742, which means it closes
   over pattern-scope variables. However, it's called as
   `openEditPerson.send({ personId: person.id })` in a .map() loop — the action
   body reads persons.get() to find the specific person. It's an action but is
   called with per-item data. This is actually an unusual case: the action
   accepts an event parameter and looks up the person itself. This is valid —
   it's not a Module Scope violation or a handler-vs-action choice violation
   because the action correctly closes over pattern-scope variables. The
   per-item event data passes just the ID.

   However: the inline arrow function calling it is still a handler convention
   violation (same as all others deferred).

2. `removePrefSpot`, `movePrefUp`, `movePrefDown` are defined as `action()`
   (lines 777, 782, 792). They accept event parameters with `{spotId}`. They
   operate on `editPersonPrefs` (a pattern-scope Writable). This is correct use
   of `action()` — they close over `editPersonPrefs` and all instantiations use
   the same Writable. The per-item distinction (which spotId to operate on) is
   passed as the event argument. This is fine.

3. `saveEditPerson` (line 754): calls `setDefaultSpot.send()` and
   `setSpotPreferences.send()`. Both of these actions exist in the pattern
   output. Calling `.send()` on actions is the correct stream invocation
   pattern. PASS.

4. Line 862: `onClick={() => adminMode.set(!adminMode.get())}` — inline arrow on
   a single button (not in a .map()), this is standard and not a violation.

5. Navigation inline arrows (e.g., line 879:
   `onClick={() => currentView.set("main")}`) — these are not in .map() loops,
   these are single-instance nav buttons. These are acceptable; the convention
   violation is specifically for .map() loop handlers.

6. `weekDays` at line 556: `const days: string[] = weekDays;` — weekDays is a
   computed(), not an array. Is this a reactivity violation? Accessing a
   computed directly (without .get()) should be valid in the CT idiom —
   computeds are reactive objects that can be passed around. Actually wait — in
   CT, computed values are accessed directly (not with .get()), unlike Writables
   which need .get(). So `const days: string[] = weekDays;` at line 556 is
   inside a computed body that already has weekGrid depending on weekDays... Let
   me re-examine.

Actually looking more carefully:

- `weekDays` is defined as `computed(() => { ... })` returning a string array
- At line 556 inside `weekGrid`, `const days: string[] = weekDays;` assigns
  weekDays directly (no .get())
- This follows the CT convention: computeds are accessed directly, not with
  .get()
- The computed body will have a reactive dependency on weekDays because it
  accessed it
- This was already noted as PASS in critic-001

7. `editPersonPrefDetails` computed (lines 838-847): The return type has an
   explicit `.filter()` with a type guard. The filter predicate is
   `(s): s is {...} => !!s`. This is fine — the filter is inside a computed()
   body, not inline in JSX.

8. Check the `openEditPerson` action signature vs handler choice:
   - `openEditPerson = action((event: { personId: string }) => ...)`
   - Called in .map() as
     `onClick={() => openEditPerson.send({ personId: person.id })}`
   - The action's event parameter carries different data per item, but since the
     action is an `action()` (not `handler()`), it cannot be bound with
     `openEditPerson({ personId: person.id })` syntax — it must be invoked via
     `openEditPerson.send(...)`.
   - The question is whether this should be a `handler()` instead. By the
     convention: actions can accept event parameters and the caller can pass
     different data. The choice of action vs handler for this case is subtle.
   - For the convention check: actions that accept parameters and are called
     per-item in .map() with different data are not inherently violations — only
     the INLINE ARROW FUNCTION wrapping the .send() call is the violation.
   - PASS for action vs handler choice — the action choice is correct since it
     closes over persons, editPersonId, etc.

## Summary of findings

### Changes from the fix pass that are GOOD:

1. MAJOR issue (missing edit-person UI) is RESOLVED — full default spot +
   preferences editor added
2. hasActiveRequest extracted to module scope — MINOR dedup resolved

### New issues introduced by fix pass:

1. 4 additional inline arrow functions in .map() loops (1 in persons list for
   "Edit", 3 in pref list)
   - Total inline arrow count rises from 6 to 10
   - Same category as existing deferred violations
   - Consistently deferred, so treat as MINOR (consistent with prior)

### Issues from critic-001 that remain unchanged:

1. 6 inline arrow functions (deferred, now 10 total including new ones)
2. TODAY static — NOTE (unchanged)
3. weekDays has no reactive deps — NOTE (unchanged)
4. Date input has no min/max constraint — NOTE (unchanged)

### Spec compliance after fix:

- Interaction 10 (set default spot): NOW PASS
- Interaction 11 (set spot preferences): NOW PASS
- All other criteria remain as before

### Test coverage notes:

- Tests cover setDefaultSpot and setSpotPreferences via allocation preference
  tests
- The new edit-person UI is not directly tested (UI actions openEditPerson,
  saveEditPerson, addPrefSpot, movePrefUp, movePrefDown, removePrefSpot are not
  exercised by the tests — but these are navigation/UI helpers that delegate to
  the core actions, which are tested)
- This is acceptable — tests cover the business logic, not navigation

## Verdict on MAJOR fix

The MAJOR issue from critic-001 (missing UI for admin interactions 10 and 11) is
fully and correctly resolved. The edit-person view:

1. Has a default spot selector bound to editPersonDefaultSpot (Writable)
2. Has a full preference list editor with add/remove/reorder controls
3. Saves both via saveEditPerson which calls the correct actions
4. Is properly navigated to from the admin-persons view via "Edit" button per
   person

No new MAJOR or CRITICAL issues were introduced.
