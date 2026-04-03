/// <cts-enable />
/**
 * Social Module - Pattern for social media profiles
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores social platform, handle, and profile URL.
 */
import { computed, type Default, NAME, pattern, UI } from "commonfabric";
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
    profileUrl: { type: "string", format: "uri", description: "Profile URL" },
  },
  fieldMapping: ["platform", "handle", "profileUrl"],
};

// ===== Types =====

/** Supported social platforms */
type SocialPlatform =
  | "twitter"
  | "linkedin"
  | "github"
  | "instagram"
  | "facebook"
  | "youtube"
  | "tiktok"
  | "mastodon"
  | "bluesky";

export interface SocialModuleInput {
  /** Social platform (normalize: Insta→instagram, X→twitter) */
  platform: Default<SocialPlatform | "", "">;
  /** Username/handle without @ prefix */
  handle: Default<string, "">;
  /** Profile URL */
  profileUrl: Default<string, "">;
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
export const SocialModule = pattern<SocialModuleInput, SocialModuleInput>(
  ({ platform, handle, profileUrl }) => {
    const displayText = computed(() => {
      const opt = PLATFORM_OPTIONS.find((o) => o.value === platform);
      return handle ? `${opt?.label || platform}: @${handle}` : "Not set";
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Social: ${displayText}`),
      [UI]: (
        <cf-vstack style={{ gap: "12px" }}>
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Platform
            </label>
            <cf-select $value={platform} items={PLATFORM_OPTIONS} />
          </cf-vstack>
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Handle</label>
            <cf-input $value={handle} placeholder="@username" />
          </cf-vstack>
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Profile URL
            </label>
            <cf-input
              type="url"
              $value={profileUrl}
              placeholder="https://..."
            />
          </cf-vstack>
        </cf-vstack>
      ),
      platform,
      handle,
      profileUrl,
    };
  },
);

export default SocialModule;
