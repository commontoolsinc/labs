# Known Issues

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
