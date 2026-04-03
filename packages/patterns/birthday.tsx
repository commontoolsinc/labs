/// <cts-enable />
/**
 * Birthday Module - Pattern for birthday/date of birth tracking
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Tracks birthday with separate month, day, and year fields.
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "birthday",
  label: "Birthday",
  icon: "\u{1F382}", // cake emoji
  schema: {
    birthMonth: { type: "string", description: "Birth month (1-12)" },
    birthDay: { type: "string", description: "Birth day (1-31)" },
    birthYear: { type: "string", description: "Birth year (YYYY)" },
  },
  fieldMapping: [
    "birthMonth",
    "birthDay",
    "birthYear",
    "birthday",
    "dob",
    "dateOfBirth",
  ],
};

// ===== Autocomplete Items =====
const MONTH_ITEMS = [
  { value: "1", label: "January", searchAliases: ["jan", "01"] },
  { value: "2", label: "February", searchAliases: ["feb", "02"] },
  { value: "3", label: "March", searchAliases: ["mar", "03"] },
  { value: "4", label: "April", searchAliases: ["apr", "04"] },
  { value: "5", label: "May", searchAliases: ["05"] },
  { value: "6", label: "June", searchAliases: ["jun", "06"] },
  { value: "7", label: "July", searchAliases: ["jul", "07"] },
  { value: "8", label: "August", searchAliases: ["aug", "08"] },
  { value: "9", label: "September", searchAliases: ["sep", "sept", "09"] },
  { value: "10", label: "October", searchAliases: ["oct"] },
  { value: "11", label: "November", searchAliases: ["nov"] },
  { value: "12", label: "December", searchAliases: ["dec"] },
];

const DAY_ITEMS = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
  searchAliases: i < 9 ? [`0${i + 1}`] : undefined,
}));

function generateYearItems(): Array<{ value: string; label: string }> {
  const currentYear = new Date().getFullYear();
  const years: Array<{ value: string; label: string }> = [];
  for (let year = currentYear; year >= 1920; year--) {
    years.push({ value: String(year), label: String(year) });
  }
  return years;
}
const YEAR_ITEMS = generateYearItems();

// ===== Helper Functions =====
const getMonthName = (month: string): string => {
  const monthItem = MONTH_ITEMS.find((m) => m.value === month);
  return monthItem?.label || month;
};

// ===== Types =====
export interface BirthdayModuleInput {
  /** Birth month (1-12 as string) */
  birthMonth: Default<string, "">;
  /** Birth day (1-31 as string) */
  birthDay: Default<string, "">;
  /** Birth year (e.g., "1990") */
  birthYear: Default<string, "">;
}

// ===== The Pattern =====
export const BirthdayModule = pattern<BirthdayModuleInput, BirthdayModuleInput>(
  ({ birthMonth, birthDay, birthYear }) => {
    // Compute display text for NAME
    const displayText = computed(() => {
      const month = birthMonth?.trim();
      const day = birthDay?.trim();
      const year = birthYear?.trim();

      if (!month && !day && !year) return "Not set";

      const parts: string[] = [];
      if (month) parts.push(getMonthName(month));
      if (day) parts.push(day);
      if (year) parts.push(year);

      return parts.join(" ");
    });

    return {
      [NAME]: computed(() =>
        `${MODULE_METADATA.icon} Birthday: ${displayText}`
      ),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1.5fr",
              gap: "8px",
            }}
          >
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Month
              </label>
              <ct-autocomplete
                $value={birthMonth}
                items={MONTH_ITEMS}
                placeholder="Month"
                allowCustom
                maxVisible={12}
              />
            </ct-vstack>

            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>Day</label>
              <ct-autocomplete
                $value={birthDay}
                items={DAY_ITEMS}
                placeholder="Day"
                allowCustom
                maxVisible={10}
              />
            </ct-vstack>

            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>Year</label>
              <ct-autocomplete
                $value={birthYear}
                items={YEAR_ITEMS}
                placeholder="Year"
                allowCustom
                maxVisible={10}
              />
            </ct-vstack>
          </div>
        </ct-vstack>
      ),
      birthMonth,
      birthDay,
      birthYear,
    };
  },
);

export default BirthdayModule;
