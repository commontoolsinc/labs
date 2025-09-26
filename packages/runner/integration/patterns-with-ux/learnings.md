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

## Testing workflow

- Keep integration tests focused on user journeys: load the charm, perform two
  or three critical actions, and assert visible outcomes.
- Reuse helpers from existing tests for login, charm creation, and teardown so
  runs stay fast and reliable.
- Document flaky behavior or missing harness features here before exiting.
