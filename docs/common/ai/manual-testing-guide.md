# Manual Testing Guide

This is the canonical reference for runtime validation of Common Fabric
patterns.

## Core Goals

- deploy the pattern in a representative environment
- verify key flows through both CLI and UI where appropriate
- record findings with severity and reproduction notes

## CLI Validation Loop

For handler-based checks:

1. deploy or update the pattern
2. call the handler
3. run `piece step`
4. inspect resulting state

Always remember that `piece set` and `piece call` do not trigger recomputation
on their own. The follow-up `piece step` is part of the test, not optional
cleanup.

## Browser Validation Loop

When using `agent-browser` or an equivalent browser harness:

1. open the deployed pattern
2. snapshot the page and capture interactive refs
3. interact using those refs
4. re-snapshot after navigation or DOM-changing actions
5. capture screenshots at key states

Typical command shape:

```bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser click @e1
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser screenshot
```

## Browser State and Session Discipline

- isolate stale browser state when a previous login, draft, or cached view can
  influence the test
- save and reload browser state only when persistence is intentional
- use separate named sessions when comparing environments or parallel flows
- remember that refs become stale after page transitions or significant DOM
  updates

## Headed vs Headless

Use a headed browser session when:

- layout debugging matters
- you need to visually confirm motion, overlays, hover behavior, or focus
- the page is difficult to reason about from snapshots alone

Use headless/browser snapshots when:

- the flow is straightforward
- you need speed and repeatability
- visual confirmation is not the main question

## Runtime Debugging

When behavior is unclear:

- inspect cell values
- inspect rendered VDOM state
- check for non-idempotent updates
- verify action schema expectations
- confirm that any identity-sensitive logic is not being masked by a CLI-only
  test path

One known limitation is that CLI-driven calls with plain JSON objects may not
exercise identity-sensitive `equals()` behavior the same way the browser does.
For handlers that depend on identity comparisons, browser testing is the more
reliable verification path.

## Common `agent-browser` Patterns

### Form submission

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i
```

### Authentication with saved state

```bash
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json
```

### Parallel sessions

```bash
agent-browser --session baseline open https://site-a.example
agent-browser --session candidate open https://site-b.example
agent-browser session list
```

## Test Report Expectations

The report should include:

- environment details
- what flows were tested
- what passed
- what failed
- severity-tagged issues
- screenshots or artifact references when relevant
- any constraints that limited coverage
