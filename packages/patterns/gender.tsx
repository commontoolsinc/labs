/// <cts-enable />
/**
 * Gender Module - Pattern for gender identity selection
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides gender selection with inclusive predefined options.
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

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "gender",
  label: "Gender",
  icon: "\u26A7", // ⚧ transgender/gender symbol
  schema: {
    gender: {
      type: "string",
      enum: ["", "woman", "man", "non-binary", "other", "prefer-not-to-say"],
      description: "Gender identity",
    },
  },
  fieldMapping: ["gender"],
};

// ===== Types =====

/** Gender identity values */
type GenderValue =
  | "woman"
  | "man"
  | "non-binary"
  | "other"
  | "prefer-not-to-say";

export interface GenderModuleInput {
  /** Gender identity - Writable<> required for setGender handler to call .set() */
  gender: Writable<Default<GenderValue | "", "">>;
}

// ===== Constants =====
const GENDER_OPTIONS = [
  { value: "", label: "Not specified" },
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "non-binary", label: "Non-binary" },
  { value: "other", label: "Other" },
  { value: "prefer-not-to-say", label: "Prefer not to say" },
];

// Valid gender values for normalization
const VALID_GENDER_VALUES = new Set([
  "",
  "woman",
  "man",
  "non-binary",
  "other",
  "prefer-not-to-say",
]);

/**
 * Normalize gender input to a valid enum value.
 * Handles case variations (e.g., "Non-binary" -> "non-binary").
 */
function normalizeGenderValue(input: string): GenderValue | "" {
  if (!input || typeof input !== "string") return "";
  const normalized = input.toLowerCase().trim();
  if (VALID_GENDER_VALUES.has(normalized)) {
    return normalized as GenderValue | "";
  }
  // Handle common variations
  if (normalized === "nonbinary" || normalized === "non binary") {
    return "non-binary";
  }
  if (normalized === "prefer not to say" || normalized === "prefernotosay") {
    return "prefer-not-to-say";
  }
  return "";
}

// ===== Handlers =====

/**
 * Handler for setting gender value programmatically.
 * Normalizes input to handle case variations and common aliases.
 *
 * This handler is LLM-callable via Omnibot's invoke() tool.
 * IMPORTANT: Handlers must accept result?: Writable<unknown> and use result.set()
 * to return data to the LLM. The 'result' Cell is injected by llm-dialog.ts.
 */
const setGender = handler<
  { value: string; result?: Writable<unknown> },
  { gender: Writable<GenderValue | ""> }
>(({ value, result }, { gender }) => {
  const normalized = normalizeGenderValue(value);
  gender.set(normalized);

  // Return confirmation to the LLM
  if (result) {
    const displayLabel = GENDER_OPTIONS.find((o) =>
      o.value === normalized
    )?.label ||
      "Not specified";
    result.set({
      success: true,
      value: normalized,
      displayLabel,
      message: `Gender set to ${displayLabel}`,
    });
  }
});

// ===== The Pattern =====
export const GenderModule = pattern<GenderModuleInput, GenderModuleInput>(
  ({ gender }) => {
    const displayText = computed(() => {
      const currentGender = gender.get();
      const opt = GENDER_OPTIONS.find((o) => o.value === currentGender);
      return opt?.label || "Not specified";
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Gender: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "8px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>Gender</label>
          <ct-select $value={gender} items={GENDER_OPTIONS} />
        </ct-vstack>
      ),
      gender,
      setGender: setGender({ gender }),
    };
  },
);

export default GenderModule;
