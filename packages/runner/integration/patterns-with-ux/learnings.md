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
  entries first.
- Unlike regular React, there is no need to add a `key` prop for each mapped
  item. Rendering performance isn't impacted.
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
- When building dynamic grid visualizations (like heatmaps), use `lift` to
  generate an array of JSX elements by iterating with a for loop, computing all
  dynamic styles (colors, borders, backgrounds) as string variables before the
  JSX to avoid template literal issues. The grid can then be bound to a dynamic
  column count using
  `style={lift((w: number) => "display: grid;
  grid-template-columns: repeat(" + String(w) + ", 1fr); gap: 8px;")(width)}`.
- For visualization patterns with computed color gradients based on normalized
  values, build HSL color strings with concatenation (e.g., `"hsl(" +
  String(hue)
  - ", " + String(saturation) + "%, " + String(lightness) + "%)"`) to create
    smooth intensity transitions. This works well for heatmaps where lightness
    varies with intensity.
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
- For simple patterns with a single input/output flow, always include the `h`
  import even when using JSX syntax exclusively (not just when using `h()`
  directly). The JSX transpiler requires `h` to be in scope to transform JSX
  elements into function calls.
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
- When rendering collections within `lift` functions, avoid using `.map()` as it
  can cause "derive is not defined" errors. Instead, use a `for...of` loop with
  `.push()` to build an array of JSX elements, computing all dynamic styles as
  variables before the JSX to avoid template literal scope issues.
- For workflow patterns with multiple stages, use color-coded badges to visually
  distinguish stages (e.g., blue for drafting, purple for review, cyan for
  ready, green for scheduled). Apply colors consistently across different UI
  sections (list items, stage distribution cards) to reinforce the visual
  language.
- Priority indicators work well as colored left borders on list items. Use
  distinct colors (red for high, orange for medium, green for low) that create
  clear visual hierarchy without requiring users to read labels.
- When building forms that clear after submission, ensure handlers call
  `.set("")` on all form field cells after successfully processing the input.
  This provides clear feedback that the action completed and readies the form
  for the next entry.
- For editorial workflow patterns, showing both queue metrics (drafts awaiting)
  and completion metrics (scheduled, published) in a summary card provides
  at-a-glance workflow health. Use large, prominent numbers with descriptive
  labels underneath.
- For list management patterns with dynamic collections, use alternating row
  backgrounds (e.g., alternating between light gray and white) to improve visual
  scanning of list items. This helps users quickly distinguish rows.
- When rendering collections with item indices, display the index in a monospace
  font with a distinct color to clearly indicate position. This is especially
  helpful when other UI controls reference items by index.
- Form inputs that clear after submission provide good UX feedback. After
  handlers successfully process input (like adding an item), reset form field
  cells to their default values (empty strings for text, "0" for counts) to
  ready the form for the next entry.
- For collection patterns where items have labels and numeric properties,
  displaying the count in a styled badge (rounded background, monospace font)
  creates visual separation from the label and emphasizes the numeric value.
- Sets are not JSON-serializable and cannot be stored in cells. Use arrays
  instead and convert to Sets only within handler logic when needed for lookups.
  This applies to any non-serializable data structures - stick to plain objects,
  arrays, strings, numbers, and booleans for cell storage.
- When creating handlers that need to reference derived cells (outputs of
  `lift`), handlers can accept derived cells as context parameters - the
  framework handles `.get()` calls on derived cells correctly. However, ensure
  all context parameters are properly passed when invoking the handler.
- For patterns with per-item interactions in dynamically rendered lists (like
  toggling student attendance), consider using simpler input methods like
  textarea with line-separated IDs rather than creating handlers inside `lift`
  functions, which cannot access outer scope variables like handler references.
- Displaying reference data (like student rosters) in a scrollable list with
  monospace formatting helps users copy IDs accurately into input fields. Use
  `maxHeight` and `overflow-y: auto` for long lists.
- When reimplementing business handler logic directly in UI handlers, avoid
  calling `.run()` on factory-bound handlers—instead, duplicate the mutation
  logic inline. This ensures proper cell updates without runtime errors about
  missing `.run()` methods.
- For union-state patterns that toggle between mutually exclusive modes
  (loading/ready), use conditional visibility with `lift` to show/hide control
  sections dynamically. Compute display style strings like `"display: block;"`
  or `"display: none;"` based on derived mode booleans.
- Status badges with dynamic colors work well for union state visualization. Use
  `lift` to compute badge colors from the current state (e.g., orange for
  loading, green for ready) and bind directly to inline styles for immediate
  visual feedback.
- Always defensively check string values with
  `typeof noteText === "string" &&
  noteText.trim() !== ""` before calling
  `.trim()` on cell values, as cells may return undefined during initialization.
  This prevents "Cannot read properties of undefined" errors in handlers.
- For timeline/scheduling patterns with sequential segments, use a flexible
  layout (`display: flex; gap: 0.5rem;`) where each segment's flex value equals
  its duration. This creates a proportional timeline visualization that scales
  naturally with content. Color-code segments with alternating or themed colors
  to distinguish them visually.
- When rendering timelines, include both absolute timestamps (start/end minutes)
  and duration in each segment card for complete context. Use monospace fonts
  for numeric values to maintain visual alignment.
- Form fields that clear after successful handler execution provide good UX
  feedback. After updating state, call `.set("")` or `.set("defaultValue")` on
  form field cells to reset them for the next operation.
- For patterns with multiple control sections (update, reorder, etc.), separate
  them into distinct cards with clear headings. This helps users understand
  which controls affect which operations without cognitive overload.
- For educational patterns demonstrating lift transformations, use visual flow
  indicators (arrows, separators with labels) to clearly show the data
  transformation pipeline. A gradient background for the raw value and a
  bordered light background for the formatted output creates clear visual
  distinction between input and output stages.
- Monospace fonts work well for displaying both raw numeric values and formatted
  strings to maintain consistency and emphasize the technical nature of the
  transformation.
- For event validation patterns that demonstrate no-op behavior, use color-coded
  visual feedback to distinguish between valid (green) and invalid (red) events.
  A dynamic "Last Event" indicator with conditional styling based on the event
  type helps users immediately understand whether their action was processed or
  rejected.
- When creating separate handlers for valid and invalid event paths, track both
  the main state (counter value, updates count) and metadata (last event label)
  to provide comprehensive feedback about what happened and why.
- Grid layouts with two equal columns work well for displaying related metrics
  side-by-side (like current value and update count), helping users understand
  the relationship between different state values.
- For patterns demonstrating typed handler records, organize handler invocation
  counts in a grid with color-coded cards (green for increments, amber for
  decrements, indigo for set operations) to create clear visual distinction
  between different handler types while maintaining symmetry.
- When rendering history with color-coded badges inside a `lift`, compute all
  color values as plain variables before JSX (e.g., `const actionColor = ...`)
  and use string concatenation to build inline styles. Use a for...of loop with
  `.push()` to build the elements array rather than `.map()`.
- Three-column grid layouts with `grid-template-columns: repeat(3, 1fr)` work
  well for displaying per-handler statistics that should have equal visual
  weight, creating a balanced dashboard-like layout for invocation counts.
- For patterns with mode-switching behavior (like toggled derive pipelines),
  color-code the mode indicators consistently across the UI - use the same color
  scheme for the active mode badge and the corresponding action button to
  reinforce the visual relationship between state and controls.
- When passing event parameters to handlers via ct-button attributes (e.g.,
  `ct-amount={1}`), bind the handler directly to `onClick` without calling it.
  The framework will automatically pass the attributes as the event object to
  the handler.
- History displays work well with color-coded badges that match the mode colors
  used elsewhere in the UI, creating a cohesive visual language that helps users
  understand the pattern's behavior at a glance.
- For shopping cart patterns with category-based aggregation, displaying both
  line items and category rollups helps users understand how their purchases
  group together. Use distinct visual sections: individual items with item-level
  details (name, unit price, quantity, subtotal) and category cards showing
  aggregated quantity and subtotal per category.
- When building UIs with multiple related collections (items, categories,
  discounts), organize them in a hierarchical layout: main cart items in the
  largest section, summary/totals in a highlighted sidebar, and supporting data
  (category breakdown, discount breakdown) in secondary sections below.
- For discount rule patterns that depend on category thresholds, show both
  qualified and unqualified discounts with clear visual distinction. Use green
  backgrounds and "APPLIED" badges for active discounts, gray for inactive.
  Display the rule criteria (e.g., "10% off when qty ≥ 5") alongside the
  discount amount so users understand why discounts did or didn't apply.
- When implementing handlers that clear form fields after submission, ensure all
  related input cells are reset with `.set("")` or `.set("0")`. This provides
  immediate feedback that the action completed and prepares the form for the
  next operation.
- For patterns with partial updates (like updating only quantity or only price),
  handle optional parameters carefully in handlers. When a field isn't provided,
  preserve the existing value rather than defaulting to zero. Check for empty
  strings or undefined before applying new values.
- Order summary cards with large, prominent totals work well in e-commerce
  patterns. Use a distinct background color (like light yellow) and larger fonts
  for the final total to draw user attention to the most important number.
- Recent activity logs showing the last 5 operations provide good context
  without overwhelming the UI. Use `.slice().reverse().slice(0, 5)` to show
  newest first and limit display to recent entries.
- For patterns demonstrating Default<T> persistence, use visual indicators (like
  colored info boxes) to clearly show which values have defaults and what those
  defaults are. This helps users understand the fallback behavior at a glance.
- When a pattern has both "apply and persist" vs "apply once" operations,
  provide separate handlers and buttons to distinguish between updating stored
  configuration versus one-time actions. Clear button labels like "Update step"
  vs "Apply once" help users understand the difference.
- Form fields that reset after one-time operations provide good UX feedback -
  after handlers successfully apply a one-time action, reset the field to a
  sensible default to clearly signal the action completed and ready the form for
  the next input.
- For logistics/routing patterns with capacity constraints, use color-coded
  visual indicators to show route status: green for available capacity, yellow
  for at-capacity, red for over-capacity. Progress bars showing utilization
  percentages provide at-a-glance understanding of system load distribution.
- When displaying collections of metrics (like route loads), compute all dynamic
  style values before JSX to avoid template literal scope issues. Use string
  concatenation with `+` operator for building inline styles.
- Activity history with color-coded entries (green checkmarks for success, red
  X's for blocked operations) creates clear visual feedback about operation
  outcomes without requiring users to parse text carefully.
- For faceted search patterns with dynamic filter lists, avoid using `ct-value`
  or similar custom attributes to pass values to handlers (not supported).
  Instead, use input fields where users type filter values and handlers read
  from those input cells. Display available options as visual badges (spans with
  conditional styling) that show selection state with checkmarks and color
  changes.
- When rendering dynamic collections of badges/pills inside `lift` functions,
  use the `h()` function to create elements rather than JSX syntax. Build style
  strings with concatenation before passing to `h()`, and use `...elements` to
  spread arrays of children into parent elements.
- JSX attribute values cannot use the `+` operator for string concatenation
  across multiple lines. Always use single-line style strings in JSX attributes,
  or compute the style string in a variable first and reference it.
- When generating dynamic lists of elements with handlers (like replica cards
  with per-item increment buttons), use the `h()` function instead of JSX within
  `lift` functions. This allows you to create handlers at the recipe level and
  pass them through to dynamically generated elements via the handler reference
  stored in the derived object.
- For patterns that manage collections of items (like replicas), handlers for
  adding items should create new entries with appropriate default values (e.g.,
  0 for counters). Removal handlers should validate index bounds and clear any
  input fields after successful removal to provide clear UX feedback.
- When using `h()` to build dynamic UI elements inside `lift`, compute all style
  strings as plain variables using string concatenation (`+` operator) before
  passing them to the `h()` function. This avoids template literal scope issues
  and keeps the code clean.
- For quote/configuration patterns with dynamic option lists, using a text input
  where users enter an option ID or name to toggle is more reliable than trying
  to create per-item button handlers inside `lift` functions. Display each
  option's ID clearly so users know what to type.
- Handlers created with JSX syntax (not `h()`) work correctly when bound to
  buttons at the recipe level. Mix JSX for static UI structure with `h()` inside
  `lift` only for dynamic collections that need to render based on state.
- For sequential timeline patterns displaying modules or segments with
  calculated start/end times, use `lift` with `h()` to generate cards
  dynamically. Color-code each card with alternating colors from a palette to
  visually distinguish sequential items. Display both absolute positions (week
  ranges) and durations to provide complete temporal context.
- When implementing add/create handlers that build IDs from titles, always check
  for duplicate IDs before adding new items to prevent collisions. Display
  user-friendly error messages in the lastAction cell when duplicates are
  detected, helping users understand why their action was rejected.
- When calling `.get()` inside a `lift` function throws "derive is not defined"
  errors, it means you're trying to read a cell directly instead of receiving
  its value as a parameter. Always pass cells as parameters to lift and extract
  their values as function arguments.
- For patterns displaying nested array structures with multiple levels (groups
  containing entries), use nested loops within `lift` functions to iterate
  through each level. Compute all intermediate values (like group totals) as
  plain variables before building JSX to maintain clean, readable code.
- When rendering optional content like notes within dynamic lists, always use
  ternary operators with explicit `null` for the false case rather than boolean
  expressions like `{condition && <Component />}`. The boolean expression will
  render "false" as text when the condition fails, while the ternary with null
  properly hides the content.
- UI handlers that target specific items in nested arrays can accept index
  parameters via form fields. Create cell-based form fields (e.g.,
  `groupIndexField`, `entryIndexField`) and have handlers read from these cells
  using `.get()` to determine which nested item to modify.
- For patterns with multiple related operations (increment, decrement, update
  label, update note), separate handlers provide clear, maintainable control
  flow. Each handler can be specialized for its operation while sharing access
  to the same underlying cell structure via `.key()` navigation.
- Alternating background colors (`ei % 2 === 0 ? "#ffffff" : "#f1f5f9"`) on list
  items improve visual scanning of dense nested structures, especially when
  displaying multiple fields per item.
- For schedule/calendar patterns displaying items grouped by day, use
  color-coded left borders with distinct colors per day to create visual
  distinction. This helps users quickly identify which day they're looking at
  when scanning through a weekly view.
- When building complex aggregation UIs (like muscle volume analysis), use `h()`
  inside `lift` functions to dynamically generate cards based on computed
  statistics. Compute all style strings with concatenation before passing to
  `h()` to avoid template literal scope issues.
- Grid layouts work well for displaying statistics within cards. A four-column
  grid showing related metrics (sessions, total sets, total reps, volume)
  provides a comprehensive view of aggregated data at a glance.
- For patterns with rich catalogs of available options (like exercises), display
  them in a separate section with clear visual categorization (color-coded
  badges per category/group). This helps users understand what options are
  available without cluttering the main interaction area.
- When working with patterns that have multiple muscle groups or categories,
  assign consistent colors throughout the UI - use the same color for a category
  in the schedule view, volume analysis, and catalog sections to create visual
  coherence.
- For patterns that display HTML content (like markdown preview), use the
  `innerHTML` attribute on a div to render the formatted HTML string. This works
  with lifted cells containing HTML strings generated by formatting functions.
  The innerHTML binding properly updates reactively when the source content
  changes.
- When testing UI interactions with Playwright MCP in shadow DOM environments,
  use a recursive helper function to traverse shadow roots and find elements.
  The `ct-button` and other ct components are typically nested in shadow DOMs,
  so direct `querySelector` won't find them - you need to recursively check
  `shadowRoot` properties.
- For simple toggle patterns with derived status labels, use `lift` to compute
  dynamic styles (colors, backgrounds) based on the derived status string. This
  creates clean visual feedback with smooth transitions between states using CSS
  transitions on inline styles.
- Status indicator patterns work well with a combination of a colored dot (using
  inline span with dynamic background color) and large uppercase status text,
  both driven by the same derived status cell. This creates clear, at-a-glance
  visual feedback about the current state.
- Dynamic button labels based on state (`lift` to compute "Enable" vs "Disable")
  provide better UX than static labels, making the available action always clear
  to users.
- For citation/bibliography patterns with multiple grouping dimensions (by
  topic, by style), create separate derived cells for each grouping strategy
  using `lift` to transform the base catalog. This allows the UI to display
  filtered views (like a bibliography for a specific citation style) while
  maintaining access to the complete dataset for listing all citations.
- When building form handlers that process multiple input fields, create
  dedicated UI cells for each form field and have handlers read from all
  relevant cells using `.get()`. After successful processing, clear all form
  fields with `.set("")` to provide clear feedback and ready the form for the
  next entry.
- For patterns with style/format filtering (like citation styles APA/MLA/
  Chicago), use a badge-style indicator to show the active filter prominently.
  Combine this with dynamic section headers (e.g., "Bibliography (APA)") that
  update based on the active filter to reinforce which view is currently
  displayed.
- When rendering dynamic collections with `h()` inside `lift`, use a `for...of`
  loop to build element arrays rather than `.map()`, as this avoids potential
  "derive is not defined" errors. Compute all dynamic values (colors, styles) as
  plain variables before creating elements with `h()`.
- Multi-field forms benefit from grid layouts with two columns for related
  fields. This creates a compact, organized input area while maintaining visual
  balance and making efficient use of horizontal space.
- When reimplementing business handler logic directly in UI handlers, avoid
  calling `.run()` on factory-bound handlers—instead, duplicate the mutation
  logic inline. This ensures proper cell updates without runtime errors about
  missing `.run()` methods.
- For scheduling patterns with dynamic coverage calculations, use color-coded
  visual indicators (green for covered, red for gaps) on both summary cards and
  individual slot cards to create clear at-a-glance status visibility.
- When displaying slot assignments with agent names, lift over the coverage
  array to render dynamic slot cards, computing all style values before JSX to
  avoid template literal scope issues. Use conditional backgrounds and borders
  based on the hasGap boolean.
- Form inputs that accept both IDs and human-readable names provide better UX.
  Implement resolver functions (like resolveSlotId, resolveAgentId) that check
  both exact ID matches and case-insensitive label/name matches to support
  flexible user input.
- When you need multiple buttons that call the same logic with different
  parameter values (like +1, +2, -0.5), create a factory function that returns
  individual handlers for each value rather than trying to pass parameters via
  custom attributes. For example, `createAdjustHandler(delta)` that returns a
  handler, then call it for each button:
  `const adjustPlus1 =
  createAdjustHandler(1)`. This ensures parameters are
  properly captured at handler creation time.
- For dynamic lists where per-item handlers are needed (like increment/
  decrement buttons for each counter), creating handlers inside `lift` functions
  doesn't work reliably even when using factory functions. Instead, use a
  centralized control approach: create input fields where users specify the item
  index and adjustment value, then have a single handler read from those fields.
  This pattern works well for collection management UIs where the collection
  size changes dynamically.
- For batch processing patterns where handlers need to parse user input (like
  comma-separated numbers), create a separate UI-specific handler that reads
  from input cells, parses the data, and replicates the business handler's state
  mutation logic. This keeps the original business handler clean while providing
  a user-friendly input mechanism. Clear form fields after successful submission
  with `.set("")` to provide feedback and ready the form for the next operation.
- When displaying historical data in reverse chronological order, use
  `.slice().reverse()` and limit display with `Math.min(reversed.length, N)` to
  show only the most recent N entries. This prevents UI clutter while still
  maintaining complete history in the underlying cell.
- For compliance tracking patterns with dynamic status indicators, use `lift` to
  compute conditional colors based on derived compliance state. Map state
  strings directly to color values (e.g., "Compliant" → green, "At Risk" →
  orange, "Non-Compliant" → red) to create clear visual feedback that updates
  reactively as tasks progress through completion.
- When building status badge UIs that need to show percentage-based progress
  bars, compute the width as a string percentage in a `lift` function and bind
  it directly to the progress bar element's width style. This creates smooth
  visual transitions as the underlying metrics change.
- For multi-category aggregation patterns (like compliance by category), use the
  `h()` function inside `lift` to dynamically generate cards with color-coded
  borders and backgrounds. Compute all style strings with concatenation before
  passing to `h()` to avoid template literal scope issues.
- When rendering collections of items with multiple fields (tasks, entries,
  records), use nested `h()` calls to build structured card layouts with
  consistent spacing. This approach works well for displaying complex data with
  headers, badges, and grid-based detail sections.
- For patterns that track gaps or outstanding items, display an empty state with
  positive messaging (e.g., "No compliance gaps!") using conditional rendering
  based on array length. This provides clear feedback when all requirements are
  met.
- Color-coded status badges computed dynamically in `lift` functions work well
  with conditional backgrounds and text colors. Define color mappings at the
  logic level (in the lift) rather than in CSS to keep styling reactive and
  consistent with state changes.
- For list management patterns with reordering functionality, using the `h()`
  function inside `lift` to dynamically render list items provides clean,
  reactive updates as the list changes. Compute all style strings with
  concatenation before passing to `h()` to avoid template literal scope issues.
- When creating handlers that modify array order (like reordering list items),
  implement the mutation logic directly in the handler using array methods like
  `.splice()` to remove and insert elements at specific indices. This keeps the
  state updates atomic and ensures the UI reflects the correct order
  immediately.
- Alternating row backgrounds in list items (using index modulo 2) significantly
  improves visual scanning, especially when items display multiple pieces of
  information like index and value. Use contrasting but subtle colors like white
  and light gray.
- For patterns that accept user input via form fields, always validate and
  sanitize inputs in handlers before applying them. Check for empty strings,
  parse numeric values, validate bounds, and only update state when inputs are
  valid. This prevents invalid state and provides implicit feedback through
  no-ops on bad input.
- For A/B testing or experiment assignment patterns that track allocation
  balance, use dynamic color-coded status indicators to show when assignments
  are balanced (green) vs imbalanced (yellow/amber). Computing the balance
  status with a threshold (e.g., max difference ≤ 25%) provides clear visual
  feedback about distribution quality.
- When displaying allocation statistics for weighted variants, show both target
  share (based on weights) and actual share (based on current assignments)
  side-by-side with the difference highlighted. This helps users understand how
  well the assignment algorithm is maintaining the desired distribution.
- For patterns that accumulate history (like assignment logs), displaying
  entries in reverse chronological order with alternating row backgrounds
  improves scannability. Limit the display to recent entries (e.g., last 10) to
  prevent UI clutter while maintaining complete history in the underlying cell.
- Assignment or allocation UIs benefit from prominent summary metrics at the
  top: total count and balance status provide at-a-glance understanding of
  system state without requiring users to scan through detailed breakdowns.
- Custom attributes on `ct-button` (like `ct-amount={5}`) are not reliably
  passed through to handlers as event parameters. Instead, create separate
  handler instances for each button using a factory function that captures the
  parameter value at creation time (e.g.,
  `const increment5 =
  createIncrementHandler(5)`). This pattern is more
  reliable than trying to pass parameters via custom attributes.
- For currency conversion or multi-item transformation patterns, use `h()`
  inside `lift` to dynamically render cards for each item in the collection. The
  base currency should be visually distinguished (e.g., with blue background and
  border) from other currencies to help users quickly identify it in the list.
- When building forms that update dictionaries or maps (like exchange rates),
  handlers should read from multiple input cells, validate all inputs, then
  perform the state mutation. Clearing form fields with `.set("")` after
  successful submission provides clear UX feedback that the operation completed.
- `compute` effects work well for syncing UI form fields with derived state.
  When a derived value updates (like normalizedAmount), the compute can update
  the corresponding input field cell to keep them in sync, ensuring the form
  always reflects current state.
- For dictionary/map patterns where entries can be added or updated, a single
  handler can serve both purposes by checking if the key exists and either
  updating the existing value or adding a new entry. This simplifies the UI to a
  single "Add/Update" button rather than separate actions.
- For permission matrix patterns displaying role-permission relationships, using
  `h()` inside `lift` to dynamically render role cards with color-coded badges
  works well. Compute all style strings with concatenation before passing to
  `h()` to avoid template literal scope issues. Green badges for granted
  permissions and gray badges for not-granted permissions create clear visual
  distinction.
- When building matrix UIs that need per-cell toggle interactions, a centralized
  form-based approach (input fields for role/permission identifiers + toggle
  button) is more reliable than trying to create handlers inside `lift`
  functions. This pattern works well when the matrix displays derived state
  while mutations happen through a separate control panel.
- Progress indicators showing permission coverage (e.g., "3/4 permissions") can
  be displayed using both numeric ratios and visual progress bars. Computing the
  percentage width with `lift` and binding to an inner div's width creates a
  responsive visual indicator that updates as permissions change.
- For patterns with flexible input resolution (accepting both IDs and
  human-readable names), implement resolver functions that check exact ID
  matches first, then try normalized keys, then case-insensitive label matches.
  This provides a good balance between precision and user-friendliness.
- For complex grading matrix patterns with nested collections (students,
  assignments, grades), separate the data display logic into individual `lift`
  functions rather than building everything in one large lift. This makes the
  code more maintainable and allows each section to be rendered independently.
- When displaying reference lists (students, assignments) alongside form inputs,
  use scrollable containers with `max-height` and `overflow-y: auto` to prevent
  long lists from dominating the UI. This keeps the form accessible while still
  showing all available options.
- For grading or scoring UIs, color-code performance levels with distinct
  background and border colors: green for excellent (≥90%), yellow for good
  (≥70%), and red for needs improvement (<70%). Gray with lighter borders works
  well for incomplete/ungraded items.
- Grid layouts with `repeat(auto-fill, minmax(Npx, 1fr))` work excellently for
  displaying variable-width grade cells that should wrap responsively while
  maintaining readable card sizes.
- For healthcare/medication tracking patterns with time-based schedules, use
  monospace fonts for scheduled times and display them prominently with colored
  backgrounds (e.g., cyan for upcoming doses). This creates clear visual
  hierarchy and makes times easily scannable.
- When rendering lists of scheduled items with multiple properties (medication,
  dosage, time, instructions), use nested `h()` elements with structured layouts
  rather than trying to build complex JSX inside `lift` functions. Compute all
  dynamic styles as string variables before passing to `h()` to avoid template
  literal scope issues.
- Completion tracking UIs benefit from large, prominent percentage displays in
  gradient backgrounds with supporting metrics (taken/total/remaining) shown in
  a grid below. This provides at-a-glance status while surfacing detailed
  breakdowns for users who want them.
- When displaying both upcoming and completed items in separate sections, use
  distinct color schemes: neutral/cool colors (blues, grays) for upcoming items
  and warm success colors (greens) for completed items. This reinforces the
  conceptual difference between pending and done states.
- For patterns with empty state variations (all completed vs none scheduled),
  provide positive, celebratory messaging when work is done ("🎉 All doses
  completed!") rather than neutral "no items" text. This creates emotional
  engagement and reward for task completion.
- Activity history logs showing recent actions work well when limited to last
  5-6 entries and displayed in reverse chronological order. Use left borders
  with accent colors to create visual consistency across log entries without
  overwhelming the interface.
- Form validation that silently fails (no-op when invalid input is submitted)
  provides clean UX for handlers that validate complex business rules. Rather
  than showing error messages, handlers can simply return early when validation
  fails, keeping the form in its current state for users to correct.
- Custom attributes on ct-button elements (like `ct-category="design"`) are not
  reliably passed through to handlers as event parameters. When you need to
  create multiple buttons that invoke the same handler with different
  parameters, use an input-based approach instead: create a text input field
  where users type the parameter value, then have a single handler read from
  that input cell. Display available options as reference badges to guide users.
- For patterns with dynamic filter/category lists, an input-based selection UI
  is more reliable than trying to create handler-bound buttons inside `lift`
  functions. Show available options as visual badges for reference, and let
  users type the option key into an input field before clicking a single "Apply"
  button that reads from the input cell.
- When handlers need to read from derived cells (outputs of `lift` functions),
  pass those derived cells directly in the handler context with type `Cell<T>`
  rather than trying to use duck-typed `{ get(): T }` interfaces. The framework
  handles Cell/OpaqueRef conversion automatically between derived and mutable
  cells.
- When creating forms with ct-input elements, use JSX syntax at the recipe
  return level rather than creating them with `h()` inside `lift` functions. The
  `$value` binding for ct-input works correctly in JSX but may not bind properly
  when using `h("ct-input", { $value: cell })` inside a lift. This prevents the
  "[object Object]" display issue in form fields.
- For editorial/scheduling patterns with multiple channels, using color-coded
  borders and badges helps users visually distinguish between different content
  channels. Assigning consistent colors (blue for Blog, purple for Newsletter,
  pink for Podcast) creates clear visual grouping across the schedule display.
- When sharing form field cells between multiple UI sections (like "Add" and
  "Update" forms), be aware that typing in one section will show in the other.
  If this is undesirable, create separate cell instances for each form section
  to maintain independent state.
- For calendar/scheduling UIs with sortable entries, displaying entries
  chronologically within each channel helps users understand the publication
  timeline at a glance. Combining this with monospace date formatting
  (YYYY-MM-DD) improves scannability.
- Activity history displayed as a single concatenated string (using
  `.join(" • ")`) provides compact feedback for recent operations without taking
  up excessive vertical space. Limiting to the last 5 entries prevents clutter
  while still showing meaningful context.
- For state machine patterns with transition validation, replicate the business
  handler logic directly in UI handlers rather than calling `.run()` on the
  original handler - the `.run()` method doesn't exist and will cause runtime
  errors. Duplicate the state mutation logic inline to ensure proper execution.
- Workflow visualization benefits from dynamic color coding based on the current
  stage, with gradient backgrounds that adapt to the active state. Use `lift` to
  compute complete style strings including gradients that incorporate the stage
  color for visual coherence.
- Progress indicators showing percentage completion through sequential stages
  work well alongside visual progress bars. Computing the percentage as
  `(currentIndex / (totalStages - 1)) * 100` provides intuitive feedback about
  workflow progression.
- For patterns with allowed/forbidden transitions, showing both the current
  stage prominently and the available next stages helps users understand the
  state machine's constraints. Color-coded badges ("Current" vs "Available") on
  stage displays create clear visual hierarchy.
- Transition history with color-coded result badges (green ✓ for accepted, red ✗
  for rejected) and human-readable rejection reasons ("Not allowed from current
  stage", "Invalid target stage") provides excellent UX feedback for
  understanding why transitions succeed or fail.
- When handlers read from UI input cells, always defensively check for undefined
  values before calling string methods like `.trim()`. Use
  `typeof amountStr ===
  "string" && amountStr.trim() !== ""` to safely handle
  cases where cell values haven't been initialized yet, preventing "Cannot read
  properties of undefined" errors during handler execution.
- For patterns with dynamic collections that start empty (no defaults provided
  at charm creation), add UI handlers that allow users to populate the
  collection from scratch. When using `Default<T, defaultValue>` in the recipe
  args, the defaults only apply when the value is explicitly undefined, not when
  a charm is created without providing initial args—in that case the cell starts
  empty.
- When creating "add item" handlers for collections, clear all form input cells
  with `.set("")` after successful submission to provide clear UX feedback and
  ready the form for the next entry. This is especially important for
  multi-field forms where users need to see that their submission was processed.
- When you need multiple buttons that call the same handler logic with different
  fixed parameter values (like increment/decrement), create separate handler
  functions rather than trying to pass parameters through the context object at
  binding time. The framework validates context parameters against the handler
  schema, so extra properties will cause compilation errors. Define handlers
  like `increment` and `decrement` separately instead of trying to use
  `adjustSingle({ target: cell, amount: 1 })` in the onClick binding.
- For subscription/billing patterns with plan catalogs, displaying available
  plans in a grid with clear pricing and cycle information helps users
  understand their options at a glance. Use color-coded borders or backgrounds
  to distinguish plan tiers visually.
- When implementing UI handlers that accept optional parameters (like custom
  cycle days), check if the input field is empty with
  `typeof str === "string" && str.trim() !== ""` before parsing and applying the
  value. This allows users to change plans without overriding cycle days when
  they leave that field blank.
- For progress tracking patterns with weighted items, use conditional color
  coding based on completion percentage thresholds (e.g., red <33%, orange
  33-66%, green
  > 66%) to provide immediate visual feedback about goal progress. Combine with
  > large percentage displays and progress bars for maximum clarity.
- When mixing JSX and `h()` in the same pattern, use JSX at the recipe return
  level for static structure and form inputs (to properly bind `$value` to
  cells), and use `h()` inside `lift` functions only for dynamic collections
  that need to render based on derived state. The `$value` binding doesn't work
  reliably when using `h("ct-input", { $value: cell })` inside a lift.
- For sparse array patterns that demonstrate fallback value filling, displaying
  the array values in a bordered list with alternating row backgrounds helps
  users see which slots have explicit values versus fallback-filled slots. The
  visual representation makes the pattern's behavior immediately clear.
- When creating form inputs with `cell()`, the initial value is immediately
  available, but handlers should still guard against edge cases where values
  might be empty strings or need default behavior (like defaulting to 1 for
  increment amounts when no value is provided).
- For inventory/warehouse patterns with conditional alerts, use `lift` to
  compute dynamic styles for alert status indicators that switch between success
  (green) and warning (red/yellow) states. Gradient backgrounds that change
  color based on alert state provide clear visual feedback.
- When rendering collections with status-based styling (like inventory items
  with low stock indicators), use the `h()` function inside `lift` to generate
  cards with conditional backgrounds, borders, and badges. Compute all style
  strings with concatenation before passing to `h()` to avoid template literal
  scope issues.
- Multi-action forms benefit from a shared SKU/identifier input with separate
  fields for different operation types (quantity for stock operations, threshold
  for configuration). This keeps the form compact while supporting multiple
  distinct operations through different button handlers.
- Status badges with uppercase text and conditional colors (green "OK" vs red
  "LOW STOCK") create immediate visual distinction in list items without
  requiring users to read numeric values first.
- For chat/message reaction patterns, displaying reaction totals in a grid of
  color-coded cards at the top provides an at-a-glance summary of engagement
  across all messages. Using emoji as both the identifier and visual element
  creates intuitive, language-independent UI that works across cultures.
- When patterns track collections that can grow from empty (like messages in a
  chat), providing an "add item" handler and form in the UI is essential for
  usability, as Default<T> values only apply when explicitly undefined, not when
  charms are created without initial arguments.
- Reaction badge displays work well when grouped inline with flexbox wrapping,
  showing both the emoji and count in a compact pill-style format. This creates
  a familiar chat-like interface that users recognize from platforms like Slack
  and Discord.
- For subscription/notification management patterns, using color-coded frequency
  badges (red for daily, orange for weekly, blue for monthly) helps users
  quickly distinguish between different update cadences at a glance. Small
  inline channel badges with uppercase text create clear visual hierarchy
  without overwhelming the card layout.
- When rendering dynamic collections of subscription items with `h()` inside
  `lift`, compute channel badge elements in a loop and spread them into the
  parent container. This allows flexible multi-channel display where each
  subscription can have a different number of channels without breaking layout.
- Multi-field subscription forms benefit from a two-column grid for related
  fields (frequency and channels) to create compact, organized input areas. This
  keeps the form visually balanced while making efficient use of horizontal
  space on wider screens.
- For inbox/threading patterns with grouped messages, display threads in reverse
  chronological order (most recent first) and highlight the active thread with
  distinct background colors and border styling. Use badges to show message
  counts and display multiple senders as comma-separated lists.
- When building two-panel layouts (list + detail view), use CSS Grid with
  proportional columns (e.g., 1fr 1.5fr) to give more space to the detail panel
  while keeping the list visible. This works well for email, messaging, and
  other item-detail patterns.
- For CRM/pipeline patterns displaying weighted forecasts, use color gradients
  based on probability to create visual hierarchy: green (high probability
  ≥80%), blue (medium 50-80%), and purple (low <50%). This helps users quickly
  identify deal stages and their likelihood of closing.
- When building UIs with dynamic statistics that update reactively, create
  separate lift functions for different UI sections (stage cards, deal cards)
  and compose them with JSX at the top level. This keeps the code maintainable
  while ensuring proper reactive updates.
- Sales pipeline visualizations benefit from showing both raw totals (open
  pipeline) and probability-weighted forecasts side-by-side in a prominent
  header, helping users understand both current value and expected outcomes.
- For aggregation patterns that dynamically compute statistics from collections
  (sum, count, average), display the aggregate metrics prominently at the top
  with large typography and gradient backgrounds to create visual hierarchy. Use
  progress bars or percentage indicators within individual items to show each
  item's contribution to the total, helping users understand the distribution at
  a glance.
- When collections can start empty (using `Default<T[], []>`), always provide UI
  handlers to add items. Empty state messages with dashed borders and helpful
  prompts ("No counters yet. Add one to get started!") create clear user
  guidance when the collection is empty.
- For multi-step workflow patterns with phase management, use color-coded status
  badges to distinguish between different phases (e.g., gray for "idle", green
  for active phases). This provides immediate visual feedback about the current
  state.
- When displaying step history in reverse chronological order, use conditional
  color coding for positive (green) vs negative (red) delta values to make the
  flow of changes immediately clear. Showing both the delta and running total
  for each step helps users understand the cumulative effect.
- Phase completion workflows benefit from separate UI sections for starting,
  stepping through, and completing sequences. This separation makes the workflow
  clear and prevents accidental actions.
- When tracking completed phases in a history log, display them with left-border
  accents and monospace fonts to create visual distinction from active phase
  steps. Showing the summary (phase name, completion note, step count, final
  total) provides complete context at a glance.
- When mixing `h()` and JSX in the same pattern, use `h()` inside `lift`
  functions for dynamic collections, and JSX at the recipe return level for
  static forms and inputs. The `$value` binding on `ct-input` works correctly in
  JSX but shows "[object Object]" when using `h("ct-input", { $value: cell
  })`
  inside a lift.
- For patterns that need to compute dynamic UI parts in a `lift` and then
  combine them with JSX forms, return an object with named properties from the
  lift (e.g., `{ header, board, historySection }`), then use additional `lift`
  calls to extract each property and interpolate them into JSX at the top level.
- Color-coded column backgrounds work well for kanban boards: use pastel colors
  for normal state (light purple for backlog, light yellow for in-progress,
  light blue for review, light green for done) and switch to red backgrounds
  with red borders when columns exceed WIP limits. This creates immediate visual
  feedback about capacity issues.
- Dynamic status banners that change color based on derived state (green for
  "all within limits", red for "over capacity") provide at-a-glance project
  health visibility. Compute the conditional colors directly in the lift using
  ternary operators rather than nested lifts to avoid runtime errors with
  `.startsWith()` on cells.
- For signature workflow patterns tracking multi-stage approval processes, use
  color-coded status badges with distinct colors for each state (green for
  signed, red for declined, amber for pending). Displaying order numbers and IDs
  alongside signer information helps users quickly identify which signer to
  target for actions.
- When building workflow UIs that need multiple action types on the same items
  (sign, decline, reset), use a shared ID input field with separate optional
  fields for each action type (signed date, decline reason). This keeps the form
  compact while supporting all operations through different button handlers.
- Progress indicators showing both percentage and fraction (e.g., "67%, 2 of 3
  signatures collected") with a visual progress bar provide comprehensive
  workflow status at a glance. Computing percentage dynamically from
  completed/total counts ensures accuracy as state changes.
- Activity logs displaying workflow history in reverse chronological order with
  alternating row backgrounds improve scannability. Including contextual details
  in log messages (e.g., "Noah Chen (Account Executive) signed on 2024-07-15")
  provides complete audit trail information without requiring users to cross-
  reference other sections.
- For workflows with business handler logic that needs UI equivalents, replicate
  the exact sanitization and state mutation logic in UI-specific handlers rather
  than trying to invoke the original handlers. This ensures consistent behavior
  while allowing form field clearing and other UI-specific operations after
  successful actions.
- For patterns demonstrating computed default strings with override behavior,
  use dynamic gradient backgrounds that change color based on whether an
  override is active. The visual distinction (purple gradient for override, pink
  for fallback) creates immediate feedback about the label source without
  requiring users to read state indicators.
- When displaying computed fallback values that dynamically update based on
  inputs, show both the fallback formula explanation and the current computed
  result to help users understand the derive chain at a glance.
- For search and filter patterns that display dynamic collections, use a
  dedicated search input cell with separate handlers for applying and clearing
  the search. This provides clear user control over the filtering behavior and
  makes it easy to reset back to showing all items.
- When rendering filtered collections inside `lift`, handle empty results with
  contextual messaging (e.g., "No matching counters found") using color-coded
  empty states that help users understand why no results are shown.
- For patterns with per-item modification operations on collections, use a
  centralized form approach where users input the item identifier (ID) and the
  modification parameters, then separate handlers for each operation type
  (increment, set value, update label). This avoids the complexity of creating
  per-item handlers inside `lift` functions.
- When displaying item IDs in the UI for user reference, use monospace fonts and
  lighter colors to visually distinguish the technical identifier from the
  human-readable label. This makes it easy for users to copy the correct ID
  value.
- For catalog/coverage tracking patterns displaying completion metrics, use
  color-coded cards with conditional backgrounds based on percentage thresholds
  (green for complete, yellow/amber for partial, red for uncovered). Computing
  these colors dynamically in `lift` functions and applying them to both borders
  and backgrounds creates immediate visual feedback about coverage health.
- When building nested conditional rendering inside `lift` functions with `h()`,
  avoid using ternary operators that return `null` as children. Instead, build
  the children array conditionally by pushing elements only when needed, then
  spread that array into the parent element with `...childrenArray`. This
  prevents TypeScript errors about null not being assignable to RenderNode.
- For library circulation patterns with complex business logic (checkout,
  return, hold placement, hold promotion), create separate UI handlers that
  duplicate the business handler logic rather than trying to invoke the original
  handlers. This allows form field clearing and other UI-specific operations
  while maintaining consistent behavior. Clear all relevant input fields with
  `.set("")` after successful operations to provide immediate UX feedback.
- When displaying catalog items with dynamic availability status (available,
  limited, on-hold, unavailable), use color-coded borders and status badges that
  reactively update based on computed availability. Green for available, amber
  for limited, red for on-hold/unavailable creates clear visual hierarchy.
- For patterns that automatically promote queued requests (like hold-to-checkout
  promotion), ensure the UI clearly shows both the primary action result and the
  cascading effect in the activity log. For example, "member-luis returned
  Modular Thoughts; promoted hold for member-jade" followed by "member-jade
  checked out Modular Thoughts via hold" provides complete context about the
  workflow automation.
- Grid layouts with three equal columns work well for displaying item statistics
  (Total, On Loan, Available) within catalog cards. Combining numeric values
  with descriptive labels helps users quickly understand inventory status
  without cognitive load.
- When building forms with multiple operation types (checkout, return, place
  hold, cancel hold), use a 2x2 grid layout to organize related operations
  visually. This creates balanced symmetry while clearly separating different
  workflow actions.
- For image gallery patterns with device-specific variants, using a gradient
  background for image placeholder previews creates visual appeal even before
  real images are loaded. The purple gradient
  (`linear-gradient(135deg,
  #667eea 0%, #764ba2 100%)`) provides good contrast
  with white text.
- When displaying collections of variants in a grid layout, color-coding the
  active variant with a distinct border and background (blue border with light
  blue background) provides immediate visual feedback about which variant is
  currently selected without requiring users to read labels.
- Badge indicators like "ACTIVE" work well as inline elements within headers,
  using high-contrast colors (white text on blue background) to draw attention
  to the current state while maintaining compact visual footprint.
- For patterns that track selection history, displaying the last 5 selections in
  reverse chronological order with arrow separators (e.g., "tablet → mobile →
  desktop") provides useful context about user interaction patterns without
  cluttering the UI.
- For undo/redo stack patterns, the `disabled` attribute on buttons works
  perfectly with derived boolean cells to prevent operations when stacks are
  empty. Use `lift((can: boolean) => !can)(canUndo)` to invert the boolean for
  the disabled state.
- When implementing UI handlers that replicate business handler logic, it's
  cleanest to duplicate the entire handler implementation rather than trying to
  call the original handler. This allows you to read from UI-specific cells
  (like form fields) while maintaining the same state mutation logic.
- Gradient backgrounds on primary value displays create visual hierarchy and
  draw attention to the most important metric. The purple gradient used for the
  current value display provides strong contrast with white text and makes the
  counter value the focal point of the interface.
- For survey/analytics patterns with multiple aggregation dimensions (questions,
  demographics), use color-coded left borders on cards to visually distinguish
  different categories. Assigning different colors to demographic segments
  (rotating through a palette) creates clear visual grouping while maintaining
  consistency across the interface.
- When displaying averaged metrics with color-coded thresholds, use conditional
  coloring based on score ranges (green for high ≥4, orange for medium ≥3, red
  for low <3) to provide instant visual feedback about performance. This works
  well for question averages where users need to quickly identify problem areas.
- Multi-metric summary cards displaying total, count, and average in a 3-column
  grid provide comprehensive insight at a glance. Computing averages with proper
  division-by-zero checks (using ternary operators) prevents NaN values in the
  UI.
- For patterns that accept JSON input via text fields, wrap JSON parsing in
  try/catch blocks within handlers and silently fail (return early) on invalid
  JSON rather than showing error messages. This provides clean UX where invalid
  input is simply ignored until corrected.
- For security tracking patterns with severity-based risk aggregation, use
  color-coded severity cards with distinct colors (red for critical, orange for
  high, yellow for medium, green for low) to provide instant visual hierarchy.
  Display both raw scores and aggregated totals to help users understand risk
  distribution at a glance.
- When building vulnerability management UIs that track multiple systems, sort
  system risk entries by risk score (highest first) with a secondary sort by
  system name for consistent display. This helps security teams prioritize
  remediation efforts by focusing on the highest-risk systems.
- Status badges with conditional colors (red for "open", orange for
  "in_progress", green for "resolved") create clear visual feedback about
  vulnerability lifecycle state. Using uppercase text and distinct background
  colors makes status immediately scannable in dense lists.
- For patterns that filter out resolved items from active views, ensure the risk
  calculations and system counts update reactively as items transition between
  states. This provides accurate real-time metrics as vulnerabilities are
  tracked through registration, update, and resolution.
- For multi-stage approval workflow patterns, create separate UI handlers for
  each action type (approve, reject, reroute) that duplicate the business
  handler logic. This allows form field clearing and provides better UX than
  trying to reuse the business handlers directly.
- When lift functions access derived objects with properties (like counts or
  totals), add defensive null checks at the start of the lift function (e.g.,
  `if (!t || !c || !reqs) return h("div", {}, "Loading...");`) to handle initial
  render before all derived cells are computed. This prevents "Cannot read
  properties of undefined" errors during initialization.
- For procurement/approval workflow UIs, color-coding status badges (green for
  approved, red for rejected, amber for routing/pending) creates immediate
  visual feedback about request state. Apply the same color scheme consistently
  across the request card borders, status badges, and stage indicators to
  reinforce the visual language.
- For patterns demonstrating shared aliases (multiple references to the same
  underlying value), use distinct visual treatments for each alias display
  (e.g., different colored borders for left/right mirrors) while showing the
  same value to clearly communicate that they're synchronized views of a single
  state cell. This helps users understand the aliasing concept at a glance.
- When creating UI handlers that reuse the same input cell for multiple purposes
  (like a shared customAmountField for both increment and step change), ensure
  the handlers clear the field with `.set("")` after successful operations to
  provide clear UX feedback and prevent confusion about which operation will use
  the entered value.
- For argument override patterns that track baseline vs. runtime state, use
  visual distinction between the immutable baseline arguments (displayed in a
  read-only info box) and the active runtime values (shown in the main display
  and modifiable through controls). This helps users understand that overrides
  change runtime state while preserving the original argument baseline.
- The `compute` effect is useful for syncing UI form fields with derived state
  when you want fields to initialize with current values but also allow user
  edits. Check if the field is empty/undefined before setting it to avoid
  overwriting user input mid-edit.
- For timeline/journey visualization patterns, use color-coded status indicators
  (green for completed, blue for in-progress, gray for planned) with matching
  left borders on cards to create clear visual hierarchy. Display both absolute
  timing (day ranges) and duration to provide complete temporal context.
- When building form handlers that accept partial updates to complex objects
  (like milestones with multiple optional fields), check for the presence of
  each field with `Object.hasOwn(event, "fieldName")` before applying updates.
  This allows users to update individual fields without providing all values.
- Progress indicators showing both percentage completion and categorical
  breakdowns (completed/in-progress/planned counts) provide comprehensive status
  at a glance. Use a gradient progress bar with large percentage display for
  visual impact, then show detailed stats in a grid below.
- For patterns that manage ordered collections with sequential timing
  (milestones, schedule segments), ensure the timeline calculation accounts for
  both planned offsets and actual sequencing to prevent overlaps. This keeps
  derived timeline entries consistent with the underlying state.
- For notification preference patterns with channel configuration, using
  color-coded status indicators (green for active, gray for paused) with
  matching backgrounds creates immediate visual feedback about channel states.
  Display both the frequency label and timing window (e.g., "Daily summary
  (08:00 local time)") to provide complete context about when notifications will
  be sent.
- When building configuration UIs that manage multiple related settings (like
  notification channels with enabled/disabled and frequency options), use a
  card-based grid layout for the channel displays with separate control forms
  for toggling and frequency updates. This separates the display of current
  state from the controls that modify it, reducing cognitive load.
- For patterns tracking configuration history, displaying the last 5 changes in
  reverse chronological order with left-border accents provides useful context
  about recent modifications without cluttering the interface. The activity log
  helps users verify their actions were applied correctly.
- For warehouse/logistics patterns with bin occupancy tracking, use conditional
  color-coding based on utilization percentage thresholds: green backgrounds for
  available bins (<80%), yellow/amber for nearly full (80-99%), and red for full
  (100%). Computing utilization as `(used / capacity) * 100` and applying colors
  dynamically in `lift` functions creates immediate visual feedback about
  capacity constraints.
- Progress bars within bin status cards work well when synchronized with the
  same utilization percentage used for background colors. Set the inner progress
  bar width to the utilization percentage with a matching status color for
  visual consistency across the card.
- When displaying inventory items in a warehouse context, alternating row
  backgrounds improve scannability in dense lists. Use monospace fonts for item
  IDs and color-coded badges for bin assignments to create clear visual
  hierarchy between technical identifiers and location information.
- For relocation/transfer patterns where handlers update both primary state and
  history logs, ensure UI handlers replicate the exact business logic including
  capacity validation, duplicate bin checking, and history message formatting.
  Clear form fields after successful operations to provide immediate UX feedback
  that the relocation completed.
- For library/catalog patterns with multi-dimensional filtering (topic, region,
  status), separating the filter display (showing available options with counts)
  from filter application (form inputs) creates clear UX. Display filter options
  as color-coded badges that show active state with distinct borders and
  backgrounds, while keeping filter controls in a separate section below.
- When building UIs with both dynamic content (rendered with `h()` in `lift`)
  and form inputs (requiring `$value` bindings), create separate lifted sections
  for each concern: one lift for headers/summaries, one for filter badges, one
  for the main content list. Then compose them with JSX at the recipe level
  where form inputs are defined, allowing proper `$value` binding to work
  correctly.
- Legal/compliance library patterns benefit from prominent summary metrics at
  the top showing categorical breakdowns (approved/draft/deprecated counts).
  Using a gradient header with large numbers creates visual impact and helps
  users understand the overall state distribution at a glance.
- For status update patterns that modify items by ID, displaying the item ID in
  monospace font within each card helps users copy the exact value needed for
  the update form. Clear form fields with `.set("")` after successful updates
  provides immediate feedback and prepares for the next operation.
- For matrix/grid patterns with dynamic dimensions, use `h()` inside `lift` to
  generate grid layouts where cell styling depends on values. Computing grid
  column count dynamically with string concatenation (e.g.,
  `"grid-template-columns: repeat(" + String(cols + 1) + ", 1fr)"`) creates
  responsive grids that adapt to the matrix dimensions. Color-code cells based
  on value (gray for zero, cyan for non-zero) to create visual emphasis on
  active cells.
- Matrix row and column headers work well as colored boxes (dark background with
  white text) positioned in the first row and first column of the grid. Using
  `R0, R1` and `C0, C1` labels creates compact, scannable headers.
- For patterns with row and column aggregations, display totals in a separate
  section above or below the grid using color-coded badges. Blue badges for row
  totals and pink/magenta badges for column totals creates clear visual
  distinction between the two aggregation dimensions.
- For recipe composition patterns demonstrating parent-child relationships, use
  color-coded cards with distinct colors (cyan for left/first, pink for
  right/second) to visually distinguish the composed child recipes. This helps
  users understand which controls belong to which child instance.
- When displaying aggregate derived values from multiple child recipes (like a
  total from two counters), use a prominent gradient header with large text to
  emphasize the combined result. Including the formula (e.g., "5 + 5") below the
  total helps users understand how the value is computed.
- Progress bars driven by `lift` that compute percentages from aggregated values
  work well for visualizing combined state. Use `h()` to build dynamic progress
  bar elements where the width is computed as a string percentage.
- Child recipe outputs can be accessed via `.key("fieldName")` to display
  child-derived values and bind child-exposed handlers directly in the parent
  UI. This demonstrates how recipe composition allows parent UIs to interact
  with both parent-level and child-level state and actions.
- For checklist/task management patterns with status tracking, use color-coded
  status badges that clearly distinguish between different states (green for
  done, blue for in_progress, red for blocked, gray for pending). Combining
  these with conditional borders on task cards helps reinforce the visual state
  at a glance.
- When displaying collections of items with multiple optional fields (owner,
  note), use conditional rendering with ternary operators that return `null`
  when the field is not present. This keeps the UI clean without showing empty
  placeholder text.
- Progress indicators that combine percentage completion with a visual progress
  bar create strong at-a-glance feedback. Computing the percentage dynamically
  from derived stats and binding it to the progress bar width with `lift`
  ensures the visualization stays synchronized with state changes.
- For patterns with gating logic (e.g., release readiness based on required
  tasks), display both the blocking items and the overall status prominently in
  the header. This helps users understand what needs to be completed before
  proceeding.
- Task sorting that prioritizes required items over optional ones helps users
  focus on critical work first. Combining this with visual distinction (colored
  borders or badges) creates clear hierarchy in task lists.
- For support ticket triage patterns with queue aggregation, use color-coded
  status badges on queue summary cards (green for stable, red for critical) to
  provide immediate visual feedback about queue health. Display key metrics
  (open count, unassigned count, nearest SLA deadline) in a grid layout within
  each queue card for comprehensive at-a-glance status.
- When building triage UIs with multiple action types (assign, escalate), use a
  two-column form layout to separate different operations visually while sharing
  common input fields like ticket ID. This keeps the interface compact while
  supporting multiple distinct workflows.
- Priority-based visual hierarchy works well for ticket lists: use colored left
  borders on ticket cards (red for urgent, orange for high, yellow for medium,
  gray for low) to create instant visual prioritization without requiring users
  to read priority labels first.
- For SLA deadline visualization, use dynamic color coding based on remaining
  time thresholds (e.g., red for ≤4h) to highlight tickets approaching their
  deadlines. This helps support teams identify urgent tickets at a glance.
- For sleep tracking or time-series health patterns, bar chart visualizations of
  weekday averages work well when dynamically scaled relative to the maximum
  value. Compute height percentages in the lift and apply them to inner divs to
  create proportional visual comparisons across categories.
- Health metric patterns benefit from color-coded value displays based on
  recommended ranges (green for optimal 7-9h sleep, amber for acceptable 6-7h,
  red for poor <6h). Computing these colors dynamically in lift functions and
  applying them to prominent metric displays creates immediate feedback about
  health status.
- When displaying collections with multiple attributes (dates, tags, metrics),
  use a combination of typography hierarchy and color-coded badges to create
  scannable layouts. Larger bold text for primary values, smaller subdued text
  for metadata, and colored pill-style badges for categorical tags creates clear
  visual organization.
- Gradient backgrounds work well for form sections to visually separate input
  areas from data display sections. Light complementary gradients (like
  blue-to-purple tints) create visual interest without overwhelming the content
  while providing clear boundaries between UI sections.
- For patterns tracking sessions over time, displaying entries in reverse
  chronological order (newest first) provides better UX, allowing users to see
  their most recent activity immediately without scrolling to the bottom.
- For incident response or operational playbook patterns, use color-coded status
  badges (green for complete, blue for in_progress, red for blocked, gray for
  pending) with matching progress bars to create clear visual hierarchy. Card
  backgrounds can change dynamically (red background for stalled steps) to
  immediately draw attention to items needing escalation.
- When building playbook UIs with multiple step statuses, derive escalation
  state from elapsed vs. expected time thresholds. Display escalation status
  prominently with gradient backgrounds that shift color (green for clear, red
  for required) to provide at-a-glance incident health visibility.
- Progress bars showing time elapsed vs. expected time work well with dynamic
  color coding that matches the status badge color. This creates visual
  consistency across the card while making progress immediately scannable.
- For workflow patterns with HTML select dropdowns, use the standard `onChange`
  event with `e.target.value` to update cell state rather than trying to bind
  `$value` directly to select elements. The `ct-select` component isn't
  available, so native select works better for status/option selection.
- Activity timelines displaying recent actions in reverse chronological order
  with left-border accents provide excellent context for operational patterns.
  Limiting display to last 8 entries prevents clutter while maintaining useful
  audit trail visibility.
- For patterns demonstrating opaque ref maps (array entry cell references), use
  alternating row backgrounds to improve scannability of history lists. Display
  entry indices in monospace font with lighter color to distinguish them from
  values.
- When using `history.key(index)` to get cell references to array entries, the
  returned cell can be cast as `Cell<T>` and modified with `.set()`. This allows
  individual array elements to be rewritten without replacing the entire array,
  demonstrating fine-grained reactivity.
- For rewrite/edit operations on array entries, clear form input fields after
  successful operations with `.set("")` to provide immediate feedback that the
  action completed and prepare for the next operation.
- For healthcare monitoring patterns with threshold-based alerts, use dynamic
  header backgrounds that change color based on alert state (green gradient for
  normal, red gradient for critical alerts). This provides immediate visual
  feedback about patient status without requiring users to scroll or read
  details.
- When building complex UIs with multiple sections (header, latest reading,
  alerts, history, forms), separate the dynamic content into individual `lift`
  functions for each section, then compose them with JSX at the top level. This
  keeps the code maintainable and allows ct-input elements to bind correctly
  with `$value`.
- Multi-vital monitoring UIs benefit from color-coded vital cards with distinct
  color schemes per vital type (blue for heart rate, yellow for blood pressure,
  pink for temperature, green for oxygen). This creates immediate visual
  distinction and helps medical professionals quickly scan values.
- Alert displays with left-border accents (red for warnings) and emoji
  indicators (⚠) create clear visual hierarchy and draw attention to critical
  issues without overwhelming the interface.
- For graph/network patterns with complex state (adjacency, order, cycles),
  compute all derived graph properties once using a single comprehensive lift
  function, then extract individual properties via additional lifts. This avoids
  redundant graph traversals and keeps the topology analysis consistent.
- When rendering dynamic collections with `h()` inside lift functions that need
  to display computed properties from objects passed as parameters, destructure
  the parameter object immediately in the lift function signature to access all
  properties. Pass cells as a single object parameter rather than multiple
  positional arguments to ensure proper reactive tracking.
- Rejection/validation logs displaying recent failures with color-coded reason
  badges (amber for "missing", red for "cycle") provide excellent debugging
  feedback for complex graph operations. Limiting to the last 4-5 entries
  prevents clutter while maintaining useful context about why operations failed.
- For dependency graph patterns, displaying both roots (nodes with no
  dependencies) and execution order (topological sort) helps users understand
  both the starting points and the full sequence of operations. The arrow
  notation (A → B → C) creates clear visual representation of execution flow.
- Status badges that dynamically switch between success (green "VALID GRAPH")
  and error (red "CYCLE DETECTED") states with matching backgrounds and borders
  provide immediate visual feedback about graph validity without requiring users
  to read detailed error messages.
- For funnel analytics patterns with sequential stages, use progressive bar
  chart visualizations where each stage's width scales proportionally to its
  count relative to the maximum stage. Color-code stages with distinct colors
  (blue, purple, pink, orange) to create clear visual distinction while
  maintaining cohesive design language.
- When displaying drop-off metrics between funnel stages, show both absolute
  lost users and percentage drop-off rates side by side in separate metrics
  cards. This dual presentation helps analysts understand both magnitude and
  proportion of funnel leakage.
- Funnel visualization patterns benefit from displaying multiple views: a visual
  funnel chart showing relative stage sizes, detailed drop-off analysis between
  consecutive stages, and summary metrics (overall conversion, worst performing
  stage). This multi-faceted approach provides comprehensive insight.
- For analytics patterns tracking mode-tagged updates (delta vs. value), use
  color-coded badges in history displays (blue for SET operations, purple for
  DELTA operations) to help users distinguish between absolute value changes and
  relative adjustments at a glance.
- For satisfaction tracking or survey analytics patterns with weighted averages
  across channels and time periods, use a prominent gradient header for the
  overall average score with large typography (3.5rem+) to create visual impact.
  Include trend indicators (↗/↘/→) with dynamic color coding (green for rising,
  red for falling, gray for steady) to provide immediate insight into
  trajectory.
- Channel breakdown cards work well when color-coded by performance thresholds
  (green for ≥4.5, amber for ≥3.5, red for <3.5) with matching backgrounds and
  borders. Using `h()` inside `lift` to dynamically generate these cards based
  on the computed channel averages keeps the UI reactive as new data arrives.
- For daily summary displays showing recent activity, limiting to the last 5-7
  entries with `summaries.slice(-7)` prevents UI clutter while providing useful
  context. Build the cards with `h()` in a loop, computing color values before
  JSX to avoid template literal scope issues.
- Multi-field forms for data entry (date, channel, score, count) benefit from
  2-column grid layouts that keep related fields together. Clear all form fields
  with `.set("")` after successful submission to provide immediate feedback and
  ready the form for the next entry.
- For risk assessment patterns with tiered categorization (high/medium/low), use
  distinct color schemes consistently throughout the UI: red for high risk,
  amber/orange for medium, green for low. Apply these colors to borders,
  backgrounds, badges, and text to create immediate visual hierarchy that helps
  users quickly identify critical items without reading detailed scores.
- When displaying collections sorted by risk tier, visual sorting (high to low)
  combined with color-coded cards creates natural scanning patterns. Users can
  quickly identify high-risk items at the top with red borders before scanning
  down through medium (orange) and low (green) risk items.
- Breakdown displays showing computation formulas (rating × weight =
  contribution) help users understand how aggregate risk scores are calculated.
  Use monospace fonts for numeric values and mathematical operators to maintain
  visual alignment and create a calculator-like feel that reinforces the
  computational nature of the data.
- For vendor/entity management patterns with nested response arrays, displaying
  all breakdown items in a scrollable list within each card provides complete
  transparency into risk calculations without requiring additional navigation or
  drill-down interactions.
- For search/ranking patterns with normalized weights, use `compute` effects to
  sync UI input fields with the normalized derived values. This ensures form
  fields always reflect the current normalized state while allowing user edits.
  Check if fields are empty before syncing to avoid overwriting user input
  mid-edit.
- For meal planning or scheduling patterns with grid layouts showing days x time
  slots, use color-coded backgrounds per slot type (e.g., different pastel
  colors for breakfast/lunch/dinner) to create visual distinction. Border colors
  can indicate whether a slot is filled (blue) or empty (gray), providing
  immediate visual feedback about plan completeness.
- Weekly grid layouts with
  `grid-template-columns: repeat(auto-fit, minmax(Npx,
  1fr))` work well for
  responsive day-based schedules that should adapt to different screen widths
  while maintaining readable card sizes.
- When building UIs that display collections of ranked items with detailed score
  breakdowns, use `h()` inside `lift` to dynamically generate cards. Color-code
  top-ranked items differently (e.g., green border and background for #1) to
  create immediate visual hierarchy showing which result leads the ranking.
- For patterns with multi-dimensional scoring (text, clicks, freshness), display
  contribution breakdowns in a grid within each result card. Use distinct colors
  for each dimension consistently across the UI to help users understand how
  different factors contribute to the final score.
- Weight normalization patterns benefit from showing both the input controls and
  the normalized output prominently. Use gradient card backgrounds for weight
  displays with large monospace numbers to create visual impact and emphasize
  the current configuration.
- For design token or theme switching patterns, use a large theme preview box
  that dynamically updates with the current token's colors (background,
  foreground, accent). Display the theme name prominently and show all color
  values in monospace font for technical clarity.
- When building token/theme switchers with history tracking, create separate
  UI-specific handlers that replicate the business logic while adding
  UI-specific functionality like clearing input fields after operations. This
  keeps form inputs responsive and provides clear feedback.
- Visual token lists work well when displaying available tokens as badges with
  conditional styling - use bold borders and colored backgrounds for the active
  token, subtle borders for inactive tokens. This creates immediate visual
  feedback about which token is currently applied.
- For patterns with cycle-through behavior (like token switching), provide both
  a "next" button for quick cycling and a text input for direct token selection.
  This accommodates both exploratory and targeted workflows.
- History displays showing recent token switches should be limited to the last
  5-6 entries displayed in reverse chronological order with left-border accents.
  Empty states should communicate "No switches yet" rather than showing empty
  sections.
