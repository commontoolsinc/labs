# Pattern Spec: Parking Coordinator

## Description

A coordination tool for a small team to manage access to shared office parking
spots. Team members can request a spot for today or a future date and see what
is available and who has what. Admins can manage the list of people and parking
spots, set priority ordering among people, and configure each person's default
spot and preferences. When a request is made, the system automatically assigns
the best available spot based on the person's default preference, then their
ordered preference list, then any free spot, and marks the request as denied if
no spots remain. The week-ahead view gives everyone a quick read on parking for
the next seven days.

## Complexity Assessment

- **Tier**: Intermediate
- **Reference exemplars**: `todo-list/` (list CRUD with status and filtering),
  `budget-tracker/` (multiple related entities, computed views, admin-level
  management)
- **Rationale**: The pattern involves three entity types (ParkingSpot, Person,
  SpotRequest) with relationships between them, auto-allocation business logic
  that runs on request creation, multiple computed views (today's status,
  week-ahead calendar, per-person history), and two distinct operational modes
  (team member and admin). It does not involve LLM integration, multi-step
  wizards, or complex concurrent state machines, placing it firmly in the
  Intermediate tier.

## Data Model

### Entities

**Parking Spot**

Represents one physical parking space in the office lot.

| Field    | Description                                                                                                             | Optional | Default |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| `number` | The spot's identifying number as displayed on the lot (e.g., 1, 5, 12). Used to refer to the spot everywhere in the UI. | No       | —       |
| `label`  | A short human-readable name for the spot (e.g., "Near entrance", "Covered"). Supplementary display name.                | Yes      | —       |
| `notes`  | Freeform notes about the spot visible to admins (e.g., "Compact cars only").                                            | Yes      | —       |

**Person**

Represents one team member who may use the parking coordinator.

| Field             | Description                                                                                                                                                                               | Optional | Default    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| `name`            | The person's full name, used throughout the UI.                                                                                                                                           | No       | —          |
| `email`           | The person's email address, shown in the person list for identification.                                                                                                                  | No       | —          |
| `commuteMode`     | How this person usually gets to work. One of: drive, transit, bike, wfh, other. Contextual information only — any person can still make a parking request regardless of their usual mode. | No       | drive      |
| `spotPreferences` | An ordered list of parking spots this person prefers, from most to least preferred. Used by auto-allocation when their default spot is unavailable. May be empty.                         | Yes      | empty list |
| `defaultSpot`     | The spot this person is assigned by default (first choice in auto-allocation before consulting preferences). Set by an admin.                                                             | Yes      | —          |

Priority among people is determined by their order in the people list: the
person at the top of the list has the highest priority. Admins can reorder the
people list to change priority.

**Spot Request**

Represents one person's request to park on a specific date.

| Field           | Description                                                                                              | Optional | Default |
| --------------- | -------------------------------------------------------------------------------------------------------- | -------- | ------- |
| `person`        | The person who made the request.                                                                         | No       | —       |
| `requestedDate` | The date for which parking is requested (a calendar date, not a datetime).                               | No       | —       |
| `status`        | Current state of the request. One of: pending, allocated, denied, cancelled.                             | No       | pending |
| `assignedSpot`  | The parking spot assigned to this request. Set when status becomes "allocated".                          | Yes      | —       |
| `autoAllocated` | Whether the spot assignment was made automatically by the system (true) or manually by an admin (false). | No       | true    |

### Relationships

- A **Person** may have one **Parking Spot** designated as their `defaultSpot`
  (optional many-to-one reference).
- A **Person's** `spotPreferences` is an ordered list of **Parking Spots** they
  prefer (ordered reference list).
- A **Spot Request** belongs to exactly one **Person** and targets exactly one
  date.
- A **Spot Request**, when allocated, references exactly one **Parking Spot** as
  its `assignedSpot`.
- Multiple **Spot Requests** may target the same date, but no two allocated
  requests for the same date may share the same `assignedSpot` (each physical
  spot can only be used by one person per day).
- The people list is ordered; position in the list determines allocation
  priority (index 0 = highest priority).

## User Interactions

### Team Member Interactions

1. **View today's parking status**: The user sees all parking spots and their
   status for today: which spots are taken (and by whom), which are free, and
   how many spots remain. This is the primary at-a-glance view.

2. **Request a parking spot**: The user selects a date (defaulting to today) and
   submits a spot request. Upon submission, auto-allocation runs: the system
   checks whether the person's default spot is available on that date, then
   checks their ordered preferences, then assigns any available spot. If no
   spots are free, the request is marked as denied. The user sees immediate
   feedback: whether they got a spot and which one.

3. **Cancel a parking request**: The user can cancel any of their own active
   requests (status: pending or allocated). When cancelled, the request status
   becomes "cancelled" and the spot is freed for others. The user sees their
   request list update immediately.

4. **View the week-ahead**: The user sees a 7-day view starting from today
   showing all allocations for each day: which spots are taken, by whom, and
   which are free. Days with no allocations show as fully available.

5. **View personal request history**: The user can see a list of their own past
   and upcoming requests with their statuses (pending, allocated, denied,
   cancelled) and which spot was assigned (if any).

### Admin Interactions

6. **Add a person**: The admin can add a new person to the system by providing
   their name, email, and commute mode. The new person is added to the bottom of
   the priority list (lowest priority by default).

7. **Remove a person**: The admin can remove a person from the system. Any
   pending or allocated requests for that person are cancelled and their spots
   freed.

8. **Reorder people (set priority)**: The admin can reorder the people list to
   change who has higher priority in spot allocation. The person at the top of
   the list has the highest priority.

9. **Set a person's default spot**: The admin can assign a specific parking spot
   as a person's default. When that person makes a request, the system tries to
   allocate this spot first. The admin can also clear the default spot
   assignment.

10. **Set a person's spot preferences**: The admin can set and reorder the list
    of preferred spots for a person. The preferences are consulted in order
    during auto-allocation when the default spot is unavailable.

11. **Add a parking spot**: The admin can add a new parking spot to the system
    by specifying its number. Optionally, the admin can add a label and notes
    for the spot.

12. **Edit a parking spot**: The admin can edit the label and notes of an
    existing spot. The spot number cannot be changed (it is the physical lot
    number).

13. **Remove a parking spot**: The admin can remove a parking spot from the
    system. Any allocated requests for that spot are cleared of their spot
    assignment and reverted to "pending" for reallocation, or the admin is
    warned before removal.

14. **Manually override an allocation**: The admin can directly assign a
    specific spot to an existing pending request, bypassing auto-allocation. The
    request status becomes "allocated" with `autoAllocated` set to false.

15. **Toggle admin mode**: A simple toggle switches the interface between the
    team-member view and the admin management view. No login is required — this
    is a trusted small-team tool.

## Acceptance Criteria

- [ ] On initial load, the pattern shows today's date and the status of all
      three parking spots (#1, #5, #12).
- [ ] The today view clearly shows each spot as either free or taken, and
      displays the occupant's name when taken.
- [ ] A team member can submit a request for today or a future date and receive
      immediate feedback: the assigned spot number or a "denied" message if all
      spots are full.
- [ ] Auto-allocation checks the person's default spot first, then their
      preferences in order, then any free spot, and denies if all spots are
      taken.
- [ ] A team member can cancel their own request; the request status changes to
      "cancelled" and the spot is freed.
- [ ] The week-ahead view shows 7 days starting from today, with allocations
      displayed per day.
- [ ] The week-ahead view clearly shows which spots are free vs. taken on each
      day.
- [ ] An admin can add a new person with name, email, and commute mode.
- [ ] An admin can remove a person; their pending/allocated requests are
      cancelled.
- [ ] An admin can reorder the people list; the new order is reflected
      immediately.
- [ ] An admin can set or clear a person's default spot.
- [ ] An admin can set and reorder a person's spot preferences.
- [ ] An admin can add a new parking spot with a required number and optional
      label and notes.
- [ ] An admin can edit the label and notes of an existing spot.
- [ ] An admin can remove a parking spot; affected requests are handled
      (reverted to pending or cancelled).
- [ ] An admin can manually assign a spot to a pending request, overriding
      auto-allocation.
- [ ] The admin mode toggle switches between the team-member view and admin
      management controls.
- [ ] No two allocated requests for the same date share the same spot.
- [ ] Requests with status "cancelled" or "denied" do not block spot
      availability for other people on that date.
- [ ] A person can request a spot regardless of their usual commute mode.
- [ ] Submitting a request for a date that already has an active (non-cancelled)
      request from the same person is disallowed or handled gracefully (no
      duplicates).

## Edge Cases

- **No spots defined**: If no parking spots exist, the today view and week-ahead
  show a message that no spots are configured, and the request form is disabled.
  Admin must add spots first.
- **No people defined**: If no people exist, the admin view shows an empty list
  with a prompt to add the first person.
- **All spots taken for a requested date**: The request is marked as "denied"
  immediately. The user sees a clear message that no spots are available on that
  date.
- **Requesting today vs. a past date**: Requests for dates before today should
  be disallowed. The date picker should not allow past dates.
- **Same person requests the same date twice**: The system should detect an
  existing active request for that date and prevent a duplicate, showing a
  message that the person already has a request for that date.
- **Cancelling an allocated request frees the spot**: Subsequent requests from
  others for that date should now see the freed spot as available.
- **Removing a person with active requests**: All their pending and allocated
  requests are cancelled, freeing spots for other people.
- **Removing a spot with active allocations**: Requests allocated to that spot
  should be reverted to "pending" status and have their `assignedSpot` cleared.
  An admin warning before removal is appropriate.
- **A person has no default spot and no preferences**: Auto-allocation assigns
  any free spot (or denies if none are available).
- **A person's default spot is already taken**: Allocation falls through to
  preferences, then any free spot.
- **Very long names or emails**: Text should wrap or truncate gracefully in the
  people list and spot assignment display.
- **Large number of requests**: The week-ahead view should remain readable with
  many requests per day.
- **Priority with only one person**: The priority list still shows that person;
  reordering is a no-op.
- **Initial load with no data**: Show the three default spots (#1, #5, #12)
  already in the system with no people and no requests.

## Assumptions

1. **Default spots pre-populated**: The three spots (#1, #5, #12) are treated as
   the initial starting state of the pattern. They are loaded as defaults so the
   tool is immediately useful without admin setup for spots. The admin can add
   more or remove them.

2. **Allocation entity merged into SpotRequest**: The brief describes both a
   "SpotRequest" and an "Allocation" as separate entities. Since a SpotRequest
   already tracks the assigned spot, status, and auto-allocated flag, a separate
   Allocation entity would be redundant. All allocation information lives on the
   SpotRequest. This simplifies the data model without losing any required
   information.

3. **Priority operates at request time**: "Higher priority people get allocated
   first" is interpreted as: when auto-allocation runs for a new request, it
   uses the available spots at that moment. It does not retroactively reassign
   spots from lower-priority people. If a lower-priority person requested first
   and got their spot, a later higher-priority request gets whatever remains.
   Re-allocation on priority change is out of scope.

4. **No authentication or login**: The pattern uses a simple admin mode toggle.
   Any user of the pattern can switch to admin mode. This is appropriate for a
   trusted small-team internal tool, as the brief specifies.

5. **Requests are per-person, per-date unique**: Only one active request
   (non-cancelled) per person per date is allowed. Submitting a second request
   for the same date the same person already has a request for is an error
   condition, not silently overwritten.

6. **Past date requests disallowed**: The brief does not explicitly say whether
   past-date requests are allowed, but for a practical coordination tool, only
   today and future dates make sense for new requests. Past dates are read-only
   in the week-ahead and history views.

7. **Commute mode is informational only**: The brief explicitly says "people who
   usually take transit or bike should still be able to request a spot." The
   `commuteMode` field is displayed for context (e.g., admins can see who
   normally drives vs. takes transit) but never blocks a request.

8. **Spot number is immutable**: The physical lot number (#1, #5, #12) is set
   once and cannot be edited. Only the label and notes can be changed. This is
   reflected in the "edit a parking spot" interaction.

9. **Auto-allocation denial is immediate**: If all spots are taken when a
   request is submitted, the request immediately gets status "denied" rather
   than entering a "pending" queue. For a small team with 3 spots, a pending
   queue would be confusing. Users can check the week-ahead and request a
   different date.

10. **Week-ahead starts from today**: The 7-day view always shows today through
    today+6. It does not allow scrolling to future or past weeks. This keeps the
    pattern focused and practical.
