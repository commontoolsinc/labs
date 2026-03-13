# Spec Interpreter Notes — Parking Coordinator

## Initial Reading

The brief is quite detailed and specific. It names:

- Exact spot numbers (#1, #5, #12 — non-sequential, real lot numbers)
- Four entities: Parking Spot, Person, Spot Request, Allocation
- Specific auto-allocation logic with priority ordering
- Two roles: team member and admin
- Week-ahead view
- People's usual commute modes

This is a well-specified brief, not sparse. I should faithfully structure what's
given and fill gaps rather than invent features.

## Complexity Assessment

Reasoning through the tier:

**Foundation** — single entity, 1-3 actions. No, this has 4 entities, admin
flows, and computed views.

**Intermediate** — multiple entities, relationships, computed views. Yes:

- Entities: ParkingSpot, Person, SpotRequest (Allocation is derived from
  requests)
- Relationships: Person references ParkingSpot for default assignment and
  preferences; SpotRequest references both
- Computed views: today's status (which spots taken/free/by whom), week-ahead
  calendar
- Auto-allocation logic on request creation
- Priority ordering on Persons

**Advanced** — complex state machines, LLM, multi-step workflows. Not quite. The
auto-allocation is algorithmic but deterministic and simple (3 spots, ordered
preferences). No LLM, no multi-step wizard, no branching state machine.

Decision: **Intermediate** tier. The most comparable completed spec is the
budget-tracker — multiple entities with relationships, derived views, and
meaningful computed logic. Kanban-board is also a good reference for the "admin
vs. team member" separation (though kanban didn't have roles, the structural
complexity is similar).

## Reference Exemplars

Using:

- `budget-tracker/spec.md` — multiple entities, computed summary view, CRUD
  across entity types
- `kanban-board/spec.md` — visual status, ordered lists, clear state about
  what's shown

## Entity Analysis

The brief lists four entities. Let me think about whether Allocation is distinct
from SpotRequest or if they collapse:

- **SpotRequest**: which person, which date, status
  (pending/allocated/denied/cancelled), which spot assigned
- **Allocation**: which spot, which date, which person, whether auto-allocated

Looking at this: when a request is allocated, the "assigned spot" field on
SpotRequest is filled in. The Allocation entity seems to be capturing the same
information from the spot's perspective vs. the person's perspective. In a real
database you'd have both, but in a UI pattern, they represent the same
underlying fact.

However, the brief explicitly lists both as separate data shapes. I should keep
them logically separate as the brief intends. The Allocation entity describes
the spot-centric view of who holds a spot on a given day. This is useful for the
"today's status" view (scan spots, see who has each).

Actually, thinking more carefully: the brief says the UI should "clearly show
today's allocation status: which spots are taken, which are free, who has each
one." This is an Allocation-centric view. And the week-ahead view also needs
allocation data per day per spot.

I'll keep Allocation as a distinct concept that gets created when a request is
approved/auto-allocated. This mirrors how the brief described it.

## Priority and Allocation Logic

The brief says:

- Auto-allocation runs when a request is created
- Logic: assign default spot if available → first preference → any available
- Higher-priority people (higher in the list) get allocated first

"Higher priority people get allocated first" — this implies the priority
ordering matters when multiple people request the same day. The spec should
describe this constraint/behavior.

## Spot Preferences

The brief says: "spot preferences (ordered list)". This is a list of spots, in
preference order, attached to a Person. The admin can manage this.

## Default Spot Assignment

Admin can assign a default spot to a person. This is the first thing checked
during auto-allocation.

## Week-Ahead View

A calendar-style view showing 7 days (today + 6 ahead) with the allocations for
each day.

## Admin Role

The brief describes an admin role with specific powers:

- Add/remove people
- Set priority order
- Assign default spots to people
- Add/remove parking spots

I need to think about how the admin role is surfaced in the UI. Since this is a
pattern (not a full auth system), the simplest approach is a toggle or a
separate admin section visible to everyone (since this is an internal tool for a
small team, security is not the concern). I'll assume a simple "admin mode"
toggle that reveals admin controls.

## Assumptions I'll Need to Make

1. **Admin mode**: Since this is a small-team internal tool, I'll assume a
   simple toggle to enter admin mode rather than login-gated access. The brief
   says "as an admin" but doesn't describe authentication.

2. **Spot Request vs. Allocation**: I'll keep both as spec'd. A request creates
   an allocation if a spot is available; it stays pending if no spot is
   available. Denied = no spot available. The allocation is the concrete
   assignment.

3. **Auto-allocation timing**: Runs at request creation time. If multiple
   requests come in for the same day, they're processed in priority order
   (higher priority = lower number in the priority list = first-come
   first-served within ties? I'll clarify: priority list determines order of
   allocation, so if two people both request today, the higher-priority person
   gets their preferred spot, then the lower-priority person gets what's left).

4. **No user identity**: Since this is a pattern, there's no login. I'll assume
   the user selects who they are from a dropdown when making a request. (This is
   a common assumption for single-user patterns that model multi-user
   scenarios.)

5. **Date selection for requests**: The user picks a date from today through
   some future window. I'll suggest today + 30 days max to keep it practical.

6. **Cancelled vs. Denied**: Cancelled = person cancelled their own request.
   Denied = no spot was available when the request was processed.

7. **Week-ahead view**: Displays the next 7 days starting from today, showing
   all allocations per day.

8. **Priority order management**: The admin reorders the list of people by
   dragging or using up/down buttons. I'll not assume drag-and-drop (too
   implementation-specific) and instead describe up/down movement.

## What I'm Collapsing

After reflection, the brief's "Allocation" entity and SpotRequest's "assigned
spot" field are closely related. I'll model them as:

- SpotRequest is the request (person-centric)
- When allocated, it has a spot assigned and its status becomes "allocated"
- The daily view is derived by looking at all allocated requests for that date

This means I don't need a separate Allocation entity — the data is on the
SpotRequest. This simplification is cleaner for a pattern, and the brief's four
entities may have been more of a data-modeling sketch than a strict requirement.
I'll note this as an assumption.

Wait — actually re-reading: the brief says "Allocation: which spot, which date,
which person, whether it was auto-allocated." This is explicitly listed as a
separate entity. I should keep it or at minimum explain why I collapsed it.

For a pattern, collapsing makes the implementation simpler. A SpotRequest when
allocated becomes the allocation. The "whether auto-allocated" flag can live on
the SpotRequest. I'll collapse and note it.

## Fields Cleanup

### ParkingSpot

- number (e.g., "1", "5", "12") — the identifying lot number; required
- label — optional friendly name (e.g., "Near entrance"); optional
- notes — any relevant notes (e.g., "Van accessible"); optional

### Person

- name — display name; required
- email — email address; optional (brief lists it, I'll keep it)
- usualCommuteMode — one of: drive, transit, bike, wfh, other; required; default
  "drive"
- spotPreferences — ordered list of parking spots they prefer; optional; default
  empty
- defaultSpot — the spot admin has assigned as their default; optional

### SpotRequest

- person — references a Person; required
- date — the date of the parking request; required
- status — one of: pending, allocated, denied, cancelled; defaults to pending at
  creation, then updated by auto-allocation
- assignedSpot — the spot allocated to this request; set when status becomes
  "allocated"; otherwise empty

## Priority Order

I'll model the admin's priority ordering as a property of the overall system —
an ordered list of people indicating priority. The first person in the list has
highest priority.

## Today vs. Week View

The main view should highlight today prominently, then show the week ahead. I'll
structure this as:

- Today's status: prominent panel showing all spots (free or occupied)
- Week-ahead table: days as columns, spots as rows (or vice versa), showing who
  has each spot each day

## Quality Check Before Writing

- Every interaction has data model support: yes
- Every field is used: yes (checking email — it's useful for contact info, I'll
  keep it but note it's display-only in the pattern)
- Acceptance criteria will cover all interactions
- Edge cases: empty state (no requests), full (all 3 spots taken), date with no
  requests, person with no preferences set
- Self-contained: yes
- Complexity: Intermediate — confirmed
- Useful as a real tool: yes, this is explicitly described as a real office tool

## Notes on What I'm Keeping vs. Simplifying

Keeping:

- All four entity types (but collapsing Allocation into SpotRequest)
- Admin mode as a toggle
- Auto-allocation logic description
- Week-ahead view
- Priority ordering
- Spot preferences per person
- Default spot assignment

Simplifying:

- No authentication — assume admin toggle
- No "who am I" login — assume person selection when making a request
- Date range for requests: today to 30 days ahead (practical limit not in brief)
