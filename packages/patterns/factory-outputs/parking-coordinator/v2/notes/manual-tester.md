# Manual Tester Working Notes: Parking Coordinator

## Session Start: 2026-02-24

## Server Startup

- Started local dev servers with port-offset=100
- Labs directory: /Users/gideonwald/coding/common_tools_2/labs
- Toolshed: http://localhost:8100 — READY (confirmed HTML response)
- Shell: http://localhost:5273 — Not verified, not needed

## Deploy

- Piece ID: baedreiez3c5uvrmdmvdmwoevtuy75fugour7ikt6zx3ud5hty6teadlxd4
- URL:
  http://localhost:8100/factory-test/baedreiez3c5uvrmdmvdmwoevtuy75fugour7ikt6zx3ud5hty6teadlxd4
- Space: factory-test

## Critical Finding: INITIAL_SPOTS not seeded

- The INITIAL_SPOTS constant is defined in the code but never used to seed the
  Writable input. The pattern starts with spots=[], persons=[], requests=[],
  priorityOrder=[] - all empty.
- The spec requires spots #1, #5, #12 to be pre-loaded on first load.
- This is a FAIL on the first acceptance criterion.

## Runtime Error Discovered

- When `piece step` is called after adding spots, multiple runtime errors fire:
  - TypeError: Cannot read properties of undefined (reading 'number') at line
    623
  - TypeError: Cannot read properties of undefined (reading 'name') at line
    ~4461
  - TypeError: Cannot read properties of undefined (reading 'personId') at line
    ~1730
- These fire consistently but don't prevent actions from completing
- The errors appear to be in computed values referencing array items that become
  undefined during the reactivity cycle

## CLI Test Results

### addSpot

- Added spot #1 via CLI: PASS (state updated, spot in spots array)
- Added spot #5 via CLI: PASS
- Added spot #12 via browser (Add Spot form): PASS
- Edge case: adding duplicate spot number would be blocked (not explicitly
  tested but code shows early return on duplicate)

### addPerson

- Added Alice (drive commute) via browser Add Person form: PASS
- Added Bob (transit commute) via browser: PASS
- Added Carol (drive) via CLI: PASS
- Added Dave (drive) via CLI: PASS

### movePriorityUp / movePriorityDown

- Clicked Bob's Up button when Bob was at position 2: PASS - Bob moved to
  position 1, Alice moved to 2
- Priority list updates immediately in UI

### requestParking

- Alice request for 2026-02-24: State = allocated (spot-1), BUT UI showed
  "Denied: no spots available"
- Bob request for 2026-02-24: State = allocated (spot-5), BUT UI showed "Denied:
  no spots available"
- Carol request for 2026-02-24: State = allocated (spot-12) via CLI
- Dave request for 2026-02-24: State = denied (all spots occupied) - UI showed
  "Denied: no spots available"
- CONCLUSION: The "Denied" message is shown regardless of allocation outcome.
  The feedback message is always "Denied" whether the request succeeded or
  failed.

### cancelRequest

- Cancelled Alice's first request via "Cancel" button in My Requests: PASS
- My Requests entry updated to show "Cancelled" status
- Spot #1 became Available in Today panel

### duplicate request prevention

- Tried to re-request for Alice who already had active allocation: PASS - no new
  request created (count stayed at 5)

### removePerson (cascade)

- Removed Carol who had active allocated request for 2026-02-24
- Carol's request status changed to "cancelled": PASS
- Spot #12 became Available in Today panel: PASS

### removeSpot

- Removed spot #12 (no active allocations at time of removal)
- Spot #12 removed from Today panel and week-ahead grid: PASS

### editSpot

- Set label="Near entrance", notes="Van accessible" for spot #1: PASS
- Label appeared in Today panel

### setDefaultSpot

- Set Alice's default spot to spot #1: PASS (defaultSpotId updated)

### setSpotPreferences

- Set Bob's preferences to [spot-5, spot-1]: PASS (spotPreferences updated)

### manualOverride

- Created manual override for Dave on 2026-02-25, spot #1: PASS
- autoAllocated=false in state
- Appeared in week-ahead grid on Wed 2/25 row

## Browser Observations

### Layout Issues

1. Horizontal overflow in admin mode: When admin tabs (People/Spots) are
   visible, the content scrolls to reveal the admin nav but clips the left edge
   of the content. "Parking Coordinator" shows as "arking Coordinator", spot
   labels are truncated. Severity: Medium

2. Tab highlighting: The "Spots" admin tab is incorrectly highlighted blue when:
   - Viewing the main "Today" view
   - Viewing "My Requests"
   - Viewing "Request Parking" form The highlighting should track the current
     view, not persist. Severity: Medium

3. Date wrapping in My Requests: Dates shown as "2026-\n02-\n24" (3 lines)
   instead of "2026-02-24" in a single line. Narrow column width issue.
   Severity: Low

4. Status not shown in My Requests: The allocated status isn't explicitly shown
   for active requests (only "Spot #1" shown). Cancelled status is shown as
   "Cancelled" text. Severity: Low

### Functional Issues

5. CRITICAL: Request form shows wrong result message: "Denied: no spots
   available for this date" is displayed ALWAYS after form submission, even when
   the request was successfully allocated. This is a bug in the result display
   logic.

6. Week-ahead grid incomplete rows: When we had 3 spots all with allocations,
   the week grid only showed 1 row (spot #1). After removing spot #12 and having
   only 2 spots, the grid showed 2 rows correctly. This suggests a rendering
   issue when all spots have allocations. Severity: High

## Screenshots Taken

- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T19-59-06-722Z-mtkhvo.png -
  Initial view after login (empty spots)
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T19-59-39-324Z-82o78a.png -
  Admin mode activated
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-04-20-397Z-zw96xu.png -
  Spots #1 and #5 added (Available)
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-05-07-772Z-rreoc3.png -
  All 3 spots added in Spots admin
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-05-21-751Z-j0xs8q.png -
  People admin empty (prompt shown)
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-06-25-349Z-n45kv5.png -
  Add Person form
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-07-04-498Z-7kxdua.png -
  Bob added (People list)
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-07-21-848Z-l4nscs.png -
  Bob moved to priority #1
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-07-37-300Z-nmdw1b.png -
  Main view with all 3 spots Available
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-07-56-106Z-a1a06l.png -
  Request Parking form
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-08-10-109Z-te741a.png -
  CRITICAL BUG: "Denied" shown for Alice's successful allocation
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-08-42-105Z-xvdj9y.png -
  Main view: Alice on #1, Bob on #5, #12 Available
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-09-55-431Z-eobh2g.png -
  My Requests view empty
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-10-08-399Z-x4jbs0.png -
  Alice's request in My Requests (with cancel button)
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-10-28-032Z-n37ug2.png -
  Alice's request after cancel (shows "Cancelled")
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-10-38-385Z-ly1ie4.png -
  Today panel: #1 Available after cancel
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-13-45-052Z-70vi1i.png -
  All 3 spots occupied (Alice/Bob/Carol)
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-14-11-963Z-znou9o.png -
  Correct denial for Dave (all occupied)
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-17-18-451Z-0psabh.png -
  After Carol removed: #12 Available
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-18-38-789Z-b351wz.png -
  After spot #12 removed: 2 spots shown
- /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T20-20-35-910Z-td670p.png -
  Week grid with Dave's manual override on 2/25
