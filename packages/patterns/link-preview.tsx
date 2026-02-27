/// <cts-enable />
import { computed, type Default, NAME, pattern, UI } from "commontools";

interface LinkPreviewInput {
  url: Default<string, "https://github.com">;
}

export const LinkPreview = pattern<LinkPreviewInput, LinkPreviewInput>(
  ({ url }) => {
    return {
      [NAME]: computed(() => `Link Preview: ${url}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-input
            $value={url}
            placeholder="Enter a URL..."
          />
          <ct-link-preview url={url} />
        </ct-vstack>
      ),
      url,
    };
  },
);

export default LinkPreview;
