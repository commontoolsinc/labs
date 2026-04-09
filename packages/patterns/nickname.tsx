/**
 * Nickname Module - Pattern for alternate names/aliases
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores a nickname that can optionally be displayed as an alias
 * in the parent Record's display name.
 */
import { computed, type Default, NAME, pattern, UI } from "commonfabric";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "nickname",
  label: "Nickname",
  icon: "\u{1F4DB}", // 📛 name badge emoji
  allowMultiple: true, // Allow multiple nicknames per record
  schema: {
    nickname: { type: "string", description: "Nickname or informal name" },
  },
  fieldMapping: ["nickname", "alias", "aka"],
};

// ===== Types =====
export interface NicknameModuleInput {
  /** Nickname or alias */
  nickname: Default<string, "">;
}

// ===== The Pattern =====
export const NicknameModule = pattern<NicknameModuleInput, NicknameModuleInput>(
  ({ nickname }) => {
    // Build display text
    const displayText = computed(() => {
      const value = nickname?.trim();
      return value || "Not set";
    });

    return {
      [NAME]: computed(() =>
        `${MODULE_METADATA.icon} Nickname: ${displayText}`
      ),
      [UI]: (
        <cf-vstack style={{ gap: "4px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>Nickname</label>
          <cf-input
            $value={nickname}
            placeholder="Enter nickname..."
          />
        </cf-vstack>
      ),
      nickname,
    };
  },
);

export default NicknameModule;
