---
name: pattern-ui
description: Add UI polish with layout and styling
user-invocable: false
---

# UI Polish Phase

Only do this AFTER all logic is verified and tests pass.

## Read First

- `docs/common/patterns/style.md` - Canonical entry point and roadmap for
  pattern styling guidance
- `docs/common/components/COMPONENTS.md` - Full component reference
- `docs/common/patterns/ui-cookbook.md` - Compact layout and empty-state
  examples
- `docs/common/patterns/two-way-binding.md` - $value, $checked bindings
- `packages/ui/README.md` - Current notes on CSS custom properties and parts
- `packages/ui/LLM-COMPONENT-INSTRUCTIONS.md` - Agent-oriented component and
  styling examples

Treat `docs/common/patterns/style.md` as the canonical entry point for this
topic, but remember that it is still a roadmap plus interim guidance rather than
the finished detailed style guide.

## Visual Priorities

Aim for:

- clear visual hierarchy
- consistent spacing rhythm
- calm grouping and sectioning
- usable empty and first-run states
- controls that support the main task rather than dominating the screen

## Theme Stance

- If `cf-theme` is already available in the environment, prefer using it
  intentionally.
- If `cf-theme` is not already available, do not assume it blindly.
- Prefer public styling affordances such as CSS custom properties and parts over
  guessing at unsupported internals.

## Available Components

Layout: `cf-screen`, `cf-vstack`, `cf-hstack` Input: `cf-input`, `cf-textarea`,
`cf-checkbox`, `cf-select` Action: `cf-button` Display: `cf-label`,
`cf-heading`, `cf-badge`, `cf-alert`

## Key Patterns

**Two-way binding:**

```tsx
<cf-input $value={field} />
<cf-checkbox $checked={done} />
```

**Layout structure:**

```tsx
<cf-screen title="My Pattern">
  <cf-vstack gap="md">
    <cf-hstack gap="sm">
      {/* horizontal items */}
    </cf-hstack>
  </cf-vstack>
</cf-screen>;
```

## Reference Existing Patterns

Search `packages/patterns/` for UI layout examples ONLY (not data/action
patterns).

## Done When

- UI renders correctly
- Bindings work (typing updates state)
- No regression in data behavior
- layout and grouping feel intentional
- empty or first-run states are not neglected
