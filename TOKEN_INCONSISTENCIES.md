# Token Inconsistencies Review

This document tracks the token, styling, and API inconsistencies found during an initial review of the core Common UI v2 components.

Scope reviewed:

- `cf-button`
- `cf-card`
- `cf-list-item`
- `cf-tab-bar`
- `cf-tabs`
- `cf-modal`
- `cf-vstack`
- `cf-hstack`
- `cf-vscroll`
- `cf-hscroll`
- `cf-toast`
- `cf-label`
- `cf-grid`
- `cf-separator`
- `cf-code-editor`
- `cf-badge`
- `cf-chip`
- `packages/patterns/mobile-app-demo.tsx`
- related story and Figma mapping files

## Status Legend

- `open`: identified and not yet addressed
- `needs-decision`: requires API or design-system choice before implementation
- `follow-up`: not a blocker for token cleanup, but should be cleaned during the same pass

## Issues

| ID | Status | Severity | Category | Summary |
| --- | --- | --- | --- | --- |
| TI-001 | open | high | token-contract | Components use token namespaces that do not exist in the canonical variable set |
| TI-002 | open | high | token-contract | Theme layer does not emit some semantic aliases that components expect |
| TI-003 | open | high | layout | Layout primitives duplicate spacing and padding scales instead of consuming shared tokens |
| TI-004 | needs-decision | high | component-overlap | `cf-badge`, `cf-chip`, and `cf-button[variant="pill"]` overlap as separate pill systems |
| TI-005 | open | medium | typography | Typography roles are encoded locally instead of through shared text tokens/recipes |
| TI-006 | open | medium | surfaces | Card, modal, and toast each define their own surface recipe |
| TI-007 | open | medium | stale-styles | Some components ship stale or alternate style exports that are not the actual runtime styles |
| TI-008 | needs-decision | medium | semantics | `cf-label` is being used as both a form label and a generic muted text component |
| TI-009 | open | medium | adoption | Theme integration is inconsistent across components |
| TI-010 | follow-up | medium | product-signal | `mobile-app-demo` relies on many inline overrides, indicating missing primitives/tokens |
| TI-011 | follow-up | medium | docs-stories | Stories and Figma mappings drift from actual component APIs |
| TI-012 | open | low | motion | Motion timings and easing are inconsistently tokenized |
| TI-013 | open | low | breakpoints | Breakpoints and structural widths are embedded locally rather than referenced semantically |

## Detailed Tracking

### TI-001: Non-canonical token namespaces in live components

Severity: high

Problem:

- The canonical variable source is `packages/ui/src/v2/styles/variables.ts`, which exports `--cf-colors-*`, `--cf-spacing-*`, `--cf-border-radius-*`, and related names.
- Some reviewed components use different fallback namespaces such as `--cf-color-*`, `--cf-color-neutral-*`, and `--ring-alpha`.
- Those names are not defined in the canonical token export, so these components quietly fall back to hard-coded color literals and bypass the shared design system.

Affected files:

- `packages/ui/src/v2/components/cf-chip/cf-chip.ts`
- `packages/ui/src/v2/components/cf-code-editor/styles.ts`
- `packages/ui/src/v2/styles/variables.ts`

Examples:

- `cf-chip` uses `--cf-color-gray-100`, `--cf-color-gray-900`, `--cf-color-blue-50`, `--cf-color-purple-700`
- `cf-code-editor` uses `--cf-color-neutral-50`, `--cf-color-primary-600`, `--cf-color-warning-700`, `--ring-alpha`

Why it matters:

- The token contract is not trustworthy if components can spell token names differently and still compile.
- This blocks systematic palette cleanup.

Recommended direction:

- Define one canonical namespace policy and migrate all live components to it.
- Prefer `--cf-colors-*` and semantic `--cf-theme-color-*` aliases only.
- Remove ad hoc fallback namespaces from component styles.

### TI-002: Theme emits fewer semantic tokens than components expect

Severity: high

Problem:

- `applyThemeToElement()` emits semantic tokens like `--cf-theme-color-primary`, `--cf-theme-color-surface`, `--cf-theme-color-surface-hover`, and `--cf-theme-color-text-muted`.
- `cf-chip` expects tokens like `--cf-theme-color-primary-surface` and `--cf-theme-color-accent-surface`.
- Those aliases are not emitted by the theme layer.

Affected files:

- `packages/ui/src/v2/components/theme-context.ts`
- `packages/ui/src/v2/components/cf-chip/cf-chip.ts`

Why it matters:

- Even when a component appears theme-aware, parts of its styling may still resolve to local fallback colors.
- This creates false confidence in the theme system.

Recommended direction:

- Either add the missing semantic aliases to the theme contract or stop referencing them in components.
- Avoid inventing component-local semantic names unless they are first-class theme tokens.

### TI-003: Layout primitives duplicate the spacing system

Severity: high

Problem:

- `cf-vstack`, `cf-hstack`, `cf-grid`, `cf-vscroll`, and `cf-hscroll` all hard-code spacing and padding ladders directly into component CSS.
- The repo already has shared spacing tokens in `variables.ts`.
- Density-aware spacing also exists in `theme-context.ts`, but the layout primitives do not consume it in a coherent way.

Affected files:

- `packages/ui/src/v2/components/cf-vstack/cf-vstack.ts`
- `packages/ui/src/v2/components/cf-hstack/cf-hstack.ts`
- `packages/ui/src/v2/components/cf-grid/cf-grid.ts`
- `packages/ui/src/v2/components/cf-vscroll/cf-vscroll.ts`
- `packages/ui/src/v2/components/cf-hscroll/cf-hscroll.ts`
- `packages/ui/src/v2/styles/variables.ts`
- `packages/ui/src/v2/components/theme-context.ts`

Examples:

- repeated `0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `1.25rem`, `1.5rem`
- repeated padding utility classes
- local scrollbar widths and fade-edge dimensions
- local responsive breakpoints in `cf-grid`

Why it matters:

- These components are foundational.
- If they do not share one spacing model, every higher-level component will drift.

Recommended direction:

- Treat layout as one migration slice.
- Replace local scales with shared spacing tokens or semantic spacing aliases.
- Decide whether numeric utility props map to `--cf-spacing-*` or to the Figma size scale, but not both at once.

### TI-004: Pill family overlap across badge, chip, and button

Severity: high

Status: needs-decision

Problem:

- `cf-badge`, `cf-chip`, and `cf-button` with `variant="pill"` all occupy overlapping visual territory.
- Each defines its own radius, padding, color semantics, and interactivity model.

Affected files:

- `packages/ui/src/v2/components/cf-badge/cf-badge.ts`
- `packages/ui/src/v2/components/cf-chip/cf-chip.ts`
- `packages/ui/src/v2/components/cf-button/styles.ts`

Observed differences:

- `cf-badge` is status-oriented and removable
- `cf-chip` is category/tag-oriented and optionally interactive/removable
- `cf-button.pill` is action-oriented but styled as a third pill recipe

Why it matters:

- This is where roundness, compact padding, and semantic color usage are already drifting.
- It will get worse if all three continue evolving independently.

Recommended direction:

- Decide whether the system wants:
- one pill primitive with role/variant wrappers
- or separate badge/chip/action concepts with a shared shape/size token recipe

### TI-005: Typography roles are local and inconsistent

Severity: medium

Problem:

- Typography values are embedded directly inside components rather than expressed as shared text roles.
- Components encode local ideas of “small text”, “secondary text”, “title”, and “compact label”.

Affected files:

- `packages/ui/src/v2/components/cf-list-item/cf-list-item.ts`
- `packages/ui/src/v2/components/cf-card/cf-card.ts`
- `packages/ui/src/v2/components/cf-label/cf-label.ts`
- `packages/ui/src/v2/components/cf-code-editor/styles.ts`

Examples:

- `cf-list-item` uses `font-size: 0.8125rem`, `font-weight: 510`, `description-size: 0.75rem`
- `cf-card` title slot uses `1.5rem` and description uses `0.875rem`
- `cf-label` hard-codes `0.875rem` and `500`
- `cf-code-editor` prose mode defines its own heading scale and inline code treatment

Why it matters:

- Text styling becomes component-specific instead of systemic.
- It is hard to compare against Figma when roles are implicit.

Recommended direction:

- Extract a small set of typography roles first: field label, body small, body, caption, section title, card title, muted meta.
- Map components to those roles rather than one-off sizes.

### TI-006: Surface recipe divergence

Severity: medium

Problem:

- `cf-card`, `cf-modal`, and `cf-toast` each define their own surface geometry and elevation.
- Radius, padding, background, border, hover, and shadow are not coming from one shared “surface” recipe.

Affected files:

- `packages/ui/src/v2/components/cf-card/cf-card.ts`
- `packages/ui/src/v2/components/cf-modal/styles.ts`
- `packages/ui/src/v2/components/cf-toast/cf-toast.ts`

Examples:

- `cf-card` title/content/footer padding is local
- `cf-modal` uses local widths `320px`, `500px`, `700px`, local `16px/20px` spacing, local shadows
- `cf-toast` uses its own min/max width, padding, blur, and shadow

Why it matters:

- Surfaces are one of the strongest visible signals of system coherence.

Recommended direction:

- Define surface tiers such as plain, elevated, overlay, transient.
- Tokenize radius, border, inset padding, and shadow per tier.

### TI-007: Stale or alternate style exports create drift

Severity: medium

Problem:

- Some components have standalone `styles.ts` exports that do not match the styles actually used at runtime.
- In some cases those alternate styles are still re-exported from `index.ts`.

Affected files:

- `packages/ui/src/v2/components/cf-label/styles.ts`
- `packages/ui/src/v2/components/cf-badge/styles.ts`
- `packages/ui/src/v2/components/cf-tabs/styles.ts`
- `packages/ui/src/v2/components/cf-separator/styles.ts`
- `packages/ui/src/v2/components/cf-tabs/index.ts`
- `packages/ui/src/v2/components/cf-separator/index.ts`

Why it matters:

- Reviewing the package becomes harder because there are two style sources for one component.
- External consumers may import stale style exports and assume they are canonical.

Recommended direction:

- Remove or clearly deprecate dead style exports.
- Keep one runtime-authoritative style source per component.

### TI-008: `cf-label` has mixed semantic responsibilities

Severity: medium

Status: needs-decision

Problem:

- `cf-label` is implemented as a form label with focus/click targeting behavior.
- In product usage it is also used as generic muted text and metadata text.

Affected files:

- `packages/ui/src/v2/components/cf-label/cf-label.ts`
- `packages/patterns/mobile-app-demo.tsx`

Why it matters:

- A form label primitive and a generic text primitive should not be the same thing.
- Typography and semantics become entangled.

Recommended direction:

- Narrow `cf-label` to form semantics only, or introduce a separate generic text component and migrate non-form use cases.

### TI-009: Theme integration is inconsistent

Severity: medium

Problem:

- `cf-button` explicitly consumes `cfThemeContext` and calls `applyThemeToElement()`.
- Most other reviewed components do not consume the theme context directly and instead rely on ambient CSS variables already being present.
- `cf-code-editor` has a `theme` prop, but it represents editor light/dark mode, not the shared CF theme object.

Affected files:

- `packages/ui/src/v2/components/cf-button/cf-button.ts`
- `packages/ui/src/v2/components/cf-code-editor/cf-code-editor.ts`
- most other reviewed component implementations

Why it matters:

- There is no clear contract for whether components are actively theme-aware or merely token-aware.
- This complicates debugging when a component does not pick up theme changes.

Recommended direction:

- Decide whether all primitives should consume theme context directly or whether only a parent theme host should populate CSS variables.
- Document that decision and make the reviewed components consistent.

### TI-010: `mobile-app-demo` is compensating with inline styling

Severity: medium

Status: follow-up

Problem:

- The demo uses many inline overrides for font sizing, spacing, letter spacing, chip gradients, card blur, tab-bar action shape, and toast action sizing.
- This is useful signal that the current primitives do not yet expose the right compositional styling hooks.

Affected file:

- `packages/patterns/mobile-app-demo.tsx`

Examples:

- custom `chipStyle()` gradient strings
- repeated muted text styling
- manual `padding: 0 16px 100px`
- manual `border-radius` and width on tab-bar action button

Why it matters:

- This file is a realistic integration harness.
- It shows where the design system currently fails to express intended app-level styling without overrides.

Recommended direction:

- Use this file as the regression harness for the cleanup.
- Success metric: fewer inline style overrides after each pass.

### TI-011: Stories and Figma mappings drift from actual APIs

Severity: medium

Status: follow-up

Problem:

- Some story and mapping files describe APIs or variants that the live components do not support.

Affected files:

- `packages/patterns/catalog/stories/cf-button-story.tsx`
- `packages/patterns/catalog/stories/vignette-recipe-story.tsx`
- `packages/ui/src/v2/components/cf-card/cf-card.figma.ts`

Examples:

- `cf-button` story uses `size="default"` while the component uses `xs | sm | md | lg | xl | icon`
- one story uses `variant="default"` for `cf-button`, which is not a valid runtime variant
- `cf-card.figma.ts` documents `slot="actions"` and `selected`, but the component uses `slot="action"` and has no `selected` property

Why it matters:

- Review work is slowed by mismatched documentation.
- Figma-to-code comparisons become unreliable.

Recommended direction:

- Clean these in parallel with the token pass so the docs reflect the actual system.

### TI-012: Motion values are inconsistently tokenized

Severity: low

Problem:

- Some components use shared transition tokens, while others embed durations and easing directly.

Affected files:

- `packages/ui/src/v2/components/cf-badge/cf-badge.ts`
- `packages/ui/src/v2/components/cf-list-item/cf-list-item.ts`
- `packages/ui/src/v2/components/cf-modal/styles.ts`
- `packages/ui/src/v2/components/cf-toast/cf-toast.ts`
- `packages/ui/src/v2/components/cf-code-editor/styles.ts`

Examples:

- hard-coded `150ms`, `200ms`
- direct cubic-bezier values in local component CSS

Recommended direction:

- Move reviewed components to shared motion tokens where possible.

### TI-013: Structural widths and breakpoints are embedded locally

Severity: low

Problem:

- Several components encode structural values directly rather than referencing semantic layout tokens.

Affected files:

- `packages/ui/src/v2/components/cf-grid/cf-grid.ts`
- `packages/ui/src/v2/components/cf-modal/styles.ts`
- `packages/ui/src/v2/components/cf-toast/cf-toast.ts`
- `packages/ui/src/v2/components/cf-code-editor/cf-code-editor.ts`

Examples:

- grid container breakpoints `640px`, `768px`, `1024px`
- modal width presets `320px`, `500px`, `700px`
- toast max/min width `420px`, `240px`
- prose editor max width `700px`

Recommended direction:

- Keep these local only if they are intentionally component-specific.
- Otherwise promote them to a shared layout token surface.

## Additional Component-Specific Notes

### `cf-list-item`

- uses `font-weight: 510`
- uses fixed `max-height: 500px` for expandable detail
- uses local hover, focus, and expansion timings

### `cf-card`

- title and description slots are styled internally with specific typography
- clickable hover state adds local elevation and translation
- spacing relies on local `tight` and `loose` aliases instead of a shared recipe

### `cf-modal`

- one of the strongest examples of local structural values
- likely should be treated as part of a shared overlay/sheet token pass

### `cf-toast`

- transient surface but not obviously derived from the same radius/padding/elevation model as card or modal

### `cf-code-editor`

- rich component and probably not a first-pass simplification target
- still needs token contract cleanup immediately because it currently references non-canonical token names

## Recommended Cleanup Order

1. Fix the token contract.
1. Remove non-canonical token names from live reviewed components.
1. Decide the shared token vocabulary for spacing, surface, and pill geometry.
1. Normalize layout primitives.
1. Normalize pill family overlap.
1. Normalize surface recipe across card, modal, and toast.
1. Clean typography role mapping.
1. Clean stories, Figma mapping files, and stale style exports.

## Out of Scope for This Pass

- Full Figma parity
- Global redesign of every v2 component
- Runtime behavior changes unrelated to styling/token coherence

