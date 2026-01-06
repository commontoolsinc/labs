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
 * TODO: Increase remove button tap target to 44x44px for mobile accessibility
 * TODO: Add export functionality (GPX, GeoJSON, CSV)
 * TODO: Add virtualization for large point lists (100+ points)
 * TODO: Expose continuous tracking mode from ct-location
 * TODO: Add schema fields for altitudeAccuracy, heading, speed
 * TODO: Consider adding to "place" template or creating "trip" template
 */
import {
  Cell,
  computed,
  type Default,
  handler,
  NAME,
  recipe,
  UI,
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
  { locations: Cell<LocationPoint[]> }
>(({ detail }, { locations }) => {
  const newPoint = detail.location;
  // Validate required fields exist
  if (newPoint &&
      typeof newPoint.latitude === 'number' &&
      typeof newPoint.longitude === 'number' &&
      typeof newPoint.timestamp === 'number') {
    locations.push(newPoint);
  }
});

/**
 * Handler to clear all locations
 */
const clearLocations = handler<
  unknown,
  { locations: Cell<LocationPoint[]> }
>((_event, { locations }) => {
  locations.set([]);
});

/**
 * Handler to remove a specific location by index
 */
const removeLocation = handler<
  unknown,
  { locations: Cell<LocationPoint[]>; index: number }
>((_event, { locations, index }) => {
  const current = locations.get() || [];
  locations.set(current.toSpliced(index, 1));
});

// ===== Helper Functions =====

function formatCoords(lat: number, lng: number): string {
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return "Invalid coordinates";
  }
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function formatTimestamp(ts: number): string {
  if (typeof ts !== 'number' || isNaN(ts)) {
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
  if (typeof accuracy !== 'number' || isNaN(accuracy)) {
    return "";
  }
  if (accuracy < 100) {
    return `\u00B1${accuracy.toFixed(0)}m`;
  }
  return `\u00B1${(accuracy / 1000).toFixed(1)}km`;
}

// ===== The Pattern =====
export const LocationTrackModule = recipe<
  LocationTrackModuleInput,
  LocationTrackModuleInput
>("LocationTrackModule", ({ locations, label }) => {
  // Local cell for ct-location binding (not stored)
  const currentCapture = Cell.of<LocationPoint | null>(null);

  // Computed display text
  const displayText = computed(() => {
    const count = (locations || []).length || 0;
    const labelText = label ? `${label}: ` : "";
    return count > 0
      ? `${labelText}${count} point${count !== 1 ? "s" : ""}`
      : `${labelText}No points`;
  });

  // Most recent point
  const lastPoint = computed(() => {
    const pts = locations || [];
    return pts.length > 0 ? pts[pts.length - 1] : null;
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
          <span style={{ fontSize: "14px", color: "#374151" }}>
            {computed(() => {
              const count = (locations || []).length || 0;
              return `${count} point${count !== 1 ? "s" : ""} captured`;
            })}
          </span>
          {computed(() => (locations || []).length > 0) && (
            <ct-button
              variant="ghost"
              size="sm"
              onClick={clearLocations({ locations })}
              style={{ fontSize: "12px", color: "#ef4444" }}
            >
              Clear All
            </ct-button>
          )}
        </ct-hstack>

        {/* Last captured point */}
        {lastPoint && (
          <ct-vstack
            style={{
              gap: "4px",
              padding: "8px",
              background: "#f9fafb",
              borderRadius: "6px",
              fontSize: "12px",
            }}
          >
            <span style={{ fontWeight: "500", color: "#374151" }}>
              Latest Point
            </span>
            <span style={{ fontFamily: "monospace", color: "#6b7280" }}>
              {computed(() => {
                const pt = lastPoint;
                if (!pt) return "";
                return formatCoords(pt.latitude, pt.longitude);
              })}
            </span>
            <ct-hstack style={{ gap: "12px", color: "#9ca3af" }}>
              <span>
                {computed(() => {
                  const pt = lastPoint;
                  return pt ? formatAccuracy(pt.accuracy) : "";
                })}
              </span>
              <span>
                {computed(() => {
                  const pt = lastPoint;
                  return pt ? formatTimestamp(pt.timestamp) : "";
                })}
              </span>
            </ct-hstack>
          </ct-vstack>
        )}

        {/* Points list (collapsible for many points) */}
        {computed(() => (locations || []).length > 1) && (
          <ct-collapsible>
            <span slot="trigger" style={{ fontSize: "12px", color: "#6b7280" }}>
              View all points
            </span>
            <ct-vstack style={{ gap: "6px", paddingTop: "8px" }}>
              {locations.filter((p: LocationPoint) => p && typeof p.latitude === 'number').map((point: LocationPoint, index: number) => (
                <ct-hstack
                  key={index}
                  style={{
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 8px",
                    background: "#f3f4f6",
                    borderRadius: "4px",
                    fontSize: "11px",
                  }}
                >
                  <ct-vstack style={{ gap: "2px" }}>
                    <span style={{ fontFamily: "monospace" }}>
                      {formatCoords(point.latitude, point.longitude)}
                    </span>
                    <span style={{ color: "#9ca3af" }}>
                      {formatTimestamp(point.timestamp)} •{" "}
                      {formatAccuracy(point.accuracy)}
                    </span>
                  </ct-vstack>
                  <button
                    type="button"
                    onClick={removeLocation({ locations, index })}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "4px",
                      fontSize: "14px",
                      color: "#9ca3af",
                      lineHeight: "1",
                    }}
                    title="Remove point"
                  >
                    ×
                  </button>
                </ct-hstack>
              ))}
            </ct-vstack>
          </ct-collapsible>
        )}
      </ct-vstack>
    ),
    locations,
    label,
  };
});

export default LocationTrackModule;
