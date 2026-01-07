# ct-map Component Design

## Overview

`ct-map` is a map component for displaying interactive maps with markers,
circles, and polylines. It uses Leaflet with OpenStreetMap tiles by default (no
API key required) and integrates with CommonTools' Cell-based reactivity system.

## Design Principles

1. **"Just Data"** - Markers, circles, and polylines are plain data objects
2. **Idiomatic** - Follows existing ct-\* component patterns for events and
   bindings
3. **Progressive** - Simple cases are simple; advanced cases use pattern
   references
4. **Extensible** - V1 core can be extended to clustering, custom tiles, etc.

## Core Types

```typescript
interface LatLng {
  lat: number;
  lng: number;
}

interface Bounds {
  north: number; // max latitude
  south: number; // min latitude
  east: number; // max longitude
  west: number; // min longitude
}
```

## Features

### MapMarker

Markers represent points on the map. Popup content follows a progressive model:

- **Simple**: Use `title`, `description`, `icon` fields (pure data, rendered by
  ct-map)
- **Advanced**: Use `popup` field with a Cell/OpaqueRef that has a `[UI]`
  property

```typescript
interface MapMarker {
  position: LatLng;

  // Simple popup content (pure data)
  title?: string;
  description?: string;
  icon?: string; // emoji, URL, or icon name

  // Advanced popup content (Cell with [UI] property)
  popup?: OpaqueRef<any>;

  // Behavior
  draggable?: boolean;
}
```

### MapCircle

Circles represent areas with a center and radius. Useful for coverage areas,
approximate locations, or highlighting regions.

```typescript
interface MapCircle {
  center: LatLng;
  radius: number; // meters

  // Styling
  color?: string;
  fillOpacity?: number;
  strokeWidth?: number;

  // Popup (same pattern as markers)
  title?: string;
  description?: string;
  popup?: OpaqueRef<any>;
}
```

### MapPolyline

Polylines represent paths or routes.

```typescript
interface MapPolyline {
  points: LatLng[];

  // Styling
  color?: string;
  strokeWidth?: number;
  dashArray?: string; // e.g., "5, 10" for dashed lines
}
```

### MapValue

The combined data structure for all map features:

```typescript
interface MapValue {
  markers?: MapMarker[];
  circles?: MapCircle[];
  polylines?: MapPolyline[];
}
```

## Component API

```typescript
<ct-map
  // Data binding
  $value={mapDataCell}           // Cell<MapValue>

  // Viewport (all bidirectional)
  $center={centerCell}           // Cell<LatLng>
  $zoom={zoomCell}               // Cell<number>
  $bounds={boundsCell}           // Cell<Bounds>

  // Behavior
  fitToBounds?={boolean}         // Auto-fit to show all features
  interactive?={boolean}         // Enable pan/zoom (default: true)

  // Events
  @ct-click={handler}            // Map background click
  @ct-bounds-change={handler}    // Viewport changed
  @ct-marker-click={handler}     // Marker clicked
  @ct-marker-drag-end={handler}  // Marker drag completed
  @ct-circle-click={handler}     // Circle clicked
></ct-map>
```

## Events

### ct-click

Emitted when the map background (not a feature) is clicked.

```typescript
interface CtClickDetail {
  lat: number;
  lng: number;
}
```

### ct-bounds-change

Emitted when the viewport changes (pan/zoom).

```typescript
interface CtBoundsChangeDetail {
  bounds: Bounds;
  center: LatLng;
  zoom: number;
}
```

### ct-marker-click

Emitted when a marker is clicked.

```typescript
interface CtMarkerClickDetail {
  marker: MapMarker;
  index: number;
  lat: number;
  lng: number;
}
```

### ct-marker-drag-end

Emitted when a draggable marker drag operation completes.

```typescript
interface CtMarkerDragEndDetail {
  marker: MapMarker;
  index: number;
  position: LatLng;
  oldPosition: LatLng;
}
```

### ct-circle-click

Emitted when a circle is clicked.

```typescript
interface CtCircleClickDetail {
  circle: MapCircle;
  index: number;
  lat: number;
  lng: number;
}
```

## Usage Examples

### Simple: Display Locations

```typescript
const mapData = {
  markers: stores.map((store) => ({
    position: { lat: store.lat, lng: store.lng },
    title: store.name,
    description: store.hours,
    icon: "📍",
  })),
};

<ct-map $value={mapData} fitToBounds />;
```

### Interactive: Click to Add Marker

```typescript
const handleMapClick = handler(({ lat, lng }, { markers }) => {
  markers.push({
    position: { lat, lng },
    title: "New Location",
    draggable: true,
  });
});

<ct-map $value={mapData} @ct-click={handleMapClick({ markers })} />;
```

### Draggable Markers

```typescript
const handleDragEnd = handler(({ index, position }, { markers }) => {
  markers.key(index).key("position").set(position);
});

<ct-map $value={mapData} @ct-marker-drag-end={handleDragEnd({ markers })} />;
```

### Coverage Areas with Circles

```typescript
const mapData = {
  circles: serviceAreas.map((area) => ({
    center: { lat: area.lat, lng: area.lng },
    radius: area.radiusMeters,
    color: area.available ? "#22c55e" : "#ef4444",
    fillOpacity: 0.2,
    title: area.name,
    description: area.available ? "Available" : "Coming soon",
  })),
};
```

### Route Visualization

```typescript
const mapData = {
  polylines: [
    {
      points: route.waypoints,
      color: "#3b82f6",
      strokeWidth: 4,
    },
  ],
  markers: [
    { position: route.start, title: "Start", icon: "🚀" },
    { position: route.end, title: "End", icon: "🏁" },
  ],
};
```

### Filter by Visible Bounds

```typescript
const bounds = cell<Bounds>({ north: 0, south: 0, east: 0, west: 0 });

const visibleStores = computed(() =>
  allStores.filter((s) => isInBounds(s, bounds.get()))
);

<ct-map $value={{ markers: visibleStores }} $bounds={bounds} />;
```

### Advanced: Pattern Reference for Rich Popup

```typescript
// Create a pattern for rich popup content
const storePopup = StoreDetailCard({
  store: selectedStore,
  onVisit: handleVisit,
});

const mapData = {
  markers: [
    {
      position: { lat: 37.7, lng: -122.4 },
      popup: storePopup, // Cell/OpaqueRef with [UI] property
    },
  ],
};
```

## Implementation Notes

### Leaflet Integration

- Use Leaflet 1.9.x with OpenStreetMap tiles
- Initialize map in `firstUpdated()` lifecycle
- Clean up in `disconnectedCallback()`
- Handle Shadow DOM CSS injection for Leaflet styles

### Cell Reactivity

- Use `CellController` pattern for bidirectional bindings
- Subscribe to Cell changes for markers/circles/polylines
- Efficiently diff arrays using built-in entity IDs
- Use `getEntityId()` for stable feature identification

### Popup Rendering

For markers/circles with popup content:

1. If `popup` (OpaqueRef) is provided, render via `<ct-render .cell=${popup}>`
2. Otherwise, render simple `title`/`description`/`icon` fields
3. Popups open on feature click, close on map click or X button

### Performance Considerations

- Leaflet handles up to ~1000 DOM markers efficiently
- For larger datasets, V2 will add clustering support
- Use Leaflet's layer groups for efficient bulk updates

## V1 Scope

| Feature                            | Status |
| ---------------------------------- | ------ |
| Render map with center/zoom        | ✅ V1  |
| Display markers with simple popups | ✅ V1  |
| Display circles with radius        | ✅ V1  |
| Display polylines                  | ✅ V1  |
| Bidirectional `$center`, `$zoom`   | ✅ V1  |
| Bidirectional `$bounds`            | ✅ V1  |
| `@ct-click` (map background)       | ✅ V1  |
| `@ct-marker-click`                 | ✅ V1  |
| `@ct-marker-drag-end`              | ✅ V1  |
| `@ct-circle-click`                 | ✅ V1  |
| `@ct-bounds-change`                | ✅ V1  |
| `fitToBounds` option               | ✅ V1  |
| Pattern reference for popup        | ✅ V1  |
| OpenStreetMap tiles (no API key)   | ✅ V1  |
| Clustering                         | 🔮 V2  |
| Custom marker icons (beyond emoji) | 🔮 V2  |
| Tile provider switching            | 🔮 V2  |
| Heatmaps                           | 🔮 V2  |
| GeoJSON layers                     | 🔮 V2  |
| Editable polygons                  | 🔮 V2  |

## File Structure

```
packages/ui/src/v2/components/ct-map/
├── ct-map.ts           # Main component
├── index.ts            # Registration and exports
├── styles.ts           # Component styles
├── types.ts            # TypeScript interfaces
├── DESIGN.md           # This document
└── ct-map.test.ts      # Integration tests
```

## Dependencies

- `leaflet` - Map library (~40KB gzipped)
- `@types/leaflet` - TypeScript types

Leaflet CSS must be injected into the Shadow DOM for proper rendering.
