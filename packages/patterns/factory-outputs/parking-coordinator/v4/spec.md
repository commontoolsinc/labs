# Pattern Spec: Parking Coordinator

## Description

Parking Coordinator is a shared workspace tool for small teams to manage a
limited set of numbered parking spots at an office. Team members can see today's
parking availability, request a spot for any upcoming date, and cancel their own
requests. Admins can manage the roster of people and spots, set priority order
and spot preferences per person, and assign default spots. When a request is
created, the system automatically allocates the best available spot based on
each person's preferences and their position in the priority queue. The tool is
designed to be practical and frictionless for a real team — it is not a demo.

## Complexity Assessment

- **Tier:** Advanced
- **Reference exemplars:** `contacts/` (multi-entity roster management, detail
  views, list editing), `calendar/` (date-based views, scheduling, derived
  sorted/filtered state)
- **Rationale:** The pattern has four distinct entities with relationships
  between them, two user roles (team member and admin) with different
  capabilities, a non-trivial auto-allocation algorithm with a priority chain, a
  status state machine on requests (pending → allocated / denied / cancelled),
  and date-based views including a week-ahead schedule. This combination of
  multi-role access, complex business logic, and date-driven derived state
  places it firmly in the Advanced tier.

## Data Model

### Entity: Parking Spot

Represents a physical parking space in the lot.

- **number** — The spot's official number (e.g., 1, 5, 12). This is the
  human-visible identifier. Required.
- **label** — A short friendly name for the spot, optional (e.g., "Near
  entrance"). Optional.
- **notes** — Any additional notes about the spot (e.g., "Compact cars only").
  Optional.

### Entity: Person

Represents a team member who may use the parking system.

- **name** — The person's full name. Required.
- **email** — The person's email address. Required.
- **commuteMode** — Their usual way of getting to the office: one of drive,
  transit, bike, wfh, or other. Required. Defaults to "drive".
- **spotPreferences** — An ordered list of parking spot numbers representing the
  person's ranked preferences. The first entry is most preferred. Optional,
  defaults to empty.
- **defaultSpot** — The spot number of the spot pre-assigned to this person as
  their default. Optional. When set, the auto-allocator tries this spot first
  before consulting spotPreferences.

### Entity: Spot Request

Represents a team member's request for a parking spot on a specific date.

- **person** — Reference to the person making the request. Required.
- **date** — The date the parking is needed (YYYY-MM-DD format). Required.
- **status** — The current state of the request: pending, allocated, denied, or
  cancelled. Defaults to pending on creation. Required.
- **assignedSpot** — The spot number that was allocated. Present only when
  status is "allocated". Optional.
- **requestedAt** — When the request was submitted. Required.

### Entity: Allocation

Represents a confirmed parking assignment for a specific spot on a specific
date.

- **spot** — Reference to the parking spot. Required.
- **date** — The date of the allocation (YYYY-MM-DD). Required.
- **person** — Reference to the person assigned to this spot. Required.
- **autoAllocated** — Whether the assignment was made automatically by the
  system (true) or manually overridden by an admin (false). Required.

### Relationships

- Each **Person** may have one optional **defaultSpot** (referenced by spot
  number) from the Parking Spots list.
- Each **Person** has an ordered list of **spotPreferences** drawn from the
  Parking Spots list.
- Each **Spot Request** belongs to exactly one **Person** and targets exactly
  one date.
- Each **Spot Request** with status "allocated" corresponds to exactly one
  **Allocation**.
- Each **Allocation** links one **Parking Spot** to one **Person** on one date.
  A spot may have at most one Allocation per date.
- The **People list** is ordered by priority. The person at the top of the list
  has the highest priority and is allocated first when multiple requests exist
  for the same date.

## User Interactions

### Team Member Actions

1. **View today's parking status** — On opening the app, the user sees all
   parking spots and their status for today: each spot shows whether it is free
   or taken, and if taken, who has it. This is the primary view.

2. **View the week-ahead schedule** — The user can switch to a weekly view
   showing the next 7 days (starting from today). Each day shows each spot's
   status — free, or the name of the person assigned. This gives team members a
   picture of upcoming availability.

3. **Request a parking spot** — The user selects a date (today or any future
   date) and submits a parking request. The system immediately runs
   auto-allocation: it tries the person's default spot first, then their spot
   preferences in order, then any available spot. If a spot is found, the
   request is marked "allocated" and the spot is reserved. If all spots are
   taken, the request is marked "denied" and the user sees a message indicating
   no spot was available on that date.

4. **Cancel a parking request** — The user can cancel any of their own requests
   that have status "allocated" or "pending." When cancelled, the associated
   allocation (if any) is removed, freeing the spot for others on that date.

5. **View my requests** — The user can see a list of their own requests, showing
   each date, status, and assigned spot. This lets them track upcoming
   reservations.

### Admin Actions

6. **Toggle admin mode** — The user can switch into admin mode using a control
   in the app header. Admin mode reveals additional management controls. No
   password is required — this is a trust-based tool for a small team.

7. **Add a person** — The admin enters a name, email, and commute mode to add a
   new person to the system. The person is added at the bottom of the priority
   list (lowest priority by default).

8. **Remove a person** — The admin removes a person from the system. Their
   future requests are cancelled and their allocations are freed.

9. **Reorder priority** — The admin can move people up or down in the priority
   list using up/down controls. The person at the top of the list gets first
   pick during auto-allocation.

10. **Set a person's default spot** — The admin selects a spot number to assign
    as a person's default. When auto-allocating, the system tries this spot
    first. The admin can also clear the default.

11. **Set a person's spot preferences** — The admin configures an ordered
    preference list for a person by adding/removing spots and reordering them.
    The first spot in the list is the most preferred fallback (after the default
    spot).

12. **Add a parking spot** — The admin enters a spot number and optional label
    and notes to add a new parking spot to the system.

13. **Remove a parking spot** — The admin removes a parking spot. All future
    allocations for that spot are cancelled. Past allocations are preserved for
    record-keeping.

14. **Edit a parking spot** — The admin can update a spot's label or notes after
    creation.

15. **Manually override an allocation** — The admin can manually assign any
    available spot to a specific person for a specific date, overriding the
    auto-allocation result. The allocation is marked as not auto-allocated.

16. **Re-run allocation for a denied request** — The admin (or the person
    themselves) can retry allocation for a previously denied request. This is
    useful when another person cancels, freeing a spot. If a spot is now
    available, the request is allocated; otherwise it remains denied.

## Acceptance Criteria

- When the app loads, today's date is shown with each parking spot listed and
  its current status (free or taken, with the occupant's name if taken).
- A team member can submit a request for today or a future date and immediately
  see whether they were allocated a spot or denied.
- When allocated, the specific spot number is shown to the user.
- When denied, the user sees a clear message that no spot was available on that
  date.
- Cancelling a request removes the allocation for that date, and the spot
  immediately appears as available again in today's view or the weekly view.
- The week-ahead view correctly shows all 7 days from today, each with per-spot
  status.
- Admin mode toggle is visible and changes the UI to reveal management controls.
- An admin can add a new person; the person appears in the list at the lowest
  priority position.
- An admin can remove a person; their future allocations are cleared.
- An admin can move a person up or down in the priority list.
- An admin can assign or clear a default spot for any person.
- An admin can add spot preferences for a person and reorder them.
- An admin can add a new parking spot; it immediately appears as available in
  views.
- An admin can remove a parking spot; future allocations for it are cancelled.
- Auto-allocation follows the correct priority chain: (1) person's default spot
  if available, (2) first available spot from preferences list, (3) any
  available spot. Higher-priority people are allocated before lower-priority
  people on the same date.
- Each spot can only have one allocation per day — double-booking is not
  possible.
- People with non-drive commute modes can still submit parking requests and are
  allocated spots normally.
- A request for a past date cannot be submitted.
- The list of each person's own requests shows correct statuses (allocated,
  denied, cancelled).

## Edge Cases

- **Empty state**: No people in the system — the app shows empty lists and the
  admin is prompted to add team members.
- **No parking spots**: If all spots are removed, requests show as denied
  immediately. The app still functions.
- **All spots taken on a requested date**: The request is denied immediately
  with a message. The spot count and all spot names are shown so the user
  understands the situation.
- **Requesting today when spots are already allocated**: The system checks
  allocations as of the time of request — a spot allocated earlier in the day is
  not available.
- **Removing a spot with future allocations**: The admin sees a warning
  indicating how many future allocations will be cancelled. Confirming removes
  the spot and cancels affected allocations.
- **Removing a person with future allocations**: Their spots are freed on all
  future dates so other people can request them.
- **Requesting the same date twice**: A person cannot have two active requests
  for the same date. If a request for that date already exists (with status
  allocated or pending), submitting another is blocked with a message.
- **Very long names**: Spot labels, person names, and notes may be long — the UI
  should not break or clip important information.
- **Person with no preferences or default spot**: The system allocates any
  available spot at random (or in spot-number order) as the final fallback.
- **Single spot remaining on a date with multiple requesters**: The first person
  in priority order receives the allocation; others are denied.
- **Week view spanning a month boundary**: The 7-day view correctly shows dates
  across months.
- **Spot preferences referencing a removed spot**: The system skips removed spot
  references gracefully during allocation without error.

## Assumptions

- **Admin mode is a UI toggle, not authentication.** The brief does not mention
  login or authentication. Given the "small team / practical tool" framing, a
  simple admin mode toggle in the header is assumed. Any user can enter admin
  mode. This is noted as a trust-based design choice.
- **Auto-allocation runs immediately on request creation.** The brief says
  "auto-allocation should run when a request is created," interpreted as
  synchronous resolution at the time of request submission. The "pending" status
  is therefore transient and expected to resolve immediately to "allocated" or
  "denied."
- **"Pending" status is transient.** Since auto-allocation is immediate, pending
  exists only as an initial state before resolution. It is kept in the data
  model as specified in the brief, but the UI will typically show allocated or
  denied rather than pending.
- **Priority is determined by list position.** The brief says "higher-priority
  people get allocated first" but does not specify how priority is stored. I
  interpret this as the order of the people list — position 0 is highest
  priority. Admins reorder by moving people up/down.
- **Only one request per person per date.** The brief does not state this
  explicitly, but it is implied by the allocation model. A person should not be
  able to hold two spots on the same day.
- **Allocations are date-specific and do not repeat.** There is no concept of
  recurring reservations — each date is treated independently.
- **Past dates cannot be requested.** The brief does not say this explicitly,
  but it would be operationally nonsensical to allocate spots for past dates.
  Requests must be for today or future dates.
- **Allocations for past dates are preserved as history.** They are not editable
  but are visible in the week view if the 7-day window overlaps with yesterday
  (today's date means the window starts at today, so this is unlikely, but the
  system retains past allocations).
- **Spot number uniqueness.** Each spot has a unique number. Adding a spot with
  the same number as an existing spot is blocked.
- **Person email uniqueness.** Each person's email must be unique in the system.
- **The initial spot list is #1, #5, and #12.** These are seeded as the default
  parking spots when no data exists, matching the brief's specification.
- **No initial people or requests** are seeded — the team starts with the three
  spots and an empty people list.
- **Commute mode options** are the five listed in the brief: drive, transit,
  bike, wfh, other. No custom options.
- **Manual admin override of allocation** is included based on the spirit of the
  brief's admin role, though not explicitly stated. An admin who needs to
  resolve edge cases should be able to override the auto-allocator.
- **Re-running allocation for denied requests** is included so that
  cancellations can benefit waiting/denied parties without requiring them to
  re-submit a request.
