/// <cts-enable />
/**
 * Link Module - Sub-charm for web links/resources
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface LinkModuleInput {
  url: Default<string, "">;
  linkTitle: Default<string, "">;
  description: Default<string, "">;
}

export const LinkModule = recipe<LinkModuleInput, LinkModuleInput>(
  "LinkModule",
  ({ url, linkTitle, description }) => {
    const displayText = computed(() => linkTitle || url || "Not set");

    return {
      [NAME]: computed(() => `🌐 Link: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>URL</label>
            <ct-input type="url" $value={url} placeholder="https://example.com" />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Title</label>
            <ct-input $value={linkTitle} placeholder="Link title" />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Description
            </label>
            <ct-textarea
              $value={description}
              placeholder="Brief description..."
              rows={2}
            />
          </ct-vstack>
        </ct-vstack>
      ),
      url,
      linkTitle,
      description,
    };
  }
);

export default LinkModule;
