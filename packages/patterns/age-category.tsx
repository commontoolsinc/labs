/// <cts-enable />
/**
 * Age Category Module - Pattern for categorizing age groups
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides two-tier categorization: Adult/Child with optional
 * specific subcategories (Senior, Young Adult, Teenager, etc.).
 *
 * Design: Single enum prevents invalid states (e.g., adult + baby subcategory).
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Types =====

/**
 * Single enum for age categories - invalid states are impossible by construction.
 * "adult" and "child" are general categories without specific subcategory.
 */
export type AgeCategory =
  | "adult"
  | "child" // General categories
  | "senior"
  | "adult-specific"
  | "young-adult" // Adult subcategories
  | "teenager"
  | "school-age"
  | "toddler"
  | "baby"; // Child subcategories

/**
 * Category metadata with age ranges for inference and display.
 */
export const AGE_CATEGORY_INFO = {
  // General categories
  adult: { label: "Adult (general)", ageMin: 18, ageMax: 150, isAdult: true },
  child: { label: "Child (general)", ageMin: 0, ageMax: 17, isAdult: false },
  // Adult subcategories
  senior: { label: "Senior", ageMin: 65, ageMax: 150, isAdult: true },
  "adult-specific": { label: "Adult", ageMin: 26, ageMax: 64, isAdult: true },
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
  baby: { label: "Baby", ageMin: 0, ageMax: 1, isAdult: false },
} as const;

/**
 * Helper to determine if a category belongs to the Adult group.
 */
export const isAdultCategory = (cat: AgeCategory): boolean =>
  AGE_CATEGORY_INFO[cat]?.isAdult ?? true;

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "age-category",
  label: "Age Category",
  icon: "\u{1F464}", // bust silhouette emoji
  schema: {
    ageCategory: {
      type: "string",
      enum: [
        "adult",
        "child",
        "senior",
        "adult-specific",
        "young-adult",
        "teenager",
        "school-age",
        "toddler",
        "baby",
      ],
      description: "Age category",
    },
  },
  fieldMapping: ["ageCategory"],
};

// ===== Interface =====
export interface AgeCategoryModuleInput {
  ageCategory: Default<AgeCategory, "adult">;
}

// ===== Constants =====

const ADULT_CATEGORY_OPTIONS = [
  { value: "adult", label: "Adult (general)" },
  { value: "senior", label: "Senior (65+)" },
  { value: "adult-specific", label: "Adult (26-64)" },
  { value: "young-adult", label: "Young Adult (18-25)" },
];

const CHILD_CATEGORY_OPTIONS = [
  { value: "child", label: "Child (general)" },
  { value: "teenager", label: "Teenager (13-17)" },
  { value: "school-age", label: "School-age (5-12)" },
  { value: "toddler", label: "Toddler (1-4)" },
  { value: "baby", label: "Baby (0-1)" },
];

// ===== Utility Functions =====

/**
 * Calculate current age from birth year and optional birth date.
 * Handles MM-DD and YYYY-MM-DD formats.
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
 */
export function inferCategoryFromAge(age: number): AgeCategory {
  if (age >= 65) return "senior";
  if (age >= 26) return "adult-specific";
  if (age >= 18) return "young-adult";
  if (age >= 13) return "teenager";
  if (age >= 5) return "school-age";
  if (age >= 1) return "toddler";
  return "baby";
}

// ===== Handlers =====

// Handle age group radio change
const handleGroupChange = handler<
  { detail: { value: string } },
  { ageCategory: Writable<AgeCategory> }
>(({ detail }, { ageCategory }) => {
  const newGroup = detail.value;
  const current = ageCategory.get();
  const currentIsAdult = isAdultCategory(current);

  // Only change if switching groups
  if (newGroup === "adult" && !currentIsAdult) {
    ageCategory.set("adult");
  } else if (newGroup === "child" && currentIsAdult) {
    ageCategory.set("child");
  }
});

// ===== The Pattern =====
export const AgeCategoryModule = pattern<
  AgeCategoryModuleInput,
  AgeCategoryModuleInput
>(({ ageCategory }) => {
  // Compute whether current category is in Adult group
  const currentIsAdult = computed(() => isAdultCategory(ageCategory));

  // Compute display text for NAME
  const displayText = computed(() => {
    const cat = ageCategory as AgeCategory;
    const info = AGE_CATEGORY_INFO[cat];
    return info?.label || "Adult";
  });

  // Get current category options based on group
  const categoryOptions = computed(() =>
    currentIsAdult ? ADULT_CATEGORY_OPTIONS : CHILD_CATEGORY_OPTIONS
  );

  // Compute current group for radio display
  const currentGroup = computed(() => (currentIsAdult ? "adult" : "child"));

  // Age group options for radio
  const ageGroupOptions = [
    { label: "Adult", value: "adult" },
    { label: "Child", value: "child" },
  ];

  return {
    [NAME]: computed(() => `${MODULE_METADATA.icon} Age: ${displayText}`),
    [UI]: (
      <ct-vstack style={{ gap: "16px" }}>
        {/* Main category toggle */}
        <ct-vstack style={{ gap: "8px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>
            Age Group
          </label>
          <ct-radio-group
            orientation="horizontal"
            items={ageGroupOptions}
            value={currentGroup}
            onct-change={handleGroupChange({ ageCategory })}
          />
        </ct-vstack>

        {/* Specific category selection */}
        <ct-vstack style={{ gap: "4px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>
            Specific Category
          </label>
          <ct-select $value={ageCategory} items={categoryOptions} />
        </ct-vstack>
      </ct-vstack>
    ),
    ageCategory,
  };
});

export default AgeCategoryModule;
