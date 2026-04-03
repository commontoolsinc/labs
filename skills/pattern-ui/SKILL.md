---
name: pattern-ui
description: Add UI polish with layout and styling
user-invocable: false
---

# UI Polish Phase

Only do this AFTER all logic is verified and tests pass.

## Read First

- `docs/common/components/COMPONENTS.md` - Full component reference
- `docs/common/patterns/style.md` - Placeholder roadmap for future detailed
  styling guidance; not authoritative yet
- `docs/common/patterns/two-way-binding.md` - $value, $checked bindings
- `packages/ui/README.md` - Current notes on CSS custom properties and parts
- `packages/ui/LLM-COMPONENT-INSTRUCTIONS.md` - Agent-oriented component and
  styling examples

Treat `docs/common/patterns/style.md` as a placeholder location for future
guidance, not as the source of truth for detailed styling rules.

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
