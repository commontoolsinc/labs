# Research: ct-render Component Implementation

## Overview

This research document analyzes the current architecture and patterns in the codebase to understand how to implement a new `<ct-render cell={charm} />` component that renders cells as VDOM.

## Current Architecture

### 1. Rendering System (`packages/html/src/render.ts`)

The rendering system provides:

- **`render(parent: HTMLElement, view: VNode | Cell<VNode>)`**: Main entry point for rendering VNodes or reactive cells
- **`vdomSchema`**: JSON schema defining valid VDOM structure with support for reactive cells
- **Reactive rendering**: Automatically updates DOM when cell values change
- **`[UI]` symbol support**: Special property for specifying UI representation

Key features:
- Supports both static VNodes and reactive Cell<VNode>
- Handles event binding for cells/streams
- Properties starting with `$` pass raw values (e.g., cells themselves)
- Automatic cleanup and cancellation

### 2. Cell System (`packages/runner/src/cell.ts`)

Cells are reactive data containers with:

- **Methods**: `get()`, `set()`, `send()`, `update()`, `push()`, `key()`, `equals()`
- **Schema support**: `asSchema()` to apply JSON schemas
- **Reactivity**: `sink()` for subscribing to changes
- **References**: Can be converted to links with `getAsLink()`
- **Streams**: Special cells for event handling

Example cell usage:
```typescript
const myCell = createCell(runtime, link);
myCell.set({ name: "Example" });
myCell.key("name").get(); // "Example"
```

### 3. Recipe Pattern

Recipes are functions that transform input cells into output cells:

```typescript
const MyRecipe = recipe(inputSchema, outputSchema, (input) => {
  return {
    [NAME]: str`Recipe: ${input.name}`,
    [UI]: <div>{input.value}</div>,
    value: input.value
  };
});
```

Key properties:
- `[UI]`: Defines the visual representation as VDOM
- `[NAME]`: Human-readable name
- `[TYPE]`: Type identifier

### 4. ct-* Component Pattern

Components in v2 follow this structure:

```typescript
export class CTComponent extends BaseElement {
  static override styles = css`...`;
  
  static override properties = {
    someProp: { type: String }
  };
  
  override render() {
    return html`...`;
  }
}

globalThis.customElements.define("ct-component", CTComponent);
```

Key patterns:
- Extend `BaseElement` from `packages/ui/src/v2/core/base-element.ts`
- Use Lit for reactivity and rendering
- Export from index.ts for proper module resolution
- Follow naming convention: `ct-[component-name]`

### 5. Existing Rendering Examples

#### CharmRunner Component
- Renders charm cells by extracting `[UI]` property
- Uses `render()` function from html package
- Handles errors and provides runtime context

```typescript
const cleanup = render(
  container,
  charm.asSchema(charmSchema).key(UI) as Cell<VNode>
);
```

#### Common-charm Component
- Wrapper component providing context (charm-id, space-name)
- Used as container for rendered content

## Implementation Recommendations

### 1. Component Structure

Create `packages/ui/src/v2/components/ct-render/`:
- `ct-render.ts` - Main component
- `index.ts` - Exports
- `styles.ts` - Component styles (if needed)

### 2. Component Design

```typescript
import { html, css } from "lit";
import { property } from "lit/decorators.js";
import { render } from "@commontools/html";
import { BaseElement } from "../../core/base-element.ts";
import { isCell, UI } from "@commontools/runner";

export class CTRender extends BaseElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  static override properties = {
    cell: { type: Object },
    errorBoundary: { type: Boolean, attribute: "error-boundary" }
  };

  @property({ type: Object })
  cell: any;

  @property({ type: Boolean })
  errorBoundary = true;

  private _container?: HTMLDivElement;
  private _cleanup?: () => void;

  override render() {
    return html`
      <div class="ct-render-container" part="container"></div>
    `;
  }

  override firstUpdated() {
    this._container = this.shadowRoot?.querySelector('.ct-render-container') as HTMLDivElement;
    this._renderCell();
  }

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('cell')) {
      this._renderCell();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup?.();
  }

  private _renderCell() {
    if (!this._container) return;

    // Clean up previous render
    this._cleanup?.();
    this._container.innerHTML = '';

    if (!this.cell) return;

    try {
      // Check if it's a cell
      if (isCell(this.cell)) {
        // Try to get UI representation
        const uiCell = this.cell.key?.(UI);
        if (uiCell) {
          this._cleanup = render(this._container, uiCell);
        } else {
          // Fallback: render the cell value as text
          this._renderValue(this.cell.get());
        }
      } else if (this.cell?.[UI]) {
        // Static object with UI property
        this._cleanup = render(this._container, this.cell[UI]);
      } else {
        // Fallback: render as value
        this._renderValue(this.cell);
      }
    } catch (error) {
      if (this.errorBoundary) {
        this._renderError(error);
      } else {
        throw error;
      }
    }
  }

  private _renderValue(value: any) {
    // Simple value rendering
    if (value === null || value === undefined) {
      this._container!.textContent = '';
    } else if (typeof value === 'object') {
      this._container!.textContent = JSON.stringify(value, null, 2);
    } else {
      this._container!.textContent = String(value);
    }
  }

  private _renderError(error: any) {
    this._container!.innerHTML = `
      <div style="color: var(--destructive); padding: 8px; border: 1px solid currentColor; border-radius: 4px;">
        <strong>Render Error:</strong> ${error.message || error}
      </div>
    `;
  }
}

globalThis.customElements.define("ct-render", CTRender);
```

### 3. Usage Examples

```jsx
// In a recipe
<ct-render cell={myCharmCell} />

// With error boundary disabled
<ct-render cell={someCell} error-boundary={false} />

// Rendering a cell with UI
const uiCell = cell({
  [UI]: <div>Hello World</div>,
  value: "Hello"
});
<ct-render cell={uiCell} />
```

### 4. Integration Points

1. **Export from v2/index.ts**:
```typescript
export * from "./components/ct-render/index.ts";
```

2. **Type definitions** (if needed):
```typescript
declare global {
  interface HTMLElementTagNameMap {
    "ct-render": CTRender;
  }
}
```

### 5. Advanced Features to Consider

1. **Schema validation**: Use cell.asSchema() to ensure proper typing
2. **Loading states**: Show skeleton while cells are loading
3. **Error recovery**: Provide retry mechanisms
4. **Performance**: Use requestAnimationFrame for large updates
5. **Accessibility**: Add ARIA attributes for dynamic content

### 6. Testing Approach

1. Unit tests for component logic
2. Integration tests with real cells
3. Visual regression tests for different content types
4. Error boundary testing
5. Memory leak tests for cleanup

## Conclusion

The `ct-render` component should:
1. Accept any cell or value with a `[UI]` property
2. Use the existing `render()` function from html package
3. Follow ct-* component patterns using Lit and BaseElement
4. Provide error boundaries and fallback rendering
5. Handle cleanup properly to prevent memory leaks

This approach aligns with the existing architecture while providing a flexible way to render cells as VDOM in the UI.