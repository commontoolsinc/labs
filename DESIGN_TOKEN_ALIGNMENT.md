# Design Token Alignment: Figma → Codebase

Analysis of the Figma design library (file `LPebgX2vf5Axd6yuo4umBE`, "Element"
section `1157:51240`) compared against the codebase's theme system
(`packages/ui/src/v2/components/theme-context.ts` and
`packages/ui/src/v2/styles/variables.ts`).

## Figma Design Token System

### Sizing Scale

The Figma design system defines a coordinated sizing scale where all component
dimensions scale together. This is the most important structural concept that
doesn't exist in the codebase today.

| Token  | Size | Radius | Icon (L/M/S) | Spacing | Padding (H,V) | Font (size/line-height) |
| ------ | ---- | ------ | ------------ | ------- | ------------- | ----------------------- |
| **XS** | 16px | 4px    | 12/8/6       | 2px     | 4px, 2px      | 9px / 12px              |
| **S**  | 24px | 5px    | 16/12/10     | 4px     | 6px, 4px      | 11px / 16px             |
| **M**  | 32px | 8px    | 20/16/12     | 8px     | 8px, 8px      | 12px / 16px             |
| **L**  | 40px | 9px    | 24/20/16     | 12px    | 12px, 8px     | 16px / 20px             |
| **XL** | 48px | 10px   | 28/24/20     | 16px    | 16px, 12px    | 18px / 24px             |

Each row controls: component height, border-radius, icon sizes (three weights),
inner spacing between elements, horizontal/vertical padding, and font size with
line-height. The radius formula is roughly `size * 0.2` capped at 12.

### Color Palette

#### Semantic / Surface Colors

| Figma Token                | Value                      | Code Token             | Code Value                 | Status   |
| -------------------------- | -------------------------- | ---------------------- | -------------------------- | -------- |
| `_bg/default`              | `#ffffff`                  | `surface`              | `#ffffff`                  | ✅ Match |
| `_bg/base`                 | `#f2f3f6`                  | `background`           | `#f2f3f6`                  | ✅ Match |
| `_bg/secondary`            | `#f2f3f6`                  | `secondary`            | `#f2f3f6`                  | ✅ Match |
| `_bg/hover`                | `#f9fafb`                  | `surfaceHover`         | `#f9fafb`                  | ✅ Match |
| `_bg/pressed-alpha`        | `rgba(54, 63, 74, 0.1)`    | `surfacePressed`       | `rgba(54, 63, 74, 0.1)`    | ✅ Match |
| `_bg/tertiary`             | `#e4e6ea`                  | `surfaceTertiary`      | `#e4e6ea`                  | ✅ Match |
| `_bg/disabled`             | `#e4e6ea`                  | `surfaceDisabled`      | `#e4e6ea`                  | ✅ Match |
| `_bg/inverse`              | `#16181d`                  | `surfaceInverse`       | `#16181d`                  | ✅ Match |
| `_bg/border`               | `rgba(79, 89, 103, 0.15)`  | `border`               | `rgba(79, 89, 103, 0.15)`  | ✅ Match |
| `_label/default`           | `#34373c`                  | `text`                 | `#34373c`                  | ✅ Match |
| `_label/secondary`         | `#71747a`                  | `textMuted`            | `#71747a`                  | ✅ Match |
| `_label/tertiary`          | `#b3b6bc`                  | `textTertiary`         | `#b3b6bc`                  | ✅ Match |
| `_label/disabled`          | `rgba(0, 0, 0, 0.3)`       | `textDisabled`         | `rgba(0, 0, 0, 0.3)`       | ✅ Match |
| `_label/pressed`           | `#16181d`                  | `textPressed`          | `#16181d`                  | ✅ Match |
| `_label/oncolor`           | `#ffffff`                  | `primaryForeground`    | `#ffffff`                  | ✅ Match |
| `_label/oncolor-secondary` | `rgba(255, 255, 255, 0.6)` | `textOnColorSecondary` | `rgba(255, 255, 255, 0.6)` | ✅ Match |
| `_label/oninverse`         | `#ffffff`                  | `textOnInverse`        | `#ffffff`                  | ✅ Match |

**Semantic model:** Figma's `_bg/base` (grey) is the page canvas; `_bg/default`
(white) is the card/component surface. In code: `background` = grey canvas,
`surface` = white cards.

#### Named Colors

| Figma Token     | Value                      | Code Token                | Code Value                 | Status   |
| --------------- | -------------------------- | ------------------------- | -------------------------- | -------- |
| `blue/blue`     | `#4979fa`                  | `primary`                 | `#4979fa`                  | ✅ Match |
| `blue/dark`     | `#376bf9`                  | `--cf-colors-blue-dark`   | `#376bf9`                  | ✅ Match |
| `blue/a10`      | `rgba(73, 121, 250, 0.1)`  | `--cf-colors-blue-a10`    | `rgba(73, 121, 250, 0.1)`  | ✅ Match |
| `blue/a20`      | `rgba(73, 121, 250, 0.15)` | `--cf-colors-blue-a20`    | `rgba(73, 121, 250, 0.15)` | ✅ Match |
| `blue/a90`      | `rgba(73, 121, 250, 0.9)`  | `--cf-colors-blue-a90`    | `rgba(73, 121, 250, 0.9)`  | ✅ Match |
| `purple/purple` | `#8952fd`                  | `brand`                   | `#8952fd`                  | ✅ Match |
| `purple/dark`   | `#632cda`                  | `--cf-colors-purple-dark` | `#632cda`                  | ✅ Match |
| `purple/a10`    | `rgba(137, 82, 253, 0.1)`  | `--cf-colors-purple-a10`  | `rgba(137, 82, 253, 0.1)`  | ✅ Match |
| `purple/a20`    | `rgba(137, 82, 253, 0.15)` | `--cf-colors-purple-a20`  | `rgba(137, 82, 253, 0.15)` | ✅ Match |
| `red/red`       | `#ff6057`                  | `error`                   | `#ff6057`                  | ✅ Match |
| `red/dark`      | `#eb4747`                  | `--cf-colors-red-dark`    | `#eb4747`                  | ✅ Match |
| `green/green`   | `#21c17b`                  | `success`                 | `#21c17b`                  | ✅ Match |
| `coral/coral`   | `#fc856d`                  | `accent`                  | `#fc856d`                  | ✅ Match |
| `indigo/indigo` | `#5b53ff`                  | `--cf-colors-indigo`      | `#5b53ff`                  | ✅ Match |

#### Slate Scale (Figma's neutral gray ramp)

| Token       | Value     | CSS Variable            | Status   |
| ----------- | --------- | ----------------------- | -------- |
| `slate/000` | `#ffffff` | `--cf-colors-slate-000` | ✅ Match |
| `slate/100` | `#f2f3f6` | `--cf-colors-slate-100` | ✅ Match |
| `slate/150` | `#eceef1` | `--cf-colors-slate-150` | ✅ Match |
| `slate/300` | `#d5d7dd` | `--cf-colors-slate-300` | ✅ Match |
| `slate/400` | `#b3b6bc` | `--cf-colors-slate-400` | ✅ Match |
| `slate/450` | `#94979e` | `--cf-colors-slate-450` | ✅ Match |
| `slate/550` | `#5b5f65` | `--cf-colors-slate-550` | ✅ Match |
| `slate/600` | `#404349` | `--cf-colors-slate-600` | ✅ Match |
| `slate/700` | `#34373c` | `--cf-colors-slate-700` | ✅ Match |

The legacy `--cf-colors-gray-50` through `--cf-colors-gray-900` scale has been
re-aligned to match the Figma slate values (preserving variable names for
backwards compatibility).

#### Light Alpha Ramp

| Token       | Value                     | CSS Variable           | Status   |
| ----------- | ------------------------- | ---------------------- | -------- |
| `light/a00` | `rgba(13, 18, 24, 0)`     | `--cf-colors-alpha-00` | ✅ Match |
| `light/a03` | `rgba(37, 45, 54, 0.03)`  | `--cf-colors-alpha-03` | ✅ Match |
| `light/a06` | `rgba(46, 53, 64, 0.06)`  | `--cf-colors-alpha-06` | ✅ Match |
| `light/a10` | `rgba(54, 63, 74, 0.1)`   | `--cf-colors-alpha-10` | ✅ Match |
| `light/a20` | `rgba(79, 89, 103, 0.15)` | `--cf-colors-alpha-20` | ✅ Match |

### Shadows

| Figma Token     | Value                                                                               | Codebase Equivalent                                    | Status     |
| --------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------- |
| `Shadow 1-2`    | `0 0 0 1px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.05)`                             | `--cf-shadow-sm` (different values)                    | ❌ Phase 3 |
| `Shadow 4-16`   | `0 0 3px rgba(0,0,0,0.12), 0 3px 8px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.08)` | `--cf-shadow-lg` / `--cf-shadow-xl` (different values) | ❌ Phase 3 |
| `Inner focused` | `inset 0 0 0 2px rgba(255,255,255,0.9)`                                             | N/A — no inner shadow token                            | ❌ Phase 3 |

### Typography

| Figma                                       | Codebase                                                           | Status     |
| ------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| `SF Pro` weight 510 (Medium)                | `system-ui, -apple-system, sans-serif`                             | ❌ Phase 6 |
| `JetBrains Mono`                            | `ui-monospace, Cascadia Code, Source Code Pro, Menlo, Consolas...` | ❌ Phase 6 |
| Mono XS: Regular 400, 9px/12px, +3 tracking | N/A                                                                | ❌ Phase 6 |
| Mono M: Medium 500, 12px/16px, -2 tracking  | N/A                                                                | ❌ Phase 6 |
| Mono L: Medium 500, 15px/20px, -2 tracking  | N/A                                                                | ❌ Phase 6 |

### Button Variant Model

**Figma** uses two axes:

- **Color category:** `button` (default/white), `button.accent` (blue
  `#4979fa`), `button.brand` (purple `#8952fd`), `button.alert` (red `#ff6057`)
- **Style:** `Primary` (filled background) vs `Muted` (subtle/transparent) vs
  `Secondary` (Figma default buttons only — bordered)
- **Split button:** Boolean toggle adds a dropdown arrow divider
- **Sizes:** Small (24px), Medium (32px), Large (36px) — tied to the sizing
  scale

**Codebase** (`cf-button`) uses a flat variant list:

- `primary` | `secondary` | `destructive` | `outline` | `ghost` | `link` |
  `pill`
- No split-button support
- No color axis independent of variant

**Mapping proposal:**

| Figma                   | Proposed Code                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `button` Primary        | `variant="outline"` (closest, but not exact — Figma's default button has a shadow) |
| `button` Secondary      | New — bordered with different fill                                                 |
| `button` Muted          | `variant="ghost"`                                                                  |
| `button.accent` Primary | `variant="primary"`                                                                |
| `button.accent` Muted   | `variant="primary"` + `muted` prop?                                                |
| `button.brand` Primary  | New — needs `color="brand"` or similar                                             |
| `button.brand` Muted    | New                                                                                |
| `button.alert` Primary  | `variant="destructive"`                                                            |
| `button.alert` Muted    | New — destructive muted                                                            |

### Other Components

#### Checkbox (Figma `1216:31209`)

- Inner box: 16x16px, 4px radius
- Hit target: 24x24px (4px padding around)
- Checked fill: `blue/a90` = `rgba(73,121,250, 0.9)` with `blue/blue` border
- States: Default, Focus, Disabled x Checked, Mixed, Unchecked
- Has `Muted` variant (lighter fill)

#### Avatar (Figma `171:14831`)

- Sizes: 16px (small group), 24px (group), 32px (standalone)
- Shapes: Circle (80px radius) or Square (uses `button-radius`)
- Variants: Icon, Image, Initial, Initial Inactive, Count, Count Accent
- Status ring: 2px white border, with optional color bar / ring / spotlight /
  audio indicators
- Key colors: `indigo/indigo` for initials, `blue/blue` for count accent,
  `slate/150` for inactive
- Codebase has no `cf-avatar` component

#### Toggle Button (Figma `123:9541`)

- 24x24px, On/Off states
- Checkbox-like but for icon toggles

#### Button Box (Figma `1348:18608`)

- 24x24px hit area with 16x16px inner content
- Icon-only with Muted variant

#### Nav Button (Figma `582:12476`)

- 32x32px
- For navigation chrome (back, menu, etc.)

#### Logo Button (Figma `467:13562`)

- 32x32px with `Shadow 4-16`
- App identity / branding

#### Action Button (Figma, seen in sizing table)

- Pill-shaped (`slate/150` background)
- Icon + label
- Scales with the sizing system (XS: 20px, S: 24px, M: 32px, L: 40px, XL: 48px)
- Border radius tracks slightly above `button-radius` (6/7/8/9/10px)
- Not present in codebase

---

## Gap Summary

### ✅ Completed (Phase 1)

1. ~~**Base color palette**~~ — Aligned to Figma neutral slate grays
2. ~~**Missing named colors**~~ — Added brand (purple), indigo, coral, slate
   scale
3. ~~**Alpha color variants**~~ — Added blue/a10-a90, purple/a10-a20,
   red/a10-a20
4. ~~**Label tokens**~~ — Added textOnColorSecondary, textOnInverse,
   textPressed, textTertiary, textDisabled
5. ~~**Surface tokens**~~ — Added surfacePressed, surfaceTertiary,
   surfaceDisabled, surfaceInverse

### Remaining

6. **Coordinated sizing scale** — XS/S/M/L/XL system doesn't exist in code
   (Phase 2)
7. **Border radius scaling** — Fixed in code, size-proportional in Figma
   (Phase 2)
8. **Shadow tokens** — Values don't match (Phase 3)
9. **Button variant model** — Color x Style axes vs flat variant list (Phase 4)
10. **New components** — Avatar, action button, split button (Phase 5)
11. **Typography** — Weight 510, JetBrains Mono, mono size tokens (Phase 6)
12. **Inner shadow focus** — Different focus indicator style (Phase 3)

---

## Plan of Attack

### Phase 1: Color Alignment ✅

Updated `theme-context.ts` default theme colors to match Figma's neutral
palette. Added missing color categories (brand, indigo, coral) and the slate
scale. Added alpha variant support for named colors. Swapped background/surface
semantics to match Figma's grey-canvas/white-card model. Updated all legacy CSS
variable fallbacks across 7 component files.

**Files changed:** `packages/ui/src/v2/components/theme-context.ts`,
`packages/ui/src/v2/styles/variables.ts`, plus 7 component files with fallback
hex updates.

### Phase 2: Sizing Scale

Introduce the XS/S/M/L/XL coordinated sizing system as a new concept in the
theme. Each size token bundles: component height, border-radius, icon sizes,
spacing, padding, and font size.

**Files:** `packages/ui/src/v2/components/theme-context.ts` (new `SizingScale`
type)

### Phase 3: Shadow Alignment

Update shadow token values to match Figma's `Shadow 1-2` and `Shadow 4-16`.

**Files:** `packages/ui/src/v2/styles/variables.ts`

### Phase 4: Button Reconciliation

Evolve `cf-button` to support the color x style model from Figma. Consider
adding a `color` prop (default/accent/brand/alert) alongside the existing
`variant` prop (or rework variants to match).

**Files:** `packages/ui/src/v2/components/cf-button/`

### Phase 5: New Components

- `cf-avatar` — with status ring, all variants
- Action button — pill-shaped icon+label component
- Split button support on `cf-button`

### Phase 6: Typography

Align font stacks and add JetBrains Mono. Consider weight 510 support.
