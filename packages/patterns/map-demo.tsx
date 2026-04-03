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
  showRoute: Cell<Default<boolean, true>>;
  center: Cell<Default<LatLng | null, null>>;
  zoom: Cell<Default<number, 9>>;
  selectedStopIndex: Cell<Default<number | null, null>>;
  fitBoundsTrigger: Cell<Default<number, 0>>;
  initialized: Cell<Default<boolean, false>>;
}

interface Output {
  tripName: string;
  stops: TripStop[];
  areasOfInterest: AreaOfInterest[];
  showRoute: boolean;
  center: LatLng;
  zoom: number;
  selectedStopIndex: number | null;
  fitBoundsTrigger: number;
  initialized: boolean;
}

// Runtime values for the defaults (for use in handlers like Reset)
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
    position: { lat: 37.5485, lng: -122.059 },
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
    center: { lat: 37.4419, lng: -122.143 },
    radius: 5000,
    title: "Stanford Area",
    description: "University and research hub",
    color: "#22c55e",
  },
];

// Handler for adding a new stop when map is clicked
const addStopHandler = handler<
  { detail: { lat: number; lng: number } },
  { stops: Cell<TripStop[]>; stopCount: number }
>(({ detail: { lat, lng } }, { stops, stopCount }) => {
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
  { detail: { index: number; position: LatLng } },
  { stops: Cell<TripStop[]> }
>(({ detail: { index, position } }, { stops }) => {
  const currentStops = stops.get();
  if (index >= 0 && index < currentStops.length) {
    const updated = currentStops.map((stop, i) =>
      i === index ? { ...stop, position } : stop
    );
    stops.set(updated);
  }
});

// Handler for selecting a marker on click
const markerClickHandler = handler<
  { detail: { index: number } },
  { selectedStopIndex: Cell<number | null> }
>(({ detail }, { selectedStopIndex }) => {
  selectedStopIndex.set(detail?.index ?? null);
});

// Handler for removing a stop
const removeStopHandler = handler<
  void,
  { stops: Cell<TripStop[]>; index: number }
>((_event, { stops, index }) => {
  const current = stops.get();
  if (index >= 0 && index < current.length) {
    stops.set(current.toSpliced(index, 1));
  }
});

// Handler for adding an area of interest
const addAreaHandler = handler<
  void,
  { areas: Cell<AreaOfInterest[]>; center: Cell<LatLng | null> }
>((_event, { areas, center }) => {
  const colors = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6"];
  const colorIndex = areas.get().length % colors.length;
  const currentCenter = center.get() ?? { lat: 37.6, lng: -122.2 };
  areas.push({
    center: currentCenter,
    radius: 2000,
    title: `Area ${areas.get().length + 1}`,
    description: "New area of interest",
    color: colors[colorIndex],
  });
});

// Format coordinates for display (handles undefined during reactive updates)
const formatCoord = (
  val: number | undefined | null,
  decimals = 4,
): string => val != null ? val.toFixed(decimals) : "N/A";

// Handler to initialize demo data
const initHandler = handler<
  void,
  {
    stops: Cell<TripStop[]>;
    areasOfInterest: Cell<AreaOfInterest[]>;
    center: Cell<LatLng | null>;
    initialized: Cell<boolean>;
  }
>((_event, { stops, areasOfInterest, center, initialized }) => {
  if (!initialized.get()) {
    stops.set(DEFAULT_STOPS);
    areasOfInterest.set(DEFAULT_AREAS);
    center.set({ lat: 37.6, lng: -122.2 });
    initialized.set(true);
  }
});

export default pattern<Input, Output>(
  ({
    tripName,
    stops,
    areasOfInterest,
    showRoute,
    center,
    zoom,
    selectedStopIndex,
    fitBoundsTrigger,
    initialized,
  }) => {
    // Computed values
    const stopCount = computed(() => stops.get().length);
    const areaCount = computed(() => areasOfInterest.get().length);

    // Bound handler for initialization
    const initializeDemo = initHandler({
      stops,
      areasOfInterest,
      center,
      initialized,
    });

    // Build map value from stops and areas
    const mapValue = computed(() => {
      const currentStops = stops.get();
      const currentAreas = areasOfInterest.get();
      const currentShowRoute = showRoute.get();

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
      const polylines = currentShowRoute && currentStops.length > 1
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
              {/* Initialization prompt for empty state */}
              {ifElse(
                computed(() => !initialized.get() && stops.get().length === 0),
                <ct-card style="background: var(--ct-color-yellow-50); border: 1px solid var(--ct-color-yellow-300);">
                  <ct-vstack gap="2" align="center">
                    <ct-heading level={5}>Welcome to Trip Planner!</ct-heading>
                    <p style="text-align: center; color: var(--ct-color-gray-600); margin: 0;">
                      Get started with demo data or click on the map to add your
                      first stop.
                    </p>
                    <ct-button variant="primary" onClick={initializeDemo}>
                      Load Demo Data
                    </ct-button>
                  </ct-vstack>
                </ct-card>,
                null,
              )}

              {/* Map container */}
              <ct-card style="padding: 0; overflow: hidden;">
                <ct-map
                  $value={mapValue}
                  $center={center}
                  $zoom={zoom}
                  style="height: 400px; width: 100%;"
                  fitToBounds={computed(
                    () => fitBoundsTrigger.get() > 0 && stops.get().length > 0,
                  )}
                  onct-click={addStopHandler({
                    stops,
                    stopCount: stopCount,
                  })}
                  onct-marker-drag-end={markerDragHandler({ stops })}
                  onct-marker-click={markerClickHandler({ selectedStopIndex })}
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
                      Center: {computed(() =>
                        formatCoord(
                          (center.get() ?? { lat: 37.6, lng: -122.2 }).lat,
                        )
                      )}, {computed(() =>
                        formatCoord(
                          (center.get() ?? { lat: 37.6, lng: -122.2 }).lng,
                        )
                      )}
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
                          "var(--ct-color-gray-50)",
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
                              `${formatCoord(stop.position.lat)}, ${
                                formatCoord(stop.position.lng)
                              }`,
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
                        onClick={removeStopHandler({ stops, index })}
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
                    null,
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
                        <ct-input
                          $value={area.title}
                          style="font-weight: 500;"
                        />
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
                    null,
                  )}
                </ct-vstack>
              </ct-card>

              {/* Route summary */}
              {ifElse(
                computed(() => showRoute.get() && stops.get().length > 1),
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={5}>Route Overview</ct-heading>
                    <ct-hstack gap="2" wrap>
                      {stops.map((stop, index) => (
                        <ct-hstack gap="1" align="center">
                          <span style="font-weight: 500;">{stop.title}</span>
                          {ifElse(
                            computed(() =>
                              index < stops.get().length - 1
                            ),
                            <span style="color: var(--ct-color-gray-400);">
                              {" "}
                              -&gt;{" "}
                            </span>,
                            null,
                          )}
                        </ct-hstack>
                      ))}
                    </ct-hstack>
                    <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                      {stopCount} stops connected by dashed route line
                    </span>
                  </ct-vstack>
                </ct-card>,
                null,
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
                    <li>
                      Add areas of interest to highlight regions on the map
                    </li>
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
      center: computed(() => center.get() ?? { lat: 37.6, lng: -122.2 }),
      zoom: computed(() => zoom.get()),
      selectedStopIndex: computed(() => selectedStopIndex.get()),
      fitBoundsTrigger: computed(() => fitBoundsTrigger.get()),
      initialized: computed(() => initialized.get()),
    };
  },
);
