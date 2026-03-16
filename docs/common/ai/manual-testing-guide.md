# Manual Testing Guide

This is the agent-neutral reference for runtime validation of Common Fabric
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
on their own.

## Browser Validation Loop

When using `agent-browser` or an equivalent browser harness:

1. clear or isolate stale browser state when needed
2. open the deployed pattern
3. snapshot the page and interact
4. re-snapshot after DOM-changing actions
5. capture screenshots at key states

## Runtime Debugging

When behavior is unclear:

- inspect cell values
- inspect rendered VDOM state
- check for non-idempotent updates
- verify action schema expectations

## Test Report Expectations

The report should include:

- environment details
- what flows were tested
- what passed
- what failed
- severity-tagged issues
- any constraints that limited coverage
