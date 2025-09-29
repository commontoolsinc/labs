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

## Playwright + MCP tips

- Capture screenshots at meaningful checkpoints and note any visual quirks in
  this file.
- Use `page.locator` with semantic selectors (data attributes, ids) rather than
  styling hooks.
- Wait on explicit UI signals (text, aria attributes) instead of arbitrary
  sleeps whenever possible.
