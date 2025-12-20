/// <cts-enable />
/**
 * Social Module - Pattern for social media profiles
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores social platform, handle, and profile URL.
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "social",
  label: "Social",
  icon: "\u{1F517}", // link emoji
  schema: {
    platform: {
      type: "string",
      enum: [
        "twitter",
        "linkedin",
        "github",
        "instagram",
        "facebook",
        "youtube",
        "tiktok",
        "mastodon",
        "bluesky",
      ],
      description: "Social platform",
    },
    handle: { type: "string", description: "Username/handle" },
    url: { type: "string", format: "uri", description: "Profile URL" },
  },
  fieldMapping: ["platform", "handle", "url"],
};

// ===== Types =====
export interface SocialModuleInput {
  platform: Default<string, "">;
  handle: Default<string, "">;
  url: Default<string, "">;
}

// ===== Constants =====
const PLATFORM_OPTIONS = [
  { value: "", label: "Select platform" },
  { value: "twitter", label: "𝕏 Twitter/X" },
  { value: "linkedin", label: "🔗 LinkedIn" },
  { value: "github", label: "🐙 GitHub" },
  { value: "instagram", label: "📷 Instagram" },
  { value: "facebook", label: "📘 Facebook" },
  { value: "youtube", label: "▶️ YouTube" },
  { value: "tiktok", label: "🎵 TikTok" },
  { value: "mastodon", label: "🐘 Mastodon" },
  { value: "bluesky", label: "🦋 Bluesky" },
];

// ===== The Pattern =====
export const SocialModule = recipe<SocialModuleInput, SocialModuleInput>(
  "SocialModule",
  ({ platform, handle, url }) => {
    const displayText = computed(() => {
      const opt = PLATFORM_OPTIONS.find((o) => o.value === platform);
      return handle ? `${opt?.label || platform}: @${handle}` : "Not set";
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Social: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Platform
            </label>
            <ct-select $value={platform} items={PLATFORM_OPTIONS} />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Handle</label>
            <ct-input $value={handle} placeholder="@username" />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Profile URL
            </label>
            <ct-input type="url" $value={url} placeholder="https://..." />
          </ct-vstack>
        </ct-vstack>
      ),
      platform,
      handle,
      url,
    };
  },
);

export default SocialModule;
