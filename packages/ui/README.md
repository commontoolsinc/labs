# Common UI Web Components

A web component library fully compatible with Deno 2. This library provides
production-ready components designed for untrusted DOM contexts with strict
security constraints.

## 🚀 Features

- **39 Production-Ready Components** (v2) - Complete implementation of a
  shadcn/ui-inspired component library
- **Security-First Design** - Built for sandboxed environments with strict
  isolation
- **Zero External Dependencies** - No remote resources, fully self-contained
- **TypeScript Support** - Full type definitions with Deno's native TypeScript
- **Framework Agnostic** - Works with React, Vue, Angular, or vanilla JavaScript
- **Accessibility Built-in** - WCAG 2.1 AA compliant components

## 📦 Library Structure

```
src/
├── index.ts          # Main entry (exports both v1 and v2, with v2 as default)
└── v2/              # New shadcn-inspired components (cf- prefix)
    ├── components/  # 39 modern components
    ├── core/        # Base element class
    ├── styles/      # Design tokens and shared styles
    └── utils/       # Utilities and helpers
```

## 🎯 Quick Start

### Installation with Deno

```typescript
// Import v2 components (default)
import { CFButton, CFCard, CFInput } from "@commonfabric/ui";

// Or import specific versions
import { v2 } from "@commonfabric/ui";

// Auto-register all v2 components
import { registerAllComponents } from "@commonfabric/ui/v2";
registerAllComponents();
```

### Use in HTML

```html
<!-- V2 Components (cf- prefix) -->
<cf-button variant="primary">Click Me</cf-button>
<cf-input type="email" placeholder="Enter email"></cf-input>
<cf-card>
  <h3 slot="header">Card Title</h3>
  <p slot="content">Card content</p>
</cf-card>
```

## 📖 V2 Components (39 total)

### Core UI Components (23)

- **Forms**: `cf-button`, `cf-input`, `cf-textarea`, `cf-checkbox`, `cf-radio`,
  `cf-switch`, `cf-toggle`, `cf-slider`
- **Layout**: `cf-card`, `cf-separator`, `cf-accordion`, `cf-collapsible`,
  `cf-tabs`, `cf-scroll-area`
- **Feedback**: `cf-alert`, `cf-badge`, `cf-progress`, `cf-skeleton`, `cf-label`
- **Data**: `cf-table`, `cf-form`, `cf-input-otp`
- **Display**: `cf-aspect-ratio`, `cf-resizable-panel-group`

### Layout Components (8)

- **Flexbox**: `cf-hstack`, `cf-vstack`, `cf-hgroup`, `cf-vgroup`
- **Scrolling**: `cf-hscroll`, `cf-vscroll`
- **Grid**: `cf-grid`, `cf-table`

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
│       ├── components/      # cf-* components
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
<cf-form>
  <cf-vstack gap="4">
    <cf-vgroup gap="1">
      <cf-label for="email" required>Email</cf-label>
      <cf-input id="email" type="email" name="email" required></cf-input>
    </cf-vgroup>

    <cf-vgroup gap="1">
      <cf-label for="message">Message</cf-label>
      <cf-textarea id="message" name="message" rows="4"></cf-textarea>
    </cf-vgroup>

    <cf-hstack gap="3" justify="end">
      <cf-button variant="outline" type="reset">Cancel</cf-button>
      <cf-button type="submit">Submit</cf-button>
    </cf-hstack>
  </cf-vstack>
</cf-form>
```

### Dashboard Layout

```html
<cf-vstack gap="4">
  <cf-card>
    <h2 slot="header">Dashboard</h2>
    <cf-grid slot="content" columns="3" gap="4">
      <cf-card>
        <cf-vstack slot="content" gap="2">
          <cf-badge variant="secondary">Active</cf-badge>
          <h3>Total Users</h3>
          <p style="font-size: 2rem">1,234</p>
        </cf-vstack>
      </cf-card>
      <!-- More cards... -->
    </cf-grid>
  </cf-card>
</cf-vstack>
```

### Event Handling

```javascript
// V2 events (cf- prefix)
document.querySelector("cf-button").addEventListener("cf-click", (e) => {
  console.log("Button clicked:", e.detail);
});

document.querySelector("cf-form").addEventListener("cf-submit", (e) => {
  e.preventDefault();
  console.log("Form data:", e.detail.formData);
});
```

## 🎨 Styling

Components support CSS custom properties and parts:

```css
/* Custom properties */
cf-button {
  --background: #3b82f6;
  --foreground: white;
}

/* CSS parts */
cf-input::part(input) {
  font-family: monospace;
}

cf-card::part(header) {
  background: #f3f4f6;
}
```

### TypeScript/JSX Support

For React/TypeScript projects, add type definitions:

```typescript
// types/jsx.d.ts
declare namespace JSX {
  interface IntrinsicElements {
    "cf-button": {
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
