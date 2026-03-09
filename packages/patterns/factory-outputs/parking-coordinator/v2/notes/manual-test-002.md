# Manual Test 002 Working Notes — Parking Coordinator

## Session Start

- Date: 2026-02-24
- Piece ID (new deployment):
  baedreiab4xbp5mque4fuxv2ce47k5rkhbrnymksqezufb2an2ay6kuxvby
- Previous piece ID (with bugs):
  baedreiez3c5uvrmdmvdmwoevtuy75fugour7ikt6zx3ud5hty6teadlxd4
- Space: factory-test
- API URL: http://localhost:8100
- URL:
  http://localhost:8100/factory-test/baedreiab4xbp5mque4fuxv2ce47k5rkhbrnymksqezufb2an2ay6kuxvby

## Server Startup

- Servers restarted successfully with --force --port-offset=100
- Toolshed: http://localhost:8100 (UP)
- Shell: http://localhost:5273 (UP)

## Deploy

- Pattern deployed fresh from pattern/main.tsx
- Initial piece ID: baedreiab4xbp5mque4fuxv2ce47k5rkhbrnymksqezufb2an2ay6kuxvby
- Browser identity issue encountered (multiple deploy attempts)
- Final piece ID used for testing:
  baedreiasfxx2f6dpkkxzhzqwzedeqr62cqtyc5uvt6oxgmvlj7e547clti
- Browser identity key: /tmp/browser-identity.key (BIP39 mnemonic derived)

## Browser Identity Issue

The browser uses BIP39-format passphrases for key generation, while the CT tool
uses arbitrary strings. To match identities:

1. Registered fresh user in browser using "Generate Passphrase" button
2. Captured the BIP39 mnemonic displayed in the browser
3. Derived key file: deno run labs/packages/identity/mod.ts id derive
   "{mnemonic}"
4. Deployed piece with this key to match browser session identity

## Initial State Verification

- `piece get spots` returned 3 spots: #1, #5, #12 -- FIX #1 CONFIRMED
- Browser screenshot confirms 3 "Available" spots on first load

## Fix Verification Results

### Fix 1: Initial spots seeded

- CONFIRMED FIXED
- `piece get spots` shows 3 spots on fresh deployment
- Browser shows Spot #1, #5, #12 as Available on first load

### Fix 2: submitRequest message

- CONFIRMED FIXED
- Allocation success: "Allocated spot #1!" shown correctly
- Genuine denial: "Denied: no spots available for this date." shown only when
  actually denied
- Duplicate prevention: "This person already has an active request for this
  date." shown distinctly

### Fix 3: Null guards in computeds

- CONFIRMED
- No TypeErrors during `piece step` on fresh piece
- Previous test saw TypeError on every step call

### Fix 4: WeekGrid

- NOT CHANGED (no code fix applied)
- DOM accessibility tree confirms all spot rows present with correct data
- Visual CSS issue persists: rows render with zero visible height

## CLI Tests Performed

- addPerson: Alice (drive), Bob (transit), Carol (drive), Dave (drive) -- all
  PASS
- requestParking: Alice → spot-1, Bob → spot-5, Carol → spot-12, Dave → denied
  (no spots) -- all PASS
- cancelRequest: Alice cancelled via browser button -- PASS
- movePriorityUp: Bob moved to position #1 -- PASS
- editSpot: Spot #1 label/notes updated -- PASS
- addSpot: Spot #7 added -- PASS
- removeSpot (cascade): Spot #5 removed, Bob's request → denied -- PASS
- removePerson (cascade): Carol removed, her request → cancelled -- PASS

## Browser Test Results

- Total acceptance criteria: 19
- Pass: 15 (some partial)
- Fail: 2
- Partial pass: 2

Remaining issues:

- Issue 4: Admin toggle causes horizontal layout overflow (HIGH)
- Issue 5: Admin tabs visible on page load without clicking Admin (MEDIUM)
- Issue 6: Week-ahead grid rows visually invisible (HIGH)
- Issue 7: Date wrapping in My Requests (LOW)
- Issue 8: Active allocation status not labeled (LOW)
- Issue 9: Add Spot form shows previous-edit values as placeholder text (LOW)

## Report Written

- Path: workspace/2026-02-24-parking-coordinator-k21l/reviews/manual-test-002.md
