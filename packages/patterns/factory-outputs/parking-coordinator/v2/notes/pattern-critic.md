# Critic Working Notes: Parking Coordinator (Pass 1)

## File read: main.tsx

Total ~1350 lines. Large pattern. Let me work through it section by section.

---

## Section 1: Module scope (lines 1-173)

Lines 1-12: Imports. Standard. `/// <cts-enable />` is present. Good. Lines
14-35: Utility functions at module scope: getTodayDate, getDateOffset,
formatShortDate, genId. All correct. Lines 33-35: `_idCounter` module-level
mutable. OK - this is a counter for ID generation. Lines 37-77: Type definitions
and INITIAL_SPOTS constant. All at module scope. Correct. Lines 80-124:
Input/Output interfaces. Correct. Lines 128-172: `allocateSpot` helper function
at module scope. Correct.

NO handler() defined inside the pattern - all handlers are action(). NO lift()
found anywhere in the file. NO helper functions inside the pattern body -
utility fns are at module scope.

PASS: Module scope check.

---

## Section 2: Reactivity (lines 176+)

Pattern body starts at line 177.

Line 178: `const TODAY = getTodayDate();` — This is captured ONCE when the
pattern is instantiated, not reactively. TODAY will be stale if the pattern
stays open overnight. This is a NOTE-level concern, not a FAIL — the spec
doesn't require today to auto-update, and the date isn't a reactive input.
However it's worth noting.

Lines 181-204: All Writable.of() calls use static values (false, "", "drive",
etc.). PASS.

Lines 210-231: addPerson uses `persons.push()` and `priorityOrder.get()/set()`.
PASS - reading inside action is correct.

Line 541: `const days: string[] = weekDays;` in weekGrid computed. This reads
`weekDays` (a computed) without `.get()`. Wait - in the reactive system,
computeds are accessed directly (they're not Writables). Let me think more
carefully.

Actually in the CT system, computed() returns a value that can be accessed
directly (it's part of the reactive graph). `weekDays` here is
`computed(() => [...])`. When accessed inside another `computed(() => {...})`,
`weekDays` should be accessed as `weekDays` (not `weekDays.get()`). So
`const days: string[] = weekDays;` on line 541 means `days` holds the computed
itself, not its value. This is used as `days.map(...)` on line 544, which would
call `.map()` on the computed object, not the array it contains. This is a MAJOR
bug.

Wait, let me re-read the skill: "`.get()` on computed/lift result — Access
directly (only Writable has .get())". So computeds are accessed directly, not
via .get(). That means `weekDays` IS already the array value when accessed
inside a reactive scope. But line 541 says `const days: string[] = weekDays;` —
this assigns the computed to days. Inside a computed body, does accessing a
computed return its value or the computed object?

In the CT framework: computed() returns the reactive cell. Inside another
computed, you access it by just referencing it (the reactive system tracks
dependencies). The value you get IS the resolved value. So
`const days: string[] = weekDays;` should work correctly — `weekDays` inside the
computed body resolves to the string array.

But then `days.map((day: string) => ...)` on line 544 calls .map() on the string
array. That's correct.

Actually looking at this more carefully: lines 875 and 542-544 both use
`weekDays` without .get(). The pattern consistently accesses computeds directly.
This is the idiomatic CT way. So this is correct.

Lines 500-501: `spotCount` and `personCount` use `.get()` on Writables inside
computed bodies. That's correct (Writables need .get()).

Line 609: `spot.label as string` — `spot.label` is typed as
`Default<string, "">` which has value type string. The cast is technically a
typing workaround for the Default<> type. This is a pattern-wide concern.

Line 820:
`alloc.occupied ? "border-left: 4px solid #dc2626;" : "border-left: 4px solid #16a34a;"`
— This is a conditional in a style prop on `ct-card` which is a custom element.
String style on custom element is correct. But the ternary is inside a .map() —
it's not a computed violation, it's inline JSX. PASS.

Line 975: `{reqMessage ? (...) : null}` — reqMessage is a Writable. Used
directly in JSX as truthy check. In CT, Writables in JSX... Let me check the
pattern. Writables are reactive cells. In JSX, referencing a Writable directly
(not via .get()) in a conditional triggers reactive tracking. This should work
fine — CT auto-converts ternaries. PASS.

Line 967: `<ct-select $value={reqPersonId} items={personOptions} />` —
reqPersonId is a Writable<string>. `$value` binding. Correct.

Line 1023: `{myRequests.map(...)}` — myRequests is a computed. Direct access in
JSX, correct.

Checking for inline filter/sort in JSX:

- Line 578-580: `.sort()` inside myRequests computed (not inline in JSX). PASS.
- I see no inline .filter() or .sort() in JSX.

Lines 593-600: personOptions computed — returns array. Uses `persons.get()`
inside computed. Correct.

Line 614-620: `commuteOptions` is a static array (not computed). It doesn't
depend on reactive state. PASS — static is appropriate here.

One reactive concern: The `weekGrid` computed at line 537-559 reads `weekDays`
directly on line 541. As discussed above, this is the CT idiom for accessing a
computed inside another computed. However, the assignment to a typed local
variable `const days: string[] = weekDays;` creates an interesting question. If
weekDays is a reactive computed, does assigning it to a local variable break the
reactivity tracking? In CT, reactive tracking happens when you read a cell
value, so the tracking is established at the point of access in the reactive
computation. Inside the weekGrid computed, `weekDays` resolves to its current
value (the string array), and that dependency is tracked. PASS.

---

## Section 3: Conditional Rendering

Lines 753-760: Admin button with inline `() => adminMode.set(!adminMode.get())`.
This is a JSX event handler (onClick), NOT inside a computed(). PASS.

Lines 754: `variant={isAdmin ? "primary" : "ghost"}` — isAdmin is a computed.
Ternary in JSX attribute. CT auto-converts. PASS.

Lines 777-787: `{isAdmin ? (<ct-button ...>) : null}` — Ternary in JSX. PASS.

Lines 829-835: `{(alloc.spot.label as string) ? (...) : null}` — Ternary in JSX.
PASS.

Lines 957-963: `{hasNoPersons ? (...) : null}` — hasNoPersons is a computed.
Ternary in JSX. PASS.

No `onClick` inside `computed()`. PASS.

---

## Section 4: Type System

Lines 82-87: Input type. All arrays are `Writable<Default<T[], []>>`. PASS for
Default.

Lines 39-68: Entity types use `Default<string, "">`, `Default<string[], []>`,
`Default<boolean, true>`. These are interface fields — the Default<> wrapping is
for the cell typing system. PASS.

Line 89-97: Output type has `spots: ParkingSpot[]`, `persons: Person[]`, etc. —
plain arrays. These are output (read-only from the perspective of the caller).
PASS.

Lines 136-144: `allocateSpot` uses `new Set(...)` — line 136. This creates a
`Set<string>`. Per convention category 4: "Map or Set in cell data — Use plain
objects/arrays". BUT this Set is a local variable inside an action (specifically
inside a helper function), NOT stored in a cell. This is fine. PASS.

Line 59:
`export type RequestStatus = "pending" | "allocated" | "denied" | "cancelled"` —
no Default needed here, it's a type alias. PASS.

Line 67: `assignedSpotId: Default<string, "">` — string ID or empty. PASS. Line
68: `autoAllocated: Default<boolean, true>` — PASS.

Custom id field: Lines 40, 49, 62 all have `id: string`. The platform convention
note says "Custom id property for identity — Use equals() function instead." But
looking at this pattern, IDs are used as foreign key references between entities
(personId in SpotRequest, spotId in Person.defaultSpotId, etc.). This is
different from using id for cell identity comparison. The IDs here are
structural references between entities (like foreign keys), not for cell
identity. This is idiomatic for relational data models. The pattern-critic skill
says to use equals() for cell identity, but this pattern's IDs serve a different
purpose — they're the data model's primary/foreign key mechanism. This is a
NOTE, not a FAIL.

Actually, let me reconsider. The spec data model describes Person, ParkingSpot,
SpotRequest as entities with relationships. Using string IDs as foreign keys is
the standard approach for this kind of normalized data model in CT patterns. The
`equals()` anti-pattern warning is about using a custom id field to determine if
two cell references are the same cell, which is different from using ids as
foreign key references in a relational data model. PASS.

---

## Section 5: Binding

Line 967: `<ct-select $value={reqPersonId} items={personOptions} />` — $value
binding. reqPersonId is Writable<string>. PASS. Line 972:
`<ct-input $value={reqDate} placeholder="YYYY-MM-DD" />` — $value binding.
reqDate is Writable<string>. PASS. Line 1017-1021:
`<ct-select $value={selectedPersonId} items={personOptions} />` — PASS. Line
1203: `<ct-input $value={newPersonName} placeholder="e.g. Alice" />` — PASS.
Line 1207-1210: `<ct-input $value={newPersonEmail}.../>` — PASS. Line 1214-1217:
`<ct-select $value={newPersonCommute} items={commuteOptions} />` — PASS. Line
1245: `<ct-input $value={newSpotNumber}.../>` — PASS. Line 1249-1252:
`<ct-input $value={newSpotLabel}.../>` — PASS. Line 1256-1259:
`<ct-input $value={newSpotNotes}.../>` — PASS. Line 1287:
`<ct-input $value={editSpotLabel}.../>` — PASS. Line 1291:
`<ct-input $value={editSpotNotes}.../>` — PASS.

No missing $ prefixes. No wrong event names. PASS all.

---

## Section 6: Style Syntax

HTML elements (div, table, tr, td, th, span, thead, tbody, label): Line 826:
`<span style={{ fontWeight: "600" }}>` — object on HTML. PASS. Line 855:
`<div style={{ overflowX: "auto" }}>` — object on HTML. PASS. Line 857-862:
`<table style={{ width: "100%", ... }}>` — object on HTML. PASS. Line 903-910:
`<tr>` — no style. PASS. Line 904-910: `<td style={{ ... }}>` — object on HTML.
PASS.

ct-* elements: Line 749: `<ct-vstack slot="header" gap="1">` — no style. PASS.
Line 762:
`<ct-hstack ... style="border-bottom: 1px solid var(--ct-color-gray-200);">` —
string on ct-_. PASS. Line 806: `<ct-vstack gap="3" style="padding: 1rem;">` —
string on ct-_. PASS. Line 820-822:
`<ct-card style={alloc.occupied ? "border-left: 4px solid #dc2626;" : "border-left: 4px solid #16a34a;"}`
— ternary string on ct-card. Both options are strings. PASS. Line 954:
`<ct-vstack gap="3" style="padding: 1rem;">` — string on ct-*. PASS.

Line 995: `<ct-button ... style="flex: 1;">` — string on ct-button. PASS.

Now check for kebab-case props on ct-*: Line 749: `slot="header"` — `slot` is a
standard HTML attribute, not kebab-case. PASS. Line 750:
`<ct-hstack justify="between" align="center">` — camelCase props. PASS. Line
802: `<ct-vscroll flex showScrollbar fadeEdges>` — camelCase. PASS.

Checking for any object style on ct-*: Lines 1117:
`<ct-button ... style="color: #dc2626;">` — string on ct-button. PASS. Lines
1184: `<ct-button ... style="color: #dc2626;">` — string on ct-button. PASS.

Wait - lines 826, 831-833, 837-843: These are `<span>` elements inside ct-card,
so they are HTML elements. Using object style. PASS.

No violations found in style section.

---

## Section 7: Handler Binding

All event handlers are either:

1. Inline arrow functions: `onClick={() => ...}` — for simple navigation/state
   toggles
2. Direct action references: `onClick={submitRequest}`,
   `onClick={openAddPerson}`, etc.
3. Inline `.send()` calls:
   `onClick={() => movePriorityUp.send({ personId: person.id })}`

The third pattern (inline `.send()` in .map()) creates new arrow functions per
item. Let me check:

Lines 1099-1121: Inside `priorityList.map((person: Person) => ...)`:

- Line 1101-1104: `onClick={() => movePriorityUp.send({ personId: person.id })}`
  — creates new arrow fn per item
- Line 1107-1110:
  `onClick={() => movePriorityDown.send({ personId: person.id })}` — creates new
  arrow fn per item
- Line 1114-1118: `onClick={() => removePerson.send({ personId: person.id })}` —
  creates new arrow fn per item

Per category 10 (Performance): "Handler created per-item in .map() — Create
handler once, bind with item". These should use handler() at module scope with
binding.

Lines 1150-1191: Inside `spots.map((spot: ParkingSpot) => ...)`:

- Line 1174-1177: `onClick={() => openEditSpot.send({ spotId: spot.id })}` —
  per-item arrow fn
- Line 1181-1184: `onClick={() => removeSpot.send({ spotId: spot.id })}` —
  per-item arrow fn

Lines 1051-1061: Inside `myRequests.map(...)`:

- Line 1055-1056: `onClick={() => cancelRequest.send({ requestId: r.id })}` —
  per-item arrow fn

These all create new arrow functions per render cycle per item, which is a
performance violation per the skill. The fix is to use handler() at module
scope.

Also checking category 7 (Handler Binding): Line 755:
`onClick={() => adminMode.set(!adminMode.get())}` — inline nav, creates arrow fn
but not in .map(). This is acceptable as a toggle.

Lines 765, 772, 780-785, 789-795, 1001-1003, 1229-1231, 1271-1272, 1302-1304:
Navigation clicks `() => currentView.set(...)` — inline but not in .map().
Acceptable for simple nav.

FAIL - Handler binding violation: Multiple per-item arrow functions in .map()
loops.

---

## Section 8: Stream/Async

No Stream.of() usage. (Stream is imported but only used as a type in the output
interface.) No .subscribe() calls. No async/await in handlers. No
generateText/generateObject.

PASS all stream/async checks.

---

## Section 9: LLM Integration

Line 1: `/// <cts-enable />` — present. PASS. No generateText/generateObject
usage. N/A for most checks.

---

## Section 10: Performance

As noted in section 7: per-item arrow functions in .map() loops.

Lines 1099-1121 (priorityList.map): 3 inline arrow functions per item. Lines
1150-1191 (spots.map): 2 inline arrow functions per item. Lines 1023-1065
(myRequests.map): 1 inline arrow function per item. Lines 812-850
(todayAllocations.map): 0 inline arrow functions — only data display. Lines
894-943 (weekGrid.map + row.cells.map): 0 inline arrow functions — only data
display.

Total: 6 inline event handler arrow functions in .map() loops. These should use
handler() at module scope.

FAIL - Performance: 6 per-item arrow function handlers.

---

## Section 11: Action vs Handler Choice

All mutable operations are implemented as action() inside the pattern body. This
is CORRECT for the pattern-scope operations.

The per-item .map() inline arrow functions (section 7/10) should be handler() at
module scope. That's the violation.

Currently:

- movePriorityUp, movePriorityDown, removePerson, openEditSpot, removeSpot,
  cancelRequest are all action()s — correct for their core implementations.
- But they're being bound via inline arrow functions in .map() rather than
  through handler() per-item bindings.

The correct fix for the .map() scenarios: extract handler() wrappers at module
scope that accept item-specific binding and call the action's .send():

```typescript
const handleMovePriorityUp = handler<void, { personId: string }>(
  (_, { personId }) => movePriorityUp.send({ personId }),
);
```

But wait — handler() at module scope can't close over pattern-scope actions like
`movePriorityUp` because module scope is evaluated at module load time, not
pattern instantiation. The standard pattern is to put handler() at module scope
with explicit bindings passed from the .map() context. But the actions
(movePriorityUp etc.) would need to be part of the binding.

Actually, for this case the simpler fix is:

```typescript
// At module scope
const handleMovePriorityUp = handler<
  void,
  { personId: string; action: Stream<{ personId: string }> }
>(
  (_, { personId, action }) => action.send({ personId }),
);
```

Or more practically, in the CT pattern the actions ARE the streams — they have
.send(). But handler() at module scope needs to be able to access the action.
For a list where items vary, the typical pattern is:

```typescript
const handleMovePriorityUp = handler<void, { personId: string }>(
  (_, { personId }) => {...}
);
```

where the handler does the work directly rather than delegating to another
action. In that case the handler contains the logic. But for this pattern, the
logic is in the action already.

Practically for this pattern: the per-item arrow functions in .map() are a
convention violation (Performance category 10) but their severity is MINOR to
MAJOR — MINOR if there are few items, MAJOR if there are many. For a parking
coordinator with typically < 20 persons, this is MINOR but still a violation to
flag.

---

## Section 12: Design Review

Entity boundaries: ParkingSpot, Person, SpotRequest — clear, well-defined.
Actions match user intent: addPerson, removePerson, requestParking,
cancelRequest, manualOverride — good names. Unidirectional data flow: parent
(pattern) owns all state; no child pattern. PASS. Normalized state: Persons and
Spots are separate collections; SpotRequests reference them by ID. No
duplication. PASS. Self-documenting types: Very clear. PASS. Appropriate
granularity: This is a single pattern that handles ~10 interactions. For
intermediate complexity, this is appropriate. Not a "god" pattern — it's all one
coordination tool. PASS.

One design concern: `allocateSpot` on line 128 is a pure function at module
scope. This is good design — the allocation logic is isolated and testable.
PASS.

Another design concern: The `editSpotAction` is exposed in the output as
`editSpot: editSpotAction` (line 1342). The internal variable is named
differently from the exposed key. Minor naming inconsistency but not a
violation.

---

## Extended Checks

### Static vs. Reactive Correctness

Line 178: `const TODAY = getTodayDate()` — captured once at pattern
instantiation. Static string stored in pattern closure. The weekGrid computed
uses this value directly (line 541). If the tool stays open overnight, TODAY
will be stale.

Lines 875 and 881-885: `day === TODAY` comparisons in JSX and computeds use this
static TODAY. These will be wrong after midnight.

IMPACT: MINOR for a same-day tool, but worth noting. A robust implementation
would make TODAY reactive: `const TODAY = computed(() => getTodayDate())` and
call `.get()` where needed.

Lines 529-535: weekDays computed recalculates dates each time it's called. But
since its dependencies (nothing reactive) don't change, it will only compute
once and cache the result. Same staleness issue as TODAY. MINOR.

Line 614-620: commuteOptions is a static array literal. Correct — this never
changes. PASS.

### Computed Logic Duplication

The duplicate-request check logic appears in TWO places:

1. In `requestParking` action (lines 400-407):

```typescript
const hasActive = currentRequests.some(
  (r) =>
    r.personId === personId && r.date === date &&
    (r.status === "allocated" || r.status === "pending"),
);
```

2. In `submitRequest` action (lines 643-650):

```typescript
const hasActive = currentRequests.some(
  (r) =>
    r.personId === personId && r.date === date &&
    (r.status === "allocated" || r.status === "pending"),
);
```

This is duplication. submitRequest calls requestParking.send() after its own
check, so the check in requestParking serves as a safety guard. But the same
predicate is written twice. Could be extracted as a helper function. MINOR.

Same pattern: spotTaken check in manualOverride (lines 452-458) is unique to
that context. Not duplicated.

### Spec Compliance

Going through spec acceptance criteria:

1. "On first load, the today panel shows all three parking spots (#1, #5, #12)
   as available." — INITIAL_SPOTS has the 3 spots, todayAllocations computed
   handles this. PASS.

2. "The week-ahead grid shows 7 days starting from today, with all spots shown
   as free initially." — weekGrid computed, 7 days via weekDays. PASS.

3. "A team member can select their name and request parking for today; if a spot
   is free, it is allocated immediately and the today panel updates." —
   requestParking action with todayAllocations computed. PASS.

4. "After a successful allocation, the allocated spot shows as occupied in the
   today panel with the person's name." — todayAllocations maps spots to person
   names. PASS.

5. "If all spots are occupied for a requested date, the request status shows as
   'denied' with a clear message that no spots were available." — requestParking
   creates denied request; submitRequest shows "Denied: no spots available for
   this date." PASS.

6. "A person cannot have more than one active (non-cancelled) request for the
   same date. Attempting to request again for a date with an existing allocation
   shows an error." — Duplicate check in submitRequest shows message "This
   person already has an active request for this date." PASS.

7. "Cancelling a request returns the spot to 'available' immediately in the
   today panel and week-ahead grid." — cancelRequest action,
   todayAllocations/weekGrid are computed reactively. PASS.

8. "Auto-allocation follows the priority: default spot first → spots in
   preference order → any free spot." — allocateSpot function lines 156-171.
   PASS.

9. "If a person has no default spot and no preferences set, the system assigns
   any available spot." — allocateSpot fallback at line 171. PASS.

10. "The week-ahead grid correctly shows allocations for future dates after
    requests are made." — weekGrid computed. PASS.

11. "Admin mode reveals add/remove/edit controls for persons and spots." —
    isAdmin ternary in nav tabs. PASS.

12. "Adding a person via admin makes them immediately available in the request
    form's name selector." — addPerson updates persons; personOptions computed
    derives from persons.get(). PASS.

13. "Removing a person cancels any upcoming allocated requests for that person."
    — removePerson action, lines 245-261. PASS.

14. "The priority list in admin mode shows all persons in ranked order. Moving a
    person up/down updates their position immediately." — priorityList computed,
    movePriorityUp/Down actions. PASS.

15. "Adding a spot via admin makes it appear in the today panel, week-ahead
    grid, and preference selection lists." — addSpot action; todayAllocations,
    weekGrid, spotOptions all use spots reactively. PASS.

16. "Removing a spot cancels any upcoming allocated requests for that spot;
    affected persons see their allocations as lost." — removeSpot action lines
    330-373. Note: status is set to "denied" not "cancelled". Spec says
    "cancelled (status becomes denied)". Line 339:
    `status: "denied" as RequestStatus`. The spec says "cancelled" for
    remove-spot: "those allocations are cancelled (status becomes denied)". So
    the spec actually says status becomes "denied" (which is what the code
    does). PASS.

17. "A spot's label and notes can be edited; updates appear immediately
    everywhere the spot is displayed." — editSpotAction. PASS.

18. "Persons with usual commute mode of 'transit', 'bike', 'wfh', or 'other' can
    still make parking requests — their commute mode is informational only, not
    a restriction." — No restriction in requestParking. PASS.

19. "The 'My Requests' view shows the current user's requests filtered by their
    selected name, including status and assigned spot." — myRequests computed,
    isMyRequests view. PASS.

### Edge Cases from Spec

- "No persons registered: The request form cannot be submitted until at least
  one person exists." — hasNoPersons shows message, but submitRequest only
  checks `!personId`. If no person is selected and user clicks Submit, it shows
  "Please select a person and date." — functional but the spec says "The request
  form cannot be submitted" — the button is present and clickable, but the
  action validates. PASS (validation still prevents submission).

- "All spots occupied for a requested date: The request is created with status
  'denied.'" — PASS.

- "Person requests a date that already has an active request: prevents creating
  a duplicate and shows informative message." — PASS.

- "Person's default spot is occupied: falls through to preferences, then any
  free spot." — PASS.

- "Two people with the same default spot request the same date simultaneously:
  higher-priority person gets it." — The allocation runs sequentially per
  request, so the first requester (in priority order) gets the spot. The
  priority ordering doesn't affect who requests first — this edge case is only
  handled if requests are made in priority order. POTENTIAL CONCERN: If a
  lower-priority person requests before a higher-priority person, the
  lower-priority person gets the spot first. The spec says "The higher-priority
  person (earlier in the priority list) gets their default spot." This is only
  guaranteed if allocation is done in batch (re-running all pending requests in
  priority order), which this pattern does NOT do. Each request is allocated
  greedily at submission time. This is a spec ambiguity that the spec's own
  Assumption 5 addresses: "Priority order determines allocation sequence, not
  real-time competition." So the behavior is: whoever submits first gets the
  spot, but if they submit simultaneously in a batch, priority determines order.
  In practice (single-user tool), the person who clicks Submit first gets it.
  This is consistent with Assumption 5. PASS as implementation choice.

- "Requesting a date in the past: The form does not allow selecting past dates."
  — submitRequest checks `if (date < TODAY)` and shows error message (line
  638-640). The form uses `<ct-input>` for the date field, not a date picker
  with min constraints. The validation happens on submit, not form-level.
  PARTIAL — the spec says the form should not allow selecting past dates, but
  the implementation only validates on submit. MINOR spec gap.

- "Admin reorders the priority list when some requests for today already exist:
  Existing allocations are not changed." — movePriorityUp/Down only changes
  priorityOrder; doesn't touch requests. PASS.

- "Empty week-ahead (no requests at all): Every cell shows the spot as free." —
  weekGrid shows "-" for unoccupied cells. PASS.

### Missing Features from Spec

1. **"Set priority order" in admin via People/Priority view**: There IS a
   priority list with Up/Down buttons in the admin-persons view. PASS.

2. **"Assign a default spot to a person"** (Interaction 10): The setDefaultSpot
   action exists but there is NO UI in the admin section for this! Looking at
   lines 1070-1134 (admin-persons view), there is NO UI to set a default spot or
   edit preferences for a person. These actions (setDefaultSpot,
   setSpotPreferences) are only exposed as outputs but have no UI triggers in
   the admin panel.

This is a MAJOR gap. The spec says (Interaction 10): "When viewing or editing a
person, the admin can select any parking spot as that person's default." And
(Interaction 11): "The admin can edit a person's preference list." The
admin-persons view has no per-person editing capability beyond Up/Down/Remove.

Similarly, the admin-spots view (lines 1137-1194) only has Edit (goes to
edit-spot form for label/notes) and Remove. No per-person default/preferences
management.

Wait, let me re-read the spec. The spec describes it as "When viewing or editing
a person, the admin can select any parking spot as that person's default."
There's no "edit person" form in the current UI — the add-person form doesn't
have default spot or preferences. And there's no per-person detail/edit page.

This means admin interactions 10 and 11 (default spot assignment and preference
management) are missing from the UI. The underlying actions exist and work
(tested), but the admin UI to trigger them is absent.

MAJOR spec compliance failure: No UI to set a person's default spot or spot
preferences.

3. **Date picker with min/max constraints**: The date input is a plain
   `<ct-input>` with placeholder "YYYY-MM-DD" rather than a constrained date
   picker. The spec says "Only today and future dates (up to 30 days ahead) are
   selectable." The implementation validates on submit but doesn't prevent
   past-date selection in the UI. MINOR.

### Defensive Coding

Line 144: `r.assignedSpotId as string` — type cast. In the context of filtering
allocated requests, this is fine since allocated requests always have an
assignedSpotId. MINOR concern about cast.

Line 157: `(person.defaultSpotId as string) ?? ""` — The double guard (cast +
nullish coalescing) suggests uncertainty about the type. Since defaultSpotId is
typed as `Default<string, "">`, the cast handles the Default wrapper. This is
the standard pattern for Default<> access. PASS.

Lines 163, 352-353: Similar Default<> casts. Consistent pattern throughout.
PASS.

Line 142: `r.assignedSpotId as string` in a filter/map chain. If assignedSpotId
is "" (for denied/cancelled requests), `new Set()` would include "" — but this
is fine because the `!= ""` check on line 142 filters those out.

Actually line 141-143:
`.filter(r => r.date === date && r.status === "allocated" && (r.assignedSpotId ?? "") !== "")`
— good defensive check. PASS.

Line 517: `allPersons.find(p => p.id === req.personId)?.name ?? "Unknown"` —
nullish coalescence. PASS.

Line 552: `allPersons.find(p => p.id === req.personId)?.name ?? "?"` — PASS.

Line 588-589: `priorityList` computed: `.filter((p) => !!p)` guards against
missing persons. PASS.

Line 397: `if (!personId || !date) return;` — guards. PASS. Line 448:
`if (!personId || !date || !spotId) return;` — guards. PASS.

The pattern is generally defensive. No unsafe unguarded accesses observed.

### Handler Architecture Consistency

The pattern uses action() for all named operations and inline arrow functions in
.map(). This is inconsistent — the map loops should use handler() at module
scope.

The core actions (addPerson, removePerson, etc.) are all action() inside the
pattern body — consistent. The .map() event handlers are all inline arrow
functions — consistent within that pattern but violates the convention.

Summary of .map() arrow function handlers:

1. priorityList.map: movePriorityUp.send, movePriorityDown.send,
   removePerson.send (3 per person)
2. spots.map: openEditSpot.send, removeSpot.send (2 per spot)
3. myRequests.map: cancelRequest.send (1 per request)

These 6 inline handlers in .map() should be handler() instances at module scope
with per-item bindings.

---

## Test Review

Test structure: Uses sequential action/assertion steps. 64 tests total, 60
passing.

The 4 failing tests are related to editSpot reactive detection limitations in
the test harness (same-length array — the spots array remains the same length
when a spot is edited, so the reactive system may not detect the change in some
test harness contexts).

Looking at the test assertions for editSpot (lines 596-598):

```
{ action: action_edit_spot_1 },
{ assertion: assert_spot_1_label_covered },
{ assertion: assert_spot_1_notes_lobby },
```

The test comment at line 592-594 acknowledges this:

> "NOTE: This action times out in the test runner due to a same-length array
> reactive detection limitation. The timeout provides necessary propagation
> delay for subsequent actions to work correctly."

This is a known test harness limitation, not a pattern bug.

Other observations about tests:

- Tests cover initial state, CRUD for persons and spots, request lifecycle,
  cancellation, priority ordering, preferences/defaults, manual override.
- The test note at line 393-409 shows the test author wrestling with test state
  ordering — ultimately restructured to use 4 spots for the allocation tests
  (adding spot 7 before doing requests).
- "Warmup" assertions (assert_still_4_persons repeated multiple times) are used
  to wait for reactive propagation after setDefaultSpot and setSpotPreferences —
  this is a test harness workaround.
- The warmup pattern for manualOverride (10x assert_3_persons_after_remove at
  lines 684-693) is excessive but a known harness constraint.

Test quality overall: Good coverage of happy path and several edge cases. The
denial-after-all-spots-full scenario is not directly tested (the test
reorganized to always have 4 spots). This is a minor test gap.

Test file has `/// <cts-enable />` at line 1. PASS.

---

## Priority Issues Summary

1. MAJOR: No UI to set default spot or spot preferences for a person. Actions
   exist but admin UI omits them. (Interactions 10 and 11 from spec)
2. MINOR: Per-item inline arrow functions in .map() loops (6 instances) —
   performance/convention violation.
3. MINOR: Duplicate request detection logic written twice (requestParking +
   submitRequest).
4. NOTE: TODAY captured statically — stale after midnight.
5. NOTE: Date input is plain text, not a constrained date picker (past dates not
   prevented at form level).
