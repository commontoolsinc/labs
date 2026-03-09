# Manual Test Report: Parking Coordinator (Targeted Retest 003)

**Piece ID**: baedreiggxhe4npokyxwqe3sf5557pmrhbentuas4dejbti63pr5fwrr34i
**Space**: factory-test **API URL**: http://localhost:8100 **Date**: 2026-02-24
**Previous Report**: manual-test-002.md (piece
baedreiasfxx2f6dpkkxzhzqwzedeqr62cqtyc5uvt6oxgmvlj7e547clti)

## Purpose

Targeted retest of two specific UI fixes applied after manual-test-002:

1. **Week-ahead grid rows visually invisible** — Fix: removed
   `<div style="overflowX: auto">` wrapper around the table and added
   `tableLayout: "fixed"` to the table style.
2. **Admin toggle horizontal layout overflow** — Fix: added `overflow: hidden`
   to the header `ct-vstack`, `min-width: 0` to the header `ct-hstack`, and
   `min-width: 0; overflow: hidden` to each nav tab button.

---

## Fix Verification

### Fix 1: Week-Ahead Grid Rows Now Visible

**Status: CONFIRMED FIXED**

**What was broken**: In manual-test-002, the week-ahead grid table rendered with
only the header row visible. The tbody rows for spots #1, #5, and #12 existed in
the DOM (confirmed via accessibility tree) but had zero visible height, making
the entire grid appear empty to users.

**What the fix did**: Removed the `overflowX: auto` wrapper div around the table
(which was likely constraining the table body height) and added
`tableLayout: "fixed"` to the table style to enforce explicit column sizing.

**Verification**:

- Deployed fresh piece. Accessibility tree snapshot confirms all 3 tbody rows
  are present: `row "#1 - - - - - - -"`, `row "#5 - - - - - - -"`,
  `row "#12 - - - - - - -"`.
- Screenshot after scrolling into view shows all 3 rows (#1, #5, #12) with
  proper visible height, each displaying 7 day columns.
- The "Week Ahead" heading, column headers (Spot | Tue 2/24 | Wed 2/25 | Thu
  2/26 | Fri 2/27 | Sat 2/28 | Sun 3/1 | Mon 3/2), and all 3 data rows render
  correctly.

**Note on initial scroll position**: The table rows are below the fold on
initial load (the Today panel with 3 spots takes up significant vertical space).
Rows are visible when the user scrolls down. This is normal expected behavior
given the content height, not a bug.

---

### Fix 2: Admin Toggle No Longer Causes Layout Overflow

**Status: CONFIRMED FIXED**

**What was broken**: In manual-test-002, clicking Admin to toggle OFF after
having toggled it ON caused severe horizontal layout overflow. The left side of
the UI was clipped: "Parking Coordinator" appeared as "ing Coordinator", the
"Today" button appeared as "ay". The overflow persisted until page reload.

**What the fix did**: Added `overflow: hidden` to the header `ct-vstack`,
`min-width: 0` to the header `ct-hstack` (title row), and
`min-width: 0; overflow: hidden` to each nav tab button (Today, My Requests,
People, Spots). These constraints prevent the flex children from overflowing
when the nav collapses back to 2 tabs.

**Additional observation**: Issue 5 from manual-test-002 (admin tabs
People/Spots visible on initial load without clicking Admin) is also resolved.
On fresh page load, only Today and My Requests are visible in the nav bar.

**Verification**:

_Initial state_: Fresh page load shows clean layout — "Parking Coordinator"
title on left, "Admin" ghost button on right, nav shows only Today + My
Requests. No overflow.

_Admin ON_: Clicked Admin. Button highlights blue. Nav expands to Today | My
Requests | People | Spots. All 4 tabs fit cleanly without overflow. Title fully
visible.

_Admin OFF_: Clicked Admin again to toggle OFF. "Parking Coordinator" title
fully visible on left (no clipping). "Admin" ghost button on right. Nav returns
to Today | My Requests only. Layout clean, no text clipped, no overflow.

_Second toggle cycle_: Toggled admin ON then OFF a second time. Identical clean
result — behavior is consistent and not a one-time fix.

---

## Screenshots

- **Initial load — Today panel + Week Ahead header visible**:
  `/Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-41-090Z-nitp02.png`
- **Week Ahead — all 3 rows (#1, #5, #12) visible after scroll**:
  `/Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-25-231Z-pulweo.png`
- **Admin toggle ON — clean layout with People + Spots tabs**:
  `/Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-54-533Z-34tkx4.png`
- **Admin toggle OFF — clean layout, no overflow (first cycle)**:
  `/Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-23-06-087Z-v96ezp.png`
- **Admin toggle OFF — clean layout, no overflow (second cycle)**:
  `/Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-23-16-773Z-cwgomu.png`

---

## Issues Previously Remaining (Status Update)

| Issue                                                   | Severity | Previous Status | Current Status                                      |
| ------------------------------------------------------- | -------- | --------------- | --------------------------------------------------- |
| Issue 4: Admin toggle overflow                          | HIGH     | OPEN            | **FIXED**                                           |
| Issue 5: Admin tabs visible on load                     | MEDIUM   | OPEN            | **FIXED** (resolved as side effect of overflow fix) |
| Issue 6: Week-ahead grid invisible                      | HIGH     | OPEN            | **FIXED**                                           |
| Issue 7: Date display wraps in My Requests              | LOW      | OPEN            | Not retested (out of scope)                         |
| Issue 8: Active allocation status not labeled           | LOW      | OPEN            | Not retested (out of scope)                         |
| Issue 9: Add Spot form shows previous-edit placeholders | LOW      | OPEN            | Not retested (out of scope)                         |

---

## Summary

Both targeted UI fixes are confirmed working:

1. **Week-ahead grid fix: PASS** — All 3 spot rows (#1, #5, #12) render with
   visible height in the browser. The table with `tableLayout: "fixed"` and
   without the overflowX wrapper correctly displays all spot data rows with
   their 7 day columns.

2. **Admin toggle overflow fix: PASS** — Toggling admin mode ON then OFF no
   longer causes any horizontal layout overflow. The header correctly collapses
   from 4 nav tabs to 2 without clipping any content. Tested over two
   consecutive toggle cycles with consistent results.

**Bonus fix observed**: Issue 5 (admin tabs visible on initial load) is also
resolved — the nav bar now correctly shows only Today and My Requests on fresh
page load.

The two HIGH severity issues that were blocking acceptance (Issues 4 and 6) are
both resolved. The remaining open issues are LOW severity (Issues 7, 8, 9) which
are minor cosmetic concerns.

**Updated acceptance criteria result: 17/19 pass (up from 15/19), 0 fail, 2
partial pass (same as before for low-severity cosmetic items)**

The pattern is now ready for acceptance grading.
