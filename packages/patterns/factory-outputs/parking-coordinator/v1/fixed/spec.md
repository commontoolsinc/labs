# Pattern Spec: Parking Coordinator

## Description

A practical coordination tool for a small office team to manage shared parking spots. Team members can request a parking spot for today or a future date; the tool auto-allocates a spot when a request is made, following each person's preferences and priority order. An admin view lets designated coordinators manage the list of people, set priority ordering, assign default spots, and update the set of available parking spots. The main screen shows today's allocation at a glance — which spots are taken, which are free, who has each one — plus a week-ahead view for planning. Designed to be simple and practical for daily use by a small team.

## Complexity Assessment

- **Tier:** Intermediate
- **Reference exemplars:** `budget-tracker/` (multiple entities with relationships, computed derived views, CRUD across entity types), `kanban-board/` (visual status indicators, clear state display, operational constraints)
- **Rationale:** The pattern has three core entities (ParkingSpot, Person, SpotRequest) with multiple relationships between them, meaningful derived views (today's status panel, week-ahead calendar), auto-allocation logic that runs on request creation, priority-based ordering, and separate admin controls for data management. There is no LLM integration, no multi-step wizard, and the allocation logic is a simple deterministic rule (default spot → first preference → any available). This places it firmly in the Intermediate tier.

## Data Model

### Entity: Parking Spot

Represents a single numbered parking space in the office lot.

- **number** — The parking spot's identifier as it appears on the physical lot (e.g., "1", "5", "12"). Required. Must be unique across all spots.
- **label** — An optional friendly name for the spot (e.g., "Near entrance", "Covered"). Optional; defaults to empty.
- **notes** — Any relevant operational notes about the spot (e.g., "Van accessible", "Do not block door"). Optional; defaults to empty.

### Entity: Person

Represents a team member who may request parking. Managed by the admin.

- **name** — The person's display name. Required.
- **email** — The person's email address, shown as contact information. Optional.
- **usualCommuteMode** — How the person typically gets to the office. One of: "drive", "transit", "bike", "wfh", or "other". Required; defaults to "drive".
- **spotPreferences** — An ordered list of parking spots indicating this person's preferred spots, from most to least preferred. Optional; defaults to empty (no preferences set).
- **defaultSpot** — The specific parking spot the admin has designated as this person's default. When this person makes a request, this spot is tried first during auto-allocation. Optional; defaults to none.

### Entity: Spot Request

Represents a single request by one person for a parking spot on a specific date. Created when a team member requests parking. Updated by auto-allocation and by cancellation.

- **person** — The team member making the request. References an existing Person. Required.
- **date** — The calendar date for which parking is being requested. Required.
- **status** — The current state of the request. One of: "pending" (just created, awaiting allocation), "allocated" (a spot has been assigned), "denied" (no spot was available at allocation time), "cancelled" (the person cancelled the request). Starts as "pending" and is immediately updated by the auto-allocation process.
- **assignedSpot** — The parking spot assigned to this request. Present only when status is "allocated"; empty otherwise.
- **autoAllocated** — Whether the spot was assigned automatically by the system (true) or by an admin manual override (false). Defaults to true.

### Priority Ordering

The system maintains a global priority list — an ordered ranking of all Persons. The person at the top of the list has the highest priority and is allocated first when multiple people have requested the same date. This list is managed by the admin.

### Relationships

- A ParkingSpot may be referenced by many Persons (as default spot or in preferences), and may be assigned to many SpotRequests across different dates.
- A Person has at most one SpotRequest per date. A second request for the same person on the same date is not permitted if an active (non-cancelled) request already exists.
- A SpotRequest belongs to exactly one Person and, when allocated, exactly one ParkingSpot.
- The priority ordering is a separate ranked list of all Persons. Every Person appears exactly once in this list.
- A spot is "available" on a given date if it has no SpotRequest with status "allocated" for that date.

### Initial State

The system starts with the three office parking spots pre-loaded: spot #1, spot #5, and spot #12 (no labels or notes). No persons are pre-loaded; the admin adds them. The priority list starts empty and grows as persons are added.

## User Interactions

### Team Member Interactions

1. **View today's parking status** — On the main screen, the user sees a prominent "Today" panel showing all parking spots. Each spot is clearly marked as either occupied (showing the name of the person who has it) or available (shown as free). The panel provides an at-a-glance answer to "where can I park today?"

2. **View the week-ahead schedule** — Below the today panel, the user sees a 7-day grid spanning today through 6 days ahead. Columns are days; rows are parking spots (or vice versa). Each cell shows who has that spot on that day, or indicates the spot is free. This lets team members plan whether to drive in on upcoming days.

3. **Request a parking spot** — The user opens a request form by clicking a "Request Parking" button. They select:
   - Their name from a list of all registered persons
   - The date they need parking (defaults to today; can select any date from today up to 30 days ahead)
   They submit the form. The system immediately runs auto-allocation: it assigns the person's default spot if it is available on that date; if not, it tries the person's spots in preference order; if none are available, it assigns any free spot; if no spots are free, the request is denied. The result (allocated spot or denied) is shown to the user immediately after submission. The today panel and week-ahead grid update to reflect the new allocation.

4. **Cancel a parking request** — The user can find their active (allocated) request in the "My Requests" section or on the today/week view, and cancel it. The spot becomes available again immediately. The today panel and week-ahead grid update to reflect the freed spot.

5. **View my requests** — The user can see a list of their own past and upcoming requests, filtered by their selected name. Each entry shows the date, assigned spot (or "denied"), and status. This lets them review their history and find upcoming allocations to cancel.

### Admin Interactions

6. **Enter admin mode** — A clearly labeled "Admin" button or section reveals the admin controls. No password is required (this is a trust-based internal tool). The admin controls are visually distinct from the team member interface.

7. **Add a person** — The admin fills in a form with the person's name, optional email, and usual commute mode. The new person is added to the bottom of the priority list. They immediately appear as an option in the request form.

8. **Remove a person** — The admin can remove a person from the system. If the person has any upcoming allocated requests, those allocations are cancelled and the spots become available. The person is removed from the priority list.

9. **Set priority order** — The admin sees a ranked list of all persons, ordered from highest to lowest priority. They can move any person up or down in the list using up/down controls. The new priority order takes effect immediately for any future allocation runs. Existing allocations are not retroactively changed.

10. **Assign a default spot to a person** — When viewing or editing a person, the admin can select any parking spot as that person's default. Only one spot can be a person's default at a time. The admin can also clear the default (leaving the person with no default). Multiple people may share the same default spot (in which case the higher-priority person gets it first when both request the same day).

11. **Set spot preferences for a person** — The admin can edit a person's preference list: adding spots to the list, removing them, and reordering them. The preference list is used as a fallback when the person's default spot is unavailable.

12. **Add a parking spot** — The admin opens an add-spot form and enters the spot number (required), an optional label, and optional notes. The new spot is immediately available for allocation and appears in the today panel, week-ahead grid, and preference lists.

13. **Remove a parking spot** — The admin can remove a parking spot. If the spot has any upcoming allocated requests, those allocations are cancelled (status becomes denied) and the affected persons are notified visually (their allocations show as lost). The spot is removed from all persons' preference lists and default assignments.

14. **Edit a parking spot's details** — The admin can update a spot's label and notes at any time. The spot number cannot be changed after creation.

15. **Manually override an allocation** — The admin can directly assign any available spot to any person for a specific date, bypassing the auto-allocation rules. This creates an allocated SpotRequest (or updates an existing one) with autoAllocated set to false. The admin can also manually move an existing allocation to a different spot if the target spot is free.

## Acceptance Criteria

- On first load, the today panel shows all three parking spots (#1, #5, #12) as available.
- The week-ahead grid shows 7 days starting from today, with all spots shown as free initially.
- A team member can select their name and request parking for today; if a spot is free, it is allocated immediately and the today panel updates.
- After a successful allocation, the allocated spot shows as occupied in the today panel with the person's name.
- If all spots are occupied for a requested date, the request status shows as "denied" with a clear message that no spots were available.
- A person cannot have more than one active (non-cancelled) request for the same date. Attempting to request again for a date with an existing allocation shows an error.
- Cancelling a request returns the spot to "available" immediately in the today panel and week-ahead grid.
- Auto-allocation follows the priority: default spot first → spots in preference order → any free spot.
- If a person has no default spot and no preferences set, the system assigns any available spot.
- The week-ahead grid correctly shows allocations for future dates after requests are made.
- Admin mode reveals add/remove/edit controls for persons and spots.
- Adding a person via admin makes them immediately available in the request form's name selector.
- Removing a person cancels any upcoming allocated requests for that person.
- The priority list in admin mode shows all persons in ranked order. Moving a person up/down updates their position immediately.
- Adding a spot via admin makes it appear in the today panel, week-ahead grid, and preference selection lists.
- Removing a spot cancels any upcoming allocated requests for that spot; affected persons see their allocations as lost.
- A spot's label and notes can be edited; updates appear immediately everywhere the spot is displayed.
- Persons with usual commute mode of "transit", "bike", "wfh", or "other" can still make parking requests — their commute mode is informational only, not a restriction.
- The "My Requests" view shows the current user's requests filtered by their selected name, including status and assigned spot.

## Edge Cases

- **No persons registered (initial admin setup):** The request form cannot be submitted until at least one person exists. The today and week-ahead panels show only spots with no names. The admin should see a prompt to add people.
- **All spots occupied for a requested date:** The request is created with status "denied." The user sees a clear message. The today panel shows all spots as occupied.
- **Person requests a date that already has an active request for them:** The system prevents creating a duplicate request and shows an informative message.
- **Person's default spot is occupied on the requested date:** Auto-allocation falls through to preferences. If all preferences are also occupied, any free spot is assigned. If no spots are free, the request is denied.
- **Two people with the same default spot request the same date simultaneously:** The higher-priority person (earlier in the priority list) gets their default spot; the lower-priority person falls through to their next preference or any available spot.
- **Person with no preferences and no default:** Any available spot is assigned. If no spot is available, the request is denied.
- **Admin removes a spot that has upcoming allocations:** The affected SpotRequests are updated to denied status. The persons whose allocations were cancelled see their requests as lost.
- **Admin removes a person who has upcoming allocations:** The allocated requests are cancelled; spots become available again.
- **Requesting a date in the past:** The form does not allow selecting past dates. Only today and future dates (up to 30 days ahead) are selectable.
- **Very long person name:** The name truncates or wraps gracefully in the today panel, week-ahead grid, and person lists without breaking the layout.
- **Spot with a very long label or notes:** Text wraps within the display without breaking the layout.
- **Week-ahead grid at end of month:** The grid correctly handles month boundaries (e.g., showing March 30 through April 5 with correct dates).
- **All persons in the system have a commute mode that is not "drive":** They should still be able to request spots — commute mode is informational.
- **Admin reorders the priority list when some requests for today already exist:** Existing allocations are not changed. The new priority order applies only to future allocation runs.
- **Empty week-ahead (no requests at all):** Every cell in the grid shows the spot as free. A helpful message or visual indicator clarifies that no bookings have been made.

## Assumptions

1. **No authentication; admin mode is a toggle.** The brief does not describe a login system. Since this is a small internal team tool, admin controls are accessible via a visible toggle on the interface. All users see the same data; only admin controls are gated behind the toggle. The brief says "as an admin" but does not imply a separate login.

2. **Person selection for requests.** Because there is no user identity in the pattern, team members select their own name from the registered persons list when making a request. This is a standard simplification for internal team patterns.

3. **Allocation entity collapsed into SpotRequest.** The brief describes both "SpotRequest" (person-centric) and "Allocation" (spot-centric) as separate entities. In this spec they are unified: a SpotRequest, when allocated, carries the assigned spot and the autoAllocated flag. The today and week-ahead views derive their display from allocated SpotRequests. This simplification avoids redundant data without losing any required information.

4. **Auto-allocation runs immediately on request submission.** The brief says "auto-allocation should run when a request is created." The request transitions from "pending" to "allocated" or "denied" within the same action — users never see a prolonged pending state. Pending status is an internal transitional state during the allocation process.

5. **Priority order determines allocation sequence, not real-time competition.** When multiple people have requested the same date, they are allocated in priority order: the highest-priority person's preferences are satisfied first, then the next, and so on. This applies when viewing the week-ahead (all existing requests are already allocated or denied in priority order at the time each was submitted).

6. **Date range for requests: today to 30 days ahead.** The brief does not specify a date range. 30 days ahead is a practical window for a small office team's planning needs. Past dates cannot be requested.

7. **Multiple people may share the same default spot.** The brief does not restrict this. If two people have the same default, the higher-priority person gets it when both request the same day.

8. **Email is display-only.** The brief lists email as a person field. In this pattern, email is stored and displayed as contact information but is not used for notifications (no email sending capability in the pattern).

9. **Spot number is immutable after creation.** The spot number is the physical identifier on the lot. Labels and notes can be updated; the number cannot, to avoid confusion with physical spots.

10. **Up/down controls for preference and priority ordering.** The brief does not specify the UI mechanism for ordering. Up/down arrow buttons per row are assumed rather than drag-and-drop, as they are simpler to implement and accessible.

11. **Initial spots pre-loaded; no persons pre-loaded.** The three spots (#1, #5, #12) from the brief are present on first load as the "known" office spots. No persons are pre-loaded — the admin adds their team. This matches the brief's description of the spots as fixed, real lot numbers.

12. **Cancellation is only available for upcoming/today requests.** Past requests (dates in the past) are shown in history but cannot be cancelled. Only future or today's allocated requests can be cancelled.

13. **Admin can manually override allocations.** The brief says admin can "occasionally update" things. A manual override interaction is added for the admin to directly assign or reassign a spot, as this is a natural expectation for a coordination tool admin.
