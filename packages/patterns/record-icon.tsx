/// <cts-enable />
/**
 * Record Icon Module - Pattern for manually setting a record's emoji icon
 *
 * A composable pattern that can be used in Record containers to override
 * the automatic type-based icon inference. When set, this emoji takes
 * precedence over the inferred icon.
 *
 * Uses the emoji-picker pattern for the selection UI.
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";
import EmojiPicker from "./emoji-picker.tsx";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "record-icon",
  label: "Custom Icon",
  icon: "\u{1F3A8}", // 🎨 palette emoji
  allowMultiple: false, // Only one custom icon per record
  schema: {
    icon: { type: "string", description: "Custom emoji icon for record" },
  },
  fieldMapping: ["icon", "emoji"],
};

// ===== Types =====
export interface RecordIconModuleInput {
  /** Custom emoji/icon */
  icon: Default<string, "">;
}

// ===== The Pattern =====
export const RecordIconModule = pattern<
  RecordIconModuleInput,
  RecordIconModuleInput
>(({ icon }) => {
  // Compose the emoji picker pattern
  const picker = EmojiPicker({ selectedEmoji: icon });

  // Display text for NAME
  const displayText = computed(() => {
    const currentIcon = icon;
    return currentIcon || "(auto)";
  });

  return {
    [NAME]: computed(
      () => `${MODULE_METADATA.icon} Icon: ${displayText}`,
    ),
    [UI]: picker,
    icon,
  };
});

export default RecordIconModule;
