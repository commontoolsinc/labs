/// <cts-enable />
/**
 * Location Track Module - GPS coordinate tracking over time
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Captures GPS coordinates with timestamps, storing them as an
 * array for track/breadcrumb logging.
 *
 * TODO: Add confirmation dialog before "Clear All" to prevent accidental data loss
 * TODO: Add allowMultiple: true to MODULE_METADATA for multiple tracks per record
 * TODO: Consider increasing remove button tap target to 44x44px for mobile accessibility (currently 32x32px)
 * TODO: Add export functionality (GPX, GeoJSON, CSV)
 * TODO: Add virtualization for large point lists (100+ points)
 * TODO: Expose continuous tracking mode from ct-location
 * TODO: Add schema fields for altitudeAccuracy, heading, speed
 * TODO: Consider adding to "place" template or creating "trip" template
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Types =====

/**
 * Single GPS point with metadata
 */
export interface LocationPoint {
  /** Unique ID for this point */
  id: string;
  /** Latitude in decimal degrees */
  latitude: number;
  /** Longitude in decimal degrees */
  longitude: number;
  /** Accuracy in meters */
  accuracy: number;
  /** Altitude in meters (if available) */
  altitude?: number;
  /** Altitude accuracy in meters (if available) */
  altitudeAccuracy?: number;
  /** Heading in degrees 0-360 (if available) */
  heading?: number;
  /** Speed in m/s (if available) */
  speed?: number;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "location-track",
  label: "Location Track",
  icon: "\u{1F310}", // globe emoji
  schema: {
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          accuracy: { type: "number" },
          altitude: { type: "number" },
          timestamp: { type: "number" },
        },
      },
      description: "Array of GPS location points with timestamps",
    },
    label: { type: "string", description: "Label for this track" },
  },
  fieldMapping: ["locations", "label"],
};

// ===== Module Input Type =====
export interface LocationTrackModuleInput {
  /** Array of captured location points */
  locations: Default<LocationPoint[], []>;
  /** Optional label for this track (e.g., "Morning run", "Commute") */
  label: Default<string, "">;
}

// ===== Handlers =====

/**
 * Handler for when ct-location emits a new location
 * Appends the location to the array
 */
const handleLocationUpdate = handler<
  { detail: { location: LocationPoint } },
  { locations: Writable<LocationPoint[]> }
>(({ detail }, { locations }) => {
  const newPoint = detail.location;
  // Validate required fields exist
  if (
    newPoint &&
    typeof newPoint.latitude === "number" &&
    typeof newPoint.longitude === "number" &&
    typeof newPoint.timestamp === "number"
  ) {
    locations.push(newPoint);
  }
});

/**
 * Handler to clear all locations
 */
const clearLocations = handler<
  unknown,
  { locations: Writable<LocationPoint[]> }
>((_event, { locations }) => {
  locations.set([]);
});

/**
 * Handler to remove a specific location by index
 */
const removeLocation = handler<
  unknown,
  { locations: Writable<LocationPoint[]>; index: number }
>((_event, { locations, index }) => {
  const current = locations.get() || [];
  locations.set(current.toSpliced(index, 1));
});

// ===== Helper Functions =====

function formatCoords(lat: number, lng: number): string {
  if (
    typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) ||
    isNaN(lng)
  ) {
    return "Invalid coordinates";
  }
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function formatTimestamp(ts: number): string {
  if (typeof ts !== "number" || isNaN(ts)) {
    return "Invalid time";
  }
  const date = new Date(ts);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAccuracy(accuracy: number): string {
  if (typeof accuracy !== "number" || isNaN(accuracy)) {
    return "";
  }
  if (accuracy < 100) {
    return `\u00B1${accuracy.toFixed(0)}m`;
  }
  return `\u00B1${(accuracy / 1000).toFixed(1)}km`;
}

// ===== The Pattern =====
export const LocationTrackModule = pattern<
  LocationTrackModuleInput,
  LocationTrackModuleInput
>("LocationTrackModule", ({ locations, label }) => {
  // Local writable cell for ct-location binding (not stored)
  const currentCapture = Writable.of<LocationPoint | null>(null);

  // Computed display text
  const displayText = computed(() => {
    const count = locations.length || 0;
    const labelText = label ? `${label}: ` : "";
    return count > 0
      ? `${labelText}${count} point${count !== 1 ? "s" : ""}`
      : `${labelText}No points`;
  });

  const hasPoints = computed(() => locations.length > 0);
  const hasMultiplePoints = computed(() => locations.length > 1);

  // Pre-compute filtered locations with indices for the list
  // IMPORTANT: We pre-compute index here because closures over index in .map() callbacks
  // don't work correctly with the reactive system
  const validLocationsWithIndex = computed(() => {
    return locations
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => point && typeof point.latitude === "number");
  });

  return {
    [NAME]: computed(() => `${MODULE_METADATA.icon} Track: ${displayText}`),
    [UI]: (
      <ct-vstack style={{ gap: "12px" }}>
        {/* Label input */}
        <ct-vstack style={{ gap: "4px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>
            Track Label (optional)
          </label>
          <ct-input
            $value={label}
            placeholder="e.g., Morning walk, Commute..."
          />
        </ct-vstack>

        {/* Location capture button */}
        <ct-vstack style={{ gap: "4px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>
            Capture Location
          </label>
          <ct-location
            $location={currentCapture}
            onct-location-update={handleLocationUpdate({ locations })}
          />
        </ct-vstack>

        {/* Points summary */}
        <ct-hstack
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 0",
            borderTop: "1px solid #e5e7eb",
          }}
        >
          <span
            style={{ fontSize: "14px", color: "#374151", padding: "0 8px" }}
          >
            {computed(() => {
              const count = locations.length || 0;
              return `${count} point${count !== 1 ? "s" : ""} captured`;
            })}
          </span>
          {ifElse(
            hasPoints,
            <ct-button
              variant="ghost"
              size="sm"
              onClick={clearLocations({ locations })}
              style={{
                fontSize: "12px",
                color: "#ef4444",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              Clear All
            </ct-button>,
            null,
          )}
        </ct-hstack>

        {/* Points list (collapsible for many points) */}
        {ifElse(
          hasMultiplePoints,
          <ct-collapsible>
            <span slot="trigger" style={{ fontSize: "12px", color: "#6b7280" }}>
              View all points
            </span>
            <ct-vstack style={{ gap: "0", marginTop: "8px" }}>
              {validLocationsWithIndex.map(({ point, index }) => (
                <ct-hstack
                  key={index}
                  gap="3"
                  style={{
                    alignItems: "center",
                    padding: "8px 4px",
                    borderBottom: "1px solid var(--border-subtle, #e5e7eb)",
                  }}
                >
                  {/* Point number - badge style */}
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: "500",
                      color: "#6b7280",
                      background: "#f3f4f6",
                      borderRadius: "4px",
                      padding: "2px 6px",
                      minWidth: "24px",
                      textAlign: "center",
                      flexShrink: "0",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      alignSelf: "center",
                    }}
                  >
                    {index + 1}
                  </span>

                  {/* Main content: coords + metadata stacked */}
                  <ct-vstack style={{ flex: "1", gap: "2px", minWidth: "0" }}>
                    {/* Coordinates */}
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "13px",
                        color: "#1f2937",
                      }}
                    >
                      {formatCoords(point.latitude, point.longitude)}
                    </span>
                    {/* Timestamp + Accuracy on same line */}
                    <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                      {formatTimestamp(point.timestamp)}{" "}
                      <span style={{ color: "#d1d5db" }}>·</span>{" "}
                      {formatAccuracy(point.accuracy)}
                    </span>
                  </ct-vstack>

                  {/* Delete button - more visible */}
                  <button
                    type="button"
                    onClick={removeLocation({ locations, index })}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "4px 8px",
                      fontSize: "16px",
                      color: "#9ca3af",
                      borderRadius: "4px",
                      flexShrink: "0",
                    }}
                    title="Remove point"
                  >
                    ×
                  </button>
                </ct-hstack>
              ))}
            </ct-vstack>
          </ct-collapsible>,
          null,
        )}
      </ct-vstack>
    ),
    locations,
    label,
  };
});

export default LocationTrackModule;
