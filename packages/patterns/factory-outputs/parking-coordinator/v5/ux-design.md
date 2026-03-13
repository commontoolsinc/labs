# UX Design: Parking Coordinator

## Primary User

The primary user is a team member who commutes by car and needs to know,
quickly, whether they have a parking spot for today or an upcoming day. They
open the tool in the morning — possibly while still at home deciding whether to
drive — and need an immediate answer. They care about speed and clarity above
all else: is a spot available, can I claim one, done.

A secondary user is the office admin or team lead who occasionally manages the
system: adding new hires, adjusting priority order, configuring spot
preferences. Admin tasks are deliberate and infrequent, not time-sensitive.

## Design Principles

1. **Answer the question before it's asked.** The default view shows today's
   spot status the moment the app loads — no tap required to see whether spots
   are free.

2. **Requesting a spot should feel like one action.** Once you've identified
   yourself, claiming a spot for a date is a single click. No form, no
   confirmation dialog, no steps. It's reversible, so optimism is the right
   call.

3. **Denial is informative, not a dead end.** When a request is denied because
   all spots are full, the user immediately sees which other days this week
   still have availability. There's always a next move.

4. **Admin mode is a mode, not a destination.** Toggling into admin adds
   capabilities to existing views rather than replacing them. The parking view
   remains visible; admin controls layer on top.

5. **The tool should feel calm and efficient.** This is a utility, not an app.
   No animations that delay, no playfulness that distracts. Status is
   immediately readable.

## Information Architecture

```
View 1: Parking — The default view. Shows today prominently, then the next 6 days.
  Section A: "You are:" selector — persistent identity selector at the top of the view.
             Always visible. User picks themselves from the team member list.
  Section B: Today panel — today's date, headline slot count ("2 of 3 spots taken"),
             each spot shown as free or taken (with occupant name). User's own status
             shown prominently (if they have a request, what's the status + spot;
             if not, a "Request spot" button).
  Section C: This week — the next 6 days in a compact row-per-day layout.
             Each row: day name, date, spot availability summary, user's status for
             that day (free to request, or their current allocation/denial).

View 2: My Requests — Personal request history. All past and upcoming requests for
        the currently selected person, in reverse-chronological order.
  Section A: Upcoming requests — active (allocated, pending) future requests with
             spot assignment and cancel option.
  Section B: Past requests — historical record (allocated, denied, cancelled).
             Read-only.

View 3: Admin Panel — Visible only when admin mode is toggled on.
        Replaces the navigation's third slot.
  Section A: People — priority-ordered list of all team members. Drag to reorder.
             Each person shows name, email, commute mode, default spot, and action
             controls (edit preferences, set default spot, remove).
             "Add person" form inline at the bottom.
  Section B: Spots — list of all parking spots. Each spot shows number, label,
             notes, and controls (edit, remove).
             "Add spot" form inline at the bottom.
```

Navigation: Three tabs across the top — "Parking", "My Requests", and (when
admin mode is on) "Admin". The admin mode toggle lives in the page header,
always accessible regardless of which tab is active.

When admin mode is ON, the Parking view gains additional controls: pending
requests show a spot assignment dropdown for manual override.

## Core Flows

### Flow: Request a spot for today

Trigger: User opens the app and sees today has free spots, wants to claim one.

Steps:

1. User sees the Parking view loaded with today's status. "You are: [Name]"
   shows their identity (if not yet set, they see a prompt to select
   themselves).
2. User sees the Today panel: "1 of 3 spots free" and a "Request spot" button
   adjacent to their status row (which currently shows "No request").
3. User clicks "Request spot".
4. System runs auto-allocation immediately. If a spot is found, the request is
   shown as "Allocated — Spot #5". If no spots remain, it shows "No spots
   available for today".
5. User sees their status update inline in the Today panel — no page transition.

Completion: The Today panel shows the user's allocated spot number (or denied
message). Happy path duration: 1 interaction (if identity already set), 2
interactions (if identity selection needed).

---

### Flow: Check availability and request a spot for a future date

Trigger: User knows they need to drive in later this week and wants to claim a
spot.

Steps:

1. User sees the Parking view. The "This week" section shows 6 upcoming days.
2. User scans the rows and finds a day with available spots. The row shows
   availability (e.g., "2 of 3 free") and their own status ("No request").
3. User clicks the "Request" affordance on that day's row.
4. System allocates immediately. The row updates to show "Allocated — Spot #1".

Completion: The day row shows the user's allocated spot. Happy path duration: 2
interactions (spot the day, click request).

---

### Flow: Cancel a request

Trigger: Plans change — user won't be driving in and wants to free their spot.

Steps:

1. User sees their allocated request either in the Today panel (for today) or in
   the week-ahead row (for a future day), or in My Requests.
2. User clicks "Cancel" next to their request.
3. System immediately updates: the request shows as "Cancelled", the spot count
   updates to show one more free spot.

Completion: The request shows "Cancelled" status. The spot counter increments.
Happy path duration: 1 interaction. Abandonment: If user clicks Cancel but then
hesitates, there is no confirmation dialog — the action is immediate. This is
acceptable because the user can simply make a new request to re-claim a spot (if
one is still free).

---

### Flow: Check personal request history

Trigger: User wants to review past parking days or see all upcoming requests.

Steps:

1. User taps "My Requests" tab.
2. User sees their full request list split into upcoming (future/active) and
   past.
3. From upcoming, they can cancel directly. Past is read-only.

Completion: User has the information they wanted. Happy path duration: 1
interaction (tap tab).

---

### Flow: Admin — Add a new team member

Trigger: Someone new joined the team and needs to be added to the parking
system.

Steps:

1. Admin toggles admin mode on.
2. Admin taps "Admin" tab, lands in the People section.
3. Admin sees the people list and an inline "Add person" form at the bottom.
4. Admin fills in name, email, commute mode and clicks "Add".
5. Person appears at the bottom of the priority list.

Completion: New person visible in list. Admin can immediately set their default
spot or preferences. Happy path duration: 4 interactions (toggle admin, tap tab,
fill form, submit).

---

### Flow: Admin — Set a person's default spot and preferences

Trigger: Admin wants to configure who gets which spot first.

Steps:

1. Admin is in the People section of the Admin tab.
2. Admin clicks "Edit" on a person's row. The row expands inline (no modal) to
   show: default spot selector (dropdown of spots), and spot preferences editor
   (ordered list of spots with add/remove/reorder controls).
3. Admin selects a default spot from the dropdown.
4. Admin uses the preferences editor to add spots in preferred order.
5. Admin clicks "Save" on the inline editor.

Completion: The person's row updates to show their default spot. Changes take
effect for future allocation. Happy path duration: 3-5 interactions depending on
how many preferences are set.

---

### Flow: Admin — Reorder people priority

Trigger: Admin wants to change who gets priority access to spots.

Steps:

1. Admin is in the People section of the Admin tab.
2. Admin sees the ordered list with drag handles on each row.
3. Admin drags a person's row to a new position.
4. List updates immediately. New priority order takes effect for future
   allocations.

Completion: List reflects new order. No save button needed — reorder is
immediate. Happy path duration: 1 interaction (drag).

---

### Flow: Admin — Manual override of a request

Trigger: Auto-allocation got it wrong, or a special case requires direct
assignment.

Steps:

1. Admin has admin mode on and is viewing the Parking view.
2. Admin sees a pending request row (either today or the week-ahead) which shows
   an additional "Assign spot" dropdown in admin mode.
3. Admin selects a specific spot from the dropdown.
4. Request updates to "Allocated — Spot #X (manual override)".

Completion: Request shows allocated with the chosen spot. `autoAllocated` flag
is false. Happy path duration: 1 interaction (select spot from dropdown).

---

### Flow: Admin — Remove a parking spot

Trigger: A physical spot is no longer available.

Steps:

1. Admin is in the Spots section of the Admin tab.
2. Admin clicks "Remove" on a spot.
3. System shows an inline warning: "N active allocations for this spot will be
   reverted to pending. Continue?"
4. Admin confirms.
5. Spot is removed. Affected requests show status "Pending" with no assigned
   spot.

Completion: Spot removed from list. Affected requests are visible in the Parking
view as pending. Happy path duration: 2 interactions (remove, confirm). Note:
This is the one deletion that requires a confirmation, because its cascade
effect is significant.

---

## State Design

### View 1: Parking

**Empty state (no people, no requests)** Today panel shows 3 spots
(pre-populated) all marked "Free". The "You are:" selector shows "Select
yourself..." with no options available and a note: "No team members have been
added yet. An admin needs to add people before requests can be made." The
"Request spot" button is absent — there's no one to request for. Admin mode
toggle is still accessible so an admin can immediately add people.

**Empty state (person selected, no requests exist yet)** The "You are:" selector
shows the selected person. Today panel shows all spots free with a prominent
"Request spot" button. Week-ahead shows all 7 days as fully available. This is
the ideal "first use by a real user" state — clear and inviting.

**Loaded state (typical: 3-8 people, mix of requests)** Today panel: some spots
marked taken with occupant names, some free. User's own row clearly
distinguished (highlighted or labeled "You"). Week-ahead: compact day rows
showing availability counts, user's own requests visible on each row. The view
answers "do I have a spot?" instantly without any interaction.

**Heavy state (many requests, all spots taken)** Today panel: all 3 spots show
as taken with names. User sees "No spots available" in their status row, or
their denied request if they already tried. Week-ahead: days where spots are
available stand out visually (they have lower density). The tool still works
correctly — it's just giving the bad news clearly.

**Error states**

- Person selected but they've already requested this date: "Request spot" button
  is disabled/hidden; user sees their existing request status instead. No
  duplicate is possible.
- No spots configured: a message replaces the parking view: "No parking spots
  configured. An admin needs to add spots in Admin mode." Request functionality
  disabled.

---

### View 2: My Requests

**Empty state** "No requests yet. Go to Parking to request a spot for today or
an upcoming day." Includes a direct link/button to the Parking tab. Not blank.

**Loaded state** Two sections: "Upcoming" (future + today's active requests) and
"Past". Each request shows: date, status badge
(allocated/pending/denied/cancelled), spot number if allocated. Upcoming
requests have a "Cancel" button. Past requests are read-only rows.

**Heavy state** Past section could grow long. Show the most recent 30 past
requests with a "Load more" affordance if there are older ones. Upcoming section
stays fully shown (there can't be more than 7 upcoming requests in practice,
given the week-ahead scope).

**Error states** If the "You are:" selector is not set, My Requests shows:
"Select who you are at the top of the Parking view to see your requests."

---

### View 3: Admin Panel

**Empty state — People section** "No team members yet. Add the first person
below." The inline add-person form is immediately visible and pre-focused. Clear
call to action.

**Empty state — Spots section** Three default spots (#1, #5, #12) are shown
pre-populated per assumption 1. A note explains: "These are the default spots.
You can add more or remove them."

**Loaded state — People section** Ordered list of people. Each row: drag handle,
name, email, commute mode pill, default spot indicator, action buttons (Edit,
Remove). At the bottom: collapsed "Add person" form with a "+" button to expand
it.

**Loaded state — Spots section** List of spots. Each row: spot number, label (if
set), notes (if set, truncated), action buttons (Edit, Remove). At the bottom:
"Add spot" form.

**Error states**

- Attempting to remove the last spot: warning "This is the only spot. Removing
  it will leave no spots available." Proceed button still available — admin may
  want to start fresh.
- Attempting to remove a person with active allocations: inline warning showing
  how many requests will be cancelled, with confirm/cancel options.

---

## Interaction Patterns

### Identity selection (You are:)

Implemented as a persistent dropdown selector at the top of the Parking view,
always visible. Selection is stored in application state and persists for the
session. Selecting a different person instantly updates all views (today panel,
week-ahead rows, My Requests). If no person is selected, a soft prompt appears:
"Select yourself to make requests." The selector shows all people in the system,
sorted alphabetically. Admin does not need to be selected — admin mode is a
separate toggle.

### Requesting a spot

A single "Request spot" button, no form. The button is contextual to the day row
or today panel. Clicking it submits immediately. The button transitions to a
loading indicator for the moment auto-allocation runs, then resolves to the
result state inline. No confirmation required. The action is reversible
(cancel). If the user already has a request for that day, the button is replaced
by their request status.

### Cancelling a request

"Cancel" button adjacent to an active request (allocated or pending status).
Clicking it is immediate with no confirmation dialog. The row updates instantly
to show "Cancelled" and the spot count adjusts. The cancel button is removed.
Rationale: cancellation is low-stakes and easily undone by making a new request.

### Creating people and spots (admin)

Inline form at the bottom of the respective list section. The form is initially
collapsed (to avoid visual clutter) and expands on clicking an "Add person" /
"Add spot" button. Submit adds the item to the list immediately. The form resets
and collapses after submission. Validation is inline: empty required fields are
flagged before submission.

### Editing people's default spot and preferences (admin)

Clicking "Edit" on a person row expands the row to reveal an inline editing
panel. (No modal — keeps context visible.) The editing panel contains:

- Default spot: dropdown selector showing all spots.
- Spot preferences: an ordered list. Each item has a remove button and drag
  handle (or up/down arrow buttons as fallback). An "Add preference" selector
  appends a spot to the list. Clicking "Save" commits changes and collapses the
  editor. Clicking "Cancel" discards.

### Editing spot details (admin)

Clicking "Edit" on a spot row expands the row inline to show label and notes
text fields. Spot number is shown but not editable (greyed out with a note
"cannot be changed"). "Save" commits, "Cancel" discards.

### Deleting things (admin)

- **Remove person**: Immediate with no confirmation, unless they have active
  requests — in that case, an inline confirmation shows the impact ("N active
  requests will be cancelled").
- **Remove spot**: Always requires confirmation due to cascade effect on
  allocations.
- **Remove spot preference**: Immediate, no confirmation (low stakes, easily
  re-added).

### Reordering people priority (admin)

Drag-and-drop handles on each person row in the People section. The new order
takes effect immediately on drop — no save button required. For accessibility
and non-drag environments, each row also has up/down arrow buttons that move the
person one position at a time.

### Reordering spot preferences for a person (admin)

Same pattern as people reordering: drag handles plus up/down arrows.

### Manual override of allocation (admin)

When admin mode is on, pending requests in the Parking view display an
additional "Assign spot" dropdown showing all spots. Selecting a spot from the
dropdown immediately allocates it to that request. This is the only point of
manual override — it's contextual to the request, not a separate workflow.

### Admin mode toggle

A toggle switch in the page header, persistently visible. Labeled "Admin mode".
Toggling on reveals the Admin tab in navigation and adds override controls to
the Parking view. Toggling off hides the Admin tab and removes override
controls. No confirmation when toggling either direction.

### Filtering and searching

No filter or search is implemented in the primary flows — the team is small
enough that the full list is always manageable. If the People list grows beyond
~15 people (unlikely for the intended use case), the pattern may need a filter,
but this is left as an open question.

---

## Open Questions

1. **Session persistence of "You are:" selection**: Should the identity
   selection persist across browser sessions (e.g., in localStorage)? The spec
   doesn't say. The pattern-maker should default to session-only persistence
   (in-memory Cell state), which is safer for a shared computer scenario but
   requires re-selection on each visit.

2. **Week-ahead scroll vs. fixed window**: The spec says the week-ahead always
   shows today through today+6 with no scrolling to future weeks. This is a
   deliberate constraint. The pattern-maker should implement this as specified —
   no "next week" navigation.

3. **Multiple people requesting from same device**: Since there's no auth,
   multiple team members might use the tool from different tabs or sessions. The
   "You are:" selector makes this manageable, but there's no multi-user
   real-time sync. The pattern-maker should note that this is
   single-session/single-user by design.

4. **Denied request retry flow**: When a request is denied, should the
   week-ahead highlight days that still have availability to make "try another
   day" obvious? A visual cue (e.g., green dot on days with free spots) would
   help, but adds complexity. The pattern-maker can decide whether to implement
   this affordance.

5. **Commute mode display**: Where exactly should `commuteMode` be shown? In the
   people list for admin, yes. In the request flow or parking view, probably not
   — it's informational context that would clutter the operational view. The
   pattern-maker should show it only in the Admin People list.
