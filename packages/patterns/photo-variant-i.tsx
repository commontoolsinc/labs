/// <cts-enable />
/**
 * Photo Variant I - Separate variable for conditional, no input in Cell.of (CT-1148)
 */
import { Cell, type Default, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-i",
  label: "Photo I",
  icon: "📷",
};

export interface PhotoVariantIInput {
  imageUrl: Default<string, "">;
  label: Default<string, "">;
}

interface PhotoVariantIOutput {
  [NAME]: unknown;
  [UI]: unknown;
  imageUrl: string;
  label: string;
}

// Helper function to compute initial array - moves complexity outside recipe
function getInitialUrls(url: string): string[] {
  return url ? [url] : [];
}

export const PhotoVariantIModule = recipe<PhotoVariantIInput, PhotoVariantIOutput>(
  "PhotoVariantIModule",
  ({ imageUrl, label }) => {
    // Empty Cell - no input parameter reference
    const urls = Cell.of<string[]>([]);

    // Use lift to sync the input to the Cell
    const syncedUrl = lift(({ url, arr }: { url: string; arr: string[] }) => {
      // If array is empty and we have a URL, this is initialization
      // Return the input URL
      return url || (arr.length > 0 ? arr[0] : "");
    })({ url: imageUrl, arr: urls });

    return {
      [NAME]: "Photo I",
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <span>URL: {syncedUrl}</span>
          <ct-input $value={label} placeholder="Label..." />
        </ct-vstack>
      ),
      imageUrl: syncedUrl,
      label,
    };
  },
);

export default PhotoVariantIModule;
