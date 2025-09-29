# Patterns with UX learnings

Add short notes after each run so the next agent can build on proven approaches.

- Don't use `{ proxy: true }` when defining handles. Instead define `Cell<...>`
  in context schema for values you want to change and call `.set()`, `.push()`
  and `.get()` on those cells. It's ok that the call site has a type of
  `OpaqueRef` and the handler expects `Cell`, the framework will handle that
  conversion for you.
- Don't use `toSchema<>` when defining lifts, instead use
  `lift<ArgumentType, ResultType>((arg) => { ...})`.
- Don't write `onClick={() => ...}` etc., instead create a handler with
  `handler` and call it with the state bindings in needs, i.e.
  `onClick={myHandler({ foo, bar })}`.
- Reach for `cell()` when the UI needs its own form state; ct components wired
  with `$value={cell}` stay reactive, and you can sanitize user input with
  `lift` before feeding it back into shared derives.
- When you need to mirror numeric state into text inputs, sync the UI cell with
  a `compute` effect instead of calling `.get()` during recipe creation; this
  keeps the harness happy while still updating the field after sanitizer
  handlers run.
- If a compute should run only on demand, wrap it in a handler and keep the UI
  focused on sanitized derives. That lets the interface show queued work without
  draining it accidentally.
- Plain closures on `ct-button` often skip the harness, so wrap even simple
  interactions in `handler` helpers and pass the cells they mutate; this keeps
  schema generation happy and ensures state updates flow through results.
- When wrapping business handlers for the UI, re-express the effect inside a new
  `handler` that takes the same cells instead of closing over the original
  callable; otherwise runtime errors like `TypeError: resize is not a function`
  can pop up once Playwright exercises the controls.
- When recreating mutations that append to history, update both the primary cell
  and its companion collection (e.g. call `history.push(next)`) so derived
  boundaries stay in sync; deriving from a sanitized view alone won't write the
  new entry back.
- `lift` hands you the underlying values, not the `Cell`, so if you need both
  min/max/value at once pass them as an object and sanitize inside the mapper
  instead of expecting `.get()` on the inputs.
- `ct-slider` works well once you bind `$value` to the derived number and adapt
  its `ct-change` event through a dedicated handler; the slider's keyboard
  controls are reliable for Playwright while buttons cover the rest of the
  interactions.
- If you need to reuse a business handler's logic inside new UI actions, factor
  the shared state mutation into a plain helper (e.g. `applyIncrementToState`)
  and call that from both places; invoking the original handler factory from
  another handler still surfaces `TypeError: ... is not a function` at runtime.
- Avoid using boolean expressions like `{childCount > 0 && <Button />}` directly
  in JSX when `childCount` is a `Cell` - this will render "false" when the
  condition fails. Instead, use `lift` with a derived boolean, then
  conditionally hide elements with
  `style={lift((show) => show ? "display: block;" : "display:
  none;")(derivedBool)}`
  or return `null` from the lift function.
- When dynamically creating child recipes in a `lift`, remember that each
  invocation recreates all children from scratch with their initial values - any
  runtime state changes (like incremented counters) will be lost when the parent
  configuration changes. This is expected behavior for parameterized patterns.
- The `disabled` attribute on `ct-button` works well with derived boolean cells
  to prevent invalid operations (e.g., incrementing past max, decrementing below
  min). Use `lift` to compute boundary conditions and bind them directly to the
  `disabled` prop.
- Visual progress indicators (like progress bars) can be driven entirely by
  `lift` functions that compute percentages from the current value relative to
  min/max boundaries. Use inline styles with lift for dynamic width/positioning.
- When handlers need to enforce boundaries, perform the clamping logic directly
  in the handler using `Math.min`/`Math.max` with values from `.get()` on the
  boundary cells to ensure the value never escapes the valid range.
- For patterns demonstrating nested derive chains, visualize the data flow with
  a simple arrow diagram (`value → current → magnitude → parity → ...`) to help
  users understand the reactive propagation; this pairs well with color-coded
  cards showing each derived layer's current output.
- When `compute` effects sync UI fields to match derived state, they should only
  update the field when its value differs from the derived value to avoid
  unnecessary re-renders.
- For dynamic styles that depend on multiple derived cells, extract the style
  computation into separate `lift` calls that return style strings, then bind
  those derived style cells directly to JSX `style` attributes. This keeps the
  JSX clean and ensures proper reactive updates.
- When rendering collections like audit trails, use `lift` to map over the array
  and return JSX elements. Use `.slice().reverse()` if you need to show newest
  entries first. Remember to include a `key` prop for each mapped item to help
  with rendering performance.
- For validation UIs that show error/success states, use separate `lift` calls
  to compute dynamic styles (borders, backgrounds, text colors) based on
  validation state, then interpolate those lifted style strings into inline
  styles. This creates clear visual feedback that updates reactively.

## Guidelines for UI code

- Drive the UI from sanitized derives; never tap raw event payloads in JSX.
- Prefer ct primitives (`ct-button`, `ct-input`, `ct-card`, etc.) for consistent
  styling and accessibility.
- Keep layouts responsive with flex or stack containers; avoid hard coded pixel
  widths unless a component demands it.

- For conditional branch patterns, use `lift` to compute the branch state string
  (e.g., "Enabled" vs "Disabled") directly from the boolean cell rather than
  using `ifElse` to return objects that need additional lifting. This simplifies
  the derive chain.
- Dynamic styling based on boolean state works well with `lift` functions that
  return complete style strings, including gradients and transitions. Binding
  these directly to JSX `style` attributes provides smooth visual feedback.
- The `disabled` attribute on buttons can be bound to inverted boolean derives
  (e.g., `lift((isActive: boolean) => !isActive)(active)`) to prevent actions
  when conditions aren't met.
- Status indicators with dynamic icons (like colored dots) can be implemented
  with inline `span` elements whose styles are controlled by lifted functions,
  creating clear visual state without external assets.

## Playwright + MCP tips

- Capture screenshots at meaningful checkpoints and note any visual quirks in
  this file.
- Use `page.locator` with semantic selectors (data attributes, ids) rather than
  styling hooks.
- Wait on explicit UI signals (text, aria attributes) instead of arbitrary
  sleeps whenever possible.
- After navigating to a charm URL, wait 2 seconds before taking snapshots to
  allow the UI to fully render and become interactive.

## Advanced patterns

- When you need per-item actions in a list rendered by `lift`, you cannot create
  handlers dynamically inside the lift function (they need CTS context).
  Instead, create a centralized control section where users input an identifier
  (like an asset ID) and then have separate handlers at the recipe level that
  read from that input cell. This keeps handlers in the recipe scope while still
  allowing item-specific actions.
- The `ct-value` attribute doesn't appear to be a supported pattern in the
  framework - avoid using it. Instead, use cells to capture user input and have
  handlers read from those cells.
- When rendering collections with `lift`, keep the JSX simple - display data
  only, and avoid conditional rendering with boolean expressions like
  `{condition && <Component />}` as the false value renders as text. Use ternary
  operators with `null` instead: `{condition ? <Component /> : null}`.
- For patterns that track transitions or history, make sure to update both the
  primary state cell and the history cell within the same handler to keep
  derived boundaries in sync.
- When combining multiple derived cells into a single style string, pass them as
  an object to a single `lift` function rather than calling `.get()` inside the
  lift - this keeps everything reactive and avoids runtime errors about
  undefined values.
- For conditional UI elements (like showing/hiding based on state), compute the
  complete style string including the visibility toggle in a single `lift` that
  takes all dependencies as an object parameter - this ensures proper reactive
  updates when any dependency changes.
- When rendering lists with `lift`, use `.map()` to create JSX elements for each
  item. Remember to include a `key` attribute on each mapped element for proper
  rendering. For empty states, return a placeholder message element from the
  lift function.
- Progress bars and percentage displays work well with `lift` functions that
  compute ratios from multiple cells passed as an object parameter. Bind the
  resulting style string to the progress bar's inner element for smooth animated
  transitions.
- For patterns tracking audit data or statistics with multiple fields, define an
  interface for the audit record structure and use `lift` to safely access and
  format those fields for display. This keeps the UI robust against undefined
  values.
- Avoid using template literals with `${}` syntax directly in JSX style
  attributes inside `lift` functions. Instead, compute the dynamic values as
  variables first, then concatenate them with strings using `+`. This prevents
  `ReferenceError: style is not defined` errors during recipe compilation.
- When rendering collections with `.map()` inside a `lift`, compute all dynamic
  style values (colors, widths, etc.) as plain variables before the JSX return
  statement. This keeps the JSX clean and avoids scope issues with template
  literals.
- For budget/allocation patterns with multiple categories, using a grid layout
  with `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))` creates a
  responsive card layout that adapts to different screen sizes.
- Visual indicators for variance (positive/negative deltas from targets) work
  well with conditional color logic computed before the JSX. Use distinct colors
  for negative (red), positive (green), and neutral (gray) variances.
- History/action logs displayed in reverse chronological order
  (`.slice().reverse()`) provide better UX, showing the most recent action
  first. Limit history length in the handler (e.g., keep last 6 entries) to
  prevent unbounded growth.
- When working with conditional child instantiation patterns, avoid calling
  `.set()` on cells inside `lift` functions - lifts are for deriving values, not
  side effects. If you need to track metadata about child creation (like seed
  values), handle it in handlers or compute effects rather than trying to mutate
  state within lifts.
- For patterns that dynamically create/destroy child recipes, focus the UI on
  showing the lifecycle state (present/absent) rather than trying to reactively
  read derived values from child recipe instances. Child recipe outputs are best
  accessed through their exposed schema rather than by trying to peek into their
  internal derived state from the parent's lift functions.
- When implementing `ifElse` patterns in the UI, you can simplify the derive
  chain by using `lift` to extract individual properties from the branched
  object rather than passing through the entire `ifElse` result. This makes it
  easier to bind specific values (header, description, variant) to different UI
  elements while maintaining reactivity.
- Conditional visibility in `ifElse` patterns works cleanly with `lift`
  functions that return complete style strings including `display: flex;` or
  `display: none;` based on the boolean state. This provides smooth UI
  transitions between different branch states.
- The `ifElse` primitive creates distinct object trees for each branch, making
  it ideal for patterns where the UI should completely switch between two
  different states rather than just changing individual properties. Each branch
  can have its own complete set of properties (header, variant, description,
  etc.).
- When rendering complex nested structures (like groups containing arrays of
  entries) inside a `lift`, compute all dynamic values as plain variables BEFORE
  the JSX return statement. This prevents "Can't read value during recipe
  creation" errors. Use string concatenation with `+` instead of template
  literals, and call `String()` on numeric values before interpolation.
- For patterns with deeply nested data structures rendered via `lift`, extract
  inner collections into separate mapping operations with their own variable
  assignments. Build the JSX from the inside out, storing intermediate results
  (like `entryElements`) before composing the outer structure.
- When a `lift` renders an empty state vs. actual data, check both null/
  undefined and array length before attempting to map. Use
  `if (!form ||
  !Array.isArray(form.groups) || form.groups.length === 0)` for
  robust empty state detection.
- When a `lift` needs to both transform data and render JSX, compute all
  transformation logic (like mapping array values into objects with computed
  properties) directly within the lift function rather than creating a separate
  intermediate derived cell. This simplifies the derive chain and avoids type
  mismatches when passing complex structures between lifts.
- For checksum or hash computation patterns displayed in the UI, showing a
  breakdown of the computation steps (value → normalized → weighted →
  contribution) helps users understand the algorithm. Use monospace fonts for
  numeric values and hex representations to maintain visual alignment.
- When creating audit logs that track which source triggered a change (e.g.,
  "primary" vs "secondary"), use descriptive helper functions like
  `formatSource()` to convert internal enums into user-friendly labels. This
  keeps the JSX clean and improves readability.
- For patterns showing mathematical relationships (like difference = primary −
  secondary), include a formula display section that shows the computation with
  current values interpolated. This helps users understand the derive logic at a
  glance.
- When rendering audit cards with conditional styling (positive/negative
  badges), compute color values as plain variables before the JSX to avoid
  template literal scope issues. Use string concatenation to build inline styles
  rather than template literals inside JSX attributes within `lift` functions.
- Side-by-side layouts for dual counter patterns work well with CSS Grid's
  two-column layout. Use colored borders (e.g., blue for primary, pink for
  secondary) to visually distinguish the controls while maintaining symmetry.
- When you need multiple buttons that call the same handler with different
  parameters, create separate handler functions for each button rather than
  trying to use inline functions or event attributes. Each handler should be
  defined at the recipe level with `handler()` and then invoked with the
  necessary cells in context.
- For patterns with preset configuration options (like step sizes 1, 5, 10, 25,
  100), individual handlers for each preset provide the clearest, most
  maintainable approach. While this creates more handler definitions, it avoids
  runtime complexity and keeps the JSX simple with straightforward `onClick`
  bindings.
- When handlers update both a primary cell and a UI input field (like syncing
  step size to the custom input), both updates should happen in the same handler
  to maintain consistency. This prevents drift between the actual state and
  what's shown in input fields.
- For hierarchical defaults patterns, keep the UI display-only to show how
  settings resolve through multiple levels. Avoid trying to create editable
  configuration UIs that mutate `Default<T>` typed cells, as the framework's
  default resolution happens via `lift` and isn't designed for runtime mutation
  of partial settings objects.
- When interpolating cells inside JSX within `lift` functions, you cannot
  reference cells directly in the JSX - they render as JSON strings. Instead,
  pass cells as parameters to the lift and extract their values as function
  arguments. Simple direct cell interpolation like `{myCell}` works fine in
  top-level JSX outside of lifts.
- When passing multiple derived cells to a `lift` function, wrap them in an
  object parameter (e.g.,
  `{ blocked: blockedAttempts, applied: appliedAttempts
  }`) rather than
  passing them as separate positional arguments. This avoids "undefined" values
  appearing in the UI and ensures all dependencies are properly tracked.
- For patterns that track attempt history (successful vs. blocked operations),
  use color-coded visual feedback: green backgrounds for successful operations,
  red backgrounds for blocked ones. This makes the pattern's behavior
  immediately clear to users.
- For enumeration state patterns with a fixed sequence of states, use a progress
  indicator (percentage and progress bar) to visualize how far along the state
  machine has progressed. Combine this with color-coded state indicators that
  change based on the current state (e.g., gray for idle, green for running,
  orange for paused, purple for complete).
- When displaying transition history with different transition types (advance,
  retreat, reset, tick), use color-coded badges to distinguish each type
  visually. This helps users quickly scan the history and understand the flow of
  state changes.
- State enumeration patterns benefit from showing both the current state name
  and its position in the sequence (e.g., "RUNNING (1/3)") to give users a clear
  sense of progress through the lifecycle.
- When rendering collections inside `lift` functions, define the lift before the
  return statement rather than inline in JSX. This avoids "ReferenceError: X is
  not defined" errors during recipe compilation. Compute all dynamic styles and
  content as variables before the JSX, then return the complete component tree.
- For patterns with fixed catalogs (like time slots), display-only UIs work well
  when interactive controls aren't required. Use color-coded visual states
  (green for available, red for blocked, gray for unavailable) to clearly
  communicate status without requiring user interaction.
- When a pattern needs per-item handlers for a fixed list, consider whether the
  UI truly needs direct manipulation or can be display-only. For many scheduling
  and availability patterns, showing computed state visually is sufficient, with
  programmatic control available via the exported handlers.
- For patterns that render dynamic collections with conditional styling based on
  filter criteria, compute all style values (colors, borders, backgrounds) as
  plain string variables before the JSX to avoid template literal scope issues.
  Use string concatenation with `+` to build inline styles rather than template
  literals.
- Grid layouts with `grid-template-columns: repeat(auto-fill, minmax(Npx, 1fr))`
  work well for displaying collections of items that should wrap responsively.
  This is particularly effective for filtered collections where the number of
  items changes dynamically.
- When implementing filter/projection patterns, use distinct visual treatments
  for included (green with solid borders) vs excluded (red with faded opacity)
  items to make the filtering behavior immediately clear. Color-coded section
  headers with indicator dots reinforce the visual distinction.
- Empty state messages for filtered collections should be contextual: show "No
  counters added yet" when the source is empty, "No values meet the threshold"
  when the included filter is empty, and "All values meet the threshold" when
  the excluded filter is empty. This helps users understand why sections are
  empty.
- For grouped summary patterns displaying aggregations, a three-column stats
  layout (Total, Count, Average) within each group card provides a complete
  picture of the data. Computing the average as `total / count` and formatting
  it consistently with the total helps users compare groups.
- Grid layouts with
  `grid-template-columns: repeat(auto-fill, minmax(280px,
  1fr))` work well for
  group summary cards, allowing them to reflow responsively while maintaining
  readable card widths for the stat displays.
- When rendering entry lists with group associations, displaying both the group
  name and value side-by-side helps users quickly scan which entries belong to
  which group. A simple flex layout with space-between keeps the value visually
  prominent on the right.
- For patterns with "dominant" or "winning" group calculations, showing both the
  group name and its total value in the display (e.g., "alpha (15)") provides
  context for why it's dominant, especially in tie scenarios.
- When creating dynamic handler lists where handlers are generated per-item in a
  collection, pass the cells directly (not derived values) to the handler
  factory within the `lift` function. The framework handles Cell/OpaqueRef
  conversion automatically, so `adjustValue({ values, slotIndex: index, ... })`
  works correctly even when called from within a lift that receives the derived
  array.
- For patterns displaying adjustment history with positive/negative changes, use
  conditional color coding computed before JSX: green for positive amounts, red
  for negative, gray for zero. String concatenation for the sign display ("+",
  "-", or "±") provides clear visual feedback in compact space.
- When rendering dynamic collections of slots/items that each have their own
  handlers, the `lift` function should focus on transforming the data and
  creating the handler references - it doesn't need to receive all the context
  cells separately. Pass the cells once to the adjustment handler factory, and
  reference them by index within the lift's mapping operation.
- When working with handler-spawned child recipes, accessing nested cell values
  requires navigating the cell structure: use `.key("fieldName")` to get a child
  cell, then `.get()` or `.set()` on that cell. For example, to modify a child's
  value field: `childCell.key("value").set(newValue)`. The type system may
  require casting (`as Cell<T>`) but the framework handles the actual cell
  navigation at runtime.
- For patterns that spawn child recipes from handlers, the spawned children
  maintain their own independent state. When displaying children in the UI, lift
  over the children array and extract the relevant fields (value, label) from
  each child object in the array rather than trying to access the child recipe
  instances directly.
- When implementing UI handlers that need to modify spawned child state,
  validate the index bounds first (check against array length), then use the
  cell navigation pattern (`childCell.key("field")`) to access and modify nested
  fields within the child's state object.
- Use `NAME` and `UI` constants from commontools imports, not string literals
  `"[NAME]"` and `"[UI]"`. The constants are required for the framework to
  properly recognize and render the UI exports in the return statement:
  `return
  { [NAME]: name, [UI]: ui }`.
- For hierarchical key path patterns that dynamically traverse nested
  structures, define handlers at the module level (not inside the recipe) and
  factor out shared path traversal logic into a helper function. This avoids
  "invalid handler, no schema provided" errors that occur when handlers are
  defined inside the recipe function.
- When displaying complex nested state (like multi-level hierarchies), use
  `lift` to map over the structure and compute all display values (like totals)
  before the JSX. This keeps the rendering logic clean and ensures proper
  reactive updates when any part of the hierarchy changes.
- Grid layouts with colored cluster indicators help users understand
  hierarchical relationships. Use distinct colors for different clusters/groups
  (e.g., blue for one cluster, red for another) with colored borders and
  indicator dots to create clear visual groupings.
- For history tracking patterns with bar chart visualizations, compute all
  dynamic styling (colors, heights, backgrounds) as plain variables before JSX
  to avoid template literal scope issues. Use `Math.max(...array.map())` to
  calculate relative scaling for consistent bar height visualization.
- When rendering history arrays in reverse chronological order with bar charts,
  use color-coding to distinguish positive (green) vs negative (red) values.
  Computing percentage-based heights relative to the maximum absolute value
  creates a clear visual comparison across all entries.
- History visualization patterns work well with horizontal scrollable containers
  (`overflow-x: auto`) that display bars side-by-side, allowing users to scan
  through the timeline naturally from newest (left) to oldest (right) after
  reversing the array.
- For rich label patterns that compose multiple configuration values into a
  single display, use `lift` to create a visually prominent label component that
  shows all parts together. This helps users understand how their configuration
  choices affect the final output.
- When building configuration UIs that update separate parameters (prefix, step,
  unit), initialize UI field cells with empty strings and rely on `compute`
  effects to sync them from the actual parameter defaults. This ensures the UI
  always reflects the current state without hardcoding initial values.
- For patterns where button labels need to reflect current configuration (like
  "+5" for step size 5), bind the button content directly to the underlying
  parameter cell rather than a sanitized UI field. This keeps the displayed
  action accurate to what will actually happen.
- When displaying parent-child recipe relationships where cells are passed as
  arguments, use side-by-side layouts with color-coded sections to visually
  distinguish the parent and child UIs. This helps users understand which
  controls belong to which recipe while demonstrating shared state.
- For patterns demonstrating cell-level state sharing, include a real-time
  alignment indicator that shows when parent and child values are synchronized.
  Use color-coded badges (green for aligned, red for misaligned) to provide
  immediate visual feedback about the state relationship.
- Child recipe outputs can be accessed via `.key("fieldName")` in the parent's
  JSX, allowing you to display child-derived values (like parity, nextPreview)
  alongside parent controls. This demonstrates how derives propagate across
  recipe boundaries.
- When both parent and child recipes expose handlers that mutate the same cells,
  you can bind them directly to buttons in a unified UI. The framework handles
  the cell references correctly even though the handlers were created in
  different recipe contexts.
- For optional/fallback patterns that track undefined vs defined state, use
  `lift` to create a boolean derived cell (e.g., `typeof val === "number"`) and
  bind it to dynamic styling and status text. This provides clear visual
  feedback about whether a value is using its actual value or falling back to a
  default.
- Conditional status indicators work well with color-coded backgrounds: use
  yellow/amber for warning states (undefined, using fallback) and green for
  success states (value is set). Compute the complete style string including
  background, border, color, and padding in a single `lift` function.
- For patterns demonstrating fallback behavior, include both "set value" and
  "clear value" actions in the UI so users can easily toggle between defined and
  undefined states to observe the fallback logic in action.
