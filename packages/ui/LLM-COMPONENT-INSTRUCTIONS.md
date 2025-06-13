# LLM Component Composition Guide

This document provides comprehensive component specifications for Language
Models to assist with web component composition using the Common CT library.

## Component Library Overview

The Common CT library provides 39 secure web components that follow the
shadcn/ui design system. All components:

- Use custom element tags prefixed with `ct-`
- Support Shadow DOM encapsulation
- Emit custom events prefixed with `ct-`
- Follow strict security constraints (no external resources, limited events)

## Component Reference

### 1. ct-button

**Purpose**: Interactive button element **Tag**: `<ct-button>` **Attributes**:

- `variant` - "default" | "destructive" | "outline" | "secondary" | "ghost" |
  "link"
- `size` - "default" | "sm" | "lg" | "icon"
- `disabled` - boolean
- `type` - "button" | "submit" | "reset" **Events**:
- `ct-click` - Fired on click with detail: `{ variant, size }` **Slots**:
  Default slot for button content **Example**:

```html
<ct-button variant="primary" size="lg">Click Me</ct-button>
```

### 2. ct-input

**Purpose**: Text input field **Tag**: `<ct-input>` **Attributes**:

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
- `ct-input` - Fired on input with detail: `{ value, name }`
- `ct-change` - Fired on change with detail: `{ value, name }`
- `ct-focus` - Fired on focus
- `ct-blur` - Fired on blur **Example**:

```html
<ct-input type="email" placeholder="Enter email" required></ct-input>
```

### 3. ct-textarea

**Purpose**: Multi-line text input **Tag**: `<ct-textarea>` **Attributes**:

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
- `ct-input` - Fired on input with detail: `{ value, name }`
- `ct-change` - Fired on change with detail: `{ value, name }` **Example**:

```html
<ct-textarea rows="4" placeholder="Enter message" auto-resize></ct-textarea>
```

### 4. ct-checkbox

**Purpose**: Binary selection input **Tag**: `<ct-checkbox>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string
- `value` - string
- `required` - boolean
- `indeterminate` - boolean **Events**:
- `ct-change` - Fired on change with detail: `{ checked, indeterminate }`

**Example**:

```html
<ct-checkbox name="terms" checked>Accept terms</ct-checkbox>
```

### 5. ct-radio

**Purpose**: Single selection from group **Tag**: `<ct-radio>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string (required for grouping)
- `value` - string (required)
- `required` - boolean **Events**:
- `ct-change` - Fired on change with detail: `{ value, checked }` **Note**: Must
  be used within `ct-radio-group` for proper functionality **Example**:

```html
<ct-radio-group name="color" value="blue">
  <ct-radio value="red">Red</ct-radio>
  <ct-radio value="blue">Blue</ct-radio>
</ct-radio-group>
```

### 6. ct-radio-group

**Purpose**: Container for radio buttons **Tag**: `<ct-radio-group>`
**Attributes**:

- `name` - string (required)
- `value` - string (currently selected value)
- `disabled` - boolean **Events**:
- `ct-change` - Fired when selection changes with detail: `{ value }` **Slots**:
  Default slot for ct-radio elements

### 7. ct-switch

**Purpose**: Toggle switch **Tag**: `<ct-switch>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string **Events**:
- `ct-change` - Fired on toggle with detail: `{ checked }` **Example**:

```html
<ct-switch name="notifications" checked>Enable notifications</ct-switch>
```

### 8. ct-slider

**Purpose**: Range input slider **Tag**: `<ct-slider>` **Attributes**:

- `value` - number
- `min` - number (default: 0)
- `max` - number (default: 100)
- `step` - number (default: 1)
- `disabled` - boolean
- `name` - string **Events**:
- `ct-change` - Fired on value change with detail: `{ value }` **Example**:

```html
<ct-slider min="0" max="100" value="50" step="5"></ct-slider>
```

### 9. ct-toggle

**Purpose**: Toggle button **Tag**: `<ct-toggle>` **Attributes**:

- `pressed` - boolean
- `disabled` - boolean
- `variant` - "default" | "outline"
- `size` - "default" | "sm" | "lg"
- `value` - string (for toggle groups) **Events**:
- `ct-change` - Fired on toggle with detail: `{ pressed }` **Slots**: Default
  slot for content **Example**:

```html
<ct-toggle pressed>Bold</ct-toggle>
```

### 10. ct-toggle-group

**Purpose**: Group of toggle buttons **Tag**: `<ct-toggle-group>`
**Attributes**:

- `type` - "single" | "multiple"
- `value` - string (for single) | string[] (for multiple)
- `disabled` - boolean **Events**:
- `ct-change` - Fired on selection change with detail: `{ value }` **Slots**:
  Default slot for ct-toggle elements

### 11. ct-label

**Purpose**: Form field label **Tag**: `<ct-label>` **Attributes**:

- `for` - string (ID of associated input)
- `required` - boolean (shows asterisk)
- `disabled` - boolean **Events**:
- `ct-label-click` - Fired on click with detail: `{ targetId, targetElement }`

**Slots**: Default slot for label text **Example**:

```html
<ct-label for="email" required>Email Address</ct-label>
<ct-input id="email" type="email"></ct-input>
```

### 12. ct-card

**Purpose**: Content container **Tag**: `<ct-card>` **Attributes**: None
**Events**: None **Slots**:

- `header` - Card header content
- `content` - Main card content
- `footer` - Card footer content **Example**:

```html
<ct-card>
  <h3 slot="header">Card Title</h3>
  <p slot="content">Card content goes here</p>
  <ct-button slot="footer">Action</ct-button>
</ct-card>
```

### 13. ct-badge

**Purpose**: Status indicator or label **Tag**: `<ct-badge>` **Attributes**:

- `variant` - "default" | "secondary" | "destructive" | "outline"
- `removable` - boolean (shows X button) **Events**:
- `ct-remove` - Fired when X clicked (if removable) **Slots**: Default slot for
  badge text **Example**:

```html
<ct-badge variant="secondary" removable>Status</ct-badge>
```

### 14. ct-alert

**Purpose**: Alert message display **Tag**: `<ct-alert>` **Attributes**:

- `variant` - "default" | "destructive"
- `dismissible` - boolean **Events**:
- `ct-dismiss` - Fired when dismissed **Slots**:
- `icon` - Alert icon
- `title` - Alert title
- `description` - Alert description
- Default slot - Alert content **Example**:

```html
<ct-alert variant="destructive" dismissible>
  <span slot="icon">⚠️</span>
  <h4 slot="title">Error</h4>
  <p slot="description">Something went wrong</p>
</ct-alert>
```

### 15. ct-separator

**Purpose**: Visual divider **Tag**: `<ct-separator>` **Attributes**:

- `orientation` - "horizontal" | "vertical"
- `decorative` - boolean **Example**:

```html
<ct-separator orientation="vertical"></ct-separator>
```

### 16. ct-progress

**Purpose**: Progress indicator **Tag**: `<ct-progress>` **Attributes**:

- `value` - number (0-100)
- `max` - number (default: 100)
- `indeterminate` - boolean **Example**:

```html
<ct-progress value="60"></ct-progress>
```

### 17. ct-skeleton

**Purpose**: Loading placeholder **Tag**: `<ct-skeleton>` **Attributes**: None
(style with CSS width/height) **Example**:

```html
<ct-skeleton style="width: 200px; height: 20px"></ct-skeleton>
```

### 18. ct-accordion

**Purpose**: Collapsible content panels **Tag**: `<ct-accordion>`
**Attributes**:

- `type` - "single" | "multiple"
- `value` - string | string[] (open items)
- `collapsible` - boolean (for single type) **Events**:
- `ct-change` - Fired on expand/collapse with detail: `{ value }` **Slots**:
  Default slot for ct-accordion-item elements **Example**:

```html
<ct-accordion type="single" collapsible>
  <ct-accordion-item value="item1">
    <div slot="trigger">Section 1</div>
    <div slot="content">Content 1</div>
  </ct-accordion-item>
</ct-accordion>
```

### 19. ct-accordion-item

**Purpose**: Individual accordion panel **Tag**: `<ct-accordion-item>`
**Attributes**:

- `value` - string (required, unique identifier)
- `disabled` - boolean **Slots**:
- `trigger` - Clickable header
- `content` - Collapsible content

### 20. ct-collapsible

**Purpose**: Single collapsible section **Tag**: `<ct-collapsible>`
**Attributes**:

- `open` - boolean
- `disabled` - boolean **Events**:
- `ct-toggle` - Fired on open/close with detail: `{ open }` **Slots**:
- `trigger` - Clickable trigger element
- `content` - Collapsible content

### 21. ct-tabs

**Purpose**: Tabbed interface container **Tag**: `<ct-tabs>` **Attributes**:

- `default-value` - string (initially active tab)
- `orientation` - "horizontal" | "vertical" **Events**:
- `ct-change` - Fired on tab change with detail: `{ value }` **Slots**: Default
  slot for ct-tab-list and ct-tab-panel elements **Example**:

```html
<ct-tabs default-value="tab1">
  <ct-tab-list>
    <ct-tab value="tab1">Tab 1</ct-tab>
    <ct-tab value="tab2">Tab 2</ct-tab>
  </ct-tab-list>
  <ct-tab-panel value="tab1">Content 1</ct-tab-panel>
  <ct-tab-panel value="tab2">Content 2</ct-tab-panel>
</ct-tabs>
```

### 22. ct-tab-list

**Purpose**: Container for tab buttons **Tag**: `<ct-tab-list>` **Slots**:
Default slot for ct-tab elements

### 23. ct-tab

**Purpose**: Individual tab button **Tag**: `<ct-tab>` **Attributes**:

- `value` - string (required)
- `disabled` - boolean **Events**:
- `click` - Native click event

### 24. ct-tab-panel

**Purpose**: Tab content panel **Tag**: `<ct-tab-panel>` **Attributes**:

- `value` - string (required, matches tab value) **Slots**: Default slot for
  content

### 25. ct-scroll-area

**Purpose**: Custom scrollable area **Tag**: `<ct-scroll-area>` **Attributes**:

- `orientation` - "vertical" | "horizontal" | "both" **Slots**: Default slot for
  scrollable content **Example**:

```html
<ct-scroll-area style="height: 200px">
  <div>Long content...</div>
</ct-scroll-area>
```

### 26. ct-aspect-ratio

**Purpose**: Maintains aspect ratio of content **Tag**: `<ct-aspect-ratio>`
**Attributes**:

- `ratio` - string (e.g., "16/9", "1/1", "4/3") **Slots**: Default slot for
  content **Example**:

```html
<ct-aspect-ratio ratio="16/9">
  <div style="background: gray">Video placeholder</div>
</ct-aspect-ratio>
```

### 27. ct-form

**Purpose**: Form wrapper with validation **Tag**: `<ct-form>` **Attributes**:

- `action` - string
- `method` - string
- `novalidate` - boolean **Events**:
- `ct-submit` - Fired on valid submission with detail: `{ formData }`
- `ct-invalid` - Fired on validation failure with detail: `{ errors }`

**Slots**: Default slot for form elements **Methods**:

- `submit()` - Programmatically submit
- `reset()` - Reset form
- `validate()` - Validate and return boolean

### 28. ct-input-otp

**Purpose**: One-time password input **Tag**: `<ct-input-otp>` **Attributes**:

- `length` - number (default: 6)
- `value` - string
- `disabled` - boolean
- `name` - string **Events**:
- `ct-change` - Fired on value change with detail: `{ value, complete }`
- `ct-complete` - Fired when all digits entered with detail: `{ value }`

**Methods**:

- `focus()` - Focus first input
- `clear()` - Clear all inputs **Example**:

```html
<ct-input-otp length="6" name="otp"></ct-input-otp>
```

### 29. ct-resizable-panel-group

**Purpose**: Container for resizable panels **Tag**:
`<ct-resizable-panel-group>` **Attributes**:

- `direction` - "horizontal" | "vertical" **Events**:
- `ct-layout` - Fired on resize with detail: `{ sizes }` **Slots**: Default slot
  for panels and handles

### 30. ct-resizable-panel

**Purpose**: Individual resizable panel **Tag**: `<ct-resizable-panel>`
**Attributes**:

- `default-size` - number (percentage)
- `min-size` - number (percentage)
- `max-size` - number (percentage)
- `collapsible` - boolean **Slots**: Default slot for content

### 31. ct-resizable-handle

**Purpose**: Drag handle between panels **Tag**: `<ct-resizable-handle>`
**Attributes**: None

## Layout Components

### 32. ct-hstack

**Purpose**: Horizontal flexbox container **Tag**: `<ct-hstack>` **Attributes**:

- `gap` - "0" | "1" | "2" | "3" | "4" | "5" | "6" | "8"
- `align` - "start" | "center" | "end" | "stretch" | "baseline"
- `justify` - "start" | "center" | "end" | "between" | "around" | "evenly"
- `wrap` - boolean
- `reverse` - boolean **Slots**: Default slot for child elements **Example**:

```html
<ct-hstack gap="4" align="center" justify="between">
  <ct-button>Left</ct-button>
  <ct-button>Right</ct-button>
</ct-hstack>
```

### 33. ct-vstack

**Purpose**: Vertical flexbox container **Tag**: `<ct-vstack>` **Attributes**:
Same as ct-hstack **Example**:

```html
<ct-vstack gap="2" align="stretch">
  <ct-card>Card 1</ct-card>
  <ct-card>Card 2</ct-card>
</ct-vstack>
```

### 34. ct-hgroup

**Purpose**: Horizontal group with semantic spacing **Tag**: `<ct-hgroup>`
**Attributes**:

- `gap` - "xs" | "sm" | "md" | "lg" | "xl" **Slots**: Default slot for grouped
  elements

### 35. ct-vgroup

**Purpose**: Vertical group with semantic spacing **Tag**: `<ct-vgroup>`
**Attributes**: Same as ct-hgroup

### 36. ct-hscroll

**Purpose**: Horizontal scroll container **Tag**: `<ct-hscroll>` **Attributes**:

- `fade-edges` - boolean (gradient fade on edges)
- `show-scrollbar` - boolean
- `snap` - boolean (scroll snapping) **Events**:
- `ct-scroll` - Fired on scroll with detail:
  `{ scrollLeft, scrollWidth, clientWidth }` **Methods**:
- `scrollToX(x, smooth)` - Scroll to position
- `scrollByX(x, smooth)` - Scroll by amount

### 37. ct-vscroll

**Purpose**: Vertical scroll container **Tag**: `<ct-vscroll>` **Attributes**:

- `height` - string (CSS height)
- `fade-edges` - boolean
- `show-scrollbar` - boolean
- `snap` - boolean **Events**:
- `ct-scroll` - Fired on scroll with detail:
  `{ scrollTop, scrollHeight, clientHeight }` **Methods**:
- `scrollToY(y, smooth)` - Scroll to position
- `scrollByY(y, smooth)` - Scroll by amount

### 38. ct-grid

**Purpose**: CSS Grid container **Tag**: `<ct-grid>` **Attributes**:

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
<ct-grid columns="3" gap="4">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</ct-grid>
```

### 39. ct-table

**Purpose**: Semantic HTML table **Tag**: `<ct-table>` **Attributes**:

- `striped` - boolean (zebra stripes)
- `bordered` - boolean
- `hover` - boolean (row hover effect)
- `compact` - boolean (reduced padding)
- `fixed` - boolean (fixed layout) **Slots**: Default slot for thead, tbody,
  tfoot **Example**:

```html
<ct-table striped hover>
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
</ct-table>
```

## Component Composition Guidelines

### Form Example

```html
<ct-form>
  <ct-vstack gap="4">
    <ct-vgroup gap="sm">
      <ct-label for="name" required>Full Name</ct-label>
      <ct-input id="name" name="name" required></ct-input>
    </ct-vgroup>

    <ct-vgroup gap="sm">
      <ct-label for="email" required>Email</ct-label>
      <ct-input id="email" name="email" type="email" required></ct-input>
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

### Dashboard Layout Example

```html
<ct-vstack gap="4" style="padding: 2rem">
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
      <!-- More stat cards... -->
    </ct-grid>
  </ct-card>

  <ct-tabs default-value="overview">
    <ct-tab-list>
      <ct-tab value="overview">Overview</ct-tab>
      <ct-tab value="analytics">Analytics</ct-tab>
      <ct-tab value="reports">Reports</ct-tab>
    </ct-tab-list>
    <ct-tab-panel value="overview">
      <!-- Overview content -->
    </ct-tab-panel>
  </ct-tabs>
</ct-vstack>
```

## Event Handling Patterns

All components emit custom events with the `ct-` prefix. Event details are
always in the `detail` property:

```javascript
document.querySelector("ct-button").addEventListener("ct-click", (e) => {
  console.log("Button clicked:", e.detail);
});

document.querySelector("ct-input").addEventListener("ct-change", (e) => {
  console.log("Input value:", e.detail.value);
});

document.querySelector("ct-form").addEventListener("ct-submit", (e) => {
  e.preventDefault();
  console.log("Form data:", e.detail.formData);
});
```

## Styling Components

Components expose CSS custom properties and parts for styling:

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

## Security Constraints

When composing components, remember:

- No `<img>`, `<svg>`, `<iframe>`, `<canvas>`, or `<a>` tags
- No external resource loading
- Use Unicode symbols for icons: ✓ ✕ → ← ↑ ↓ • ○ ▶ ▼ ▲
- All components use Shadow DOM for isolation
- Only allowed events are keyboard, mouse, focus, and form events
