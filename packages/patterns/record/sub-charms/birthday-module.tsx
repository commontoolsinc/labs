/// <cts-enable />
/**
 * Birthday Module - Sub-charm for birthday/date of birth tracking
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface BirthdayModuleInput {
  birthDate: Default<string, "">;
  birthYear: Default<number | null, null>;
}

export const BirthdayModule = recipe<BirthdayModuleInput, BirthdayModuleInput>(
  "BirthdayModule",
  ({ birthDate, birthYear }) => {
    // Compute display text for NAME
    const displayText = computed(() => {
      const date = birthDate;
      const year = birthYear;
      return date || year
        ? `${date}${year ? ` (${year})` : ""}`
        : "Not set";
    });

    return {
      [NAME]: computed(() => `🎂 Birthday: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Birthday (MM-DD or YYYY-MM-DD)
            </label>
            <ct-input
              $value={birthDate}
              placeholder="e.g., 03-15 or 1990-03-15"
            />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Birth Year (optional)
            </label>
            <ct-input
              type="number"
              $value={birthYear}
              placeholder="e.g., 1990"
            />
          </ct-vstack>
        </ct-vstack>
      ),
      birthDate,
      birthYear,
    };
  }
);

export default BirthdayModule;
