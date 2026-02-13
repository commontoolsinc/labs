/// <cts-enable />
/**
 * Location Module - Pattern for places/venues
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores location name, address, and optional coordinates.
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "location",
  label: "Location",
  icon: "\u{1F5FA}", // world map emoji
  schema: {
    locationName: { type: "string", description: "Location name" },
    locationAddress: { type: "string", description: "Full address" },
    coordinates: { type: "string", description: "Coordinates (lat,lng)" },
  },
  fieldMapping: ["locationName", "locationAddress", "coordinates"],
};

// ===== Types =====
export interface LocationModuleInput {
  /** Location name (e.g., venue, landmark) */
  locationName: Default<string, "">;
  /** Full address */
  locationAddress: Default<string, "">;
  /** Coordinates in lat,lng format */
  coordinates: Default<string, "">;
}

// ===== The Pattern =====
export const LocationModule = pattern<LocationModuleInput, LocationModuleInput>(
  "LocationModule",
  ({ locationName, locationAddress, coordinates }) => {
    const displayText = computed(() =>
      locationName || locationAddress || "Not set"
    );

    return {
      [NAME]: computed(() =>
        `${MODULE_METADATA.icon} Location: ${displayText}`
      ),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Location Name
            </label>
            <ct-input
              $value={locationName}
              placeholder="e.g., Home, Office, Cafe"
            />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Address
            </label>
            <ct-textarea
              $value={locationAddress}
              placeholder="Full address..."
              rows={2}
            />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Coordinates (optional)
            </label>
            <ct-input
              $value={coordinates}
              placeholder="lat,lng (e.g., 37.7749,-122.4194)"
            />
          </ct-vstack>
        </ct-vstack>
      ),
      locationName,
      locationAddress,
      coordinates,
    };
  },
);

export default LocationModule;
