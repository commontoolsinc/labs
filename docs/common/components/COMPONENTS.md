<!-- @reviewed 2025-12-11 docs-rationalization -->

# UI Components Reference

CommonTools UI components with bidirectional binding support.

## Bidirectional Binding

Use `$` prefix for automatic two-way sync. No handler needed for simple updates.

```tsx
<ct-checkbox $checked={item.done} />    // Auto-syncs checkbox state
<ct-input $value={title} />             // Auto-syncs text input
<ct-select $value={category} items={[...]} />
```

**Native HTML inputs are one-way only.** Always use `ct-*` components for form inputs.

For when to use handlers vs binding, see [PATTERNS.md](PATTERNS.md).

## Property Names: Use CamelCase

Use camelCase for `ct-*` component properties. Kebab-case JSX attributes don't map correctly:

```tsx
// ❌ Kebab-case won't work
<ct-autocomplete allow-custom={true} />  // Sets element["allow-custom"], not allowCustom

// ✅ CamelCase works
<ct-autocomplete allowCustom={true} />  // Sets element.allowCustom correctly
```

---

## ct-button

```tsx
// Simple inline handler
<ct-button onClick={() => count.set(count.get() + 1)}>Increment</ct-button>

// action() for more complex logic (preferred)
const increment = action(() => {
  count.set(count.get() + 1);
  lastUpdated.set(Date.now());
});
<ct-button onClick={increment}>Increment</ct-button>
```

---

## ct-input

```tsx
// Bidirectional binding (preferred)
<ct-input $value={title} />

// With placeholder
<ct-input $value={searchQuery} placeholder="Search..." />

// Manual handler for side effects
<ct-input value={title} onct-input={(e) => {
  title.set(e.detail.value);
  console.log("Changed:", e.detail.value);
}} />
```

---

## ct-checkbox

```tsx
// Bidirectional binding
<ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>

// In array maps
{items.map((item) => (
  <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
))}
```

---

## ct-select

Uses `items` attribute with `{ label, value }` objects. **Do not use `<option>` elements.**

```tsx
<ct-select
  $value={category}
  items={[
    { label: "Produce", value: "Produce" },
    { label: "Dairy", value: "Dairy" },
    { label: "Other", value: "Other" },
  ]}
/>

// Values can be any type
<ct-select
  $value={selectedId}
  items={[
    { label: "First", value: 1 },
    { label: "Second", value: 2 },
  ]}
/>

// Dynamic items from data
<ct-select
  $value={selectedUser}
  items={users.map(u => ({ label: u.name, value: u }))}
/>
```

---

## ct-message-input

Input + button combo for adding items.

```tsx
<ct-message-input
  placeholder="New item"
  onct-send={(e) => {
    const text = e.detail?.message?.trim();
    if (text) items.push({ title: text, done: false });
  }}
/>
```

---

## ct-card

Styled card with built-in padding (1rem). Don't add extra padding to children.

```tsx
// ✅ Let ct-card handle padding
<ct-card>
  <ct-vstack gap={1}>
    <h3>Title</h3>
    <p>Content</p>
  </ct-vstack>
</ct-card>

// ❌ Double padding
<ct-card>
  <div style="padding: 1rem;">Content</div>
</ct-card>
```

---

## ct-render

Renders pattern instances for composition.

```tsx
import SubPattern from "./sub-pattern.tsx";

const subView = SubPattern({ items });

// Three equivalent ways:
<ct-render $cell={subView} />   // Most explicit
{subView}                        // Direct interpolation
<SubPattern items={items} />     // JSX syntax
```

**Use `$cell`, not `piece` or `pattern` attribute.**

Multiple patterns sharing data:

```tsx
const listView = ListView({ items });
const gridView = GridView({ items });

<div style={{ display: "flex", gap: "1rem" }}>
  <ct-render $cell={listView} />
  <ct-render $cell={gridView} />
</div>
// Both views stay in sync automatically
```

See [PATTERNS.md](PATTERNS.md) Level 4 for more on composition.

---

## ct-outliner

Tree structure editor. See `packages/patterns/page.tsx` for complete example.

```tsx
type OutlinerNode = {
  body: Default<string, "">;
  children: Default<any[], []>;
  attachments: Default<any[], []>;
};

<ct-outliner $value={outline} />
```

---

## ct-cell-context

Debugging tool for inspecting cell values. See [CELL_CONTEXT.md](CELL_CONTEXT.md).

```tsx
<ct-cell-context $cell={result} label="Result">
  <div>{result.value}</div>
</ct-cell-context>
```

---

## Removing Array Items

Use `equals()` for identity comparison:

```tsx
import { equals, handler, Writable } from 'commontools';

const removeItem = handler<unknown, { items: Writable<Item[]>; item: Item }>(
  (_, { items, item }) => {
    const current = items.get();
    const index = current.findIndex((el) => equals(item, el));
    if (index >= 0) items.set(current.toSpliced(index, 1));
  }
);
```

---

## ct-screen

Full-screen container for app-like layouts. Use instead of `<div style={{ height: "100%" }}>` which doesn't work (parent has no explicit height). The component already sets `display: flex; flex-direction: column;` internally.

```tsx
// ❌ DOESN'T WORK - content appears blank
<div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
  {/* Content in DOM but invisible */}
</div>

// ✅ WORKS - full available width and height
<ct-screen>
  <header>Title</header>
  <ct-vscroll style="flex: 1;">
    {/* Scrollable content */}
  </ct-vscroll>
</ct-screen>
```

---

## ct-image-input

```tsx
<ct-image-input
  onct-change={handleImageUpload}
  maxSizeBytes={5000000}
>
  📷 Add Photo
</ct-image-input>
```

The component compresses images to fit within `maxSizeBytes`.

---

## ct-code-editor

Rich text editor with wiki-link mentions. **Uses `[[` for completions, not `@`.**

```tsx
<ct-code-editor
  $value={inputText}
  $mentionable={mentionable}
  $mentioned={mentioned}
  placeholder="Type [[ to mention items..."
  language="text/markdown"
/>
```

**To trigger completions:** Type `[[` (double brackets), not `@`.

---

## ct-map

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
| `ct-click` | `{ lat, lng }` | Map background clicked |
| `ct-bounds-change` | `{ bounds, center, zoom }` | Viewport changed |
| `ct-marker-click` | `{ marker, index, lat, lng }` | Marker clicked |
| `ct-marker-drag-end` | `{ marker, index, position, oldPosition }` | Marker drag completed |
| `ct-circle-click` | `{ circle, index, lat, lng }` | Circle clicked |

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
<ct-map $value={mapData} fitToBounds />

// Interactive: Click to add marker
<ct-map
  $value={mapData}
  onct-click={(e) => {
    markers.push({
      position: { lat: e.detail.lat, lng: e.detail.lng },
      title: "New Location",
      draggable: true
    });
  }}
/>

// Draggable markers
<ct-map
  $value={mapData}
  onct-marker-drag-end={(e) => {
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
| Custom (`ct-*`) | String, kebab-case | `style="background-color: #fff;"` |

```tsx
// Mixed usage
<div style={{ display: "flex", gap: "1rem" }}>
  <ct-vstack style="flex: 1; padding: 1rem;">
    <span style={{ color: "#333" }}>Label</span>
  </ct-vstack>
</div>
```

---

## ct-chart

SVG charting components. Compose mark elements inside a `ct-chart` container.

### Elements

- **`ct-chart`** - Container that discovers child marks, computes scales, renders SVG
- **`ct-line-mark`** - Line series
- **`ct-area-mark`** - Filled area
- **`ct-bar-mark`** - Bar/column chart
- **`ct-dot-mark`** - Scatter/dot plot

### ct-chart Properties

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

**ct-line-mark** adds: `strokeWidth` (default 2), `curve` (`"linear"`, `"step"`, `"monotone"`, `"natural"`)

**ct-area-mark** adds: `opacity` (default 0.2), `curve`, `y2` (baseline)

**ct-bar-mark** adds: `opacity` (default 1), `barPadding` (0-1, default 0.2)

**ct-dot-mark** adds: `radius` (default 3)

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `ct-hover` | `{ x, y, dataX, dataY, nearest }` | Mouse over chart |
| `ct-click` | `{ x, y, dataX, dataY, nearest }` | Chart clicked |
| `ct-leave` | `{}` | Mouse left chart |

### Usage

```tsx
// Sparkline (inline, no axes)
<ct-chart height={24} style="width: 80px;">
  <ct-line-mark $data={trend} color="green" />
</ct-chart>

// Line chart with axes
<ct-chart height={200} xAxis yAxis>
  <ct-line-mark $data={prices} x="date" y="price" color="blue" label="AAPL" />
</ct-chart>

// Layered area + line
<ct-chart height={200} xAxis yAxis>
  <ct-area-mark $data={prices} x="date" y="price" color="blue" opacity={0.15} />
  <ct-line-mark $data={prices} x="date" y="price" color="blue" />
</ct-chart>

// Bar chart
<ct-chart height={200} xAxis yAxis>
  <ct-bar-mark $data={monthly} x="month" y="revenue" color="green" label="Revenue" />
</ct-chart>

// Multi-series
<ct-chart height={300} xAxis yAxis>
  <ct-line-mark $data={appl} x="date" y="price" color="blue" label="AAPL" />
  <ct-line-mark $data={goog} x="date" y="price" color="red" label="GOOG" />
</ct-chart>

// Simple number array (auto-indexed x)
<ct-chart height={100}>
  <ct-line-mark $data={[1, 3, 2, 5, 4, 7, 6]} color="#22c55e" />
</ct-chart>
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

**Workarounds:** Use `ct-chart` for data visualization, styled `<div>` elements for simple graphics, or text sparklines (`▁▂▃▄▅▆▇█`).
