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
