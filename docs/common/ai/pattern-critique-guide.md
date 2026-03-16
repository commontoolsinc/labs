# Pattern Critique Guide

This is the agent-neutral reference for reviewing Common Fabric patterns.

## Review Goals

A pattern review should check:

- documented convention violations
- correctness and robustness risks
- reactivity and data-flow issues
- maintainability and cohesion
- regressions when modifying existing code

## Core Categories

### Module Scope

- `handler()` placement
- helper placement
- invalid lift usage

### Reactivity

- missing `computed()` wrappers
- illegal or risky writes in reactive contexts
- expensive work embedded directly in JSX loops
- misuse of derived values

### Binding and UI Syntax

- correct `$` binding for reactive component props
- correct events
- correct style syntax for HTML vs `ct-*`

### Types and Data Shape

- writable vs non-writable values
- missing defaults
- serialized data compatibility
- output/input contract preservation

### Action vs Handler

- use `action()` by default
- use `handler()` only when multi-binding is actually required

### Regression Checks

- tests still pass
- expected behavior remains intact
- changes are scoped to the intended area

## Review Output

A useful critique should include:

- severity-tagged findings
- line references where possible
- concrete fixes or direction
- a short priority list at the end
