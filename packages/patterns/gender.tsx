/// <cts-enable />
/**
 * Gender Module - Pattern for gender identity selection
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides gender selection with inclusive predefined options.
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";
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
  /** Gender identity */
  gender: Default<GenderValue | "", "">;
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

// ===== The Pattern =====
export const GenderModule = recipe<GenderModuleInput, GenderModuleInput>(
  "GenderModule",
  ({ gender }) => {
    const displayText = computed(() => {
      const opt = GENDER_OPTIONS.find((o) => o.value === gender);
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
    };
  },
);

export default GenderModule;
