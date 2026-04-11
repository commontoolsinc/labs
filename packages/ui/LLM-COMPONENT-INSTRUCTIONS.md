# LLM Component Composition Guide

This document provides comprehensive component specifications for Language
Models to assist with web component composition using the Common Fabric UI
library.

## Component Library Overview

The Common Fabric UI library provides 39 secure web components that follow the
shadcn/ui design system. All components:

- Use custom element tags prefixed with `cf-`
- Support Shadow DOM encapsulation
- Emit custom events prefixed with `cf-`
- Follow strict security constraints (no external resources, limited events)

## Theme System First

When composing a polished UI with `cf-*` components, prefer `cf-theme` for
overall typography, color, spacing, radius, and motion, then use component
`--cf-*` custom properties only for local refinement.

Working references:

- `src/v2/components/cf-theme/cf-theme.ts`
- `src/v2/components/theme-context.ts`
- `../../docs/common/patterns/style.md`
- `../../docs/common/components/COMPONENTS.md`

## Component Reference

### 1. cf-button

**Purpose**: Interactive button element **Tag**: `<cf-button>` **Attributes**:

- `variant` - "default" | "destructive" | "outline" | "secondary" | "ghost" |
  "link"
- `size` - "default" | "sm" | "lg" | "icon"
- `disabled` - boolean
- `type` - "button" | "submit" | "reset" **Events**:
- `cf-click` - Fired on click with detail: `{ variant, size }` **Slots**:
  Default slot for button content **Example**:

```html
<cf-button variant="primary" size="lg">Click Me</cf-button>
```

### 2. cf-input

**Purpose**: Text input field **Tag**: `<cf-input>` **Attributes**:

- `type` - "text" | "email" | "password" | "number" | "search" | "tel" | "url" |
  "date" | "time" | "datetime-local"
- `placeholder` - string
- `value` - string
- `disabled` - boolean
- `readonly` - boolean
- `required` - boolean
- `name` - string
- `min` - string/number
- `max` - string/number
- `step` - string/number
- `pattern` - string
- `autocomplete` - string **Events**:
- `cf-input` - Fired on input with detail: `{ value, name }`
- `cf-change` - Fired on change with detail: `{ value, name }`
- `cf-focus` - Fired on focus
- `cf-blur` - Fired on blur **Example**:

```html
<cf-input type="email" placeholder="Enter email" required></cf-input>
```

### 3. cf-textarea

**Purpose**: Multi-line text input **Tag**: `<cf-textarea>` **Attributes**:

- `placeholder` - string
- `value` - string
- `disabled` - boolean
- `readonly` - boolean
- `required` - boolean
- `name` - string
- `rows` - number
- `cols` - number
- `maxlength` - number
- `auto-resize` - boolean **Events**:
- `cf-input` - Fired on input with detail: `{ value, name }`
- `cf-change` - Fired on change with detail: `{ value, name }` **Example**:

```html
<cf-textarea rows="4" placeholder="Enter message" auto-resize></cf-textarea>
```

### 4. cf-checkbox

**Purpose**: Binary selection input **Tag**: `<cf-checkbox>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string
- `value` - string
- `required` - boolean
- `indeterminate` - boolean **Events**:
- `cf-change` - Fired on change with detail: `{ checked, indeterminate }`

**Example**:

```html
<cf-checkbox name="terms" checked>Accept terms</cf-checkbox>
```

### 5. cf-radio

**Purpose**: Single selection from group **Tag**: `<cf-radio>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string (required for grouping)
- `value` - string (required)
- `required` - boolean **Events**:
- `cf-change` - Fired on change with detail: `{ value, checked }` **Note**: Must
  be used within `cf-radio-group` for proper functionality **Example**:

```html
<cf-radio-group name="color" value="blue">
  <cf-radio value="red">Red</cf-radio>
  <cf-radio value="blue">Blue</cf-radio>
</cf-radio-group>
```

### 6. cf-radio-group

**Purpose**: Container for radio buttons **Tag**: `<cf-radio-group>`
**Attributes**:

- `name` - string (required)
- `value` - string (currently selected value)
- `disabled` - boolean **Events**:
- `cf-change` - Fired when selection changes with detail: `{ value }` **Slots**:
  Default slot for cf-radio elements

### 7. cf-switch

**Purpose**: Toggle switch **Tag**: `<cf-switch>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string **Events**:
- `cf-change` - Fired on toggle with detail: `{ checked }` **Example**:

```html
<cf-switch name="notifications" checked>Enable notifications</cf-switch>
```

### 8. cf-slider

**Purpose**: Range input slider **Tag**: `<cf-slider>` **Attributes**:

- `value` - number
- `min` - number (default: 0)
- `max` - number (default: 100)
- `step` - number (default: 1)
- `disabled` - boolean
- `name` - string **Events**:
- `cf-change` - Fired on value change with detail: `{ value }` **Example**:

```html
<cf-slider min="0" max="100" value="50" step="5"></cf-slider>
```

### 9. cf-toggle

**Purpose**: Toggle button **Tag**: `<cf-toggle>` **Attributes**:

- `pressed` - boolean
- `disabled` - boolean
- `variant` - "default" | "outline"
- `size` - "default" | "sm" | "lg"
- `value` - string (for toggle groups) **Events**:
- `cf-change` - Fired on toggle with detail: `{ pressed }` **Slots**: Default
  slot for content **Example**:

```html
<cf-toggle pressed>Bold</cf-toggle>
```

### 10. cf-toggle-group

**Purpose**: Group of toggle buttons **Tag**: `<cf-toggle-group>`
**Attributes**:

- `type` - "single" | "multiple"
- `value` - string (for single) | string[] (for multiple)
- `disabled` - boolean **Events**:
- `cf-change` - Fired on selection change with detail: `{ value }` **Slots**:
  Default slot for cf-toggle elements

### 11. cf-label

**Purpose**: Form field label **Tag**: `<cf-label>` **Attributes**:

- `for` - string (ID of associated input)
- `required` - boolean (shows asterisk)
- `disabled` - boolean **Events**:
- `cf-label-click` - Fired on click with detail: `{ targetId, targetElement }`

**Slots**: Default slot for label text **Example**:

```html
<cf-label for="email" required>Email Address</cf-label>
<cf-input id="email" type="email"></cf-input>
```

### 12. cf-card

**Purpose**: Content container **Tag**: `<cf-card>` **Attributes**: None
**Events**: None **Slots**:

- `header` - Card header content
- `content` - Main card content
- `footer` - Card footer content **Example**:

```html
<cf-card>
  <h3 slot="header">Card Title</h3>
  <p slot="content">Card content goes here</p>
  <cf-button slot="footer">Action</cf-button>
</cf-card>
```

### 13. cf-badge

**Purpose**: Status indicator or label **Tag**: `<cf-badge>` **Attributes**:

- `variant` - "default" | "secondary" | "destructive" | "outline"
- `removable` - boolean (shows X button) **Events**:
- `cf-remove` - Fired when X clicked (if removable) **Slots**: Default slot for
  badge text **Example**:

```html
<cf-badge variant="secondary" removable>Status</cf-badge>
```

### 14. cf-alert

**Purpose**: Alert message display **Tag**: `<cf-alert>` **Attributes**:

- `variant` - "default" | "destructive"
- `dismissible` - boolean **Events**:
- `cf-dismiss` - Fired when dismissed **Slots**:
- `icon` - Alert icon
- `title` - Alert title
- `description` - Alert description
- Default slot - Alert content **Example**:

```html
<cf-alert variant="destructive" dismissible>
  <span slot="icon">⚠️</span>
  <h4 slot="title">Error</h4>
  <p slot="description">Something went wrong</p>
</cf-alert>
```

### 15. cf-separator

**Purpose**: Visual divider **Tag**: `<cf-separator>` **Attributes**:

- `orientation` - "horizontal" | "vertical"
- `decorative` - boolean **Example**:

```html
<cf-separator orientation="vertical"></cf-separator>
```

### 16. cf-progress

**Purpose**: Progress indicator **Tag**: `<cf-progress>` **Attributes**:

- `value` - number (0-100)
- `max` - number (default: 100)
- `indeterminate` - boolean **Example**:

```html
<cf-progress value="60"></cf-progress>
```

### 17. cf-skeleton

**Purpose**: Loading placeholder **Tag**: `<cf-skeleton>` **Attributes**: None
(style with CSS width/height) **Example**:

```html
<cf-skeleton style="width: 200px; height: 20px"></cf-skeleton>
```

### 18. cf-accordion

**Purpose**: Collapsible content panels **Tag**: `<cf-accordion>`
**Attributes**:

- `type` - "single" | "multiple"
- `value` - string | string[] (open items)
- `collapsible` - boolean (for single type) **Events**:
- `cf-change` - Fired on expand/collapse with detail: `{ value }` **Slots**:
  Default slot for cf-accordion-item elements **Example**:

```html
<cf-accordion type="single" collapsible>
  <cf-accordion-item value="item1">
    <div slot="trigger">Section 1</div>
    <div slot="content">Content 1</div>
  </cf-accordion-item>
</cf-accordion>
```

### 19. cf-accordion-item

**Purpose**: Individual accordion panel **Tag**: `<cf-accordion-item>`
**Attributes**:

- `value` - string (required, unique identifier)
- `disabled` - boolean **Slots**:
- `trigger` - Clickable header
- `content` - Collapsible content

### 20. cf-collapsible

**Purpose**: Single collapsible section **Tag**: `<cf-collapsible>`
**Attributes**:

- `open` - boolean
- `disabled` - boolean **Events**:
- `cf-toggle` - Fired on open/close with detail: `{ open }` **Slots**:
- `trigger` - Clickable trigger element
- `content` - Collapsible content

### 21. cf-tabs

**Purpose**: Tabbed interface container **Tag**: `<cf-tabs>` **Attributes**:

- `default-value` - string (initially active tab)
- `orientation` - "horizontal" | "vertical" **Events**:
- `cf-change` - Fired on tab change with detail: `{ value }` **Slots**: Default
  slot for cf-tab-list and cf-tab-panel elements **Example**:

```html
<cf-tabs default-value="tab1">
  <cf-tab-list>
    <cf-tab value="tab1">Tab 1</cf-tab>
    <cf-tab value="tab2">Tab 2</cf-tab>
  </cf-tab-list>
  <cf-tab-panel value="tab1">Content 1</cf-tab-panel>
  <cf-tab-panel value="tab2">Content 2</cf-tab-panel>
</cf-tabs>
```

### 22. cf-tab-list

**Purpose**: Container for tab buttons **Tag**: `<cf-tab-list>` **Slots**:
Default slot for cf-tab elements

### 23. cf-tab

**Purpose**: Individual tab button **Tag**: `<cf-tab>` **Attributes**:

- `value` - string (required)
- `disabled` - boolean **Events**:
- `click` - Native click event

### 24. cf-tab-panel

**Purpose**: Tab content panel **Tag**: `<cf-tab-panel>` **Attributes**:

- `value` - string (required, matches tab value) **Slots**: Default slot for
  content

### 25. cf-scroll-area

**Purpose**: Custom scrollable area **Tag**: `<cf-scroll-area>` **Attributes**:

- `orientation` - "vertical" | "horizontal" | "both" **Slots**: Default slot for
  scrollable content **Example**:

```html
<cf-scroll-area style="height: 200px">
  <div>Long content...</div>
</cf-scroll-area>
```

### 26. cf-aspect-ratio

**Purpose**: Maintains aspect ratio of content **Tag**: `<cf-aspect-ratio>`
**Attributes**:

- `ratio` - string (e.g., "16/9", "1/1", "4/3") **Slots**: Default slot for
  content **Example**:

```html
<cf-aspect-ratio ratio="16/9">
  <div style="background: gray">Video placeholder</div>
</cf-aspect-ratio>
```

### 27. cf-form

**Purpose**: Form wrapper with validation **Tag**: `<cf-form>` **Attributes**:

- `action` - string
- `method` - string
- `novalidate` - boolean **Events**:
- `cf-submit` - Fired on valid submission with detail: `{ formData }`
- `cf-form-invalid` - Fired on validation failure with detail: `{ errors }`

**Slots**: Default slot for form elements **Methods**:

- `submit()` - Programmatically submit
- `reset()` - Reset form
- `validate()` - Validate and return boolean

### 28. cf-input-otp

**Purpose**: One-time password input **Tag**: `<cf-input-otp>` **Attributes**:

- `length` - number (default: 6)
- `value` - string
- `disabled` - boolean
- `name` - string **Events**:
- `cf-change` - Fired on value change with detail: `{ value, complete }`
- `cf-complete` - Fired when all digits entered with detail: `{ value }`

**Methods**:

- `focus()` - Focus first input
- `clear()` - Clear all inputs **Example**:

```html
<cf-input-otp length="6" name="otp"></cf-input-otp>
```

### 29. cf-resizable-panel-group

**Purpose**: Container for resizable panels **Tag**:
`<cf-resizable-panel-group>` **Attributes**:

- `direction` - "horizontal" | "vertical" **Events**:
- `cf-resize` - Fired on resize with detail: `{ panels }` **Slots**: Default
  slot for panels and handles

### 30. cf-resizable-panel

**Purpose**: Individual resizable panel **Tag**: `<cf-resizable-panel>`
**Attributes**:

- `default-size` - number (percentage)
- `min-size` - number (percentage)
- `max-size` - number (percentage)
- `collapsible` - boolean **Slots**: Default slot for content

### 31. cf-resizable-handle

**Purpose**: Drag handle between panels **Tag**: `<cf-resizable-handle>`
**Attributes**: None

## Layout Components

### 32. cf-hstack

**Purpose**: Horizontal flexbox container **Tag**: `<cf-hstack>` **Attributes**:

- `gap` - "0" | "1" | "2" | "3" | "4" | "5" | "6" | "8"
- `align` - "start" | "center" | "end" | "stretch" | "baseline"
- `justify` - "start" | "center" | "end" | "between" | "around" | "evenly"
- `wrap` - boolean
- `reverse` - boolean **Slots**: Default slot for child elements **Example**:

```html
<cf-hstack gap="4" align="center" justify="between">
  <cf-button>Left</cf-button>
  <cf-button>Right</cf-button>
</cf-hstack>
```

### 33. cf-vstack

**Purpose**: Vertical flexbox container **Tag**: `<cf-vstack>` **Attributes**:
Same as cf-hstack **Example**:

```html
<cf-vstack gap="2" align="stretch">
  <cf-card>Card 1</cf-card>
  <cf-card>Card 2</cf-card>
</cf-vstack>
```

### 34. cf-hgroup

**Purpose**: Horizontal group with semantic spacing **Tag**: `<cf-hgroup>`
**Attributes**:

- `gap` - "xs" | "sm" | "md" | "lg" | "xl" **Slots**: Default slot for grouped
  elements

### 35. cf-vgroup

**Purpose**: Vertical group with semantic spacing **Tag**: `<cf-vgroup>`
**Attributes**: Same as cf-hgroup

### 36. cf-hscroll

**Purpose**: Horizontal scroll container **Tag**: `<cf-hscroll>` **Attributes**:

- `fade-edges` - boolean (gradient fade on edges)
- `show-scrollbar` - boolean
- `snap` - boolean (scroll snapping) **Events**:
- `cf-scroll` - Fired on scroll with detail:
  `{ scrollLeft, scrollWidth, clientWidth }` **Methods**:
- `scrollToX(x, smooth)` - Scroll to position
- `scrollByX(x, smooth)` - Scroll by amount

### 37. cf-vscroll

**Purpose**: Vertical scroll container **Tag**: `<cf-vscroll>` **Attributes**:

- `height` - string (CSS height)
- `fade-edges` - boolean
- `show-scrollbar` - boolean
- `snap` - boolean **Events**:
- `cf-scroll` - Fired on scroll with detail:
  `{ scrollTop, scrollHeight, clientHeight }` **Methods**:
- `scrollToY(y, smooth)` - Scroll to position
- `scrollByY(y, smooth)` - Scroll by amount

### 38. cf-grid

**Purpose**: CSS Grid container **Tag**: `<cf-grid>` **Attributes**:

- `columns` - number | string (e.g., "3" or "repeat(auto-fit, minmax(200px,
  1fr))")
- `rows` - number | string
- `gap` - "0" | "1" | "2" | "3" | "4" | "5" | "6" | "8"
- `column-gap` - same as gap
- `row-gap` - same as gap
- `areas` - string (grid template areas)
- `auto-flow` - "row" | "column" | "dense" | "row dense" | "column dense"

**Example**:

```html
<cf-grid columns="3" gap="4">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</cf-grid>
```

### 39. cf-table

**Purpose**: Semantic HTML table **Tag**: `<cf-table>` **Attributes**:

- `striped` - boolean (zebra stripes)
- `bordered` - boolean
- `hover` - boolean (row hover effect)
- `compact` - boolean (reduced padding)
- `fixed` - boolean (fixed layout) **Slots**: Default slot for thead, tbody,
  tfoot **Example**:

```html
<cf-table striped hover>
  <thead>
    <tr>
      <th>Name</th>
      <th>Value</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Item 1</td>
      <td>100</td>
    </tr>
  </tbody>
</cf-table>
```

## Component Composition Guidelines

### Form Example

```html
<cf-form>
  <cf-vstack gap="4">
    <cf-vgroup gap="1">
      <cf-label for="name" required>Full Name</cf-label>
      <cf-input id="name" name="name" required></cf-input>
    </cf-vgroup>

    <cf-vgroup gap="1">
      <cf-label for="email" required>Email</cf-label>
      <cf-input id="email" name="email" type="email" required></cf-input>
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

### Dashboard Layout Example

```html
<cf-vstack gap="4" style="padding: 2rem">
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
      <!-- More stat cards... -->
    </cf-grid>
  </cf-card>

  <cf-tabs default-value="overview">
    <cf-tab-list>
      <cf-tab value="overview">Overview</cf-tab>
      <cf-tab value="analytics">Analytics</cf-tab>
      <cf-tab value="reports">Reports</cf-tab>
    </cf-tab-list>
    <cf-tab-panel value="overview">
      <!-- Overview content -->
    </cf-tab-panel>
  </cf-tabs>
</cf-vstack>
```

## Event Handling Patterns

All components emit custom events with the `cf-` prefix. Event details are
always in the `detail` property:

```javascript
document.querySelector("cf-button").addEventListener("cf-click", (e) => {
  console.log("Button clicked:", e.detail);
});

document.querySelector("cf-input").addEventListener("cf-change", (e) => {
  console.log("Input value:", e.detail.value);
});

document.querySelector("cf-form").addEventListener("cf-submit", (e) => {
  e.preventDefault();
  console.log("Form data:", e.detail.formData);
});
```

## Styling Components

Components expose CSS custom properties and parts for styling:

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

## Security Constraints

When composing components, remember:

- No `<img>`, `<svg>`, `<iframe>`, `<canvas>`, or `<a>` tags
- No external resource loading
- Use Unicode symbols for icons: ✓ ✕ → ← ↑ ↓ • ○ ▶ ▼ ▲
- All components use Shadow DOM for isolation
- Only allowed events are keyboard, mouse, focus, and form events
