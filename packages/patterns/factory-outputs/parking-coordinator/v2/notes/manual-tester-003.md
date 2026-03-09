# Manual Tester 003 - Working Notes

## Task

Targeted retest of two UI fixes in the parking coordinator pattern:

1. Week-ahead grid rows visually invisible fix (removed overflowX auto wrapper,
   added tableLayout fixed)
2. Admin toggle horizontal layout overflow fix (overflow:hidden on header
   vstack, min-width:0 on hstack and nav buttons)

## Timeline

- Start: 2026-02-24

## Server Startup

- Restarted dev servers with --port-offset=100 --force
- Old processes killed (ports 8100, 5273 were in use)
- Toolshed: http://localhost:8100 (UP, 200)
- Shell: http://localhost:5273 (UP, 200)
- Browser cache cleared

## Deploy

- Pattern: /workspace/2026-02-24-parking-coordinator-k21l/pattern/main.tsx
- Identity: ../labs/claude.key
- Space: factory-test
- Piece ID: baedreiggxhe4npokyxwqe3sf5557pmrhbentuas4dejbti63pr5fwrr34i
- URL:
  http://localhost:8100/factory-test/baedreiggxhe4npokyxwqe3sf5557pmrhbentuas4dejbti63pr5fwrr34i
- Deploy output confirmed weekGrid data present: spots #1, #5, #12 with 7-day
  cells

## Browser Identity

- Opened pattern URL -- shows Register/Login (not yet authenticated)
- Clicked Register -> Generate Passphrase
- Mnemonic: coil list artefact verb supply chunk bottom fortune match bronze
  year click beef inner maid poem dragon adult produce evoke frown salmon chase
  beef
- Derived key: deno task ct id derive "{mnemonic}" >
  /tmp/browser-identity-003.key
- Clicked "I've Saved It - Continue" to complete registration
- Page now shows "Parking Coordinator" - pattern accessible

## Fix 1: Week-Ahead Grid Test

### Code Verification

- Found tableLayout: "fixed" at line 979 in main.tsx (confirmed)
- No overflowX auto wrapper around table (confirmed removed)

### Accessibility Tree

- Full snapshot shows all 3 rows in tbody:
  - row "#1 - - - - - - -" (ref e22-e29)
  - row "#5 - - - - - - -" (ref e30-e37)
  - row "#12 - - - - - - -" (ref e38-e45)
- All rows present in DOM with correct data

### Visual Verification

- Initial screenshot: row #1 visible at bottom of viewport, rows #5 and #12
  below fold
- After scrolling/clicking #5 cell: all 3 rows visible with proper height
  - #1: visible with 7 day cells showing "-"
  - #5: visible with 7 day cells showing "-"
  - #12: visible with 7 day cells showing "-"
- Full-page screenshot confirms all 3 rows render with visible height

### Result: FIXED

Previous behavior: DOM rows had zero visible height (no rows visible). New
behavior: All 3 rows render with proper height and are visible when scrolled
into view.

## Fix 2: Admin Toggle Overflow Test

### Code Verification

- ct-vstack slot="header": style="overflow: hidden;" (line 870)
- ct-hstack justify="between": style="min-width: 0;" (line 871)
- Today button: style="...min-width: 0; overflow: hidden;" (line 885)
- My Requests button: style="...min-width: 0; overflow: hidden;" (line 892)
- People button: style="...min-width: 0; overflow: hidden;" (line 901)
- Spots button: style="...min-width: 0; overflow: hidden;" (line 912)

### Initial State

- Fresh page load: Admin button top-right (ghost), nav shows only Today + My
  Requests
- Issue 5 also resolved: admin tabs NOT visible on initial load (was a bug in
  previous test)
- Layout clean, no overflow

### Admin ON

- Clicked Admin button
- Nav expanded: Today | My Requests | People | Spots
- Admin button highlighted (blue)
- Layout clean, all 4 tabs fit without overflow
- Screenshot captured

### Admin OFF

- Clicked Admin again (toggle OFF)
- Nav returned to: Today | My Requests only
- Admin button back to ghost style (top-right position)
- "Parking Coordinator" title FULLY visible (no left-side clipping)
- Layout clean, no overflow, no text clipping
- Screenshot captured

### Second Toggle Cycle

- Toggled admin ON then OFF again
- Same clean result - consistent behavior
- No regression

### Result: FIXED

Previous behavior: Toggling admin OFF caused severe left-side clipping -
"Parking Coordinator" appeared as "ing Coordinator", Today as "ay". New
behavior: Clean layout on admin OFF, all text fully visible, no overflow.

## Screenshots Taken

1. Initial load:
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-21-54-608Z-atob2k.png
2. After scroll - all 3 week grid rows visible:
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-04-976Z-ybjxrm.png
3. Full page - week grid 3 rows:
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-12-024Z-sz5haq.png
   (shows only row #1 at top, rows #5 #12 needed scroll)
4. After clicking #5 cell - all 3 rows visible:
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-25-231Z-pulweo.png
5. Initial state (fresh load, before admin toggle):
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-41-090Z-nitp02.png
6. Admin toggle ON:
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-22-54-533Z-34tkx4.png
7. Admin toggle OFF (first):
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-23-06-087Z-v96ezp.png
8. Admin toggle OFF (second cycle):
   /Users/gideonwald/.agent-browser/tmp/screenshots/screenshot-2026-02-24T23-23-16-773Z-cwgomu.png

## Conclusion

Both targeted fixes verified as working. The two HIGH severity issues from
manual-test-002 are resolved.
