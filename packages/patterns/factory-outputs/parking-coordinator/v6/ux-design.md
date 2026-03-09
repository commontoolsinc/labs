# UX Design: Parking Coordinator

## Primary User

A team member at a small office who drives in occasionally and needs to know
whether they have a parking spot arranged for today (or an upcoming day). They
check this tool quickly — often on their way to work — and want an immediate,
unambiguous answer. They do not want to spend time in the tool; they want to
confirm their status and move on.

## Design Principles

1. **Answer the question before they ask it.** The moment the app opens, today's
   parking status is visible. No clicks required to see whether spots are free
   or taken.

2. **The most common action takes one tap.** Requesting a spot for today should
   be a single action from the default view. No navigation, no forms, no
   confirmation dialogs before the action.

3. **Outcomes, not process.** After requesting, show the result (spot number or
   "no spots available") immediately. The system's internal mechanics —
   allocation logic, priority order — are invisible unless something goes wrong.

4. **Denied is not an error.** When all spots are taken, this is a real outcome,
   not a failure. The message should be calm and informative: "No spots are
   available for today." Not an error state, not alarming.

5. **Admin work stays out of the way.** Configuration tasks (managing people,
   managing spots) live in a separate tab that doesn't appear for non-admins.
   The primary experience is clean for regular team members.

---

## Information Architecture

```
App
├── Header
│     Identity selector: "Acting as: [Name]" (always visible, tappable to change)
│
├── Tab: Today (default)
│     My Status Banner: "You have Spot #5 today" / "You have no spot today"
│     Action: [Request a Spot] or [Cancel My Request]
│     Spot Grid: one card per spot showing — spot number, label, who has it (or Free)
│
├── Tab: Week
│     7-day list, one row per day
│     Each row: date label, day-of-week, my status indicator, spot summary
│     Tapping a day expands it to show full spot breakdown + request/cancel action
│
├── Tab: My Requests
│     Chronological list of all personal requests (upcoming first, then past)
│     Each entry: date, spot (if allocated), status badge
│     Cancel action on upcoming/active requests
│
└── Tab: Manage  [ADMIN ONLY — hidden for non-admins]
      Sub-section: People
        Priority-ordered list of people, drag to reorder
        Each person: name, priority rank, commute mode, default spot
        Add / Edit / Remove actions
      Sub-section: Spots
        List of parking spots
        Each spot: number, label, notes
        Add / Edit / Remove actions
```

---

## Core Flows

### Flow: Request a spot for today

**Trigger:** User needs parking today and does not have a spot allocated.

**Steps:**
1. User opens the app. They are on the Today tab.
2. They see the My Status Banner: "You have no spot today."
3. They see the Spot Grid showing which spots are free and which are taken.
4. They tap "Request a Spot."
5. The system runs auto-allocation immediately. The button enters a brief loading
   state (under 500ms in practice).
6. The My Status Banner updates to one of:
   - "You have Spot #5 today" (allocated — spot card also updates to show their name)
   - "No spots are available today." (denied — calm, non-alarming message)

**Completion signal:** The My Status Banner shows the result. The Spot Grid
reflects the new state.

**Happy path duration:** 1 interaction (tap "Request a Spot").

**Abandoned flow:** If the user closes the app without tapping, nothing changes.
No partial state is created.

---

### Flow: Request a spot for a future date

**Trigger:** User wants to arrange parking for a day later this week.

**Steps:**
1. User taps the Week tab.
2. They see 7 rows, one per day. Each row shows their status ("You" indicator or
   blank) and the spot occupancy at a glance.
3. They tap the row for the day they need (e.g., Thursday).
4. The row expands to show full spot detail and a "Request for Thursday" button.
5. They tap "Request for Thursday."
6. The system runs auto-allocation immediately. The row updates to show their
   name on the assigned spot, or shows "No spots available that day."

**Completion signal:** The expanded day row shows the new state. Their personal
indicator appears on that row.

**Happy path duration:** 3 interactions (tap Week, tap day row, tap Request).

**Abandoned flow:** If the user collapses the row or navigates away, nothing
changes.

---

### Flow: Cancel a request

**Trigger:** User no longer needs parking on a day they have allocated.

**Steps from Today view (if cancelling today's spot):**
1. User is on Today tab. My Status Banner shows "You have Spot #5 today."
2. They tap "Cancel My Request."
3. An inline confirmation appears beneath the button: "Cancel your spot for
   today? This frees Spot #5 for others. [Yes, cancel] [Keep it]"
4. User taps "Yes, cancel."
5. The My Status Banner updates to "You have no spot today." The spot card shows
   Spot #5 as free.

**Steps from My Requests view:**
1. User is on My Requests tab.
2. They find the upcoming request they want to cancel.
3. They tap "Cancel" on that request.
4. Same inline confirmation step as above.
5. The request's status badge updates to "Cancelled."

**Completion signal:** Status banner or request entry updates immediately.

**Happy path duration:** 3 interactions (tap button, confirm, done).

**Edge case:** If the request is already denied or cancelled, the cancel action
is not shown — the entry is read-only.

---

### Flow: View week overview

**Trigger:** User wants to see their parking situation across the next 7 days.

**Steps:**
1. User taps the Week tab.
2. They see 7 rows. Each row shows:
   - Day of week + date (e.g., "Mon Mar 3")
   - A "You" badge if they have an allocation that day
   - A compact spot summary: green dots for free spots, person initials for
     taken spots (e.g., "G W · J S · free")
3. No further action required — the overview is immediately readable.

**Completion signal:** The user has the information they need. Rows are
tappable to drill in and take action.

**Happy path duration:** 1 interaction (tap Week tab).

---

### Flow: Admin — Add a person

**Trigger:** A new team member joins and needs to be added to the system.

**Steps:**
1. Admin user is on the Manage tab, People sub-section.
2. They tap "Add Person."
3. A form panel appears (inline below the button, not a modal) with fields:
   - Name (required)
   - Email (required)
   - Commute mode (segmented control: Drive, Transit, Bike, WFH, Other)
   - Default spot (optional — dropdown of existing spots)
4. Admin fills in the fields and taps "Save."
5. The new person appears at the bottom of the priority list with the next
   available priority rank shown.
6. Admin can immediately drag to reorder if needed.

**Completion signal:** Person appears in the list.

**Happy path duration:** 5 interactions (open form, fill 3+ fields, save).

---

### Flow: Admin — Reorder priority

**Trigger:** Admin needs to change who has first priority for spot allocation.

**Steps:**
1. Admin is on Manage > People.
2. The list shows people in priority order (rank 1 at top).
3. Admin drags a person card up or down to the desired position.
4. As they release, ranks renumber visually (1, 2, 3…).
5. The new order is saved immediately (no explicit save button).

**Completion signal:** List reflects new order with updated rank numbers.

**Happy path duration:** 1 interaction (drag and drop).

---

### Flow: Admin — Manually assign a spot

**Trigger:** Admin wants to give a specific person a specific spot on a specific
date, bypassing auto-allocation.

**Steps:**
1. Admin is on the Week tab (enhanced view for admins).
2. They tap the day they want to assign.
3. The expanded day view shows each spot with a "Manually Assign" action next to
   free spots (and an "Override Allocation" for already-taken spots).
4. Admin taps "Manually Assign" on a spot.
5. A compact form appears: "Assign Spot #5 to: [person dropdown] on [date shown]"
6. Admin selects the person and taps "Assign."
7. The spot updates immediately with the person's name and an "M" badge indicating
   manual allocation.

**Completion signal:** Spot shows as assigned in the day view.

**Happy path duration:** 4 interactions (tap day, tap assign, select person, confirm).

**Note:** If the selected person already has an allocation that day, a brief
warning appears inline: "This will replace their current Spot #1 allocation.
Continue?"

---

### Flow: Admin — Remove a spot with active allocations

**Trigger:** Admin removes a parking spot from the roster.

**Steps:**
1. Admin is on Manage > Spots.
2. They tap "Remove" on a spot.
3. If the spot has upcoming allocations, a warning panel appears inline:
   "Spot #5 has allocations on 3 upcoming dates: Wed Mar 5 (John S.), Fri Mar 7
   (Grace W.), Mon Mar 10 (Grace W.). These will be cancelled. Remove anyway?"
4. Admin taps "Yes, Remove" or "Cancel."
5. If confirmed, the spot disappears from the list and the flagged allocations
   are cancelled.

**Completion signal:** Spot is gone from the list.

---

## State Design

### Today View

**Empty state (no spots configured):**
A centered message: "No parking spots have been configured yet."
If the current user is admin: an "Add your first spot" link that leads to
Manage > Spots.
If not admin: "Ask an admin to configure the system."
No request button appears — there is nothing to request.

**Empty state (no people configured, spots exist):**
Spot cards show as free. My Status Banner shows "Set up your profile to request
spots." This state only occurs during initial setup. Admin prompt to add people.

**Identity not set (first launch):**
Before any other view renders, a full-width "Who are you?" prompt appears.
Shows a list of all configured people with their name and commute mode.
User taps their name. This is remembered across sessions. If no people exist,
falls back to the no-people empty state.

**Loaded state (typical use — 3 spots, some allocated):**
- My Status Banner at top with action button
- Spot cards in a responsive grid (row or stacked)
- Each card: spot number large, label below, person's name if taken, "Free" if not
- "Manual" badge on admin-assigned allocations (visible to all, for transparency)

**All-full state (all spots taken, user has no allocation):**
All spot cards show occupants. My Status Banner shows "No spots available today."
No request button is displayed — requesting again would produce another denial.
A soft informational note appears: "All spots are taken. If a spot opens up,
you'll need to check back and request again."

**Error state:**
If the data fails to load, the spot cards show a skeleton/placeholder state with
a retry option. "Couldn't load today's status. Retry" — no alarming error language.

### Week View

**Empty state (no spots configured):**
Same as Today empty state, since there's nothing to show.

**Loaded state (7 days shown):**
Each day row is a compact strip:
- Today's row is visually distinct (slightly highlighted background, "Today" label)
- Rows for days with personal allocation: "You" badge in green
- Rows for days with denied status: "No spot" badge in muted color
- Rows for days with no request: blank personal indicator
- Compact spot occupancy shown as initials or "Free" text
- All 7 rows visible without scrolling on typical screen sizes

**Expanded day row:**
Full spot cards for that day, same style as Today view.
Request or cancel button for the current user's situation on that day.
Admin users see additional "Manually Assign" controls on each spot card.

**Heavy state (far future dates with no allocations):**
All spots show as free on future days. This is visually clean. No clutter.

### My Requests View

**Empty state:**
"You haven't made any requests yet. Request a spot from the Today or Week tabs."
Direct, actionable.

**Loaded state (5-10 requests):**
Chronological list, upcoming first:
- Upcoming/active requests: date, spot number (if allocated), status badge
  (Allocated, Pending, Denied), Cancel button for allocated/pending
- Past requests: date, outcome badge, no cancel option

**Heavy state (many past requests):**
Past requests are shown collapsed under a "Show past requests" expandable section.
Upcoming requests always shown fully. This prevents the view from being
overwhelmed by history while keeping it accessible.

### Manage View (Admin)

**People: empty state:**
"No team members added yet. Add your first team member to get started."
Prominent "Add Person" button.

**People: loaded state:**
Priority-ordered list with drag handles. Each row: rank number, name, commute
mode icon, default spot badge if set, action buttons (Edit, Remove).
"Add Person" button at bottom of list.

**People: heavy state (15+ people):**
List scrolls. Drag handles remain functional. This is a small-team tool;
15+ people would be an outlier, and drag reordering is sufficient at that scale.

**Spots: empty state:**
"No parking spots configured. Add spots before team members can request them."
Prominent "Add Spot" button.

**Spots: loaded state:**
Simple list: spot number, label (if any), notes (if any, truncated). Edit/Remove
per row. "Add Spot" at bottom.

---

## Interaction Patterns

### Creating things

**Adding a person or spot:** Tapping "Add Person" or "Add Spot" expands an
inline form panel directly in the list context — not a modal overlay. The form
appears where the new item will end up. Fields are minimal: only required fields
are required; optional fields are labeled clearly as optional.

**Making a request:** Single button tap. No form. No confirmation before
submission. The user already knows what they're requesting (today's spot, or
the date from the week view). The system handles spot selection.

### Editing things

**Editing a person or spot:** Tapping "Edit" opens an inline edit state for
that item, replacing the read view with an editable form. "Save" and "Cancel"
buttons appear. Other items in the list remain interactive.

**Priority reordering:** Drag and drop. The drag handle is always visible (not
hidden behind a swipe). Visual feedback as the item moves: other items shift to
show the drop target. Release saves immediately. No explicit "Save order" button.

### Deleting things

**Removing a person:** Tapping "Remove" shows an inline confirm: "Remove
[Name]? Future allocations will be cancelled." Two buttons: "Yes, Remove" and
"Cancel." No modal dialog. The confirmation appears inline below the person row.

**Removing a spot:** Same pattern, but with additional information if there are
upcoming allocations (list of affected dates). The warning is prominent but
not alarming.

**Cancelling a request:** Same inline confirm pattern. Tapping "Cancel My
Request" shows "Cancel your spot for [date]? [Yes, cancel] [Keep it]" inline
directly below the button.

### Request results (immediate feedback)

After submitting a request, the result appears immediately. The button enters
a brief loading state, then the view updates:
- My Status Banner changes
- The relevant spot card changes
- A brief informational toast appears at the bottom: "Spot #5 assigned for
  today." or "No spots were available for today."

The toast disappears after 3 seconds. It is not interactive — the result is
already visible in the main view.

### Admin manual override

Manual allocation in the week view uses a compact inline form: spot is already
known (user tapped a specific spot's assign button), date is already known (from
the expanded day), only person needs to be selected. One dropdown + one button.
Very low friction.

### Filtering and searching

There is no search in this pattern. With a small team, all people and all spots
fit in a single scrollable list without filtering. If the team grows to the point
where search is needed, the lists already support it, but that is out of scope.

### Identity switching ("Acting as")

Tapping the "Acting as: [Name]" control in the header opens an inline dropdown
with the full list of team members. Tapping a name switches context immediately.
This is persistent across sessions (stored in local state). This is not a security
feature — it is a convenience mechanism for a trusted team.

---

## Open Questions

1. **Denied state — re-request after a spot opens.** The current design hides
   the request button when a user has a denied request (all spots taken). If a
   spot is later cancelled and freed, the denied user must notice and re-request
   manually. The informational note ("All spots are taken. If a spot opens up,
   you'll need to check back and request again.") manages expectations. The
   pattern-maker may choose to instead always show the request button, with the
   understanding that a re-request on a full day would simply produce another
   denial — this is also valid.

2. **Week view spot display density.** With 3 spots, the compact initials display
   works well. With 10+ spots, this approach would need rethinking. The spec says
   the tool should work with variable spot counts. Current design assumes "small"
   means 2-8 spots. Very large numbers of spots would need a different week view
   layout. The pattern-maker should handle graceful degradation for higher spot
   counts.

3. **Preference editing UX.** Editing a person's spot preferences (ordered list
   of preferred spots) requires a reorderable multi-select. The edit person form
   could handle it as a draggable list of spot checkboxes. The pattern-maker
   should decide the specific implementation of this nested ordering UI.

4. **Past request collapsing in My Requests.** The design proposes collapsing
   past requests (any status) under an expandable to keep the view focused on
   upcoming/active requests. The pattern-maker may choose to instead show all
   requests in a single list with a "Past" section header, which is simpler.

5. **Today's date boundary.** If the user opens the app at 11:58 PM and allocates
   a spot, then does not close the app, at midnight the "today" date changes.
   The pattern-maker should decide whether the app auto-refreshes the date on a
   timer or shows a static snapshot until the user manually refreshes.
