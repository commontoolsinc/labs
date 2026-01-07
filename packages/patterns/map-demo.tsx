/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

/**
 * Trip Planner Demo - Comprehensive ct-map component demonstration
 *
 * Demonstrates:
 * - Basic markers with title/description/icon
 * - Coverage circles for areas of interest
 * - Polylines for routes between stops
 * - Click to add markers
 * - Draggable markers with position updates
 * - Fit to bounds button
 * - Bidirectional center/zoom tracking
 */

interface LatLng {
  lat: number;
  lng: number;
}

interface TripStop {
  position: LatLng;
  title: string;
  description: Default<string, "">;
  icon: Default<string, "pin">;
  draggable: Default<boolean, false>;
}

interface AreaOfInterest {
  center: LatLng;
  radius: number; // meters
  title: string;
  description: Default<string, "">;
  color: Default<string, "#3b82f6">;
}

interface Input {
  tripName: Default<string, "My Bay Area Trip">;
  stops: Cell<Default<TripStop[], []>>;
  areasOfInterest: Cell<Default<AreaOfInterest[], []>>;
  showRoute: Default<boolean, true>;
}

interface Output {
  tripName: string;
  stops: TripStop[];
  areasOfInterest: AreaOfInterest[];
  showRoute: boolean;
  center: LatLng;
  zoom: number;
}

// Default Bay Area locations for the demo
const DEFAULT_STOPS: TripStop[] = [
  {
    position: { lat: 37.7749, lng: -122.4194 },
    title: "San Francisco",
    description: "The City by the Bay",
    icon: "bridge",
    draggable: true,
  },
  {
    position: { lat: 37.8716, lng: -122.2727 },
    title: "Berkeley",
    description: "Home of UC Berkeley",
    icon: "graduation",
    draggable: true,
  },
  {
    position: { lat: 37.5485, lng: -122.0590 },
    title: "Fremont",
    description: "Gateway to Silicon Valley",
    icon: "computer",
    draggable: true,
  },
  {
    position: { lat: 37.3382, lng: -121.8863 },
    title: "San Jose",
    description: "Capital of Silicon Valley",
    icon: "building",
    draggable: true,
  },
];

const DEFAULT_AREAS: AreaOfInterest[] = [
  {
    center: { lat: 37.8199, lng: -122.4783 },
    radius: 3000,
    title: "Golden Gate Area",
    description: "Iconic bridge and park",
    color: "#ef4444",
  },
  {
    center: { lat: 37.4419, lng: -122.1430 },
    radius: 5000,
    title: "Stanford Area",
    description: "University and research hub",
    color: "#22c55e",
  },
];

// Handler for adding a new stop when map is clicked
const addStopHandler = handler<
  { lat: number; lng: number },
  { stops: Cell<TripStop[]>; stopCount: number }
>(({ lat, lng }, { stops, stopCount }) => {
  stops.push({
    position: { lat, lng },
    title: `Stop ${stopCount + 1}`,
    description: "Click marker to see details",
    icon: "pin",
    draggable: true,
  });
});

// Handler for updating marker position after drag
const markerDragHandler = handler<
  { index: number; position: LatLng },
  { stops: Cell<TripStop[]> }
>(({ index, position }, { stops }) => {
  const currentStops = stops.get();
  if (index >= 0 && index < currentStops.length) {
    const updated = currentStops.map((stop, i) =>
      i === index ? { ...stop, position } : stop
    );
    stops.set(updated);
  }
});

// Handler for removing a stop
const removeStopHandler = handler<
  { index: number },
  { stops: Cell<TripStop[]> }
>(({ index }, { stops }) => {
  const current = stops.get();
  if (index >= 0 && index < current.length) {
    stops.set(current.toSpliced(index, 1));
  }
});

// Handler for adding an area of interest
const addAreaHandler = handler<
  void,
  { areas: Cell<AreaOfInterest[]>; center: LatLng }
>((_event, { areas, center }) => {
  const colors = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6"];
  const colorIndex = areas.get().length % colors.length;
  areas.push({
    center,
    radius: 2000,
    title: `Area ${areas.get().length + 1}`,
    description: "New area of interest",
    color: colors[colorIndex],
  });
});

export default pattern<Input, Output>(
  ({ tripName, stops, areasOfInterest, showRoute }) => {
    // Initialize with default data if empty
    if (stops.get().length === 0) {
      stops.set(DEFAULT_STOPS);
    }
    if (areasOfInterest.get().length === 0) {
      areasOfInterest.set(DEFAULT_AREAS);
    }

    // Local UI state
    const center = Cell.of<LatLng>({ lat: 37.6, lng: -122.2 });
    const zoom = Cell.of<number>(9);
    const selectedStopIndex = Cell.of<number | null>(null);
    const fitBoundsTrigger = Cell.of<number>(0);

    // Computed values
    const stopCount = computed(() => stops.get().length);
    const areaCount = computed(() => areasOfInterest.get().length);

    // Build map value from stops and areas
    const mapValue = computed(() => {
      const currentStops = stops.get();
      const currentAreas = areasOfInterest.get();
      const currentShowRoute = showRoute ?? true;

      // Markers from stops
      const markers = currentStops.map((stop) => ({
        position: stop.position,
        title: stop.title,
        description: stop.description || "",
        icon: stop.icon || "pin",
        draggable: stop.draggable ?? true,
      }));

      // Circles from areas of interest
      const circles = currentAreas.map((area) => ({
        center: area.center,
        radius: area.radius,
        color: area.color || "#3b82f6",
        fillOpacity: 0.2,
        strokeWidth: 2,
        title: area.title,
        description: area.description || "",
      }));

      // Polyline connecting all stops (if enabled and more than 1 stop)
      const polylines =
        currentShowRoute && currentStops.length > 1
          ? [
              {
                points: currentStops.map((stop) => stop.position),
                color: "#6366f1",
                strokeWidth: 3,
                dashArray: "10, 5",
              },
            ]
          : [];

      return { markers, circles, polylines };
    });

    // Format coordinates for display
    const formatCoord = (val: number, decimals = 4): string =>
      val.toFixed(decimals);

    return {
      [NAME]: computed(() => `Trip Planner: ${tripName}`),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="2">
            <ct-hstack justify="between" align="center">
              <ct-heading level={4}>Trip Planner</ct-heading>
              <ct-hstack gap="2">
                <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                  {stopCount} stops | {areaCount} areas
                </span>
              </ct-hstack>
            </ct-hstack>
            <ct-input $value={tripName} placeholder="Trip name..." />
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="3" style="padding: 1rem;">
              {/* Map container */}
              <ct-card style="padding: 0; overflow: hidden;">
                <ct-map
                  $value={mapValue}
                  $center={center}
                  $zoom={zoom}
                  style="height: 400px; width: 100%;"
                  fitToBounds={computed(
                    () => fitBoundsTrigger.get() > 0 && stops.get().length > 0
                  )}
                  @ct-click={addStopHandler({
                    stops,
                    stopCount: stopCount,
                  })}
                  @ct-marker-drag-end={markerDragHandler({ stops })}
                  @ct-marker-click={(e: CustomEvent) => {
                    selectedStopIndex.set(e.detail?.index ?? null);
                  }}
                />
              </ct-card>

              {/* Map controls */}
              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={5}>Map Controls</ct-heading>
                  <ct-hstack gap="2" wrap>
                    <ct-button
                      variant="secondary"
                      onClick={() => {
                        fitBoundsTrigger.set(fitBoundsTrigger.get() + 1);
                      }}
                    >
                      Fit to All Stops
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={() => {
                        center.set({ lat: 37.6, lng: -122.2 });
                        zoom.set(9);
                      }}
                    >
                      Reset View
                    </ct-button>
                    <ct-checkbox $checked={showRoute}>Show Route</ct-checkbox>
                  </ct-hstack>
                  <ct-hstack gap="3">
                    <span style="font-size: 0.875rem;">
                      Center: {computed(() => formatCoord(center.get().lat))},{" "}
                      {computed(() => formatCoord(center.get().lng))}
                    </span>
                    <span style="font-size: 0.875rem;">
                      Zoom: {computed(() => zoom.get().toFixed(1))}
                    </span>
                  </ct-hstack>
                </ct-vstack>
              </ct-card>

              {/* Stops list */}
              <ct-card>
                <ct-vstack gap="2">
                  <ct-hstack justify="between" align="center">
                    <ct-heading level={5}>Trip Stops</ct-heading>
                    <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                      Click map to add
                    </span>
                  </ct-hstack>

                  {stops.map((stop, index) => (
                    <ct-hstack
                      gap="2"
                      align="center"
                      style={{
                        padding: "0.5rem",
                        borderRadius: "0.5rem",
                        backgroundColor: ifElse(
                          computed(() => selectedStopIndex.get() === index),
                          "var(--ct-color-blue-100)",
                          "var(--ct-color-gray-50)"
                        ),
                      }}
                    >
                      <span style="font-size: 1.25rem; width: 2rem; text-align: center;">
                        {index + 1}
                      </span>
                      <ct-vstack gap="0" style="flex: 1;">
                        <ct-input
                          $value={stop.title}
                          style="font-weight: 500;"
                        />
                        <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                          {computed(
                            () =>
                              `${formatCoord(stop.position.lat)}, ${formatCoord(stop.position.lng)}`
                          )}
                        </span>
                      </ct-vstack>
                      <ct-button
                        variant="ghost"
                        onClick={() => {
                          center.set(stop.position);
                          zoom.set(14);
                        }}
                      >
                        Go
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        onClick={() => {
                          const current = stops.get();
                          const idx = current.findIndex((s) =>
                            Cell.equals(stop, s)
                          );
                          if (idx >= 0) {
                            stops.set(current.toSpliced(idx, 1));
                          }
                        }}
                      >
                        x
                      </ct-button>
                    </ct-hstack>
                  ))}

                  {ifElse(
                    computed(() => stops.get().length === 0),
                    <div style="text-align: center; color: var(--ct-color-gray-500); padding: 1rem;">
                      Click on the map to add your first stop!
                    </div>,
                    null
                  )}
                </ct-vstack>
              </ct-card>

              {/* Areas of interest */}
              <ct-card>
                <ct-vstack gap="2">
                  <ct-hstack justify="between" align="center">
                    <ct-heading level={5}>Areas of Interest</ct-heading>
                    <ct-button
                      variant="secondary"
                      size="sm"
                      onClick={addAreaHandler({
                        areas: areasOfInterest,
                        center,
                      })}
                    >
                      + Add Area
                    </ct-button>
                  </ct-hstack>

                  {areasOfInterest.map((area) => (
                    <ct-hstack gap="2" align="center">
                      <div
                        style={{
                          width: "1rem",
                          height: "1rem",
                          borderRadius: "50%",
                          backgroundColor: area.color,
                          flexShrink: 0,
                        }}
                      />
                      <ct-vstack gap="0" style="flex: 1;">
                        <ct-input $value={area.title} style="font-weight: 500;" />
                        <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                          Radius: {area.radius}m
                        </span>
                      </ct-vstack>
                      <ct-button
                        variant="ghost"
                        onClick={() => {
                          center.set(area.center);
                          zoom.set(13);
                        }}
                      >
                        Go
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        onClick={() => {
                          const current = areasOfInterest.get();
                          const idx = current.findIndex((a) =>
                            Cell.equals(area, a)
                          );
                          if (idx >= 0) {
                            areasOfInterest.set(current.toSpliced(idx, 1));
                          }
                        }}
                      >
                        x
                      </ct-button>
                    </ct-hstack>
                  ))}

                  {ifElse(
                    computed(() => areasOfInterest.get().length === 0),
                    <div style="text-align: center; color: var(--ct-color-gray-500); padding: 1rem;">
                      No areas defined. Click "Add Area" to highlight a region.
                    </div>,
                    null
                  )}
                </ct-vstack>
              </ct-card>

              {/* Route summary */}
              {ifElse(
                computed(() => showRoute && stops.get().length > 1),
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={5}>Route Overview</ct-heading>
                    <ct-hstack gap="2" wrap>
                      {stops.map((stop, index) => (
                        <ct-hstack gap="1" align="center">
                          <span style="font-weight: 500;">{stop.title}</span>
                          {ifElse(
                            computed(() => index < stops.get().length - 1),
                            <span style="color: var(--ct-color-gray-400);">
                              {" "}
                              -&gt;{" "}
                            </span>,
                            null
                          )}
                        </ct-hstack>
                      ))}
                    </ct-hstack>
                    <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                      {stopCount} stops connected by dashed route line
                    </span>
                  </ct-vstack>
                </ct-card>,
                null
              )}

              {/* Instructions */}
              <ct-card style="background: var(--ct-color-blue-50);">
                <ct-vstack gap="1">
                  <ct-heading level={5}>How to Use</ct-heading>
                  <ul style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--ct-color-gray-600);">
                    <li>Click anywhere on the map to add a new stop</li>
                    <li>Drag markers to reposition stops</li>
                    <li>Use "Fit to All Stops" to zoom to see all markers</li>
                    <li>Toggle "Show Route" to display/hide the route line</li>
                    <li>Add areas of interest to highlight regions on the map</li>
                    <li>Edit stop names inline in the list below</li>
                  </ul>
                </ct-vstack>
              </ct-card>
            </ct-vstack>
          </ct-vscroll>

          <ct-hstack slot="footer" gap="2" style="padding: 1rem;">
            <ct-button
              variant="secondary"
              style="flex: 1;"
              onClick={() => {
                stops.set([]);
                areasOfInterest.set([]);
                selectedStopIndex.set(null);
              }}
            >
              Clear All
            </ct-button>
            <ct-button
              variant="primary"
              style="flex: 1;"
              onClick={() => {
                stops.set(DEFAULT_STOPS);
                areasOfInterest.set(DEFAULT_AREAS);
                center.set({ lat: 37.6, lng: -122.2 });
                zoom.set(9);
              }}
            >
              Reset Demo
            </ct-button>
          </ct-hstack>
        </ct-screen>
      ),
      tripName,
      stops,
      areasOfInterest,
      showRoute,
      center: computed(() => center.get()),
      zoom: computed(() => zoom.get()),
    };
  }
);
