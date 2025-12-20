/// <cts-enable />
/**
 * Location Module - Sub-charm for places/venues
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface LocationModuleInput {
  locationName: Default<string, "">;
  locationAddress: Default<string, "">;
  coordinates: Default<string, "">;
}

export const LocationModule = recipe<LocationModuleInput, LocationModuleInput>(
  "LocationModule",
  ({ locationName, locationAddress, coordinates }) => {
    const displayText = computed(() => locationName || locationAddress || "Not set");

    return {
      [NAME]: computed(() => `🗺️ Location: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Location Name
            </label>
            <ct-input $value={locationName} placeholder="e.g., Home, Office, Cafe" />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Address</label>
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
  }
);

export default LocationModule;
