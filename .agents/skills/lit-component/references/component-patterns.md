# Component Development Patterns

This document covers standard patterns and conventions for developing Lit components in Common UI.

## Component Categories

Common UI components fall into distinct categories, each with specific patterns:

### 1. Layout Components

Components that arrange other components without providing content themselves.

**Examples:** `ct-vstack`, `ct-hstack`, `ct-screen`, `ct-autolayout`

**Characteristics:**
- Use flexbox or grid
- Accept child elements via slots
- Provide gap, alignment, and spacing controls
- No theme color consumption (mostly)
- Simple property-based configuration

**Pattern:**
```typescript
export class CTVStack extends BaseElement {
  static override properties = {
    gap: { type: String },
    align: { type: String },
    justify: { type: String },
  };

  declare gap: string;
  declare align: string;
  declare justify: string;

  override render() {
    const classes = {
      stack: true,
      [`gap-${this.gap}`]: true,
      [`align-${this.align}`]: true,
      [`justify-${this.justify}`]: true,
    };

    return html`
      <div class="${classMap(classes)}" part="stack">
        <slot></slot>
      </div>
    `;
  }
}
```

### 2. Visual Components

Components that display content with styling.

**Examples:** `ct-label`, `ct-separator`, `ct-skeleton`

**Characteristics:**
- May consume theme
- Provide visual feedback or decoration
- Usually simple with few properties

**Pattern:**
```typescript
export class CTSeparator extends BaseElement {
  static override properties = {
    orientation: { type: String },
    decorative: { type: Boolean },
  };

  declare orientation: "horizontal" | "vertical";
  declare decorative: boolean;

  override render() {
    return html`
      <div
        class="separator ${this.orientation}"
        part="separator"
        role="${this.decorative ? "none" : "separator"}"
      ></div>
    `;
  }
}
```

### 3. Input Components

Components that capture user input.

**Examples:** `ct-button`, `ct-input`, `ct-checkbox`, `ct-textarea`

**Characteristics:**
- Consume theme for consistent styling
- Emit custom events (use `this.emit()`)
- May use `InputTimingController` for debouncing
- Handle disabled states

**Pattern:**
```typescript
export class CTButton extends BaseElement {
  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  static override properties = {
    variant: { type: String },
    disabled: { type: Boolean, reflect: true },
  };

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

  private _handleClick(e: Event) {
    if (this.disabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Emit custom event
    this.emit("ct-click", { /* detail */ });
  }
}
```

### 4. Complex/Integrated Components

Components that deeply integrate with the runtime and Cell abstractions.

**Examples:** `ct-render`, `ct-code-editor`, `ct-outliner`

**Characteristics:**
- Work with Cell properties
- Manage subscriptions
- Handle transactions for mutations
- Complex lifecycle management
- May use reactive controllers

**Pattern:** See `references/cell-integration.md` for detailed patterns.

## File Structure

Each component should follow this structure:

```
ct-component-name/
├── ct-component-name.ts    # Component implementation
├── index.ts                # Export and registration
└── styles.ts               # Optional: extracted styles (for complex components)
```

### Component Implementation File

```typescript
// ct-button.ts
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

export type ButtonVariant = "primary" | "secondary" | "destructive";

export class CTButton extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      /* component styles */
    `,
  ];

  static override properties = {
    variant: { type: String },
  };

  declare variant: ButtonVariant;

  constructor() {
    super();
    this.variant = "primary";
  }

  override render() {
    return html`<button><slot></slot></button>`;
  }
}

globalThis.customElements.define("ct-button", CTButton);
```

### Index File

```typescript
// index.ts
import { CTButton, ButtonVariant } from "./ct-button.ts";

if (!customElements.get("ct-button")) {
  customElements.define("ct-button", CTButton);
}

export { CTButton };
export type { ButtonVariant };
```

Note: The conditional check prevents duplicate registration errors during hot module replacement.

## Type Safety

### Export Types

Always export types separately:

```typescript
export type { ButtonVariant, ButtonSize };
```

### Property Type Declarations

Use `declare` for typed properties:

```typescript
static override properties = {
  variant: { type: String },
  size: { type: String },
  disabled: { type: Boolean, reflect: true },
};

declare variant: ButtonVariant;
declare size: ButtonSize;
declare disabled: boolean;
```

### Type Imports

Import types with `type` keyword when possible:

```typescript
import type { Cell } from "@commontools/runner";
import type { CTTheme } from "../theme-context.ts";
```

## Styling Conventions

### Base Styles

Always extend `BaseElement.baseStyles` for CSS variables:

```typescript
static override styles = [
  BaseElement.baseStyles,
  css`
    /* component styles */
  `,
];
```

### Box Sizing

Always include box-sizing reset:

```css
:host {
  display: block;
  box-sizing: border-box;
}

*,
*::before,
*::after {
  box-sizing: inherit;
}
```

### CSS Parts

Expose major elements as parts for external styling:

```typescript
return html`
  <button class="button" part="button">
    <slot></slot>
  </button>
`;
```

### Class Organization

Use `classMap` from `lit/directives/class-map.js` for dynamic classes:

```typescript
import { classMap } from "lit/directives/class-map.js";

const classes = {
  button: true,
  [this.variant]: true,
  [this.size]: true,
  disabled: this.disabled,
};

return html`<button class="${classMap(classes)}">...</button>`;
```

## Event Handling

### Emitting Events

Use the `emit()` helper from `BaseElement`:

```typescript
protected emit<T = any>(
  eventName: string,
  detail?: T,
  options?: EventInit,
): boolean
```

Events are automatically `bubbles: true` and `composed: true`.

**Pattern:**
```typescript
private handleChange(newValue: string) {
  this.emit("ct-change", { value: newValue });
}
```

### Event Naming

- Prefix custom events with `ct-`
- Use present tense: `ct-change`, not `ct-changed`
- Be specific: `ct-add-item`, `ct-remove-item`

### Event Documentation

Document events in JSDoc:

```typescript
/**
 * @fires ct-change - Fired when value changes with detail: { value }
 * @fires ct-submit - Fired when form is submitted with detail: { formData }
 */
```

## Property Conventions

### Reflecting Properties

Use `reflect: true` for boolean states that should be visible in DOM:

```typescript
static override properties = {
  disabled: { type: Boolean, reflect: true },
  readonly: { type: Boolean, reflect: true },
};
```

### Default Values

Set defaults in constructor:

```typescript
constructor() {
  super();
  this.variant = "primary";
  this.size = "default";
  this.disabled = false;
}
```

### Non-Attribute Properties

Use `attribute: false` for objects, arrays, and Cells:

```typescript
static override properties = {
  theme: { type: Object, attribute: false },
  cell: { attribute: false },
  items: { type: Array, attribute: false },
};
```

## Lifecycle Methods

### Common Lifecycle Pattern

```typescript
override firstUpdated(changed: Map<string | number | symbol, unknown>) {
  super.firstUpdated(changed);
  // One-time setup
  this._updateThemeProperties();
  this._setupEventListeners();
}

override updated(changed: Map<string | number | symbol, unknown>) {
  super.updated(changed);
  // React to property changes
  if (changed.has("theme")) {
    this._updateThemeProperties();
  }
}

override disconnectedCallback() {
  super.disconnectedCallback();
  // Cleanup
  this._cleanup();
}
```

## Documentation

### JSDoc Comments

Provide comprehensive JSDoc:

```typescript
/**
 * CTButton - Interactive button element with multiple variants
 *
 * @element ct-button
 *
 * @attr {string} variant - Visual style: "primary" | "secondary" | "destructive"
 * @attr {string} size - Button size: "default" | "sm" | "lg" | "icon"
 * @attr {boolean} disabled - Whether the button is disabled
 *
 * @slot - Default slot for button content
 *
 * @fires ct-click - Fired when button is clicked
 *
 * @example
 * <ct-button variant="primary" size="lg">Click Me</ct-button>
 */
```

## Testing

Tests should be colocated with components:

```
ct-component/
├── ct-component.ts
├── ct-component.test.ts
└── index.ts
```

### Basic Test Structure

```typescript
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTButton } from "./ct-button.ts";

describe("CTButton", () => {
  it("should be defined", () => {
    expect(CTButton).toBeDefined();
  });

  it("should create element instance", () => {
    const element = new CTButton();
    expect(element).toBeInstanceOf(CTButton);
  });

  it("should have default properties", () => {
    const element = new CTButton();
    expect(element.variant).toBe("primary");
    expect(element.disabled).toBe(false);
  });
});
```

Run tests with: `deno task test` (NOT `deno test` - the task includes important flags)
