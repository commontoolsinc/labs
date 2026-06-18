<!-- @reviewed 2026-06-10 docs-overhaul-phase-3 -->

# UI Components Reference

This file is the **agent-facing index plus usage narrative** for the Common
Fabric UI library. Division of labor:

- **This file** — complete component index (tag, purpose, bindable props) and
  the usage narrative that is not derivable from source.
- [`packages/patterns/catalog/catalog.tsx`](../../../packages/patterns/catalog/catalog.tsx)
  and the story files under
  [`packages/patterns/catalog/stories/`](../../../packages/patterns/catalog/stories/)
  — authoritative, type-checked live usage.
- Component source under
  [`packages/ui/src/v2/components/`](../../../packages/ui/src/v2/components/)
  — authoritative props, events, and JSDoc.
- [`packages/ui/LLM-COMPONENT-INSTRUCTIONS.md`](../../../packages/ui/LLM-COMPONENT-INSTRUCTIONS.md)
  — HTML attribute tables per component.

## Bidirectional Binding

Use the `$` prefix for explicit two-way sync. That is the normal authoring
form for Common Fabric controls. No handler is needed for simple updates.

```tsx
<cf-checkbox $checked={item.done} />    // Auto-syncs checkbox state
<cf-input $value={title} />             // Auto-syncs text input
<cf-select $value={category} items={[...]} />
```

**Native HTML inputs are one-way only.** Always use the Common Fabric form
components for inputs.

Use camelCase for component properties — kebab-case JSX attributes don't map
correctly:

```tsx
// ❌ Kebab-case won't work
<cf-autocomplete allow-custom={true} />  // Sets element["allow-custom"], not allowCustom

// ✅ CamelCase works
<cf-autocomplete allowCustom={true} />  // Sets element.allowCustom correctly
```

When a control is already bound to a cell via `$value`, treat that binding as
the primary value path. Avoid `oncf-change` handlers that simply write the same
value back into the same cell; use them only for dependent state or side
effects.

For when to use handlers vs binding — and the standard `equals()` idiom for
removing array items by identity — see
[two-way-binding](../patterns/two-way-binding.md).

### Testing note: Playwright `fill()`

Playwright's `fill()` does not work on `cf-input` hosts (they are custom
elements, not native inputs). Use `type @ref "text"` in agent-browser, or
`locator.pressSequentially()` in Playwright tests:

```bash
agent-browser snapshot -i              # → textbox "Title" [ref=e4]
agent-browser type @e4 "Quarterly plan"
```

## Component Index

One row per component directory in `packages/ui/src/v2/components/`. "Bindable
props" lists cell-bound (`$`-prefixed) properties verified in source; an empty
cell means none confirmed — check the component source before assuming.

| Tag | Purpose | Bindable props |
|-----|---------|----------------|
| `cf-accordion` | Container for collapsible content panels | |
| `cf-accordion-item` | Individual accordion panel | |
| `cf-alert` | Alert message with variants and dismissible option | |
| `cf-area-mark` | Filled area mark rendered inside `cf-chart` | `$data` |
| `cf-aspect-ratio` | Maintains a fixed aspect ratio for its content | |
| `cf-attachments-bar` | Displays pinned cells as a horizontal list of chips | |
| `cf-audio-visualizer` | Real-time audio waveform visualization | |
| `cf-autocomplete` | Search input with filterable dropdown; single/multi select | `$value`, `$items` |
| `cf-autolayout` | Responsive multi-panel layout | |
| `cf-autostart` | Zero-UI element that emits a `start` event once on connect | |
| `cf-avatar` | Avatar showing data-URI image, emoji glyph, or initials | |
| `cf-badge` | Status indicator / label with visual variants | |
| `cf-bar-mark` | Bar mark rendered inside `cf-chart` | `$data` |
| `cf-button` | Interactive button with color/variant/size options | |
| `cf-calendar` | Month-grid mini calendar | `$value`, `$markedDates` |
| `cf-canvas` | Fixed-size canvas surface emitting `cf-canvas-click` with x/y | |
| `cf-card` | Content container with header/content/footer (built-in 1rem padding) | |
| `cf-cell-context` | Associates a page region with a cell for inspection (see [CELL_CONTEXT.md](CELL_CONTEXT.md)) | `$cell` |
| `cf-cell-link` | Renders a link or cell as a clickable, draggable pill | |
| `cf-cfc-authorship` | Shows trusted authorship state for CFC-labeled content | `$value`, `$author` |
| `cf-cfc-label` | Renders the CFC label of a bound cell value | `$value` |
| `cf-chart` | SVG charting container for line/area/bar/dot marks (see [cf-chart](#cf-chart)) | `$marks` (marks: `$data`) |
| `cf-chat` | Chat container handling message flow and tool-call correlation | `$messages` |
| `cf-chat-message` | Single chat message with markdown support | |
| `cf-checkbox` | Binary selection input with indeterminate support | `$checked` |
| `cf-chevron-button` | Minimal chevron button rotating between up/down | |
| `cf-chip` | Compact pill/label for status, tags, and filters | |
| `cf-code-editor` | Code/prose editor with highlighting and `[[`-mention completion | `$value`, `$mentionable`, `$mentioned` |
| `cf-collapsible` | Single collapsible section with trigger and content | |
| `cf-copy-button` | Copy-to-clipboard button with visual feedback | |
| `cf-dot-mark` | Scatter/dot mark rendered inside `cf-chart` | `$data` |
| `cf-drag-source` | Wraps draggable content; pairs with `cf-drop-zone` (see [drag-and-drop](../patterns/meta/drag-and-drop.md)) | `$cell` |
| `cf-draggable` | Absolutely-positioned draggable container (x/y) | |
| `cf-drop-zone` | Droppable region emitting `cf-drop` events (see [drag-and-drop](../patterns/meta/drag-and-drop.md)) | |
| `cf-empty-state` | Centered, muted placeholder for empty lists (see [cf-empty-state](#cf-empty-state)) | |
| `cf-fab` | Morphing floating action button that expands into a panel | |
| `cf-field` | Labeled field wrapper: muted label, optional required/error/help text (see [cf-field](#cf-field)) | |
| `cf-file-download` | File download button (encapsulates blob/anchor download) | `$data`, `$filename` |
| `cf-file-input` | Generic file upload | |
| `cf-form` | Transactional form wrapper buffering field writes until submit (see [cf-form](#cf-form)) | |
| `cf-fragment` | Transparent wrapper element (`display: contents`) | |
| `cf-google-oauth` | Google OAuth login (wrapper over `cf-oauth`) | `$auth` |
| `cf-grid` | CSS Grid layout | |
| `cf-heading` | Theme-compliant heading replacing `h1`–`h6` | |
| `cf-hgroup` | Horizontal group with automatic gap management | |
| `cf-hscroll` | Horizontal scroll container | |
| `cf-hstack` | Horizontal stack layout (flexbox) (see [stacks](#cf-vstack--cf-hstack)) | |
| `cf-iframe` | Iframe for executing arbitrary scripts | |
| `cf-image-input` | Image capture/upload with compression, EXIF, camera support | |
| `cf-input` | Text input with validation and reactive binding | `$value` |
| `cf-input-otp` | One-time-password input with individual digit fields | |
| `cf-kbd` | Inline keyboard hint element | |
| `cf-keybind` | Declarative keyboard shortcut listener | |
| `cf-label` | Form field label with accessibility features | |
| `cf-line-mark` | Line mark rendered inside `cf-chart` | `$data` |
| `cf-link` | Navigation link that emits `cf-route-change` for `cf-router` | |
| `cf-link-preview` | Rich link preview card for a URL | |
| `cf-list-item` | Generic list row (SwiftUI-List inspired) | |
| `cf-loader` | Inline spinner for pending async operations | |
| `cf-location` | Geolocation capture (single or continuous) | `$location` |
| `cf-map` | Interactive Leaflet/OpenStreetMap map (see [cf-map](#cf-map)) | `$value`, `$center`, `$zoom`, `$bounds` |
| `cf-markdown` | Renders markdown with syntax highlighting and copy buttons | `$content` |
| `cf-message-beads` | Compact bead visualization of a message history | `$messages` |
| `cf-message-input` | Input + send button combo for chat-style item entry | |
| `cf-modal` | Accessible modal dialog with bottom-sheet presentation mode | `$open` |
| `cf-modal-provider` | Modal stack manager | |
| `cf-oauth` | Generic OAuth authentication | `$auth` |
| `cf-picker` | Carousel selection over cells with `[UI]` | `$items`, `$selectedIndex` |
| `cf-piece` | Provides piece context to child components | |
| `cf-plaid-link` | Plaid banking integration | `$auth` |
| `cf-profile-badge` | The blessed, trusted way to render a profile identity (avatar + name + the generative verification seal — a DID-derived aura ring + cursor glint, no shield icon); navigable to the profile. Variants `full`/`chip`/`circle`/`hero` + `size`/`noNavigate` attrs (CT-1761). Prefer it over a bare name/avatar anywhere an identity appears. | `$profile` |
| `cf-progress` | Progress bar, determinate or indeterminate | |
| `cf-prompt-input` | Multiline prompt input with `@`-mentions, attachments, voice | `$mentionable`, `$model` |
| `cf-question` | Asks a single question and collects the answer | |
| `cf-radio` | Single radio button used within `cf-radio-group` | |
| `cf-radio-group` | Radio group; declarative `items` or slotted `cf-radio` | `$value` |
| `cf-render` | Renders a cell containing a piece pattern at a UI variant — `full`/`chip`/`tile` (see [cf-render](#cf-render)) | `$cell`, `variant` |
| `cf-resizable-handle` | Drag handle between resizable panels | |
| `cf-resizable-panel` | Individual panel within a resizable panel group | |
| `cf-resizable-panel-group` | Container managing resizable panels and handles | |
| `cf-router` | Routes `cf-route-change` events into a path cell | `$path` |
| `cf-screen` | Full-height layout with header/main/footer slots (see [cf-screen](#cf-screen)) | |
| `cf-scroll-area` | Scrollable container with custom-styled scrollbars | |
| `cf-secret-viewer` | Trusted UI for revealing secret strings | `$value` |
| `cf-select` | Dropdown taking `{ label, value }` items — not `<option>` elements | `$value` |
| `cf-separator` | Visual divider line between content sections | |
| `cf-skeleton` | Animated loading placeholder | |
| `cf-slider` | Range input slider | |
| `cf-space-link` | Renders a space as a clickable navigation pill | |
| `cf-svg` | Renders SVG content from a string | |
| `cf-switch` | Toggle switch for binary on/off state | `$checked` |
| `cf-tab` | Individual tab button used within `cf-tab-list` | |
| `cf-tab-bar` | Fixed navigation bar for app-like UIs (with `cf-tab-bar-item`) | `$value` |
| `cf-tab-bar-item` | Individual item within `cf-tab-bar` (value, label, icon) | |
| `cf-tab-list` | Container for tab buttons | |
| `cf-tab-panel` | Content panel associated with a tab | |
| `cf-table` | Semantic table with striped/hover/bordered styling | |
| `cf-tabs` | Container managing ARIA tab navigation and panels | `$value` |
| `cf-tags` | Tag pills with add/remove functionality | |
| `cf-text` | Generic text primitive for non-label typography (see [cf-text](#cf-text)) | |
| `cf-textarea` | Multi-line text input with auto-resize and reactive binding | `$value` |
| `cf-theme` | Provides a theme to a subtree and applies CSS variables | |
| `cf-tile` | Page/item preview tile with click handling | |
| `cf-toast` | Floating ephemeral notification (inside `cf-toast-provider`) | |
| `cf-toast-provider` | Region that hosts and displays `cf-toast` notifications | |
| `cf-toggle` | Pressable toggle button with variants and sizes | |
| `cf-toggle-group` | Toggle container with single or multiple selection | |
| `cf-tool-call` | Expandable tool-call display | |
| `cf-toolbar` | Horizontal toolbar for grouping controls | |
| `cf-tools-chip` | Pill revealing a read-only tool list on hover/tap | `$tools` |
| `cf-updater` | Button registering pieces for background updates | `$state` |
| `cf-vgroup` | Vertical group with automatic gap management | |
| `cf-voice-input` | Voice recording and transcription | `$transcription` |
| `cf-vscroll` | Vertical scroll container (snap-to-bottom, fade edges) | |
| `cf-vstack` | Vertical stack layout (flexbox) (see [stacks](#cf-vstack--cf-hstack)) | |
| `cf-webhook` | Webhook integration: receives payloads into a stream | `$inbox`, `$config` |

---

## cf-form

`cf-form` provides a "write gate" for transactional form submission:

- Fields buffer writes locally instead of immediately writing to cells
- On submit, all buffered values are validated and flushed atomically, then
  `cf-submit` is emitted
- On reset (`cf-button type="reset"` or `form.reset()`), buffered changes are
  discarded and fields restore their initial cell values
- Works for both "create" (fresh staging cell) and "edit" (existing cell) modes

All form-compatible fields (`cf-input`, `cf-select`, `cf-checkbox`,
`cf-textarea`) share the same behavior: **outside** `cf-form` they write to
the bound cell immediately; **inside** `cf-form` they buffer until submit.

```tsx
<cf-form oncf-submit={handleSubmit}>
  <cf-input name="email" $value={data.key("email")} required />
  <cf-button type="submit">Save</cf-button>
</cf-form>
```

### Create mode

Bind fields to a staging cell, then copy to the collection on submit:

```tsx
const formData = new Writable({ name: "", email: "" });

<cf-form
  oncf-submit={handler((_, { formData, collection }) => {
    // cf-form flushes buffers to cells before emitting cf-submit,
    // so we can read the complete, typed object directly.
    // IMPORTANT: Copy the object to avoid sharing references!
    collection.push({ ...formData.get() });
  }, { formData, collection })}
>
  <cf-input name="name" $value={formData.key("name")} required />
  <cf-input name="email" $value={formData.key("email")} type="email" />
  <cf-button type="submit">Create</cf-button>
</cf-form>;
```

**The copy trap:** always copy with `{ ...formData.get() }` when adding to a
collection. The staging cell is reused between submissions, so pushing the same
object reference would make all items share the same data.

### Edit mode

Bind fields to a pointer (`Writable<Person>`) instead of using indices; on
submit, values are flushed to the bound cell:

```tsx
export const EditPerson = pattern<{ person: Writable<Person> }, { [UI]: VNode }>(
  ({ person }) => ({
    [UI]: (
      <cf-form oncf-submit={closeModal}>
        <cf-input name="name" $value={person.key("name")} required />
        <cf-input name="email" $value={person.key("email")} type="email" />
        <cf-button type="submit">Save</cf-button>
        <cf-button type="reset">Cancel</cf-button>
      </cf-form>
    ),
  }),
);
```

When choosing which item to edit from a list, store the pointer and find it
with `equals()` (see [two-way-binding](../patterns/two-way-binding.md)), not
array indices, which drift when lists change.

### Events and best practices

- `cf-submit` — emitted after validation passes and buffers are flushed.
  Handlers should read from the bound cell directly (type-safe), not from
  event detail.
- `cf-form-invalid` — emitted when submit is attempted but validation fails;
  detail carries `{ errors: Array<{ element, message? }> }`.
- Fields use HTML5 constraint validation by default.
- When using `cf-modal` around a form, bind `$open` to a `Writable<boolean>`
  (not a `computed`) so the modal can update state.

Contributor-facing internals (FormFieldController, file organization, design
decisions) live in
[`packages/ui/docs/forms-internals.md`](../../../packages/ui/docs/forms-internals.md).

---

## cf-field

`cf-field` is a layout/typography wrapper for labeled form fields. It replaces
the hand-rolled label-above-control stack repeated throughout patterns:

```tsx
// Before
<cf-vstack gap="1">
  <label style={{ fontSize: "12px", color: "#6b7280" }}>Email</label>
  <cf-input type="email" $value={address} />
</cf-vstack>

// After
<cf-field label="Email">
  <cf-input type="email" $value={address} />
</cf-field>
```

Attributes:

- `label` — small muted label rendered above the control
- `required` — appends a danger-colored asterisk to the label
- `error` — error text below the control in the danger color (replaces `help`
  while set)
- `help` — muted helper text below the control

The default slot takes any control (`cf-input`, `cf-select`, `cf-textarea`,
…). All colors and sizes come from theme tokens, so fields adapt to the
ambient `cf-theme`.

```tsx
<cf-field label="Username" required error={usernameError}>
  <cf-input $value={username} placeholder="Pick a username" />
</cf-field>

<cf-field label="Bio" help="Shown on your public profile.">
  <cf-textarea $value={bio} />
</cf-field>
```

Notes:

- `cf-field` is presentation only — it renders whatever `error` string it is
  given. Validation logic and submit gating belong to
  [`cf-form`](#cf-form) or the pattern.
- Shadow DOM prevents a native `for`/`id` association with the slotted
  control, so clicking the label focuses (and for custom elements, clicks)
  the first slotted element instead — same approach as `cf-label`. For full
  assistive-technology support, also set `aria-label` on the control itself.

---

## cf-render

Renders pattern instances for composition.

```tsx
import SubPattern from "./sub-pattern.tsx";

const subView = SubPattern({ items });

// Three equivalent ways:
<cf-render $cell={subView} />   // Most explicit
{subView}                        // Direct interpolation
<SubPattern items={items} />     // JSX syntax
```

**Use `$cell`, not `piece` or `pattern` attribute.**

Multiple patterns sharing data:

```tsx
const listView = ListView({ items });
const gridView = GridView({ items });

<div style={{ display: "flex", gap: "1rem" }}>
  <cf-render $cell={listView} />
  <cf-render $cell={gridView} />
</div>
// Both views stay in sync automatically
```

See [composition](../patterns/composition.md) for more on pattern composition.

### UI variants (CT-1321)

A piece can expose a **size spectrum** of renderings as optional sibling output
keys, addressed by symbols vended from `commonfabric`:

| Variant | Output key | Symbol | Use |
| --- | --- | --- | --- |
| `full` | `"$UI"` | `UI` | Standalone rendering — the default, and the universal floor. |
| `chip` | `"$CHIP_UI"` | `CHIP_UI` | Inline rendering for text and lists. |
| `tile` | `"$TILE_UI"` | `TILE_UI` | Gallery/grid card. |

Pick a variant with the `variant` attribute (default `"full"`):

```tsx
<cf-render $cell={piece} variant="full" />   // default — standalone
<cf-render $cell={piece} variant="chip" />   // inline
<cf-render $cell={piece} variant="tile" />   // gallery/grid tile
```

**Failover — every piece renders at every variant.** When a piece doesn't
export the requested variant key, `cf-render` substitutes a per-variant platform
default:

- `chip` → a `cf-cell-link` bound to the piece (renders it by its `[NAME]`).
- `tile` → the full `[UI]` rendered small at ~0.5 scale, clipped to a static
  preview and clickable to navigate to the piece (like `cf-cell-link`).

Because `full`/`[UI]` is the universal floor, a piece that exports only `[UI]`
still renders correctly at `chip` and `tile`.

A pattern exports the spectrum by returning the sibling keys:

```tsx
import { CHIP_UI, NAME, pattern, TILE_UI, UI } from "commonfabric";

export default pattern(({ title }) => ({
  [NAME]: title,
  [UI]: <FullView title={title} />,      // standalone (always provide this)
  [CHIP_UI]: <InlineChip title={title} />, // optional inline
  [TILE_UI]: <GridTile title={title} />,   // optional gallery tile
}));
```

See `packages/patterns/examples/ui-variants-demo.tsx` for a full example.

> Note: `sidebarUI`/`fabUI`/`settingsUI` are shell composition **slots**, a
> separate concept — not size variants. A vended `uiVariant()` helper for
> render paths outside `cf-render` is a planned follow-up and does not exist yet.

---

## cf-screen

Full-height app layout with pinned header, auto-scrolling main area, and pinned
footer. Use instead of `<div style={{ height: "100%" }}>` which doesn't work
(parent has no explicit height).

Content in the default slot scrolls automatically when it overflows. Use
`cf-vscroll` inside `cf-screen` only when you need snap-to-bottom (chat),
fade-edges, or a styled/hidden scrollbar.

```tsx
// Simple case — main area scrolls automatically
<cf-screen>
  <cf-heading slot="header" level={2}>Title</cf-heading>
  <cf-vstack gap="4" padding="4">
    {items}
  </cf-vstack>
</cf-screen>

// Chat case — snap-to-bottom + fade-edges
<cf-screen>
  <cf-heading slot="header" level={2}>Chat</cf-heading>
  <cf-vscroll flex snapToBottom fadeEdges>
    {messages}
  </cf-vscroll>
  <cf-message-input slot="footer" />
</cf-screen>
```

---

## cf-empty-state

Centered, muted placeholder for empty lists and regions. Use instead of ad-hoc
`<div style="text-align: center; color: ...; padding: 2rem;">` blocks.

The message comes from the `message` attribute (simple case) or the default
slot. Optional `icon` and `action` slots render above and below the message.

```tsx
// Simple case — message attribute
{items.get().length === 0
  ? <cf-empty-state message="No items yet. Add one below!" />
  : null}

// With icon and a call to action
<cf-empty-state>
  <span slot="icon">📋</span>
  Your shopping list is empty.
  <cf-button slot="action" size="sm" onClick={addItem}>
    Add first item
  </cf-button>
</cf-empty-state>
```

---

## cf-text

Generic text primitive for non-label typography: captions, helper copy,
metadata, descriptions. Use `cf-label` only when text labels a specific
control.

- `variant` — typography role: `caption`, `body-compact`, `body` (default),
  `body-large`, `heading-sm`, `heading-md`, `heading-lg`
- `tone` — semantic color: `default`, `muted`, `tertiary`, `disabled`,
  `primary`, `success`, `warning`, `error`
- `block` — render as block text instead of inline text
- `truncate` — clip overflowing text to a single line with an ellipsis. Use
  instead of ad-hoc
  `style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"`.
  `truncate` implies block display, so combining it with `block` is allowed
  but redundant. The host also gets `min-width: 0` so it shrinks and
  truncates correctly inside flex rows like `cf-hstack`.

```tsx
// Truncated note next to fixed-width siblings in a row
<cf-hstack gap="2" align="center">
  <cf-text truncate tone="muted">{item.notes}</cf-text>
  <cf-badge size="xs">{item.status}</cf-badge>
</cf-hstack>
```

---

## cf-vstack / cf-hstack

Vertical and horizontal flexbox stacks. Shared layout props:

- `gap` — space between items (`0`–`24` numeric scale or `xs`–`xl`)
- `align` / `justify` — flexbox alignment
- `reverse` — reverse the direction (`wrap` is cf-hstack only)
- `padding` — uniform padding around the stack (same scale as `gap`)
- `px` / `py` — horizontal / vertical axis padding (same scale)
- `pt` / `pr` / `pb` / `pl` — single-side padding (same scale)

Padding precedence: single-side props (`pt`/`pr`/`pb`/`pl`) override the axis
props (`px`/`py`) on their side, which override the uniform `padding`. Use
these instead of inline `style="padding-top: ..."` overrides.

```tsx
// Uniform padding, but tighter on top
<cf-vstack gap="2" padding="4" pt="2">
  {items}
</cf-vstack>

// Axis-only padding
<cf-hstack gap="2" px="4" py="1">
  {toolbarButtons}
</cf-hstack>
```

---

## cf-map

Interactive map component using Leaflet with OpenStreetMap tiles. No API key required.

### Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `value` / `$value` | `MapValue \| Writable<MapValue>` | `{}` | Map data with markers, circles, polylines |
| `center` / `$center` | `LatLng \| Writable<LatLng>` | San Francisco | Map center coordinates (bidirectional) |
| `zoom` / `$zoom` | `number \| Writable<number>` | `13` | Zoom level 0-18 (bidirectional) |
| `bounds` / `$bounds` | `Bounds \| Writable<Bounds>` | - | Visible map bounds (bidirectional) |
| `fitToBounds` | `boolean` | `false` | Auto-fit to show all features |
| `interactive` | `boolean` | `true` | Enable pan/zoom |

### Types

```tsx
interface LatLng { lat: number; lng: number; }
interface Bounds { north: number; south: number; east: number; west: number; }

interface MapValue {
  markers?: MapMarker[];
  circles?: MapCircle[];
  polylines?: MapPolyline[];
}

interface MapMarker {
  position: LatLng;
  title?: string;
  description?: string;
  icon?: string;        // Emoji or icon name
  popup?: Reactive<any>; // Advanced: pattern reference for rich popup
  draggable?: boolean;
}

interface MapCircle {
  center: LatLng;
  radius: number;       // meters
  color?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  title?: string;
  description?: string;
  popup?: Reactive<any>;
}

interface MapPolyline {
  points: LatLng[];
  color?: string;
  strokeWidth?: number;
  dashArray?: string;   // e.g., "5, 10" for dashed
}
```

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `cf-click` | `{ lat, lng }` | Map background clicked |
| `cf-bounds-change` | `{ bounds, center, zoom }` | Viewport changed |
| `cf-marker-click` | `{ marker, index, lat, lng }` | Marker clicked |
| `cf-marker-drag-end` | `{ marker, index, position, oldPosition }` | Marker drag completed |
| `cf-circle-click` | `{ circle, index, lat, lng }` | Circle clicked |

**Note:** Polylines do not emit click events. For clickable segments, use circles as waypoints.

### Usage

```tsx
// Simple: Display locations
const mapData = {
  markers: stores.map(store => ({
    position: { lat: store.lat, lng: store.lng },
    title: store.name,
    icon: "📍"
  }))
};
<cf-map $value={mapData} fitToBounds />

// Interactive: Click to add marker
<cf-map
  $value={mapData}
  oncf-click={(e) => {
    markers.push({
      position: { lat: e.detail.lat, lng: e.detail.lng },
      title: "New Location",
      draggable: true
    });
  }}
/>

// Draggable markers
<cf-map
  $value={mapData}
  oncf-marker-drag-end={(e) => {
    markers.key(e.detail.index).key("position").set(e.detail.position);
  }}
/>

// Coverage areas with circles
const mapData = {
  circles: areas.map(area => ({
    center: { lat: area.lat, lng: area.lng },
    radius: area.radiusMeters,
    color: area.available ? "#22c55e" : "#ef4444",
    fillOpacity: 0.2,
    title: area.name
  }))
};

// Route visualization
const mapData = {
  polylines: [{
    points: route.waypoints,
    color: "#3b82f6",
    strokeWidth: 4
  }],
  markers: [
    { position: route.start, icon: "🚀" },
    { position: route.end, icon: "🏁" }
  ]
};
```

### Notes

- **Bundle size:** Leaflet adds ~40KB gzipped
- **Zoom range:** 0 (world) to 18 (street level)
- **Default center:** San Francisco (37.7749, -122.4194)
- **Emoji markers:** Use any emoji as the `icon` property
- **Rich popups:** Pass a pattern reference via `popup` for interactive popup content

---

## cf-chart

SVG charting components. Compose mark elements inside a `cf-chart` container.

### Elements

- **`cf-chart`** - Container that discovers child marks, computes scales, renders SVG
- **`cf-line-mark`** - Line series
- **`cf-area-mark`** - Filled area
- **`cf-bar-mark`** - Bar/column chart
- **`cf-dot-mark`** - Scatter/dot plot

### cf-chart Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `height` | `number` | `200` | Chart height in px. Width fills container. |
| `marks` / `$marks` | `MarkConfig[]` | `[]` | Programmatic marks (rendered below children) |
| `xAxis` | `boolean` | `false` | Show x-axis |
| `yAxis` | `boolean` | `false` | Show y-axis |
| `xType` | `"linear"\|"time"\|"band"` | auto | Scale type (auto-detected from data) |
| `yType` | `"linear"\|"log"` | auto | Y scale type |
| `xDomain` | `[min, max]` | auto | Override x domain |
| `yDomain` | `[min, max]` | auto | Override y domain |
| `crosshair` | `boolean` | `true` | Show crosshair on hover |

### Mark Properties (shared)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `data` / `$data` | `number[]\|object[]` | required | Data array |
| `x` | `string` | index | Key for x accessor |
| `y` | `string` | value | Key for y accessor |
| `color` | `string` | `"#6366f1"` | Stroke/fill color |
| `label` | `string` | - | Label for tooltip |

**cf-line-mark** adds: `strokeWidth` (default 2), `curve` (`"linear"`, `"step"`, `"monotone"`, `"natural"`)

**cf-area-mark** adds: `opacity` (default 0.2), `curve`, `y2` (baseline)

**cf-bar-mark** adds: `opacity` (default 1), `barPadding` (0-1, default 0.2)

**cf-dot-mark** adds: `radius` (default 3)

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `cf-hover` | `{ x, y, dataX, dataY, nearest }` | Mouse over chart |
| `cf-click` | `{ x, y, dataX, dataY, nearest }` | Chart clicked |
| `cf-leave` | `{}` | Mouse left chart |

### Usage

```tsx
// Sparkline (inline, no axes)
<cf-chart height={24} style="width: 80px;">
  <cf-line-mark $data={trend} color="green" />
</cf-chart>

// Line chart with axes
<cf-chart height={200} xAxis yAxis>
  <cf-line-mark $data={prices} x="date" y="price" color="blue" label="AAPL" />
</cf-chart>

// Layered area + line
<cf-chart height={200} xAxis yAxis>
  <cf-area-mark $data={prices} x="date" y="price" color="blue" opacity={0.15} />
  <cf-line-mark $data={prices} x="date" y="price" color="blue" />
</cf-chart>

// Bar chart
<cf-chart height={200} xAxis yAxis>
  <cf-bar-mark $data={monthly} x="month" y="revenue" color="green" label="Revenue" />
</cf-chart>

// Multi-series
<cf-chart height={300} xAxis yAxis>
  <cf-line-mark $data={appl} x="date" y="price" color="blue" label="AAPL" />
  <cf-line-mark $data={goog} x="date" y="price" color="red" label="GOOG" />
</cf-chart>

// Simple number array (auto-indexed x)
<cf-chart height={100}>
  <cf-line-mark $data={[1, 3, 2, 5, 4, 7, 6]} color="#22c55e" />
</cf-chart>
```

### Notes

- **Data auto-detection:** Number arrays auto-index. String x-values use band scale. Date/ISO strings use time scale.
- **Responsive width:** Chart fills its container width. Use CSS to control.
- **Crosshair:** Enabled by default. Shows nearest data point on hover.
