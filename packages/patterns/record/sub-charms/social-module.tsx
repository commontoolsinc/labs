/// <cts-enable />
/**
 * Social Module - Sub-charm for social media profiles
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface SocialModuleInput {
  platform: Default<string, "">;
  handle: Default<string, "">;
  url: Default<string, "">;
}

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

export const SocialModule = recipe<SocialModuleInput, SocialModuleInput>(
  "SocialModule",
  ({ platform, handle, url }) => {
    const displayText = computed(() => {
      const opt = PLATFORM_OPTIONS.find((o) => o.value === platform);
      return handle ? `${opt?.label || platform}: @${handle}` : "Not set";
    });

    return {
      [NAME]: computed(() => `🔗 Social: ${displayText}`),
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
  }
);

export default SocialModule;
