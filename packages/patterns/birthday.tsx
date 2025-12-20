/// <cts-enable />
/**
 * Birthday Module - Pattern for birthday/date of birth tracking
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Tracks birthday date and optional birth year.
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "birthday",
  label: "Birthday",
  icon: "\u{1F382}", // cake emoji
  schema: {
    birthDate: { type: "string", description: "Birthday YYYY-MM-DD" },
    birthYear: { type: "number", description: "Birth year" },
  },
  fieldMapping: ["birthDate", "birthYear"],
};

// ===== Types =====
export interface BirthdayModuleInput {
  birthDate: Default<string, "">;
  birthYear: Default<number | null, null>;
}

// ===== The Pattern =====
export const BirthdayModule = recipe<BirthdayModuleInput, BirthdayModuleInput>(
  "BirthdayModule",
  ({ birthDate, birthYear }) => {
    // Compute display text for NAME
    const displayText = computed(() => {
      const date = birthDate;
      const year = birthYear;
      return date || year ? `${date}${year ? ` (${year})` : ""}` : "Not set";
    });

    return {
      [NAME]: computed(() =>
        `${MODULE_METADATA.icon} Birthday: ${displayText}`
      ),
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
  },
);

export default BirthdayModule;
