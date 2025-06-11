# Common UI Web Components

A modern, secure web component library with both legacy (v1) and new
shadcn-inspired (v2) components, fully compatible with Deno 2. This library
provides production-ready components designed for untrusted DOM contexts with
strict security constraints.

## 🚀 Features

- **Two Versions Available**: Legacy v1 components and modern v2 with shadcn/ui
  inspired component library
- **39 Production-Ready Components** (v2) - Complete implementation of a
  shadcn/ui-inspired component library
- **Security-First Design** - Built for sandboxed environments with strict
  isolation
- **Zero External Dependencies** - No remote resources, fully self-contained
- **TypeScript Support** - Full type definitions with Deno's native TypeScript
- **Framework Agnostic** - Works with React, Vue, Angular, or vanilla JavaScript
- **Accessibility Built-in** - WCAG 2.1 AA compliant components
- **LLM-Friendly** - Includes `LLM-COMPONENT-INSTRUCTIONS.md` for AI-assisted
  development

## 📦 Library Structure

```
src/
├── index.ts          # Main entry (exports both v1 and v2, with v2 as default)
├── v1/              # Legacy components (common- prefix)
│   └── components/  # Original common-ui components
└── v2/              # New shadcn-inspired components (ct- prefix)
    ├── components/  # 39 modern components
    ├── core/        # Base element class
    ├── styles/      # Design tokens and shared styles
    └── utils/       # Utilities and helpers
```

## 🎯 Quick Start

### Installation with Deno

```typescript
// Import v2 components (default)
import { CTButton, CTCard, CTInput } from "@commontools/ui";

// Or import specific versions
import { v1, v2 } from "@commontools/ui";

// Auto-register all v2 components
import { registerAllComponents } from "@commontools/ui/v2";
registerAllComponents();
```

### Use in HTML

```html
<!-- V2 Components (ct- prefix) -->
<ct-button variant="primary">Click Me</ct-button>
<ct-input type="email" placeholder="Enter email"></ct-input>
<ct-card>
  <h3 slot="header">Card Title</h3>
  <p slot="content">Card content</p>
</ct-card>

<!-- V1 Components (common- prefix) -->
<common-button>Legacy Button</common-button>
```

## 📖 V2 Components (39 total)

### Core UI Components (23)

- **Forms**: `ct-button`, `ct-input`, `ct-textarea`, `ct-checkbox`, `ct-radio`,
  `ct-switch`, `ct-toggle`, `ct-slider`
- **Layout**: `ct-card`, `ct-separator`, `ct-accordion`, `ct-collapsible`,
  `ct-tabs`, `ct-scroll-area`
- **Feedback**: `ct-alert`, `ct-badge`, `ct-progress`, `ct-skeleton`, `ct-label`
- **Data**: `ct-table`, `ct-form`, `ct-input-otp`
- **Display**: `ct-aspect-ratio`, `ct-resizable-panel-group`

### Layout Components (8)

- **Flexbox**: `ct-hstack`, `ct-vstack`, `ct-hgroup`, `ct-vgroup`
- **Scrolling**: `ct-hscroll`, `ct-vscroll`
- **Grid**: `ct-grid`, `ct-table`

## 🔒 Security Constraints

Both v1 and v2 components are designed for secure, sandboxed environments:

- **No External Resources** - No images, SVGs, or remote fetching
- **DOM Isolation** - Components cannot access DOM outside their Shadow DOM
- **Limited Events** - Only keyboard, mouse, focus, and form events allowed
- **No Navigation** - No anchor tags or external links
- **Visual Containment** - Components render within parent bounds

## 🤖 LLM Integration

This library includes `LLM-COMPONENT-INSTRUCTIONS.md`, a comprehensive guide for
Language Models (like Claude, GPT-4) to assist with component composition. The
guide includes:

- Complete component API reference
- Attribute types and event specifications
- Usage examples for all 39 v2 components
- Security constraints and best practices
- Component composition patterns

When working with an LLM, reference this file to ensure accurate component
usage.

## 💻 Development

### Commands

```bash
# Type checking
deno task check        # Check all files
deno task check:v2     # Check v2 only

# Linting & Formatting
deno task lint         # Lint all files
deno task lint:v2      # Lint v2 only
deno task fmt          # Format code

# Testing
deno task test         # Run tests

# Clean
deno task clean        # Remove build artifacts
```

### Project Structure Details

```
packages/ui/
├── deno.json                 # Deno configuration
├── README.md                 # This file
├── LLM-COMPONENT-INSTRUCTIONS.md  # AI assistant guide
├── src/
│   ├── index.ts             # Main exports
│   ├── v1/                  # Legacy components
│   │   ├── components/      # common-* components
│   │   └── index.ts
│   └── v2/                  # Modern components
│       ├── components/      # ct-* components
│       ├── core/            # BaseElement class
│       ├── styles/          # Shared styles
│       ├── utils/           # Utilities
│       ├── types/           # TypeScript types
│       ├── register-all.ts  # Auto-registration
│       └── index.ts
```

## 📚 Examples

### Form with Validation

```html
<ct-form>
  <ct-vstack gap="4">
    <ct-vgroup gap="sm">
      <ct-label for="email" required>Email</ct-label>
      <ct-input id="email" type="email" name="email" required></ct-input>
    </ct-vgroup>

    <ct-vgroup gap="sm">
      <ct-label for="message">Message</ct-label>
      <ct-textarea id="message" name="message" rows="4"></ct-textarea>
    </ct-vgroup>

    <ct-hstack gap="3" justify="end">
      <ct-button variant="outline" type="reset">Cancel</ct-button>
      <ct-button type="submit">Submit</ct-button>
    </ct-hstack>
  </ct-vstack>
</ct-form>
```

### Dashboard Layout

```html
<ct-vstack gap="4">
  <ct-card>
    <h2 slot="header">Dashboard</h2>
    <ct-grid slot="content" columns="3" gap="4">
      <ct-card>
        <ct-vstack slot="content" gap="2">
          <ct-badge variant="secondary">Active</ct-badge>
          <h3>Total Users</h3>
          <p style="font-size: 2rem">1,234</p>
        </ct-vstack>
      </ct-card>
      <!-- More cards... -->
    </ct-grid>
  </ct-card>
</ct-vstack>
```

### Event Handling

```javascript
// V2 events (ct- prefix)
document.querySelector("ct-button").addEventListener("ct-click", (e) => {
  console.log("Button clicked:", e.detail);
});

document.querySelector("ct-form").addEventListener("ct-submit", (e) => {
  e.preventDefault();
  console.log("Form data:", e.detail.formData);
});
```

## 🎨 Styling

Components support CSS custom properties and parts:

```css
/* Custom properties */
ct-button {
  --background: #3b82f6;
  --foreground: white;
}

/* CSS parts */
ct-input::part(input) {
  font-family: monospace;
}

ct-card::part(header) {
  background: #f3f4f6;
}
```

### TypeScript/JSX Support

For React/TypeScript projects, add type definitions:

```typescript
// types/jsx.d.ts
declare namespace JSX {
  interface IntrinsicElements {
    "ct-button": {
      variant?:
        | "default"
        | "destructive"
        | "outline"
        | "secondary"
        | "ghost"
        | "link";
      size?: "default" | "sm" | "lg" | "icon";
      disabled?: boolean;
    } & React.HTMLAttributes<HTMLElement>;
    // ... other components
  }
}
```

## 🤝 Contributing

1. Follow established patterns in `BaseElement`
2. Maintain security constraints
3. Include comprehensive JSDoc documentation
4. Add test files for new components
5. Update type definitions
6. Follow the style guide in existing components

## 📄 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- v2 design system based on [shadcn/ui](https://ui.shadcn.com/)
- Built with [Lit](https://lit.dev/) web components
- Optimized for [Deno](https://deno.land/) runtime
- Secured for sandboxed environments
