# Pattern Styling and Theme Guide

This is the current agent-facing guide for styling Common Fabric patterns with
`cf-*` components.

Use this page when you are in a UI polish or UI design pass and need to make a
pattern feel intentional, distinctive, and coherent rather than merely
functional.

## Why This System Works This Way

Common Fabric UI is designed for composition across opaque subtrees.

- Theme and public component affordances are the styling boundary.
- Restyle embedded UI by wrapping it in `cf-theme`, not by reaching into its
  internals.
- Start with component defaults, then use theme tokens, then use documented
  component-specific overrides for local refinement.
- If a needed visual treatment cannot be expressed that way, treat it as a
  design-system gap to address explicitly, or as an `iframe` / artifact case
  where you take full control yourself.

This is intentionally more opinionated than general-purpose CSS. The goal is
safe, composable UI that still gives agents enough room to form a strong visual
point of view.

## Start Here

For pattern-building work, use this guidance stack in order:

1. `skills/pattern-ui/SKILL.md`
2. `docs/common/patterns/style.md`
3. `docs/common/patterns/ui-cookbook.md`
4. `docs/common/components/COMPONENTS.md`
5. `packages/ui/README.md`
6. `packages/ui/LLM-COMPONENT-INSTRUCTIONS.md`

## Design Brief Before Coding

Before writing JSX, decide these things explicitly:

1. **Purpose**: What is the user trying to do here?
2. **Tone**: What visual direction fits the task? Choose something concrete:
   editorial, soft, luxurious, utilitarian, playful, raw, retro-futurist,
   etc.
3. **Memorable hook**: What is the one thing someone should remember about this
   interface?
4. **Constraint strategy**: How will you get there using `cf-*` components,
   local fonts, and public styling hooks?

Do not settle into a generic default app shell. Commit to a direction and make
the UI clearly about that direction.

## Theme-First Workflow

When polishing a non-trivial UI, default to this workflow:

1. Define a `theme` object first.
2. Wrap the main surface in `<cf-theme theme={theme}>`.
3. Build the layout with `cf-screen`, `cf-vstack`, `cf-hstack`, `cf-vgroup`,
   `cf-hgroup`, `cf-card`, and other `cf-*` primitives.
4. When `cf-screen` is part of the layout, put overflow content in an inner
   `cf-vscroll` instead of relying on document scroll.
5. Let the theme carry most of the typography, color, radius, density, and
   motion decisions.
6. Use component-specific CSS custom properties only for local emphasis or
   targeted refinement.

If `cf-theme` is unavailable in the environment, fall back gracefully. If it is
available, prefer it over scattered one-off overrides.

## `cf-theme` Usage

`cf-theme` merges a partial theme object with the default Common Fabric theme
and applies CSS custom properties to a subtree.

```tsx
const theme = {
  fontFamily: "'Georgia', 'Times New Roman', serif",
  borderRadius: "1rem",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  animationSpeed: "normal" as const,
  colors: {
    primary: "#8b4513",
    primaryForeground: "#fff8f0",
    background: "#fff8f0",
    surface: "#fff0e0",
    surfaceHover: "#ffe4cc",
    text: "#2c1810",
    textMuted: "#8b7355",
    border: "#e8d5c0",
    borderMuted: "#f0e6d8",
    accent: "#c84c09",
    accentForeground: "#fff8f0",
    success: "#4a7c59",
    successForeground: "#ffffff",
    error: "#a03020",
    errorForeground: "#ffffff",
    warning: "#b8860b",
    warningForeground: "#ffffff",
  },
};

<cf-theme theme={theme}>
  <cf-screen>
    <cf-heading slot="header" level={2}>Budget tracker</cf-heading>
    <cf-vscroll flex showScrollbar fadeEdges>
      <cf-vstack gap="4" padding="4">
        {/* themed UI */}
      </cf-vstack>
    </cf-vscroll>
  </cf-screen>
</cf-theme>;
```

## Full-Height Layout Rule

`cf-screen` is a full-surface frame, not an automatically scrolling page.

- If the content can exceed one screen, wrap it in `cf-vscroll` inside
  `cf-screen`.
- If the layout is wider than one viewport, introduce a deliberate `cf-hscroll`
  region.
- Do not place a long `cf-vstack` directly under `cf-screen` and assume the
  shell or document will scroll for you.

Verified top-level theme fields:

- `fontFamily`
- `monoFontFamily`
- `fontSize`
- `borderRadius`
- `density`
- `colorScheme`
- `animationSpeed`
- `colors`

Supported pattern-style aliases:

- `accentColor`
- `fontFace`

See:

- `packages/ui/src/v2/components/cf-theme/cf-theme.ts`
- `packages/ui/src/v2/components/theme-context.ts`

## What `cf-theme` Emits

`cf-theme` applies concrete CSS custom properties to the themed subtree.

### Typography, Radius, Motion

- `--cf-theme-font-family`
- `--cf-theme-mono-font-family`
- `--cf-theme-font-size`
- `--cf-theme-border-radius`
- `--cf-theme-animation-duration`

### Colors

- `--cf-theme-color-primary`
- `--cf-theme-color-primary-foreground`
- `--cf-theme-color-secondary`
- `--cf-theme-color-secondary-foreground`
- `--cf-theme-color-background`
- `--cf-theme-color-surface`
- `--cf-theme-color-surface-hover`
- `--cf-theme-color-text`
- `--cf-theme-color-text-muted`
- `--cf-theme-color-border`
- `--cf-theme-color-border-muted`
- `--cf-theme-color-success`
- `--cf-theme-color-success-foreground`
- `--cf-theme-color-error`
- `--cf-theme-color-error-foreground`
- `--cf-theme-color-warning`
- `--cf-theme-color-warning-foreground`
- `--cf-theme-color-accent`
- `--cf-theme-color-accent-foreground`

### Spacing

- `--cf-theme-spacing-tight`
- `--cf-theme-spacing-normal`
- `--cf-theme-spacing-loose`
- `--cf-theme-spacing-padding-message`
- `--cf-theme-spacing-padding-code`
- `--cf-theme-spacing-padding-block`

These are the right starting point for most visual decisions.

## Component-Specific Refinement

After setting a theme, refine individual components through their documented
custom properties rather than by guessing at internal DOM structure.

Examples from current component implementations:

- `cf-card`
  - `--cf-card-color-surface`
  - `--cf-card-color-border`
  - `--cf-card-border-radius`
- `cf-button`
  - `--cf-button-color-primary`
  - `--cf-button-color-surface`
  - `--cf-button-border-radius`
- `cf-input`
  - `--cf-input-color-border`
  - `--cf-input-color-primary`
  - `--cf-input-border-radius`
- `cf-badge`
  - `--cf-badge-color-primary`
  - `--cf-badge-color-secondary`
- `cf-hstack` / `cf-vstack`
  - `--cf-hstack-gap-*`, `--cf-hstack-padding-*`
  - `--cf-vstack-gap-*`, `--cf-vstack-padding-*`

Use these local overrides when a single component needs special treatment. Do
not use them as a substitute for defining an overall theme.

## Aesthetic Guidance

### Typography

- Prefer distinctive local font stacks or deliberate pairings.
- Avoid generic Arial/Inter/system defaults unless the concept is intentionally
  plain.
- Use the theme to make typography consistent across the surface.

### Color

- Choose one dominant palette with a clear accent.
- Prefer strong foreground/background contrast and intentional muted tones over
  evenly distributed safe neutrals.
- Let `background`, `surface`, `text`, `border`, `primary`, and `accent` do
  most of the work.

### Composition

- Use layout primitives first: `cf-screen`, `cf-vstack`, `cf-hstack`,
  `cf-vgroup`, `cf-hgroup`, `cf-card`, `cf-vscroll`, `cf-hscroll`.
- Group related information. Avoid raw form dumps.
- Make overflow explicit. A polished full-height layout is still broken if the
  lower sections cannot be reached.
- Use whitespace, overlap, layered surfaces, or asymmetry when the concept
  calls for it.

### Atmosphere

- Use gradients, borders, shadows, translucency, or textures when they support
  the chosen direction.
- Keep decorative detail coherent with the theme. Maximalism still needs
  discipline; minimalism still needs character.

## Working Examples

Use these as concrete references for theme-forward UI composition:

- `packages/patterns/catalog/stories/vignette-recipe-story.tsx`
  Warm editorial light theme with serif typography and layered surfaces.
- `packages/patterns/catalog/stories/vignette-finance-story.tsx`
  Dark dashboard-style theme with strong contrast and metric cards.
- `packages/patterns/catalog/stories/`
  Component stories for smaller component-specific usage.

## Avoid

- generic, unopinionated default shells
- scattered hard-coded colors without a shared theme object
- guessed shadow-internal selectors
- styling every element manually instead of using the theme and component
  variables
- copying production pattern data flow just to borrow a visual look

## Working Rule

If the UI needs to look polished, the first question should usually be:

> What is the theme and what is the visual point of view?

Not:

> Which random inline styles should I add to make this less plain?
