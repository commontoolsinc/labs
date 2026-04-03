/// <cts-enable />
/**
 * Link Module - Pattern for web links/resources
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores URL, title, and description.
 */
import { computed, type Default, NAME, pattern, UI } from "commonfabric";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "link",
  label: "Link",
  icon: "\u{1F310}", // globe emoji
  schema: {
    url: { type: "string", format: "uri", description: "URL" },
    linkTitle: { type: "string", description: "Link title" },
    description: { type: "string", description: "Description" },
  },
  fieldMapping: ["url", "linkTitle", "description"],
};

// ===== Types =====
export interface LinkModuleInput {
  /** URL */
  url: Default<string, "">;
  /** Link title */
  linkTitle: Default<string, "">;
  /** Description */
  description: Default<string, "">;
}

// ===== The Pattern =====
export const LinkModule = pattern<LinkModuleInput, LinkModuleInput>(
  ({ url, linkTitle, description }) => {
    const displayText = computed(() => linkTitle || url || "Not set");

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Link: ${displayText}`),
      [UI]: (
        <cf-vstack style={{ gap: "12px" }}>
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>URL</label>
            <cf-input
              type="url"
              $value={url}
              placeholder="https://example.com"
            />
          </cf-vstack>
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Title</label>
            <cf-input $value={linkTitle} placeholder="Link title" />
          </cf-vstack>
          <cf-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Description
            </label>
            <cf-textarea
              $value={description}
              placeholder="Brief description..."
              rows={2}
            />
          </cf-vstack>
        </cf-vstack>
      ),
      url,
      linkTitle,
      description,
    };
  },
);

export default LinkModule;
