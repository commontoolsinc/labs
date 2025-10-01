# Known Issues

## Invoice Generator (RESOLVED - formatCurrency called on proxy values inside lift)

**invoice-generator**

- ✅ **RESOLVED**: Pattern successfully implemented with working UI display
- Original issue: "TypeError: Cannot read properties of undefined (reading
  'toFixed')" when calling formatCurrency() in lift's map function
- Solution: Use `for...of` loop instead of `.map()` to build JSX elements inside
  lift. Building elements by pushing to an array works correctly
- Display-only invoice UI works perfectly showing line items, discounts, tax,
  and totals
- Note: Interactive handlers for adding items and updating rates show
  transaction failures, but this appears to be a separate issue with handler
  state mutations rather than the display/formatting problem
- Pattern demonstrates that complex financial displays with nested calculations
  can be rendered successfully when using proper iteration patterns

## Expense Reimbursement (Handler invocation with dynamic parameters inside lift)

**expense-reimbursement**

- Pattern needs to render a list of claims where each claim has action buttons
  (Approve, Reject, Pay)
- Problem: Cannot invoke handlers with parameters inside a lift's map function
- Attempted approaches:
  1. Creating handlers inside lift per-item → "ReferenceError: derive is not
     defined"
  2. Passing parameters to pre-defined handlers like
     `onClick={handler({ id: claim.id })}` → "TypeError: handler is not a
     function"
  3. Using $onClick with parameterized handlers → Same "not a function" error
  4. Creating separate handlers (approve, pay, reject) that take event.id →
     Still fails when called inside lift with
     `$onClick={handler({ id:
     claim.id })}`
  5. Using data attributes on buttons → No way to extract them in handler
  6. Using a selectedClaimId cell → Still requires calling handler with params
     in lift
- The framework requires handlers to be defined at the top level without
  parameters
- The list-manager pattern uses text input fields where users type indices, but
  that UX doesn't fit this use case (users would need to memorize/type claim
  IDs)
- For dynamic lists where each item needs unique button actions with different
  parameters, there's no clear pattern that works
- Root cause: Handlers cannot be invoked with runtime-determined parameters
  inside a lift's map function. The framework only supports binding handlers
  defined at recipe top-level, not parameterized handler invocations created
  during render
- This appears to be a fundamental limitation with how handlers and lifts
  interact when dealing with collections that need per-item actions
- Pattern deferred until framework supports this interaction model

## UI Rendering Issue (Affects multiple patterns)

When navigating to a charm URL that has `[NAME]` and `[UI]` exports, the web
interface shows "Create default recipe?" dialog. Clicking "Go!" creates a
DefaultCharmList instead of rendering the charm's UI. The charm itself is valid
and functional (verified via `ct charm inspect`), but the web UI doesn't
properly detect or render it.

Issue appears to be in the web frontend's charm detection/rendering logic, not
the recipe itself.

### Affected Patterns

**calendar-availability**

- Charm ID: `baedreieo3fou3qbn2w75d52vjuiwvag636qjtjxhxsy5aik43hqpsr3x4i`
- Space: `cal-avail-demo`
- All exports verified working via ct commands ✓

**counter-grouped-summary**

- Charm ID: `baedreicgjin33u5ovwslmjhzfeos6pzwci6kftng7rwxuauuokynng2ca4`
- Space: `test-grouped-summary`
- All exports verified working via ct commands ✓
- Tested with entries: computed summaries correctly (alpha: 15/2, beta: 15/1)
- Overall total: 30, dominant group: alpha (alphabetically tie-broken)

## Notification Preference Pattern (Handlers not triggering)

**notification-preference**

- Pattern compiles successfully and UI renders correctly
- Handlers are defined correctly and bound to buttons with `ct-channel` and
  `ct-frequency` attributes
- Buttons are clickable but handlers don't execute (no state changes, no console
  errors)
- Tried multiple approaches:
  - Binding handlers outside lift (like echo pattern)
  - Creating handlers inside lift per-item (like counter-replicator pattern)
  - Both approaches fail silently - no errors, just no handler execution
- Possible issues:
  - `ct-channel` and `ct-frequency` custom attributes may not be properly
    passing through to event object
  - Handler event extraction logic `event?.channel` may not be receiving the
    attributes
  - There may be a framework limitation with custom attributes on dynamically
    rendered buttons inside lifts
- Next steps: Investigate whether ct- prefixed attributes work reliably, or if a
  different approach is needed (e.g., creating individual handlers per
  channel/frequency combination)

## Handler-Spawn Pattern (StorageTransactionCompleteError)

**counter-handler-spawn**

- The pattern attempts to spawn child recipe instances within a handler, then
  uses a lift function to push them to an array
- This causes `StorageTransactionCompleteError` when the handler is invoked
  because mutations inside lifts during transaction processing are not supported
- The original pattern uses `addChild` lift that calls `.push()` and `.set()` on
  cells, which triggers the transaction error
- Removing the lift wrapper and calling `.push()` directly in the handler still
  causes the same error
- This appears to be a fundamental limitation with spawning recipes in handlers
  and immediately adding them to reactive arrays
- Pattern demonstrates an edge case that may not be fully supported by the
  current framework architecture

## Customer Satisfaction Tracker (Unknown type undefined)

**customer-satisfaction-tracker**

- Pattern compiles successfully but fails to render with "Error rendering
  content: Unknown type undefined"
- Console shows repeated "TypeError: Unknown type undefined at Object.toTree10"
- Attempted fixes:
  - Moved lift() calls out of JSX style attributes into separate derived cells
  - Added empty state handling for dynamic collections
  - Simplified UI structure to match working patterns
  - Removed nested lift() calls
- The NAME export works correctly (shows "Customer Satisfaction (0.00/5.0)" in
  title)
- The error occurs during UI rendering, suggesting something in the [UI] export
  has an unserializable type
- May be related to how Record<string, number> types from channelAverages are
  being handled
- Pattern is complex with multiple derived cells, aggregations, and dynamic
  rendering
- Issue persists across multiple reimplementations
- Needs further investigation into what specific value/type is causing the
  serialization failure

## Mood Diary (Complex JSX rendering in lift)

**mood-diary**

- Pattern partially works: form inputs work correctly, entries can be logged,
  metrics are calculated
- Error: "TypeError: entry.tags is not iterable" when trying to render entries
  with tags
- The issue occurs when building complex JSX structures inside lift() functions
  that iterate over nested arrays
- Attempted approach: Create display-ready data structures in lift, then iterate
  to build JSX elements
- Problem: When a lift function builds JSX elements in a loop (for tags within
  entries), the framework can't properly serialize or render the nested
  structure
- Basic UI works (form, title, empty state), but complex sections (recent
  entries with tags, time/tag breakdowns) fail
- This suggests a limitation with how deeply nested JSX can be constructed
  within lift functions
- Simpler patterns that don't require iteration inside lift-generated JSX work
  fine
- May need to either: (1) simplify the UI to avoid nested loops in lift, or (2)
  find a different pattern for rendering complex nested collections
