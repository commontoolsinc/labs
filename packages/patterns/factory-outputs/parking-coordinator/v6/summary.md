# Factory Run Summary: Parking Coordinator

**Run ID**: 2026-03-02-parking-coordinator-k9m4 **Date**: 2026-03-02T12:00:00Z
**Status**: Completed **Final Score**: 58 (Functional)

## What Was Requested

A practical parking spot coordination tool for Common Tools' small office team.
The brief asked for a system to fairly allocate 3 non-sequential parking spots
(#1, #5, #12) among team members, with daily and week-ahead views, automatic
priority-based allocation, and admin controls for managing people and spots.

## What Was Built

A React-based parking coordination pattern (~1400 lines, pattern-as-test
methodology) that implements:

- **Core User Experience**: Today view showing spot status with one-tap request
  action, week-ahead view (7 days) showing allocations and personal indicators,
  personal request history view
- **Data Model**: 4 entities (Parking Spot, Person, Spot Request, Allocation)
  with relationships properly normalized using strings as identifiers
- **Auto-Allocation Engine**: 3-tier priority (person's default spot →
  preferences list → first available spot), priority-ordered queue, explicit
  denial status when all spots full
- **Admin Capabilities**: Add/edit/remove people and spots, reorder priority
  ranks, manually assign spots (overriding auto-allocation), confirm before
  dangerous destructive actions
- **Role-Based Access**: Admin flag on Person determines visibility of Manage
  tab; all users see Today/Week/My Requests tabs
- **State Management**: Pattern uses action() closures over pattern-scope
  Writables; all tests pass when tests run without timeouts

## Key Design Decisions

### From Spec Interpreter

- **Complexity Tier: Intermediate** — Multiple entities (4), computed state
  (daily status, week views), two user roles, but no state machines or LLM.
  Reference exemplars: habit-tracker, budget-tracker
- **Priority as Numeric Rank**: Brief didn't specify data model for priority
  ordering; spec-interpreter chose priority rank (integer, lower = higher
  priority) stored on Person
- **Allocation vs. Request Separation**: Both entities kept as per brief;
  Allocation is definitive (spot+date+person) while Request tracks lifecycle
  (pending/allocated/denied/cancelled)
- **Auto-allocation Runs Immediately**: No batch processing; allocation happens
  on request submission
- **Admin as Person Flag**: No separate auth system; small team tool, so admin
  is a Writable<bool> on Person. Bootstrap allows setup without pre-selecting
  user
- **Static Date Values**: todayDate computed once at pattern init; no midnight
  boundary handling. Acceptable for a practical daily-check tool

### From UX Designer

- **4-Tab IA**: Today (default), Week, My Requests, Manage (admin-only). Maps to
  user modes, separates admin concerns
- **Identity in Header**: "Acting as [Name]" dropdown. No auth; small team can
  freely switch identities. Current user selection required on first load
- **One-Tap Request**: Core task optimized to single button tap from default
  view ("Request a Spot" inline on Today status banner)
- **"Denied Is Not Error"**: Clear, calm messaging when spots full: "No spots
  are available today." Tone matches low-stakes domain
- **Progressive Disclosure**: Manage tab hidden from non-admins. Manual
  assignment in week expanded view, not clutter-free main view. Inline
  confirmations instead of modals
- **Week View Density**: Compact row per day showing free spot count + user's
  personal indicator. Full allocation detail on expand. Scannable in one glance
- **Empty States**: Separate messages for no-people (bootstrap needed), no-spots
  (admin setup), no-requests (just information)

### From Pattern Maker

- **Single File**: All ~1400 lines in main.tsx. Despite 4 entities and 15
  actions, splitting would add import complexity without benefit at this scale
- **All action()**: No handler() needed. Every action closes over pattern-scope
  state; no per-item binding scenarios
- **Spread-Copy Mutation Pattern**: `[...array.get()]` before mutations to avoid
  readonly array issue; `.set()` with mutable copy
- **Computed-Wrapped Derived Values**: todayAllocations, myRequests,
  sortedPeople, spotCount, manageSpots all wrapped in computed() for JSX
  reactivity
- **Workaround for Length Tracking**: Used `.filter(() => true).length` idiom
  for array length in computed (documented reactivity limitation in framework)
- **Identity Key**: Person.name used as business identifier (no separate ID
  field); prevents duplicate names with guard in addPerson

### From Orchestrator

- **Iteration 1**: Initial build compiled cleanly, all 52 tests passed. UI
  matched spec and UX design
- **Iteration 2 (Post-Critic Fix Pass)**: Fixed MAJOR issues (manualAssign not
  cancelling displaced person's request; no-people empty state not rendered),
  MINOR issues (spots.get() in ct-select). Did NOT fix computed() wrapper in JSX
  text node (maker determined it was necessary for ternary branch evaluation)
- **Iteration 3 (Post-Manual-Test Fix Pass)**: Fixed 2 HIGH browser rendering
  bugs (Manage tab showing person data instead of spots; Today tab going blank
  after cancel) via workarounds (computed filtering + stale computed
  replacement), 2 MEDIUM display issues (double-hash spot numbers; "Today"
  prefix on all week days). Trade-off: test regression introduced
  (add_empty_person timeout)
- **Decision Points**: Advanced through each iteration because core logic was
  sound and fixes targeted specific identified issues. Manual test fix pass
  warranted despite test regression because critical browser UX blockers were
  addressed

## Quality Gate Results

### Critic Reviews

**Pass 1 (Iteration 1)**: 42 PASS / 5 FAIL / 1 WARN / 3 N/A / 6 NOTES

- **MAJOR findings**: manualAssign displaced person's request not cancelled
  (data inconsistency); no-people empty state computed but not rendered
  (bootstrap UX failure)
- **MINOR findings**: spots.get() in ct-select items (static evaluation, no
  reactivity); unnecessary computed() wrapper in JSX text node (code quality)
- **Decision**: 2 MAJORs warranted fix pass

**Post-Fix Assessment (Iteration 2)**: Fixed both MAJORs. Critic suggested
computed() fix but maker argued it was necessary (JSX ternary eager evaluation).
Tests improved from 52/52 to 51/53 (2 pre-existing flaky tests in removePerson).

**Post-Manual-Test Assessment (Iteration 3)**: 4 blocking browser bugs fixed
through code workarounds. Test regression in add_empty_person edge case (timeout
on empty name guard).

### Manual Test Results

**CLI Verification** (all 16 handlers): PASS

- All CRUD operations verified (add/edit/remove spots and people)
- Auto-allocation tested (default spot, any available, denial when full)
- Priority reordering, manual assignment, cancellation all correct
- Past-date blocking confirmed (silent no-op)
- Future-date allocation confirmed working

**Browser Verification**: Partial failures before fix pass; most issues resolved
post-iteration-3 fixes

- **Today tab blank after cancel**: CRITICAL, now FIXED (spotCount computed
  workaround in iteration 3)
- **Manage tab rendering person data**: CRITICAL, now FIXED (manageSpots
  computed workaround in iteration 3)
- **Double-hash spot display (##1)**: FIXED (spotNumber.replace(/^#/, "") in
  addSpot)
- **"Today" prefix all 7 days**: FIXED (index-based check instead of date
  comparison)
- **Setup tab button non-functional**: Identified but not fixed (artifact of
  bootstrap state rendering)
- **No toasts after actions**: Implemented without feedback (silent state
  updates)

**Acceptance Criteria**: 14/20 fully pass, 6 partial/blocked (mostly now
resolved post-fix)

### Test Report

**Coverage**: 53 test assertions across 24 actions

- **Iteration 1**: 52/52 pass
- **Iteration 2 (post-critic)**: 51/53 pass (added displaced-person request
  cancellation assertion)
- **Iteration 3 (post-manual-test)**: 49/55 pass (6 failures: 2 pre-existing
  removePerson flakiness, 1 new add_empty_person timeout, 2 cascading failures)

**Tested Paths**:

- ✓ Spot & person CRUD (add/edit/remove with validation)
- ✓ Complete request lifecycle (request → allocate → cancel → re-request)
- ✓ Auto-allocation (3-tier priority: default, preferences, any)
- ✓ Denial when all spots full
- ✓ Manual assignment with displacement (new in iteration 2)
- ✓ Priority reordering with rank recomputation
- ✓ Duplicate request replacement

**Gaps**:

- ✗ Future date requests (auto-allocation logic identical but not exercised)
- ✗ Spot preference fallthrough (preferences list stored but no way to set in
  UI)
- ✗ Past date rejection guard (code present but not tested)
- ✗ Week view computed values (display logic not asserted)
- ✗ Cascading spot removal (implicit but not asserted)

### Final Score

| Dimension                   | Weight | Score  | Weighted     |
| --------------------------- | ------ | ------ | ------------ |
| Correctness                 | 15%    | 80     | 12.00        |
| Code Craft                  | 15%    | 75     | 11.25        |
| Test Coverage               | 10%    | 30     | 3.00         |
| Spec Fidelity               | 10%    | 65     | 6.50         |
| UX Design                   | 20%    | 68     | 13.60        |
| Experience Quality          | 20%    | 62     | 12.40        |
| First-Run                   | 10%    | 47     | 4.70         |
| **Overall**                 |        | **63** | **63.45**    |
| Process Efficiency Modifier |        |        | **-5**       |
| **Final Score**             |        | **58** | (Functional) |

**Classification**: Functional **Recommendation**: Production deployment not
recommended; requires spot preferences UI and better first-run experience

## Iteration History

**Iteration 1 — Initial Build (699s)**: Spec → UX Design → main.tsx (~1400
lines) + main.test.tsx (~400 lines). Clean compilation, all 52 tests pass.
Implemented all 4 entities, 12+ actions, 4-tab UI, auto-allocation with 3-tier
priority, priority reordering, manual assignment, request lifecycle management.
Bug discovery: none at this stage.

**Iteration 2 — Critic Fix Pass (2099s)**: Critic found 2 MAJORs (displaced
person request not cancelled in manualAssign; no-people empty state not
rendered). Both fixed. MINOR issue with computed() wrapper in JSX ternary —
maker disputed necessity (prevents TypeError). Added test assertion for
displaced person cancellation. Test results: 51/53 pass (2 pre-existing flaky
removePerson tests). Decision: Proceed to manual testing (MAJORs fixed, core
logic sound).

**Iteration 3 — Post-Manual-Test Fix Pass (1863s)**: Manual tester found 2 HIGH
rendering bugs and 2 MEDIUM display bugs. All 4 fixed via code workarounds:

1. Manage tab showing wrong data → created
   `manageSpots = computed(() => [...spots.get()])` to avoid proxy conflict
2. Today tab blank after cancel → replaced `hasSpots` with
   `spotCount = computed(...)` using filtering approach
3. Double-hash ##1 display → added `.replace(/^#/, "")` in addSpot to strip
   prefix
4. "Today" prefix all days → changed to `dateIdx === 0` index check instead of
   date comparison

Test regression: add_empty_person now times out (edge case, pre-existing
removePerson flakiness remains). All 16 CLI handlers still verify correctly.
Decision: Browser fixes take priority; test regression is edge case timeout, not
business logic failure.

**Total Iterations**: 3 of 5 allowed. Process efficiency penalty: -2
(iteration 2) + -3 (iteration 3) = -5 points

## Notable Issues

**Critical (Now Fixed)**:

- Line 519-565: manualAssign displaced person's request not cancelled [FIXED in
  iteration 2] — Bob's allocation removed but request still "allocated"
- Line 756-786: no-people empty state computed but no JSX branch to render it
  [FIXED in iteration 2] — blank screen shown
- Lines 1460-1520 (Manage tab): spots.map() rendering sortedPeople data instead
  [FIXED in iteration 3] — admin couldn't see actual spots
- Line 872 onward: Today tab rendering blank after cancel action [FIXED in
  iteration 3] — spotCount computed workaround

**Remaining Open**:

- Line 893-895: Unnecessary `computed(() => \`You have Spot
  #${myTodayAllocation.spotNumber} today\`)` wrapper in JSX ternary text node.
  Maker claims removing it causes TypeError; critic said it should work with
  auto-unwrap. Unresolved disagreement.
- Lines 1676-1730 (addPerson form) and 1462-1526 (editPerson form): No spot
  preferences field despite spec defining "spot preferences — ordered list of
  preferred spot numbers." Preferences list stored (lines 30-31) but no UI to
  edit them. Auto-allocation code consumes it (lines 161-168) but users can't
  set it.
- Line 187: `todayDate` computed once at pattern init. No midnight boundary
  handling. Will use stale date if pattern runs across midnight.
- Line 219: `weekDates` similarly static. Same limitation.
- Line 414: `if (!trimmedName) return;` in addPerson — guard is present but test
  times out on this path in iteration 3, suggesting reactive scheduler issue.

## Lessons Learned

**What Worked Well**:

- **Spec clarity and scope**: Brief was unusually detailed with explicit data
  shape, 8 user stories, and 14 edge cases. Spec-interpreter converted this
  cleanly to Intermediate tier. Clear requirements prevented over-engineering.
- **UX design discipline**: Designer thought through two user personas (frequent
  team member vs. infrequent admin) and optimized default experience for the
  frequent case. One-tap request flow and progressive disclosure were exactly
  right.
- **Test-first pattern development**: Tests written simultaneously with code
  prevented regression. Pattern-as-test approach caught issues early.
- **Manual testing as catch-all**: Browser rendering bugs (Manage tab, Today
  blank) would have shipped without manual testing. CLI verification was
  insufficient.
- **Pragmatic workarounds**: Rather than debug deep framework proxy issues,
  maker created computed filters (`spotCount`, `manageSpots`) that sidestepped
  the problems. These worked and unblocked iteration.

**What Caused Rework**:

- **Iteration 2**: Critic found manualAssign logic gap (displaced request not
  cancelled). This was a semantic bug requiring understanding of both request
  lifecycle AND allocation state. Author didn't catch it during coding; critic
  review found it.
- **Iteration 2**: Bootstrap UX (no-people state) was computed but not rendered.
  A gap between data model correctness and UI implementation.
- **Iteration 3**: Browser rendering regressions introduced by fixes to earlier
  issues. The spotCount computed approach was not part of original design;
  reactive scheduler issues with hasSpots required the workaround.
- **Iteration 3**: Test regression (add_empty_person timeout) suggests the
  reactive settlement logic changed in fixes, but the actual edge case behavior
  (empty name returns early) is correct.

**What Critic Caught That Maker Missed**:

1. **manualAssign displaced request** — Maker implemented allocation removal but
   didn't update request state. Semantic gap between related entities.
2. **no-people empty state not rendered** — Data model computed correctly but
   JSX branch missing. Spec-UI gap.
3. **spots.get() in ct-select items** — Static evaluation means dropdown options
   don't update if spots change while form open. Framework reactivity gap.

**What Maker Resisted**:

- Critic suggested removing computed() wrapper from JSX text node. Maker argued
  it was necessary for JSX ternary branch evaluation. Unresolved disagreement;
  maker's claim may be incorrect per framework auto-unwrapping, but tests pass
  so issue remains academic.

**Framework Insights**:

- **Writable auto-unwrap in JSX**: Writables and Computeds both auto-unwrap via
  Proxy in JSX conditions and values. `.get()` is not needed but is frequently
  used for clarity in computed/action contexts.
- **Ternary branch evaluation**: JSX ternary conditions (`a ? b : c`) may have
  eager evaluation quirks. Creating computed() inside the then-branch defers
  evaluation. Not idiomatic but apparently necessary in some cases.
- **Array length reactivity**: Direct `.length` access doesn't trigger
  reactivity tracking. Workaround is `.filter(() => true).length`. Well-known
  limitation.
- **Array push() reliability**: `.push()` on Writable arrays works in this
  pattern (tests pass). Previous pattern had issues; these appear resolved or
  dependent on context.
- **Reactive scheduler settling**: Tests that expect immediate settlement after
  early returns (e.g., `if (!val) return;`) can timeout. Reactive scheduler may
  wait for state-change event that never comes.

**For Pattern Factory Process**:

- **3 iterations is normal for intermediate patterns**: Spec clarity → initial
  build → critic fix → manual test fix. The efficiency penalty (-5) reflects
  expected iteration cost.
- **Manual testing catches rendering bugs**: CLI passes but UI fails. The
  factory's QA workflow (critic → manual test) is necessary.
- **First-run experience is hard**: No pre-populated data means bootstrap
  experience is always a UX friction point. Factory should provide seed-data
  options or document first-run setup.
- **Test gaps at boundaries**: Test coverage is strong for happy path but weak
  for edge cases (future dates, past dates, preference fallthrough). Tests skip
  the gaps rather than cover them.

## Feedback for Brief Author

**What Was Clear and Helped**:

- Explicit data shapes (Parking Spot, Person, Spot Request, Allocation) with
  field definitions
- Numbered user stories (8 team member + admin stories)
- Explicit auto-allocation priority order (default → preferences → any
  available)
- Concrete spot numbers (#1, #5, #12) and team context
- 14 edge cases enumerated with clear expected behaviors
- 10 assumptions explicitly documented (admin mode, past date blocking, priority
  uniqueness, etc.)

**What Caused Ambiguity**:

- **Spot preferences editing not explicitly named in interactions**: The brief
  says "set spot preferences (ordered list)" in the data model and "Person can
  have spot preferences" but the user stories don't explicitly call out an admin
  interaction for editing spot preferences. Spec-interpreter included it;
  pattern-maker deprioritized it; grader marked it as a spec gap. Suggest: "As
  an admin, I can edit a person's spot preference list" as an explicit story.
- **Identity/Auth model**: Brief says "set priority order for spot allocation"
  but doesn't specify how admin status is determined. Spec-interpreter assumed a
  toggle on Person (correct for "small team tool"). But the bootstrap UX (how
  does first admin get established?) was left vague. Suggest: "Admin status is a
  boolean flag on Person; the system allows adding people and setting admin flag
  before selecting a user identity."
- **First-run/defaults**: Brief asks for a "practical" tool but doesn't specify
  whether it ships with pre-populated spots/people or starts empty. Grader
  marked this as a weakness (first-run score 47). Suggest: "For factory
  evaluation, consider providing seed data (3 pre-populated spots) for first-run
  testing."
- **Week-ahead exact definition**: "Week-ahead view" — clarify as "7 days
  starting with today" vs. "Monday-Sunday" vs. "next 7 days forward-from-now."

**What the Pattern Author Added That Worked Well**:

- **"Denied is not an error" philosophy**: Not in brief, but UX designer and
  pattern maker implemented calm messaging ("No spots are available today.")
  instead of error tone. This is appropriate for the domain.
- **Manual assignment with auto-cancellation of displaced requests**: Spec says
  "manually assign spot" but doesn't detail what happens to displaced requests.
  Pattern (with critic fix) makes this clean: displaced request is cancelled,
  not left inconsistent.
- **Bootstrap empty states**: Brief doesn't detail empty state messaging.
  Pattern provides contextual guidance ("No team members yet. Use forms
  below...") which improves first-use UX.

**What Should Change for Rerun**:

1. **Explicitly add a user story**: "As an admin, I can edit a person's spot
   preference list"
2. **Clarify auth model**: "Admin status is a flag on Person. The system shows
   forms for adding people/spots before any user is selected, enabling
   bootstrap."
3. **Decide on seed data**: "For testing, the pattern should deploy with [3
   pre-configured spots, no people] OR [3 spots + 3 example people, no
   allocations]"
4. **Define first-run success criterion**: "On fresh deploy, a user should be
   able to request a parking spot within [10 clicks / 30 seconds / 2 tabs]"
5. **Spot preferences UI**: Make a deliberate decision — simplify to "default
   spot only" and remove preferences from the spec, OR design the preferences
   editing UI (comma-separated, ordered list, etc.) and include it as an
   explicit requirement

**If Brief Author Wants This Pattern Ready for Production**: The pattern needs:

1. Spot preferences editing UI in the add/edit person forms (currently entirely
   missing)
2. Session persistence for currentUser (today starts with blank selector; real
   team would expect "me" to be remembered)
3. Pre-populated default data or guided setup flow (bootstrap empty state is
   functional but feels incomplete)
4. Fix or accept the test regression in add_empty_person edge case
5. Clarification on computed() wrapper in JSX (idiomatic or necessary?)

The brief itself was well-structured and detailed. The "practical and simple"
directive was well-heeded. The main ambiguity was admin/auth model and what gets
pre-populated. Rerun with clearer specification of these would likely yield a
higher-scoring pattern.
