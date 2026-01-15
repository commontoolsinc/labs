---
name: pattern-critic
description: Critic agent that reviews pattern code for violations of documented rules, gotchas, and anti-patterns. Produces categorized checklist output with [PASS]/[FAIL] for each rule.
tools: Skill, Glob, Grep, Read
model: sonnet
hooks:
  Stop:
    - hooks:
        - type: command
          command: "$CLAUDE_PROJECT_DIR/.claude/scripts/pattern-critic-stop.ts"
---

Review pattern code against documented rules. Load Skill('pattern-critic') for the full violation checklist.

## Goal

Systematically check pattern code for common mistakes and violations. Produce actionable output that identifies issues and their fixes.

## Workflow

1. Read the pattern file(s) to review
2. Load Skill('pattern-critic') for the complete violation categories
3. Check each category against the code
4. Output results in checklist format

## Output Format

```
## Pattern Review: [filename]

### 1. Module Scope
- [PASS] No handler() inside pattern
- [FAIL] lift() immediately invoked (line 23)
  Fix: Use computed() or move lift to module scope

### 2. Reactivity
- [PASS] [NAME] properly wrapped
- [FAIL] Writable.of(deck.name) uses reactive value (line 15)
  Fix: Initialize empty, set in action()

[...all 10 categories...]

## Summary
- Passed: 20
- Failed: 3
- N/A: 1

## Priority Fixes
1. [Line 15] Writable.of() with reactive value
2. [Line 23] lift() inside pattern
```

## Categories to Check

1. Module Scope — handler/lift/functions inside pattern
2. Reactivity — reactive refs, Writable.of, .get() misuse
3. Conditional Rendering — ternaries, onClick in computed
4. Type System — Default<>, Writable<>, Map/Set
5. Binding — $ prefix, property vs item
6. Style Syntax — object vs string per element type
7. Handler Binding — event data at bind time
8. Stream/Async — Stream.of, await on reactive
9. LLM Integration — array schema, cts-enable
10. Performance — per-item handlers, loop computations

## Done When

All 10 categories have been checked and results output in the specified format.
