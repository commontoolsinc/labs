# Pattern Styling Guide

> Placeholder: this page is intentionally a skeleton. It exists to reserve the
> canonical location for future detailed styling guidance for Common Fabric
> patterns.

This document is **not** currently the authoritative source for detailed style
rules. It should be treated as a roadmap for the guidance we want to write,
not as settled guidance about what styling patterns agents should prefer today.

## Current Status

What this page is:

- a placeholder for future styling guidance
- a pointer to the best current references
- a record of the topics the eventual guide should cover

What this page is not:

- a full theming guide
- a complete reference for component styling APIs
- the source of truth for every current syntax/detail question

## Use These Sources Today

Until this guide is filled in, use these references instead:

- `docs/common/components/COMPONENTS.md`
  For component APIs, layout primitives, and component-specific usage notes.
- `docs/common/patterns/two-way-binding.md`
  For `$value` / `$checked` binding behavior on interactive components.
- `packages/ui/README.md`
  For current notes on CSS custom properties and parts.
- `packages/ui/LLM-COMPONENT-INSTRUCTIONS.md`
  For agent-oriented component examples and current styling examples.

## Planned Sections

The eventual version of this document should cover at least:

1. Theme primitives and `cf-theme`
2. CSS custom properties exposed by core components
3. CSS parts exposed by core components
4. Layout composition patterns using `cf-screen`, `cf-vstack`, `cf-hstack`,
   `cf-card`, and related primitives
5. Guidance for mixing native HTML structure with `cf-*` components
6. Examples of polished visual hierarchy, spacing, and grouping
7. Component-specific styling gotchas and anti-patterns

## Interim Guidance

Until the detailed guide exists:

- treat styling decisions as an active area of documentation work
- prefer current component docs and examples over stale cargo-cult rules
- when a component exposes custom properties or parts, prefer those over
  guessing at unsupported internals
- document good-looking, working patterns when you find them so they can be
  promoted into this guide later
