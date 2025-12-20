/// <cts-enable />
/**
 * Address Module - Sub-charm for physical address
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface AddressModuleInput {
  street: Default<string, "">;
  city: Default<string, "">;
  state: Default<string, "">;
  zip: Default<string, "">;
}

export const AddressModule = recipe<AddressModuleInput, AddressModuleInput>(
  "AddressModule",
  ({ street, city, state, zip }) => {
    // Build display text from non-empty fields
    const displayText = computed(() => {
      const parts = [city, state].filter((v) => v?.trim());
      return parts.length > 0 ? parts.join(", ") : "Not set";
    });

    return {
      [NAME]: computed(() => `📍 Address: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Street</label>
            <ct-input $value={street} placeholder="123 Main St" />
          </ct-vstack>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr",
              gap: "8px",
            }}
          >
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>City</label>
              <ct-input $value={city} placeholder="City" />
            </ct-vstack>
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>State</label>
              <ct-input $value={state} placeholder="CA" />
            </ct-vstack>
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>ZIP</label>
              <ct-input $value={zip} placeholder="12345" />
            </ct-vstack>
          </div>
        </ct-vstack>
      ),
      street,
      city,
      state,
      zip,
    };
  }
);

export default AddressModule;
