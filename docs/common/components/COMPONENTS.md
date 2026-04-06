<!-- @reviewed 2025-12-11 docs-rationalization -->

# UI Components Reference

> **Living documentation:** [`packages/patterns/catalog/catalog.tsx`](../../../packages/patterns/catalog/catalog.tsx) is the authoritative, type-checked component catalog. Each component has a story file under [`packages/patterns/catalog/stories/`](../../../packages/patterns/catalog/stories/) showing usage. Refer to those files for the most accurate, up-to-date examples.

Common Fabric UI components with bidirectional binding support.

## Bidirectional Binding

Use `$` prefix for automatic two-way sync. No handler needed for simple updates.

```tsx
<cf-checkbox $checked={item.done} />    // Auto-syncs checkbox state
<cf-input $value={title} />             // Auto-syncs text input
<cf-select $value={category} items={[...]} />
```

**Native HTML inputs are one-way only.** Always use the Common Fabric form components for inputs.

For when to use handlers vs binding, see [two-way-binding](../patterns/two-way-binding.md).

## Property Names: Use CamelCase

Use camelCase for Common Fabric component properties. Kebab-case JSX attributes don't map correctly:

```tsx
// ❌ Kebab-case won't work
<cf-autocomplete allow-custom={true} />  // Sets element["allow-custom"], not allowCustom

// ✅ CamelCase works
<cf-autocomplete allowCustom={true} />  // Sets element.allowCustom correctly
```

---

## cf-button

```tsx
// Simple inline handler
<cf-button onClick={() => count.set(count.get() + 1)}>Increment</cf-button>

// action() for more complex logic (preferred)
const increment = action(() => {
  count.set(count.get() + 1);
  lastUpdated.set(safeDateNow());
});
<cf-button onClick={increment}>Increment</cf-button>
```

Use `safeDateNow()` rather than `Date.now()` when authored pattern code needs a
timestamp snapshot.

---

## cf-input

```tsx
// Bidirectional binding (preferred)
<cf-input $value={title} />

// With placeholder
<cf-input $value={searchQuery} placeholder="Search..." />

// Manual handler for side effects
<cf-input value={title} oncf-input={(e) => {
  title.set(e.detail.value);
  console.log("Changed:", e.detail.value);
}} />
```

---

## cf-checkbox

```tsx
// Bidirectional binding
<cf-checkbox $checked={item.done}>{item.title}</cf-checkbox>

// In array maps
{items.map((item) => (
  <cf-checkbox $checked={item.done}>{item.title}</cf-checkbox>
))}
```

---

## cf-select

Uses `items` attribute with `{ label, value }` objects. **Do not use `<option>` elements.**

```tsx
<cf-select
  $value={category}
  items={[
    { label: "Produce", value: "Produce" },
    { label: "Dairy", value: "Dairy" },
    { label: "Other", value: "Other" },
  ]}
/>

// Values can be any type
<cf-select
  $value={selectedId}
  items={[
    { label: "First", value: 1 },
    { label: "Second", value: 2 },
  ]}
/>

// Dynamic items from data
<cf-select
  $value={selectedUser}
  items={users.map(u => ({ label: u.name, value: u }))}
/>
```

---

## cf-message-input

Input + button combo for adding items.

```tsx
<cf-message-input
  placeholder="New item"
  oncf-send={(e) => {
    const text = e.detail?.message?.trim();
    if (text) items.push({ title: text, done: false });
  }}
/>
```

---

## cf-card

Styled card with built-in padding (1rem). Don't add extra padding to children.

```tsx
// ✅ Let cf-card handle padding
<cf-card>
  <cf-vstack gap={1}>
    <h3>Title</h3>
    <p>Content</p>
  </cf-vstack>
</cf-card>

// ❌ Double padding
<cf-card>
  <div style="padding: 1rem;">Content</div>
</cf-card>
```

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

## cf-cell-context

Debugging tool for inspecting cell values. See [CELL_CONTEXT.md](CELL_CONTEXT.md).

```tsx
<cf-cell-context $cell={result} label="Result">
  <div>{result.value}</div>
</cf-cell-context>
```

---

## Removing Array Items

Use `equals()` for identity comparison:

```tsx
import { equals, handler, Writable } from 'commonfabric';

const removeItem = handler<unknown, { items: Writable<Item[]>; item: Item }>(
  (_, { items, item }) => {
    const current = items.get();
    const index = current.findIndex((el) => equals(item, el));
    if (index >= 0) items.set(current.toSpliced(index, 1));
  }
);
```

---

## cf-screen

Full-screen container for app-like layouts. Use instead of `<div style={{ height: "100%" }}>` which doesn't work (parent has no explicit height). The component already sets `display: flex; flex-direction: column;` internally.

```tsx
// ❌ DOESN'T WORK - content appears blank
<div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
  {/* Content in DOM but invisible */}
</div>

// ✅ WORKS - full available width and height
<cf-screen>
  <header>Title</header>
  <cf-vscroll style="flex: 1;">
    {/* Scrollable content */}
  </cf-vscroll>
</cf-screen>
```

---

## cf-image-input

```tsx
<cf-image-input
  oncf-change={handleImageUpload}
  maxSizeBytes={5000000}
>
  📷 Add Photo
</cf-image-input>
```

The component compresses images to fit within `maxSizeBytes`.

---

## cf-code-editor

Rich text editor with wiki-link mentions. **Uses `[[` for completions, not `@`.**

```tsx
<cf-code-editor
  $value={inputText}
  $mentionable={mentionable}
  $mentioned={mentioned}
  placeholder="Type [[ to mention items..."
  language="text/markdown"
/>
```

**To trigger completions:** Type `[[` (double brackets), not `@`.

Mentions are inserted as wiki-links: `[[Name (entityId)]]` where `entityId`
is the bare CID. For rendering in `cf-markdown`, convert to markdown links
with `/of:` prefix (see [mentionable](../conventions/mentionable.md)).

---

## cf-prompt-input

Multiline textarea with `@`-mention autocomplete, attachments, and voice input.

```tsx
<cf-prompt-input
  $mentionable={mentionable}
  placeholder="Type @ to mention..."
  buttonText="Send"
  oncf-send={handleSend}
/>
```

Mentions are inserted as markdown links: `[Name](/of:entityId)`. The entity
ID is resolved to the stable piece cell ID at insertion time via
`resolveAsCell()`. See [mentionable](../conventions/mentionable.md) for details
on cell resolution and link formats.

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
  popup?: OpaqueRef<any>; // Advanced: pattern reference for rich popup
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
  popup?: OpaqueRef<any>;
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

## Style Syntax

| Element | Syntax | Example |
|---------|--------|---------|
| HTML (`div`, `span`) | Object, camelCase | `style={{ backgroundColor: "#fff" }}` |
| Custom (`cf-*`) | String, kebab-case | `style="background-color: #fff;"` |

```tsx
// Mixed usage
<div style={{ display: "flex", gap: "1rem" }}>
  <cf-vstack style="flex: 1; padding: 1rem;">
    <span style={{ color: "#333" }}>Label</span>
  </cf-vstack>
</div>
```

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

---

## Limitations

### SVG Not Supported

SVG elements (`<svg>`, `<path>`, `<circle>`, etc.) are not in the JSX type definitions:

```tsx
// ❌ CompilerError: Property 'svg' does not exist on type 'JSX.IntrinsicElements'
<svg width="100" height="100">
  <circle cx="50" cy="50" r="40" />
</svg>
```

**Workarounds:** Use `cf-chart` for data visualization, styled `<div>` elements for simple graphics, or text sparklines (`▁▂▃▄▅▆▇█`).
