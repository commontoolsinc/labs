# Common UI Theme System

This document covers the philosophy and implementation of the Common UI theme
system.

## Philosophy: Ambient Configuration

**Core Insight:** Theme is not a property passed to each component - it's
ambient context that flows down the tree like CSS inheritance.

**Design Goals:**

1. **Default works:** Components should work without explicit theme
2. **Composition over specification:** Nest theme providers for progressive
   refinement
3. **Reactive:** Theme values can be Cells that update live
4. **Pattern-friendly:** Support partial themes with pattern-style properties
   (`accentColor`, `fontFace`)
5. **CSS-native:** Emit CSS variables for performance and browser devtools
   visibility

## The `cf-theme` Provider Component

The `<cf-theme>` component wraps children and provides theme context using
`@lit/context`.

**Key characteristics:**

- Uses `display: contents` to be invisible in layout
- Merges partial themes with defaults (supports pattern-style)
- Subscribes to Cell properties for reactive updates
- Applies CSS variables to itself for cascade to children

```typescript
// Wrap any subtree to theme it
<cf-theme .theme=${{ accentColor: cell("#3b82f6") }}>
  <cf-button>Themed Button</cf-button>
</cf-theme>

// Nest providers for refinement
<cf-theme .theme=${{ colorScheme: "dark" }}>
  <div>Dark section</div>
  <cf-theme .theme=${{ accentColor: cell("#ff0000") }}>
    <div>Dark section with red accent</div>
  </cf-theme>
</cf-theme>
```

## Theme Context

The theme system uses `@lit/context` to provide theme values throughout the
component tree.

### CFTheme Interface

```typescript
interface CFTheme {
  fontFamily: string;
  monoFontFamily: string;
  borderRadius: string;
  density: "compact" | "comfortable" | "spacious";
  colorScheme: "light" | "dark" | "auto";
  animationSpeed: "none" | "slow" | "normal" | "fast";
  colors: {
    primary: ColorToken;
    primaryForeground: ColorToken;
    secondary: ColorToken;
    secondaryForeground: ColorToken;
    background: ColorToken;
    surface: ColorToken;
    surfaceHover: ColorToken;
    text: ColorToken;
    textMuted: ColorToken;
    border: ColorToken;
    borderMuted: ColorToken;
    success: ColorToken;
    successForeground: ColorToken;
    error: ColorToken;
    errorForeground: ColorToken;
    warning: ColorToken;
    warningForeground: ColorToken;
    accent: ColorToken;
    accentForeground: ColorToken;
  };
}

type ColorToken = string | { light: string; dark: string };
```

## Consuming Theme in Components

### Basic Theme Consumption

Use `@consume` decorator to access theme context:

```typescript
import { consume } from "@lit/context";
import { property } from "lit/decorators.js";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  defaultTheme,
} from "../theme-context.ts";

export class MyComponent extends BaseElement {
  @consume({ context: cfThemeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CFTheme;

  override firstUpdated(changed: Map<string | number | symbol, unknown>) {
    super.firstUpdated(changed);
    this._updateThemeProperties();
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) {
      this._updateThemeProperties();
    }
  }

  private _updateThemeProperties() {
    const currentTheme = this.theme || defaultTheme;
    applyThemeToElement(this, currentTheme);
  }
}
```

### Using Theme CSS Variables

After calling `applyThemeToElement()`, the following CSS variables are
available:

**Typography:**

- `--cf-theme-font-family`
- `--cf-theme-mono-font-family`
- `--cf-theme-font-size`
- `--cf-theme-border-radius`
- `--cf-theme-animation-duration`

**Colors:**

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

**Spacing:**

- `--cf-theme-spacing-tight`
- `--cf-theme-spacing-normal`
- `--cf-theme-spacing-loose`
- `--cf-theme-spacing-padding-message`
- `--cf-theme-spacing-padding-code`
- `--cf-theme-spacing-padding-block`

### CSS Variable Fallback Pattern

Always provide fallbacks to base CSS variables for components that may be used
without theme context:

```css
.button {
  background-color: var(
    --cf-theme-color-primary,
    var(--cf-colors-primary-500, #3b82f6)
  );
  font-family: var(--cf-theme-font-family, inherit);
  border-radius: var(
    --cf-theme-border-radius,
    var(--cf-border-radius-md, 0.375rem)
  );
}
```

## Base CSS Variables

Components inherit base CSS variables from `BaseElement.baseStyles`. These are
defined in `packages/ui/src/v2/styles/variables.ts`.

### Available Base Variables

**Colors:**

- `--cf-colors-primary-{50-900}`: Primary color scale
- `--cf-colors-gray-{50-900}`: Gray color scale
- `--cf-colors-success`, `--cf-colors-warning`, `--cf-colors-error`,
  `--cf-colors-info`

**Typography:**

- `--cf-font-family-sans`, `--cf-font-family-mono`
- `--cf-font-size-{xs,sm,base,lg,xl,2xl,3xl,4xl}`
- `--cf-font-weight-{light,normal,medium,semibold,bold}`
- `--cf-line-height-{none,tight,snug,normal,relaxed,loose}`

**Spacing:**

- `--cf-spacing-{0,1,2,3,4,5,6,8,10,12,16,20,24}`

**Border Radius:**

- `--cf-border-radius-{none,sm,base,md,lg,xl,2xl,3xl,full}`

**Shadows:**

- `--cf-shadow-{sm,base,md,lg,xl,none}`

**Transitions:**

- `--cf-transition-duration-{fast,base,slow}`
- `--cf-transition-timing-{ease,ease-in,ease-out,ease-in-out}`

**Z-index:**

- `--cf-z-index-{auto,0,10,20,30,40,50,100,1000}`

## Theme Helper Functions

### resolveColorScheme(scheme: ColorScheme): "light" | "dark"

Resolves "auto" to actual color scheme based on system preference.

### resolveColor(token: ColorToken, colorScheme: "light" | "dark"): string

Resolves a ColorToken to a concrete color value.

### getThemeColor(value: keyof CFTheme["colors"] | ColorToken | string, theme: CFTheme): string

Gets a color that can be semantic (theme key), a token, or a specific value.

### getThemeSpacing(value: string, theme: CFTheme): string

Gets spacing that can be semantic or specific.

### getAnimationDuration(speed: CFTheme["animationSpeed"]): string

Returns CSS duration value based on animation speed setting.

### createThemeVariant(baseTheme: CFTheme, overrides: Partial<CFTheme>): CFTheme

Creates a theme override with granular control.

### mergeWithDefaultTheme(partialTheme: any, baseTheme?: CFTheme): CFTheme

Merges partial theme with default, supporting pattern-style properties like
`accentColor`, `fontFace`, and `borderRadius`.
