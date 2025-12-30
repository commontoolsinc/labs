/// <cts-enable />
/**
 * Photo Variant H - Conditional Cell init but with explicit type cast (CT-1148)
 */
import { Cell, type Default, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-h",
  label: "Photo H",
  icon: "📷",
};

export interface PhotoVariantHInput {
  imageUrl: Default<string, "">;
  label: Default<string, "">;
}

interface PhotoVariantHOutput {
  [NAME]: unknown;
  [UI]: unknown;
  imageUrl: string;
  label: string;
}

export const PhotoVariantHModule = recipe<PhotoVariantHInput, PhotoVariantHOutput>(
  "PhotoVariantHModule",
  ({ imageUrl, label }) => {
    // Type-cast to break inference chain
    const urlValue = imageUrl as string;
    const urls = Cell.of<string[]>(urlValue ? [urlValue] : []);

    const syncedUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0 ? arr[0] : "";
    })({ arr: urls });

    return {
      [NAME]: "Photo H",
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

export default PhotoVariantHModule;
