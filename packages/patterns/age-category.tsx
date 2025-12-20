/// <cts-enable />
/**
 * Age Category Module - Pattern for categorizing age groups
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides two-tier categorization: Adult/Child with optional
 * specific subcategories (Senior, Young Adult, Teenager, etc.).
 *
 * Design decisions:
 * - Main toggle: Adult vs Child (simple binary for most use cases)
 * - Optional subcategory for more granular classification
 *
 * ## Future: Birthday Integration Architecture
 *
 * This module is designed to support future integration with the Birthday
 * module for automatic age category suggestions. The architecture pattern
 * can be reused by other modules that need sibling data access.
 *
 * ### Proposed Architecture: SiblingObserverContext
 *
 * Extend ContainerCoordinationContext with sibling discovery:
 *
 * ```typescript
 * interface SiblingObserverContext extends ContainerCoordinationContext {
 *   // Find sibling by type and get read-only access to its data
 *   observeSibling<T>(type: string): T | null;
 * }
 * ```
 *
 * ### Usage in Age Category:
 *
 * ```typescript
 * interface AgeCategoryWithContext extends AgeCategoryModuleInput {
 *   context?: SiblingObserverContext;
 * }
 *
 * // In pattern body:
 * const birthdayData = context?.observeSibling<BirthdayModuleInput>('birthday');
 *
 * const suggestedCategory = computed(() => {
 *   if (!birthdayData?.birthYear) return null;
 *   const age = calculateAgeFromYear(birthdayData.birthYear);
 *   return inferCategoryFromAge(age);
 * });
 *
 * // Show suggestion UI when available
 * {suggestedCategory && (
 *   <button onClick={applySuggestion}>
 *     Suggest: {suggestedCategory.subCategory} (age {age})
 *   </button>
 * )}
 * ```
 *
 * ### Other Modules That Could Use This Pattern:
 *
 * - Gift Preferences could observe Relationship for "closeness" hints
 * - Timeline could observe Birthday for age-based milestones
 * - Status could observe Timing for deadline-based status changes
 *
 * See: container-protocol.ts for protocol definitions
 */
import {
  Cell,
  computed,
  type Default,
  handler,
  ifElse,
  NAME,
  recipe,
  UI,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "age-category",
  label: "Age Category",
  icon: "\u{1F464}", // bust silhouette emoji 👤
  schema: {
    isAdult: {
      type: "boolean",
      description: "True for adult, false for child/minor",
    },
    subCategory: {
      type: "string",
      enum: [
        "",
        "senior",
        "adult",
        "young-adult",
        "teenager",
        "school-age",
        "toddler",
        "baby",
      ],
      description: "Specific age subcategory",
    },
  },
  fieldMapping: ["isAdult", "subCategory"],
};

// ===== Types =====

/**
 * Subcategory definitions with age ranges and parent mapping.
 * This enables future birthday-based auto-suggestion.
 */
export const AGE_SUBCATEGORIES = {
  // Adult subcategories
  senior: { label: "Senior", ageMin: 65, ageMax: 150, isAdult: true },
  adult: { label: "Adult", ageMin: 26, ageMax: 64, isAdult: true },
  "young-adult": {
    label: "Young Adult",
    ageMin: 18,
    ageMax: 25,
    isAdult: true,
  },
  // Child subcategories
  teenager: { label: "Teenager", ageMin: 13, ageMax: 17, isAdult: false },
  "school-age": { label: "School-age", ageMin: 5, ageMax: 12, isAdult: false },
  toddler: { label: "Toddler", ageMin: 1, ageMax: 4, isAdult: false },
  baby: { label: "Baby", ageMin: 0, ageMax: 0, isAdult: false },
} as const;

export type SubCategory = keyof typeof AGE_SUBCATEGORIES | "";

export interface AgeCategoryModuleInput {
  isAdult: Default<boolean, true>; // Default to adult
  subCategory: Default<SubCategory, "">;
}

// ===== Constants =====

const ADULT_SUBCATEGORY_OPTIONS = [
  { value: "", label: "Adult (general)" },
  { value: "senior", label: "Senior (65+)" },
  { value: "adult", label: "Adult (26-64)" },
  { value: "young-adult", label: "Young Adult (18-25)" },
];

const CHILD_SUBCATEGORY_OPTIONS = [
  { value: "", label: "Child (general)" },
  { value: "teenager", label: "Teenager (13-17)" },
  { value: "school-age", label: "School-age (5-12)" },
  { value: "toddler", label: "Toddler (1-4)" },
  { value: "baby", label: "Baby (0-1)" },
];

// ===== Utility Functions =====

/**
 * Calculate current age from birth year and optional birth date.
 * Handles MM-DD and YYYY-MM-DD formats.
 *
 * @param birthYear - The birth year (required for age calculation)
 * @param birthDate - Optional date string in MM-DD or YYYY-MM-DD format
 * @returns Current age in years, or null if birthYear is not provided
 */
export function calculateAge(
  birthYear: number | null,
  birthDate?: string,
): number | null {
  if (!birthYear) return null;

  const today = new Date();
  const currentYear = today.getFullYear();
  let age = currentYear - birthYear;

  // If we have MM-DD or YYYY-MM-DD, check if birthday has passed this year
  if (birthDate) {
    const match = birthDate.match(/(\d{2})-(\d{2})$/);
    if (match) {
      const [, month, day] = match;
      const birthdayThisYear = new Date(
        currentYear,
        parseInt(month) - 1,
        parseInt(day),
      );
      if (today < birthdayThisYear) {
        age--;
      }
    }
  }

  return age;
}

/**
 * Infer age category from a given age.
 * Useful for future birthday integration.
 */
export function inferCategoryFromAge(age: number): {
  isAdult: boolean;
  subCategory: SubCategory;
} {
  for (
    const [key, def] of Object.entries(AGE_SUBCATEGORIES) as [
      SubCategory,
      (typeof AGE_SUBCATEGORIES)[keyof typeof AGE_SUBCATEGORIES],
    ][]
  ) {
    if (age >= def.ageMin && age <= def.ageMax) {
      return { isAdult: def.isAdult, subCategory: key };
    }
  }
  // Fallback for edge cases
  return age >= 18
    ? { isAdult: true, subCategory: "adult" }
    : { isAdult: false, subCategory: "school-age" };
}

// ===== Handlers =====

// Toggle between Adult and Child, clearing subcategory when switching
const toggleIsAdult = handler<
  unknown,
  { isAdult: Cell<boolean>; subCategory: Cell<SubCategory> }
>((_event, { isAdult, subCategory }) => {
  const newValue = !isAdult.get();
  isAdult.set(newValue);
  // Clear subcategory when main category changes (subcategory may not be valid)
  subCategory.set("");
});

// ===== The Pattern =====
export const AgeCategoryModule = recipe<
  AgeCategoryModuleInput,
  AgeCategoryModuleInput
>(
  "AgeCategoryModule",
  ({ isAdult, subCategory }) => {
    // Compute display text for NAME
    const displayText = computed(() => {
      const adult = isAdult;
      const sub = subCategory;

      if (sub && AGE_SUBCATEGORIES[sub as keyof typeof AGE_SUBCATEGORIES]) {
        return AGE_SUBCATEGORIES[sub as keyof typeof AGE_SUBCATEGORIES].label;
      }
      return adult ? "Adult" : "Child";
    });

    // Get current subcategory options based on main category
    const subcategoryOptions = computed(() =>
      isAdult ? ADULT_SUBCATEGORY_OPTIONS : CHILD_SUBCATEGORY_OPTIONS
    );

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Age: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "16px" }}>
          {/* Main category toggle */}
          <ct-vstack style={{ gap: "8px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Age Group
            </label>
            <ct-hstack style={{ gap: "8px" }}>
              <button
                type="button"
                onClick={toggleIsAdult({ isAdult, subCategory })}
                style={{
                  flex: "1",
                  padding: "12px 16px",
                  borderRadius: "8px",
                  border: isAdult ? "2px solid #3b82f6" : "1px solid #d1d5db",
                  background: isAdult ? "#eff6ff" : "white",
                  color: isAdult ? "#1d4ed8" : "#374151",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: isAdult ? "600" : "400",
                }}
              >
                Adult (18+)
              </button>
              <button
                type="button"
                onClick={toggleIsAdult({ isAdult, subCategory })}
                style={{
                  flex: "1",
                  padding: "12px 16px",
                  borderRadius: "8px",
                  border: isAdult ? "1px solid #d1d5db" : "2px solid #3b82f6",
                  background: isAdult ? "white" : "#eff6ff",
                  color: isAdult ? "#374151" : "#1d4ed8",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: isAdult ? "400" : "600",
                }}
              >
                Child (0-17)
              </button>
            </ct-hstack>
          </ct-vstack>

          {/* Optional subcategory refinement */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Specific Category (optional)
            </label>
            <ct-select
              $value={subCategory}
              items={subcategoryOptions}
            />
          </ct-vstack>

          {/* Info text showing current selection */}
          {ifElse(
            computed(() => !!subCategory),
            <div
              style={{
                padding: "8px 12px",
                background: "#f9fafb",
                borderRadius: "6px",
                fontSize: "13px",
                color: "#6b7280",
              }}
            >
              Selected: {displayText}
            </div>,
            null,
          )}
        </ct-vstack>
      ),
      isAdult,
      subCategory,
    };
  },
);

export default AgeCategoryModule;
