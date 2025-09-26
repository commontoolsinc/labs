# Patterns with UX learnings

Add short notes after each run so the next agent can build on proven approaches.

## UI guidelines

- Drive the UI from sanitized derives; never tap raw event payloads in JSX.
- Prefer ct primitives (`ct-button`, `ct-field`, `ct-card`, etc.) for consistent
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
