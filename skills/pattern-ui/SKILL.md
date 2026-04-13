---
name: pattern-ui
description: Add UI polish with layout and styling
user-invocable: false
---

# UI Polish Phase

Only do this AFTER all logic is verified and tests pass.

## Read First, In Order

- `docs/common/patterns/style.md` - Theme-first UI guidance and design process
- `docs/common/patterns/ui-cookbook.md` - Themed layout scaffolds and vignette
  references
- `docs/common/components/COMPONENTS.md` - Full component reference
- `docs/common/patterns/two-way-binding.md` - $value, $checked bindings
- `packages/ui/README.md` - Current notes on CSS custom properties and parts
- `packages/ui/LLM-COMPONENT-INSTRUCTIONS.md` - Agent-oriented component and
  theme system notes
- `packages/patterns/catalog/stories/vignette-recipe-story.tsx` - warm,
  editorial light vignette
- `packages/patterns/catalog/stories/vignette-finance-story.tsx` - dark,
  dashboard-style vignette

## Visual Priorities

Aim for:

- clear visual hierarchy
- consistent spacing rhythm
- calm grouping and sectioning
- usable empty and first-run states
- controls that support the main task rather than dominating the screen
- a memorable aesthetic point of view rather than a generic default app shell

## Design Brief Before Coding

Before touching JSX, decide all of the following:

- **Purpose**: What is this interface helping the user do?
- **Tone**: Pick a concrete direction such as editorial, playful, luxurious,
  brutalist, retro-futurist, soft, or utilitarian.
- **Hook**: What is the one visual idea someone will remember?
- **Constraint strategy**: How will you get that look with `cf-*` components,
  local fonts, and public CSS custom properties?

Do not drift into an undifferentiated default. Commit to a direction and execute
it cleanly.

## Theme-First Workflow

When polishing a non-trivial UI, default to this workflow:

1. Define a `theme` object first.
2. Wrap the main surface in `<cf-theme theme={theme}>`.
3. Compose the layout with `cf-screen`, `cf-vstack`, `cf-hstack`, `cf-vgroup`,
   `cf-hgroup`, and `cf-card`.
4. If content can exceed one viewport, put the body content inside `cf-vscroll`
   (or `cf-hscroll` for wide tabular content) rather than placing a long stack
   directly under `cf-screen`.
5. Let the theme carry most of the color / type / radius / density decisions.
6. Use component-specific custom properties only for local emphasis or one-off
   refinement.

If `cf-theme` is clearly unavailable in the environment, fall back gracefully.
Otherwise, prefer it over scattered ad hoc overrides.

## Why This Works

- Embedded UI should be themed through context and public styling hooks, not by
  inspecting or mutating its internals.
- The component set is intentionally opinionated. Defaults plus theme tokens
  should carry most of the visual system.
- If public theme/hooks are not enough, treat that as either a design-system gap
  worth naming or an `iframe` / artifact case, not an excuse to guess at
  unsupported structure.

## Available Components

Layout: `cf-theme`, `cf-screen`, `cf-vstack`, `cf-hstack`, `cf-vgroup`,
`cf-hgroup`, `cf-card`, `cf-vscroll`, `cf-hscroll` Input: `cf-input`,
`cf-textarea`, `cf-checkbox`, `cf-select` Action: `cf-button`, `cf-chip`
Display: `cf-label`, `cf-heading`, `cf-badge`, `cf-alert`

## Aesthetic Guidance

- **Typography**: Prefer distinctive local font stacks and thoughtful pairings.
  Avoid generic Arial/Inter/system defaults unless the brief is intentionally
  austere.
- **Color**: Use a dominant palette with a clear accent, not evenly distributed
  safe colors.
- **Composition**: Use overlap, asymmetry, controlled density, or deliberate
  whitespace when the concept calls for it.
- **Atmosphere**: Use gradients, layered surfaces, borders, shadows, or subtle
  texture when they reinforce the chosen direction.
- **Restraint**: Minimal interfaces still need precision and a point of view.

Avoid generic AI-looking UI: timid white cards, purple-gradient-on-white
defaults, or layouts that read like a raw form dump.

## Key Patterns

**Two-way binding:**

```tsx
<cf-input $value={field} />
<cf-checkbox $checked={done} />
```

**Layout structure:**

```tsx
<cf-screen>
  <cf-heading slot="header" level={2}>My Pattern</cf-heading>
  <cf-vscroll flex showScrollbar fadeEdges>
    <cf-vstack gap="4" padding="4">
      <cf-hstack gap="3">
        {/* horizontal items */}
      </cf-hstack>
    </cf-vstack>
  </cf-vscroll>
</cf-screen>;
```

**Theme wrapper:**

```tsx
const theme = {
  fontFamily: "'Georgia', 'Times New Roman', serif",
  borderRadius: "1rem",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#8b4513",
    primaryForeground: "#fff8f0",
    background: "#fff8f0",
    surface: "#fff0e0",
    text: "#2c1810",
    textMuted: "#8b7355",
    border: "#e8d5c0",
    accent: "#c84c09",
    accentForeground: "#fff8f0",
  },
};

<cf-theme theme={theme}>
  <cf-screen>
    <cf-heading slot="header" level={2}>My Pattern</cf-heading>
    <cf-vscroll flex>
      {/* ... */}
    </cf-vscroll>
  </cf-screen>
</cf-theme>;
```

## Reference Existing Patterns

Prefer these before browsing arbitrary pattern code:

- `packages/patterns/catalog/stories/vignette-recipe-story.tsx`
- `packages/patterns/catalog/stories/vignette-finance-story.tsx`
- component stories in `packages/patterns/catalog/stories/`

Use existing production patterns only when you specifically need to understand a
domain flow, not as the first place to copy styling from.

## Done When

- UI renders correctly
- Bindings work (typing updates state)
- No regression in data behavior
- layout and grouping feel intentional
- empty or first-run states are not neglected
- a `cf-theme` strategy is used intentionally when available
- the result has a clear visual idea rather than a generic default shell
- full-height layouts remain scrollable when content exceeds one screen
