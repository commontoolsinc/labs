# Pattern Development Guide

This is the agent-neutral reference for building Common Fabric patterns.

## Core Working Style

- Plan before building. Scale the plan to the problem size.
- Start simple and keep the first implementation runnable.
- Prefer one-file patterns first. Split files only when complexity demands it.
- Iterate through `Sketch -> Run -> Verify -> Improve`.

## Verification Loop

Use the runtime, not just static reasoning:

- `deno task ct check <pattern>.tsx`
- `deno task ct check <pattern>.tsx --no-run` for faster type validation
- `deno task ct test <pattern>.test.tsx` when tests are justified

Each increment should be small enough that you can check it immediately.

## Structure Guidance

Start with:

```text
packages/patterns/<name>/main.tsx
```

Only split into `schemas.tsx` or additional modules when:

- types become hard to follow
- a helper has clear reuse value
- the main file becomes harder to evolve than to split

## Action vs Handler

Default to `action()` when the behavior is specific to one pattern instance and
can close over pattern-local state.

Use `handler()` when:

- you need different bound data per instantiation
- the same implementation is reused across items or contexts
- you are binding per-item behavior inside `.map()`

Decision rule:

- if the behavior needs different data at different call sites, use `handler()`
- otherwise, use `action()`

## Common Pitfalls

- Do not use `computed()` to gate JSX sections; use JSX conditionals directly.
- Do not call `.set()` on upstream cells from inside `computed()`.
- Do not write finished code upfront; get something running early.
- Keep composed pattern input/output names aligned exactly.
- Prefer docs and validated references over copying existing pattern code blindly.
