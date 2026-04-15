# cf-tab-bar Component Spec

**Status**: Draft
**Date**: 2026-04-15

## Overview

`cf-tab-bar` and `cf-tab-bar-item` are a pair of web components that implement a
fixed-position navigation bar for mobile and app-like UIs. They are distinct from
the existing `cf-tabs`/`cf-tab-list`/`cf-tab`/`cf-tab-panel` system and are not
an extension of it.

### Contrast with cf-tabs

| Dimension | cf-tabs | cf-tab-bar |
|---|---|---|
| Interaction model | Manages ARIA tab panels (show/hide content) | Fires selection events; parent handles view switching |
| ARIA role | `tablist` / `tab` / `tabpanel` | `navigation` / button with `aria-current="page"` |
| Layout | Inline in document flow | Fixed to top or bottom of viewport |
| Position | Configurable inside any container | Always viewport-fixed |
| Use case | Content area tabs switching between panels | App-level bottom or top nav bar |

### Motivating example

The `ios-home` pattern hand-codes a floating pill-shaped bottom navigation bar
with approximately 50 lines of custom CSS. A typical instance looks like this:

```tsx
{/* Before — hand-coded */}
<div style="
  position: fixed;
  bottom: env(safe-area-inset-bottom, 0);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  background: rgba(255,255,255,0.85);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 9999px;
  padding: 8px 12px;
  gap: 4px;
  z-index: 50;
  ...
">
  {navItems.map(item => (
    <button onClick={() => setTab(item.id)} style="...icon+label layout...">
      {item.icon}
      <span>{item.label}</span>
    </button>
  ))}
</div>
```

`cf-tab-bar` replaces this pattern with a single declarative component backed by
Cell binding, keyboard navigation, and consistent design system theming.

---

## Architecture

Two custom elements are defined:

```
cf-tab-bar   (fixed-position container, owns selection state + layout)
  ├── cf-tab-bar-item   (individual navigation button with icon + label)
  └── [action slot]      (optional primary action button, e.g. compose/add)
```

`cf-tab-bar-item` elements go in the default slot. An optional `action` slot
accepts any element (typically a `cf-button`) that renders as a primary action
beside the navigation pill — the iOS 18 "floating tab bar + FAB" pattern.

The bar's internal layout is a flex row: `[nav-pill] [action]`. The nav pill
contains the navigation items. When the action slot has content, the pill shifts
left to make room; when empty, the pill centers itself. This means the tab bar
and FAB don't compete for layout space — the FAB is part of the tab bar's layout.

Selection state is owned by `cf-tab-bar` through a `CellHandle<string>` binding
(using `createStringCellController`, the same pattern as `cf-tabs`). When an item
is selected, the bar writes the new value to the cell and fires `cf-change`.

---

## cf-tab-bar

### Purpose

A fixed-position navigation bar that sizes to its content and centers itself in
the viewport. In `"inset"` mode, the nav items form a pill that shrinks to fit
rather than stretching edge-to-edge. An optional `action` slot places a primary
action button (FAB) to the right of the pill, shifting the pill left to
accommodate it — matching the iOS 18 floating tab bar pattern.

The bar responds to pointer and keyboard interactions, writes to a Cell binding
on selection change, and exposes the active item to `cf-tab-bar-item` children
via a custom event/property protocol (analogous to `tab-click` in the cf-tabs
system).

### Attributes / Properties

| Name | Type | Default | Attribute reflected | Description |
|---|---|---|---|---|
| `value` | `CellHandle<string> \| string` | `""` | no | Currently selected item value. Pass a Cell (`$value={activeTab}`) for two-way binding, or a plain string for uncontrolled use. Matches the cf-tabs pattern. |
| `position` | `"bottom" \| "top"` | `"bottom"` | yes | Whether the bar is fixed to the bottom or top of the viewport. |
| `variant` | `"default" \| "inset"` | `"default"` | yes | `"default"` spans full viewport width. `"inset"` has horizontal margin and a fully-rounded pill shape, floating above the content below it. |

#### Notes on `value`

The `value` property is not reflected to an attribute (identical to `cf-tabs`).
JSX sets it as a property. To bind a Cell, use the `$value` JSX prefix:

```tsx
const activeTab = new Cell("home");
<cf-tab-bar $value={activeTab} />
```

To use a plain string (read-only / one-way), pass the property directly:

```tsx
<cf-tab-bar value="home" />
```

### CSS custom properties

| Property | Default | Description |
|---|---|---|
| `--cf-tab-bar-height` | `4rem` | Height of the bar (including padding, excluding safe-area inset). |
| `--cf-tab-bar-background` | `rgba(var(--cf-theme-color-surface-rgb, 241 245 249) / 0.88)` | Bar background. Semi-translucent by default. |
| `--cf-tab-bar-backdrop-blur` | `12px` | Backdrop filter blur applied to the bar surface. |
| `--cf-tab-bar-border-color` | `var(--cf-theme-color-border, #e5e7eb)` | Border color of the top (bottom-positioned) or bottom (top-positioned) edge. |
| `--cf-tab-bar-z-index` | `50` | Z-index of the fixed bar. |
| `--cf-tab-bar-inset-margin` | `1rem` | Horizontal margin used by the `"inset"` variant. |
| `--cf-tab-bar-inset-radius` | `var(--cf-border-radius-full, 9999px)` | Border radius used by the `"inset"` variant. |
| `--cf-tab-bar-padding-inline` | `var(--cf-spacing-2, 0.5rem)` | Horizontal padding inside the bar. |

### CSS parts

| Part | Description |
|---|---|
| `container` | The outermost flex row that holds the nav pill and action slot side by side. |
| `bar` | The nav pill surface containing the navigation items. Style background, border, padding, etc. here. |
| `action` | The wrapper around the `action` slot. Hidden when the slot is empty. |

### Events

| Event | Bubbles | Detail | Fired when |
|---|---|---|---|
| `cf-change` | yes (composed) | `{ value: string, oldValue: string }` | The selected item changes (user click, keyboard, or external Cell write). Matches the `cf-tabs` event name and detail shape. |

### Slots

| Slot | Description |
|---|---|
| (default) | `cf-tab-bar-item` elements. Other content is ignored. |
| `action` | Optional primary action element (e.g. a `cf-button`). Renders to the right of the navigation pill. When present, the pill shifts left; when absent, the pill centers. Typically styled as a circular button to match the iOS FAB convention. |

### Keyboard navigation

Keyboard handling is implemented in `cf-tab-bar` and follows the `cf-tabs`
pattern exactly:

| Key | Behavior |
|---|---|
| `ArrowLeft` | Move focus to the previous enabled item (wraps). |
| `ArrowRight` | Move focus to the next enabled item (wraps). |
| `Home` | Move focus to the first enabled item. |
| `End` | Move focus to the last enabled item. |
| `Enter` / `Space` | Select the focused item. |

Focus movement also selects the item (activates on focus), consistent with `cf-tabs`.

The bar listens for `keydown` events that bubble up from focused items. It
filters for `CF-TAB-BAR-ITEM` target tags, gathers enabled items, and focuses
plus selects the computed next item.

### Accessibility

- `role="navigation"` is set on the host in `connectedCallback`. This signals a
  landmark navigation region. Screen reader users can jump to it via the
  landmarks list.
- `aria-label="Main navigation"` is set by default; authors can override with a
  custom `aria-label` attribute directly on `<cf-tab-bar>`.
- Items are buttons (see below), not `role="tab"`. This is intentional — ARIA
  tab semantics require panel management; a navigation bar is a set of links or
  buttons that trigger view switching.

### Safe area inset

On mobile browsers (iOS Safari, Chrome for Android), the bottom of the screen
may be obscured by system UI (home indicator, gesture bar). The bar adds bottom
padding equal to `env(safe-area-inset-bottom)` when `position="bottom"`, and top
padding equal to `env(safe-area-inset-top)` when `position="top"`. This padding
is added to the bar's own padding so the visible content area remains centered
within the visible region.

Implementor note: apply via CSS:

```css
:host([position="bottom"]) .bar {
  padding-bottom: calc(
    var(--cf-tab-bar-padding-block, 0.5rem) + env(safe-area-inset-bottom, 0px)
  );
}

:host([position="top"]) .bar {
  padding-top: calc(
    var(--cf-tab-bar-padding-block, 0.5rem) + env(safe-area-inset-top, 0px)
  );
}
```

Patterns that use `cf-screen` should also account for the bar height when
computing the main content area's bottom (or top) margin to prevent content
from being hidden behind the fixed bar. See the usage examples below.

### Visual design

**Internal layout model:**

The shadow DOM renders a flex container (`part="container"`) holding two
children: the nav pill (`part="bar"`) and the action wrapper (`part="action"`).

```
┌─── container (flex row, justify-content: center, gap) ───┐
│   ┌─── bar (pill) ───┐   ┌─── action ───┐               │
│   │ [item] [item] ... │   │  [slot=action]│               │
│   └───────────────────┘   └──────────────┘               │
└──────────────────────────────────────────────────────────┘
```

When the action slot is empty, its wrapper is `display: none` and the pill
centers naturally. When content is slotted, the container distributes space
between pill and action.

**Default variant** (`variant="default"`):

```
|==============================================|  ← full viewport width
|  [icon]  [icon]  [icon]  [icon]  [icon]     |  ← items distributed evenly
|  [label] [label] [label] [label] [label]    |
|______________________________________________|
                                  safe-area-inset-bottom
```

- Spans full viewport width (`left: 0; right: 0`).
- Items `flex: 1` to fill the bar (edge-to-edge nav).
- Top border (when positioned at bottom) or bottom border (when at top): 1px
  `--cf-tab-bar-border-color`.
- Semi-translucent background with backdrop blur.
- `box-shadow: none` in default variant (border is sufficient at full width).
- Action slot renders at the right edge of the bar, inside the same surface.

**Inset variant** (`variant="inset"`):

```
                ╭──────────────────────╮  ╭───╮
                │ [🏠] [🔍] [📬] [👤] │  │ ＋ │
                ╰──────────────────────╯  ╰───╯
                     nav pill              action (FAB)
```

- The pill sizes to its content (`width: fit-content`), not edge-to-edge.
- Items get a minimum width but don't stretch to fill — the pill wraps them.
- `border-radius: --cf-tab-bar-inset-radius` (pill by default).
- `box-shadow: var(--cf-shadow-lg)` to float above content.
- No separate edge border — border is applied on all four sides.
- `bottom: calc(--cf-tab-bar-inset-margin + env(safe-area-inset-bottom, 0px))`
  so the pill floats above the safe area.
- The action element sits beside the pill as a visually separate circle — it
  is NOT inside the pill surface. The container centers both elements as a
  group.

**Inset variant without action:**

```
                ╭──────────────────────╮
                │ [🏠] [🔍] [📬] [👤] │
                ╰──────────────────────╯
                  centered in viewport
```

The pill centers itself when no action is present.

---

## cf-tab-bar-item

### Purpose

An individual navigation item. Renders a button with an icon (slotted) above a
text label. Communicates selection intent to the parent `cf-tab-bar` by
dispatching a `tab-bar-click` internal event (analogous to the `tab-click`
event in `cf-tab`).

### Attributes / Properties

| Name | Type | Default | Reflected | Description |
|---|---|---|---|---|
| `value` | `string` | `""` | yes | Unique identifier for this item. Matched against the parent bar's current value to determine active state. |
| `label` | `string` | `""` | yes | Text label rendered below the icon. If the default slot contains content, it overrides the `label` attribute. |
| `disabled` | `boolean` | `false` | yes | Prevents selection and removes from keyboard navigation order. |
| `selected` | `boolean` | `false` | no | Set by the parent bar when this item's value matches the current selection. Not typically set by authors. |

### Slots

| Slot | Description |
|---|---|
| `icon` | Icon content — an emoji, inline SVG, or text glyph. Rendered in the upper half of the item, above the label. The slot is always rendered; if empty, the icon area collapses gracefully. |
| (default) | Alternative label content. When slotted content is present it replaces the text rendered from the `label` attribute. Useful for rich label content (e.g., a badge overlay). |

### CSS parts

| Part | Description |
|---|---|
| `item` | The root `<button>` element — the interactive surface. |
| `icon` | The icon wrapper div — contains the `icon` slot. |
| `label` | The label wrapper div — contains either the `label` attribute text or the default slot content. |

### CSS custom properties

| Property | Default | Description |
|---|---|---|
| `--cf-tab-bar-item-color` | `var(--cf-theme-color-text-muted, #6b7280)` | Inactive item color (icon + label). |
| `--cf-tab-bar-item-color-active` | `var(--cf-theme-color-primary, var(--cf-colors-primary-500))` | Active item color (icon + label). |
| `--cf-tab-bar-item-color-disabled` | `var(--cf-theme-color-text-muted, #6b7280)` at 50% opacity | Disabled item color. |
| `--cf-tab-bar-item-icon-size` | `1.5rem` | Icon area height (width is unconstrained — the slot content determines it). |
| `--cf-tab-bar-item-label-size` | `var(--cf-font-size-xs, 0.75rem)` | Label font size. |
| `--cf-tab-bar-item-gap` | `var(--cf-spacing-1, 0.25rem)` | Gap between icon and label. |

### Accessibility

- The root element is a `<button type="button">` inside the shadow DOM. This
  gives it keyboard focusability and click semantics without requiring a link
  `href`.
- `aria-current="page"` is set on the active item's shadow root button when
  `selected` is true, and removed when false. This is the correct ARIA pattern
  for navigation items (as opposed to `aria-selected`, which belongs to
  `role="tab"`).
- `aria-disabled="true"` and `tabindex="-1"` are applied when `disabled` is
  true.
- `tabindex` follows the roving tabindex pattern: the active (selected) item
  has `tabindex="0"`, all others have `tabindex="-1"`. This matches how
  `cf-tab` manages focus within `cf-tabs`.
- The `icon` slot is wrapped in `aria-hidden="true"` so decorative icons are
  not announced separately. The `label` text is the accessible name of the
  button (either from the `label` attribute or the default slot).

### Visual design

Each item is a flex column: icon centered above label, both centered horizontally.
Items fill equal width inside the bar (`flex: 1`).

```
        ┌─────────────────┐
        │     [icon]       │  ← icon slot, 1.5rem height
        │     [label]      │  ← label text, 0.75rem
        └─────────────────┘
```

Active item color: `--cf-tab-bar-item-color-active` (theme primary).
Inactive item color: `--cf-tab-bar-item-color` (muted text).

The color transition uses `var(--cf-transition-duration-fast, 150ms)
var(--cf-transition-timing-ease)`, matching `cf-tab`.

There is no separate active indicator line or pill under the icon — color alone
signals selection. This is deliberate for the navigation bar context where
spatial layout and icon identity carry the primary meaning. Implementors who want
an indicator can add one via `::part(item)[data-selected="true"]` CSS.

---

## Internal communication protocol

`cf-tab-bar` and `cf-tab-bar-item` communicate through two mechanisms, following
the same pattern as `cf-tabs` and `cf-tab`:

1. **Item-to-bar (upward):** When a `cf-tab-bar-item` is clicked, it dispatches
   a `tab-bar-click` custom event (bubbling, composed) with `detail: { item: this
   }`. `cf-tab-bar` listens for this event and calls its internal `_handleItemClick`
   method, which updates the cell controller value.

2. **Bar-to-item (downward):** `cf-tab-bar` calls `updateItemSelection()` after
   any value change. This method queries `this.querySelectorAll("cf-tab-bar-item")`
   and sets the `selected` boolean property on each item, allowing each item to
   update its `aria-current` and visual state.

The `selected` property is never set by authors in normal usage. It is a
coordination property managed entirely by the parent bar.

---

## Z-index layer

The bar uses `z-index: var(--cf-tab-bar-z-index, 50)` by default. This places
it:

- Above regular page content and `position: sticky` headers.
- Below modals (z-index: 1000+) and toasts (z-index: 1100).

Since the primary action (FAB) is now an `action` slot within the tab bar, there
is no z-index conflict between navigation and the action button — they share the
same stacking context. The existing `cf-fab` (the morphing chat pill) remains at
z-index 999 and is a separate concern.

---

## Usage examples

### Basic bottom tab bar with Cell binding

```tsx
import { cell } from "@commontools/common-runner";

// In pattern output:
const activeTab = cell("home");

// In [UI]:
<cf-tab-bar $value={activeTab}>
  <cf-tab-bar-item value="home" label="Home">
    <span slot="icon">🏠</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="explore" label="Explore">
    <span slot="icon">🔍</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="inbox" label="Inbox">
    <span slot="icon">📬</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="profile" label="Profile">
    <span slot="icon">👤</span>
  </cf-tab-bar-item>
</cf-tab-bar>
```

When the user taps "Explore", `activeTab` is written to `"explore"` and
`cf-change` fires with `{ value: "explore", oldValue: "home" }`.

### Integration with cf-screen

`cf-screen` provides `header`, main (default), and `footer` slots. Place
`cf-tab-bar` in the `footer` slot so it renders at the bottom of the screen
layout. The bar is still `position: fixed` in the viewport; `cf-screen` does not
need to know about it. Add bottom padding to the main content to prevent the
last item from being obscured by the bar.

```tsx
<cf-screen>
  <cf-app-bar slot="header" title="My App" />

  <div style="
    padding-bottom: calc(4rem + env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
    height: 100%;
  ">
    {/* Main content for the active tab */}
    {activeTab === "home" && <HomeView />}
    {activeTab === "explore" && <ExploreView />}
    {activeTab === "inbox" && <InboxView />}
    {activeTab === "profile" && <ProfileView />}
  </div>

  {/* cf-tab-bar in the footer slot for semantic placement.
      It still fixes to the viewport, but placing it here keeps
      the component tree organized and makes the relationship
      between screen and navigation explicit. */}
  <cf-tab-bar slot="footer" $value={activeTab}>
    <cf-tab-bar-item value="home" label="Home">
      <span slot="icon">🏠</span>
    </cf-tab-bar-item>
    <cf-tab-bar-item value="explore" label="Explore">
      <span slot="icon">🔍</span>
    </cf-tab-bar-item>
    <cf-tab-bar-item value="inbox" label="Inbox">
      <span slot="icon">📬</span>
    </cf-tab-bar-item>
    <cf-tab-bar-item value="profile" label="Profile">
      <span slot="icon">👤</span>
    </cf-tab-bar-item>
  </cf-tab-bar>
</cf-screen>
```

### Switching content based on selected tab

The parent pattern owns the view-switching logic. The cell binding makes this
straightforward:

```tsx
// Pattern code
const activeView = cell("home");

// Using ifElse for binary views (two tabs)
const mainContent = ifElse(
  computed(() => activeView.get() === "home"),
  <HomeView />,
  <SettingsView />,
);

// For more than two tabs, use computed()
const mainContent = computed(() => {
  switch (activeView.get()) {
    case "home":    return <HomeView />;
    case "explore": return <ExploreView />;
    case "inbox":   return <InboxView />;
    case "profile": return <ProfileView />;
    default:        return <HomeView />;
  }
});

// [UI]
<div style="height: 100%; display: flex; flex-direction: column;">
  <div style="flex: 1; overflow-y: auto; padding-bottom: calc(4rem + env(safe-area-inset-bottom, 0px));">
    {mainContent}
  </div>
  <cf-tab-bar $value={activeView}>
    <cf-tab-bar-item value="home"    label="Home">    <span slot="icon">🏠</span> </cf-tab-bar-item>
    <cf-tab-bar-item value="explore" label="Explore"> <span slot="icon">🔍</span> </cf-tab-bar-item>
    <cf-tab-bar-item value="inbox"   label="Inbox">   <span slot="icon">📬</span> </cf-tab-bar-item>
    <cf-tab-bar-item value="profile" label="Profile"> <span slot="icon">👤</span> </cf-tab-bar-item>
  </cf-tab-bar>
</div>
```

Note: The `computed()` wrapping a switch is the correct pattern here (see
MEMORY.md). The `[UI]` itself must remain a static VNode — only inner children
should use `computed()` or `ifElse`.

### Inset (pill) variant

```tsx
<cf-tab-bar $value={activeTab} variant="inset">
  <cf-tab-bar-item value="home"   label="Home">   <span slot="icon">🏠</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="search" label="Search"> <span slot="icon">🔍</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="me"     label="Me">     <span slot="icon">👤</span> </cf-tab-bar-item>
</cf-tab-bar>
```

The pill floats `1rem` above the safe area inset with full rounded corners and a
drop shadow. Suitable for UIs where the bar should feel like a floating control
rather than an edge chrome element.

### Inset variant with action (FAB)

```tsx
<cf-tab-bar $value={activeTab} variant="inset">
  <cf-tab-bar-item value="home"   label="Home">   <span slot="icon">🏠</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="search" label="Search"> <span slot="icon">🔍</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="inbox"  label="Inbox">  <span slot="icon">📬</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="me"     label="Me">     <span slot="icon">👤</span> </cf-tab-bar-item>

  <cf-button slot="action" variant="primary"
    style="border-radius: 9999px; width: 3.5rem; height: 3.5rem; padding: 0;"
    onClick={compose}>
    ＋
  </cf-button>
</cf-tab-bar>
```

The action button appears to the right of the nav pill as a visually separate
circle. The pill + action center as a group. This replaces the need for a
separate FAB component in most app navigation layouts — a standard `cf-button`
in the action slot is sufficient.

### Disabled item

```tsx
<cf-tab-bar $value={activeTab}>
  <cf-tab-bar-item value="home"    label="Home">    <span slot="icon">🏠</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="premium" label="Upgrade"  disabled>
    <span slot="icon">⭐</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="profile" label="Profile"> <span slot="icon">👤</span> </cf-tab-bar-item>
</cf-tab-bar>
```

Disabled items render at reduced opacity, do not respond to pointer events, and
are skipped by keyboard navigation.

### Top-positioned bar

```tsx
<cf-tab-bar $value={activeSection} position="top">
  <cf-tab-bar-item value="feed"     label="Feed">     <span slot="icon">📰</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="trending" label="Trending"> <span slot="icon">🔥</span> </cf-tab-bar-item>
  <cf-tab-bar-item value="saved"    label="Saved">    <span slot="icon">🔖</span> </cf-tab-bar-item>
</cf-tab-bar>
```

When `position="top"`, the bar fixes to the top of the viewport, accounts for
`env(safe-area-inset-top)`, and applies a bottom border instead of a top border.

---

## Styling via CSS parts

The `::part()` API allows per-app style overrides from outside the shadow DOM:

```css
/* Taller bar */
cf-tab-bar::part(bar) {
  --cf-tab-bar-height: 5rem;
}

/* Custom active color per-app */
cf-tab-bar-item {
  --cf-tab-bar-item-color-active: #8b5cf6;
}

/* Active indicator dot under icon */
cf-tab-bar-item::part(icon)[data-selected="true"]::after {
  content: "";
  display: block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--cf-tab-bar-item-color-active);
  margin: 2px auto 0;
}
```

---

## Implementation notes

### Selection update timing

Like `cf-tabs`, the bar uses `requestAnimationFrame` to defer the first
`updateItemSelection()` call when items are found in the DOM but their `value`
properties have not yet been assigned by the JSX framework. This avoids a
double-update on first render.

The `firstUpdated` lifecycle method initializes the cell controller binding
(calling `_cellController.bind(this.value, stringSchema)`) and sets up a
`slotchange` listener on the default slot to detect dynamically added items.

### Cell controller

`cf-tab-bar` uses `createStringCellController` with `timing: { strategy:
"immediate" }` — navigation selection changes should be reflected instantly, not
debounced.

```ts
private _cellController = createStringCellController(this, {
  timing: { strategy: "immediate" },
  onChange: (newValue: string, oldValue: string) => {
    this._lastKnownValue = newValue;
    this.updateItemSelection();
    this.emit("cf-change", { value: newValue, oldValue });
  },
});
```

### Item discovery

`cf-tab-bar` discovers child items with:

```ts
private getItems(): NodeListOf<Element> {
  return this.querySelectorAll("cf-tab-bar-item");
}
```

This matches the `cf-tabs` approach of using `querySelectorAll` rather than
slot inspection, which avoids the complexity of shadow DOM slot traversal and
is reliable when items are direct light DOM children.

### No panel management

`cf-tab-bar` does not manage panels, set `hidden` on anything, or participate in
ARIA tabpanel relationships. All content-switching logic lives in the parent
pattern. This is the key architectural distinction from `cf-tabs`.

### Template structure

The shadow DOM template wraps items and action in a two-level structure:

```html
<div class="container" part="container">
  <div class="bar" part="bar">
    <slot></slot>
  </div>
  <div class="action" part="action">
    <slot name="action" @slotchange="${this._handleActionSlotChange}"></slot>
  </div>
</div>
```

The `_handleActionSlotChange` handler sets a `_hasAction` state flag. When
false, `.action` is `display: none`. In inset mode, the container uses
`width: fit-content; margin: 0 auto;` so the pill + action group centers.
In default mode, the bar stretches full-width and the action sits at the
right edge.

### Inset mode item sizing

In default mode, items use `flex: 1` to fill the bar. In inset mode, items
use `min-width` instead so the pill shrinks to fit content rather than
stretching edge-to-edge. The CSS for this:

```css
:host([variant="inset"]) ::slotted(cf-tab-bar-item) {
  flex: 0 0 auto;
  min-width: 3.5rem;
}
```

---

## File locations (proposed)

```
packages/ui/src/v2/components/cf-tab-bar/
  cf-tab-bar.ts          — CFTabBar element
  cf-tab-bar-item.ts     — CFTabBarItem element
  index.ts               — re-exports both
  styles.ts              — shared style utilities (if needed)
```

Register both elements with `globalThis.customElements.define` at the bottom of
their respective files, consistent with all other components in the package.

Both files should be added to the package's main barrel export
(`packages/ui/src/v2/index.ts` or equivalent) so they are available to patterns
without per-file imports.

---

## Future enhancements (out of v1 scope)

### Badge counts on items

A `badge` attribute (or slot) on `cf-tab-bar-item` for notification counts
(`<cf-tab-bar-item value="inbox" badge={unreadCount} label="Inbox">`). Renders a
small numeric pill overlaid on the icon.

### Animated active indicator

An animated sliding indicator that moves beneath the active item when selection
changes. Requires tracking item positions and animating a shared indicator
element in the bar.

### SVG icon support helpers

A companion `cf-tab-bar-icon` element or a set of built-in icon names that render
as SVGs, so authors don't need to supply their own SVG markup for common icons
(home, search, bell, person).

### Scroll-to-hide behavior

On scroll-heavy pages, the bar could hide itself when the user scrolls down and
reappear on scroll up (common iOS app pattern). This could be opt-in via a
`hide-on-scroll` boolean attribute.

---

## Open questions

1. Should `cf-tab-bar-item` accept an `href` attribute to render as an `<a>`
   instead of a `<button>`? For patterns that use real URL routing, a link
   element would provide middle-click and "Open in new tab" semantics. For v1,
   button is sufficient since patterns manage view switching reactively without
   URL navigation.

2. Should there be a `label-hidden` attribute on `cf-tab-bar-item` for icon-only
   bars? The label would still exist in the DOM for accessibility (as the button's
   accessible name) but not be visually rendered. This is common in narrow-screen
   designs.

3. The `variant="inset"` pill positioning — should the inset margin and bottom
   offset be separate CSS custom properties, or should a single
   `--cf-tab-bar-inset-offset` property control the distance from the screen
   edge? Separate properties give more control; a single property is simpler for
   the common case.

4. Should `cf-tab-bar` emit `cf-change` when the Cell changes externally (from
   outside the component), or only when the user interacts? Currently specced to
   emit on all value changes (matching `cf-tabs` behavior), but some authors might
   prefer to distinguish user interactions from programmatic updates.
