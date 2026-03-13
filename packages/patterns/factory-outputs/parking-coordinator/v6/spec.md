# Pattern Spec: Parking Coordinator

## Description

A coordination tool for small office teams to fairly manage a limited set of
shared parking spots. Team members can request spots for today or upcoming dates
and see who has each spot. Admins configure the people in the system, set
priority order for auto-allocation, and manage the parking spot roster. The
pattern is designed to be practical and low-friction — a real team tool, not a
demo.

## Complexity Assessment

- **Tier:** Intermediate
- **Reference exemplars:** `habit-tracker` (date-based daily state across
  multiple entities, "what's the status today" read view), `budget-tracker`
  (admin-configurable entities drive user-facing tracking)
- **Rationale:** Four related entities, date-based status computation,
  auto-allocation logic, and a two-role permission model. No LLM or complex
  state machines, but the coordination of requests, allocations, priorities, and
  dates across a week-ahead view puts this comfortably in Intermediate.

## Data Model

### Parking Spot

Represents a physical parking spot in the lot.

- **spot number** — The label used in the physical lot, e.g. "#1", "#5", "#12".
  This is a short text string, not a sequential integer, because the actual lot
  numbers are non-sequential.
- **label** — Optional short human-readable name for the spot, e.g. "Closest to
  door". Helps team members identify spots.
- **notes** — Optional longer text for additional context, e.g. "Has a tight
  turning radius".

### Person

Represents a team member who may use the parking system.

- **name** — Full name of the person.
- **email** — Email address, used for identification.
- **commute mode** — How this person usually gets to the office. One of: drive,
  transit, bike, wfh, other. This is for informational context; all people can
  request spots regardless of their usual mode.
- **spot preferences** — An ordered list of preferred spot numbers. The first
  entry is the person's top choice, the second is their fallback, and so on. Can
  be empty.
- **default spot** — An optional spot number indicating this person's standing
  assignment. When requesting a spot, the system tries their default first
  before consulting their preference list.
- **priority rank** — A positive integer indicating this person's allocation
  priority. Lower numbers mean higher priority (rank 1 gets first pick). Used by
  auto-allocation when multiple pending requests exist for the same date. No two
  people share the same rank.
- **is admin** — Whether this person has admin capabilities (can manage the spot
  roster, manage people, and set priority order).

### Spot Request

Represents a team member's request to use a parking spot on a specific date.

- **person** — The person making the request.
- **date** — The date for which a spot is requested, stored as YYYY-MM-DD. Must
  be today or a future date.
- **status** — The lifecycle state of the request. One of:
  - `pending` — Request submitted but not yet resolved (used if auto-allocation
    is deferred, or as a brief transitional state)
  - `allocated` — A spot has been assigned
  - `denied` — Request was processed but no spot was available
  - `cancelled` — Cancelled by the person
- **assigned spot** — The spot number assigned to this request. Only present
  when status is `allocated`.

### Allocation

Represents the definitive record of a spot being assigned to a person on a
specific date. Created when a Spot Request is allocated. Removed when the
corresponding request is cancelled.

- **spot** — The parking spot that is assigned.
- **date** — The date of the allocation, stored as YYYY-MM-DD.
- **person** — The person holding this allocation.
- **auto-allocated** — Whether this allocation was made automatically by the
  system (true) or manually assigned by an admin (false).

### Relationships

- A Parking Spot can appear in many Allocations (across different dates) and in
  many persons' preference lists and default spot fields, but only one
  Allocation can exist per spot per date.
- A Person can have many Spot Requests and many Allocations (across different
  dates), but only one active (non-cancelled) request per date.
- A Spot Request results in at most one Allocation. An Allocation always
  corresponds to exactly one Spot Request.
- Spot Requests are owned by their Person. Allocations are derived from Spot
  Requests.

## User Interactions

### Team Member Interactions (all users)

1. **View today's parking status** — The user sees all parking spots and their
   status for today: which spots are taken (with the name of who has them),
   which spots are free, and which spots have no one assigned. This is the
   primary "at a glance" view.

2. **Request a spot for today** — The user submits a request for a spot on
   today's date. The system immediately attempts auto-allocation: it tries to
   assign the person's default spot first (if they have one and it is not
   taken), then their first available preference, then any available spot. If a
   spot is found, the request is set to `allocated` and the spot is shown as
   taken by this person. If all spots are full, the request is set to `denied`.

3. **Request a spot for a future date** — The user picks a date (today or any
   future date) and submits a request. Auto-allocation runs using the same logic
   as above, evaluated against all requests for that date at the time of
   submission. If a person already has an active request for that date, a new
   request for the same date replaces it (the old one is cancelled first).

4. **View week-ahead allocation summary** — The user sees a 7-day view (today
   through 6 days from now) showing which spots are allocated on each day and to
   whom, which spots are free, and whether they personally have a spot on each
   day.

5. **Cancel a request** — The user cancels one of their own existing requests.
   If the request was `allocated`, the corresponding Allocation is removed and
   the spot becomes available for that date. If the request was `pending` or
   `denied`, it is simply marked `cancelled`. Cancelled requests are not removed
   from history.

6. **View their own request history** — The user can see their own past and
   upcoming requests and their statuses.

### Admin Interactions (admin users only)

7. **Add a person** — Admin enters a name, email, commute mode, and optional
   default spot. The person is added to the system with a priority rank at the
   bottom of the current list (lowest priority). The admin can then reorder
   priorities.

8. **Edit a person's details** — Admin updates a person's name, email, commute
   mode, spot preferences, default spot, or admin status.

9. **Remove a person** — Admin removes a person from the system. Any future
   allocations for that person are cancelled. Past records are retained for
   history.

10. **Set priority order** — Admin reorders the list of people by priority. The
    person at the top of the list gets priority rank 1 (highest). Reordering
    reassigns ranks to all people accordingly.

11. **Add a parking spot** — Admin enters a spot number and optional label and
    notes. The spot is immediately available for future requests.

12. **Edit a parking spot** — Admin updates a spot's label or notes. The spot
    number itself cannot be changed (it is a physical lot identifier).

13. **Remove a parking spot** — Admin removes a spot from the system. Any future
    allocations for that spot are cancelled. The admin sees a warning if the
    spot has current or upcoming allocations before confirming.

14. **Manually assign a spot** — Admin directly assigns a specific spot to a
    specific person for a specific date, bypassing the auto-allocation logic.
    This creates an Allocation with `auto-allocated` set to false. If that
    person already has an allocation for that date, it is replaced. If that spot
    is already allocated on that date, the prior allocation is replaced.

15. **Manually cancel an allocation** — Admin cancels any allocation (not just
    their own), returning the spot to available for that date.

## Acceptance Criteria

- When the pattern loads, today's parking status is visible without any user
  action required.
- All three configured spots (#1, #5, #12) appear in the today status view, even
  if none are allocated.
- A team member can submit a spot request and immediately see the result
  (allocated with a spot number, or denied).
- Auto-allocation assigns the person's default spot first when it is available.
- Auto-allocation assigns the person's first available preference when the
  default is not available.
- Auto-allocation assigns any available spot when neither default nor
  preferences are available.
- When all spots are taken on a date, a new request for that date receives
  `denied` status.
- A person with a denied request sees clear messaging that no spots were
  available.
- A team member can cancel their own allocated request and the spot immediately
  becomes available for that date.
- A team member cannot submit a request for a past date.
- The week-ahead view shows 7 days (today through 6 days from now) with per-day
  spot allocation status.
- The week-ahead view shows the current user's own allocation status on each
  day.
- Admin can add, edit, and remove people from the system.
- Admin can add, edit, and remove parking spots from the system.
- Admin can reorder the priority list and the new order is reflected immediately
  for future auto-allocations.
- Admin sees a confirmation warning before removing a spot that has active or
  upcoming allocations.
- Admin can manually assign any spot to any person for any date.
- A person cannot have two active (non-cancelled) requests for the same date.
- The system works correctly with only one or two spots (not hardcoded to
  exactly three).
- Spot numbers are displayed as human labels (e.g. "#5"), not as internal
  identifiers.

## Edge Cases

- **No spots configured** — The tool shows an empty state prompting an admin to
  add spots before requests can be made.
- **No people configured** — The tool shows an empty state prompting an admin to
  add people.
- **No requests for a day** — All spots appear as free in the week-ahead view
  for that day.
- **All spots full** — New requests for that date receive `denied` status with a
  clear message.
- **Person has no preferences and no default** — Auto-allocation assigns any
  available spot.
- **Person cancels an allocated request** — The spot is freed and any existing
  `denied` requests for that date are NOT automatically re-evaluated (they
  remain denied; users must re-request).
- **Admin removes a person with active allocations** — Future allocations for
  that person are cancelled; the spots become available.
- **Admin removes a spot with active allocations** — Future allocations for that
  spot are cancelled; the admin sees a confirmation warning listing affected
  dates and people.
- **Duplicate request for same date** — If a person submits a request for a date
  on which they already have an active request, the prior request is cancelled
  and replaced by the new one (auto-allocation re-runs).
- **Request for today after spots are already full** — Status is `denied`, not
  an error.
- **Priority rank gaps after removing a person** — Ranks are recomputed to be
  contiguous after removal.
- **Single person in the system** — Priority ordering still works; that person
  always gets rank 1.
- **Request for a date far in the future** — No upper bound restriction; the
  system handles any future date.
- **Very long name or label** — Display truncates gracefully without breaking
  layout.
- **Spot with no label** — Displayed by its spot number only.

## Assumptions

1. **Admin mode is a toggle on Person** — The brief mentions admin capabilities
   without specifying how admin status is determined. Since this is a small team
   tool without an authentication system, each person has an `is admin` flag.
   The pattern renders admin controls when acting in admin mode. This was chosen
   over a separate auth layer to keep the tool "practical and simple."

2. **Past-date requests are blocked** — The brief says "today or a future date,"
   which I interpret as explicitly preventing past-date requests. The date
   picker constrains selection to today or later.

3. **Auto-allocation runs immediately on request submission** — The brief states
   this explicitly. There is no "pending" queue that processes in batch; pending
   is only a transitional state if needed for display.

4. **Denied requests are not auto-re-evaluated on cancellation** — When a spot
   is freed by cancellation, existing denied requests do not automatically get
   promoted. This keeps the logic simple; affected users re-request if they
   still need a spot. Documented as a known limitation.

5. **Allocation is a separate entity from Spot Request** — The brief lists both.
   I've treated Allocation as the definitive resolved record (spot + date +
   person) while Spot Request tracks the lifecycle (pending, allocated, denied,
   cancelled). The Allocation is created when a request is approved and removed
   when cancelled.

6. **Week-ahead means today plus 6 more days** — The brief says "week-ahead
   view" without defining it precisely. I interpret this as 7 calendar days
   starting with today, which is the most natural reading.

7. **Priority rank must be unique** — The brief says "higher-priority people get
   allocated first" but does not address ties. I assume ranks are unique;
   reordering always produces a clean 1-through-N ranking.

8. **Spot number is immutable once created** — The lot number is a physical
   label. Admins can update the label and notes but not the spot number itself,
   since changing it could cause confusion with actual lot markings.

9. **Manual admin allocation bypasses priority** — Admins can assign any spot to
   any person regardless of priority or preferences. This is intentional for
   exceptional circumstances.

10. **No notification system** — The brief does not mention notifications
    (email, push, etc.). The pattern is purely in-app; users check the tool to
    see their status.
