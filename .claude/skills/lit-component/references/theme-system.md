# Common UI Theme System

This document covers the philosophy and implementation of the Common UI theme system.

## Philosophy: Ambient Configuration

**Core Insight:** Theme is not a property passed to each component - it's ambient context that flows down the tree like CSS inheritance.

**Design Goals:**
1. **Default works:** Components should work without explicit theme
2. **Composition over specification:** Nest theme providers for progressive refinement
3. **Reactive:** Theme values can be Cells that update live
4. **Pattern-friendly:** Support partial themes with pattern-style properties (`accentColor`, `fontFace`)
5. **CSS-native:** Emit CSS variables for performance and browser devtools visibility

## The `ct-theme` Provider Component

The `<ct-theme>` component wraps children and provides theme context using `@lit/context`.

**Key characteristics:**
- Uses `display: contents` to be invisible in layout
- Merges partial themes with defaults (supports pattern-style)
- Subscribes to Cell properties for reactive updates
- Applies CSS variables to itself for cascade to children

```typescript
// Wrap any subtree to theme it
<ct-theme .theme=${{ accentColor: cell("#3b82f6") }}>
  <ct-button>Themed Button</ct-button>
</ct-theme>

// Nest providers for refinement
<ct-theme .theme=${{ colorScheme: "dark" }}>
  <div>Dark section</div>
  <ct-theme .theme=${{ accentColor: cell("#ff0000") }}>
    <div>Dark section with red accent</div>
  </ct-theme>
</ct-theme>
```

## Theme Context

The theme system uses `@lit/context` to provide theme values throughout the component tree.

### CTTheme Interface

```typescript
interface CTTheme {
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
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";

export class MyComponent extends BaseElement {
  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

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

After calling `applyThemeToElement()`, the following CSS variables are available:

**Typography:**
- `--ct-theme-font-family`
- `--ct-theme-mono-font-family`
- `--ct-theme-border-radius`
- `--ct-theme-animation-duration`

**Colors:**
- `--ct-theme-color-primary`
- `--ct-theme-color-primary-foreground`
- `--ct-theme-color-secondary`
- `--ct-theme-color-secondary-foreground`
- `--ct-theme-color-background`
- `--ct-theme-color-surface`
- `--ct-theme-color-surface-hover`
- `--ct-theme-color-text`
- `--ct-theme-color-text-muted`
- `--ct-theme-color-border`
- `--ct-theme-color-border-muted`
- `--ct-theme-color-success`
- `--ct-theme-color-success-foreground`
- `--ct-theme-color-error`
- `--ct-theme-color-error-foreground`
- `--ct-theme-color-warning`
- `--ct-theme-color-warning-foreground`
- `--ct-theme-color-accent`
- `--ct-theme-color-accent-foreground`

**Spacing:**
- `--ct-theme-spacing-tight`
- `--ct-theme-spacing-normal`
- `--ct-theme-spacing-loose`
- `--ct-theme-spacing-padding-message`
- `--ct-theme-spacing-padding-code`
- `--ct-theme-spacing-padding-block`

### CSS Variable Fallback Pattern

Always provide fallbacks to base CSS variables for components that may be used without theme context:

```css
.button {
  background-color: var(
    --ct-theme-color-primary,
    var(--ct-color-primary, #3b82f6)
  );
  font-family: var(--ct-theme-font-family, inherit);
  border-radius: var(
    --ct-theme-border-radius,
    var(--ct-border-radius-md, 0.375rem)
  );
}
```

## Base CSS Variables

Components inherit base CSS variables from `BaseElement.baseStyles`. These are defined in `packages/ui/src/v2/styles/variables.ts`.

### Available Base Variables

**Colors:**
- `--ct-colors-primary-{50-900}`: Primary color scale
- `--ct-colors-gray-{50-900}`: Gray color scale
- `--ct-colors-success`, `--ct-colors-warning`, `--ct-colors-error`, `--ct-colors-info`

**Typography:**
- `--ct-font-family-sans`, `--ct-font-family-mono`
- `--ct-font-size-{xs,sm,base,lg,xl,2xl,3xl,4xl}`
- `--ct-font-weight-{light,normal,medium,semibold,bold}`
- `--ct-line-height-{none,tight,snug,normal,relaxed,loose}`

**Spacing:**
- `--ct-spacing-{0,1,2,3,4,5,6,8,10,12,16,20,24}`

**Border Radius:**
- `--ct-border-radius-{none,sm,base,md,lg,xl,2xl,3xl,full}`

**Shadows:**
- `--ct-shadow-{sm,base,md,lg,xl,none}`

**Transitions:**
- `--ct-transition-duration-{fast,base,slow}`
- `--ct-transition-timing-{ease,ease-in,ease-out,ease-in-out}`

**Z-index:**
- `--ct-z-index-{auto,0,10,20,30,40,50,100,1000}`

## Theme Helper Functions

### resolveColorScheme(scheme: ColorScheme): "light" | "dark"

Resolves "auto" to actual color scheme based on system preference.

### resolveColor(token: ColorToken, colorScheme: "light" | "dark"): string

Resolves a ColorToken to a concrete color value.

### getThemeColor(value: keyof CTTheme["colors"] | ColorToken | string, theme: CTTheme): string

Gets a color that can be semantic (theme key), a token, or a specific value.

### getThemeSpacing(value: string, theme: CTTheme): string

Gets spacing that can be semantic or specific.

### getAnimationDuration(speed: CTTheme["animationSpeed"]): string

Returns CSS duration value based on animation speed setting.

### createThemeVariant(baseTheme: CTTheme, overrides: Partial<CTTheme>): CTTheme

Creates a theme override with granular control.

### mergeWithDefaultTheme(partialTheme: any, baseTheme?: CTTheme): CTTheme

Merges partial theme with default, supporting pattern-style properties like `accentColor`, `fontFace`, and `borderRadius`.
