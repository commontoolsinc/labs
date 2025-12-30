/// <cts-enable />
/**
 * Photo Variant D - lift() but with simpler type (string instead of ImageData)
 * CT-1148 bisection - testing if it's lift() specifically with ImageData
 */
import { Cell, type Default, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-d",
  label: "Photo D",
  icon: "📷",
};

export interface PhotoVariantDInput {
  imageUrl: Default<string, "">; // String instead of ImageData
  label: Default<string, "">;
}

// Explicit output
interface PhotoVariantDOutput {
  [NAME]: unknown;
  [UI]: unknown;
  imageUrl: string;
  label: string;
}

export const PhotoVariantDModule = recipe<PhotoVariantDInput, PhotoVariantDOutput>(
  "PhotoVariantDModule",
  ({ imageUrl, label }) => {
    // Use lift with string[] instead of ImageData[]
    const urls = Cell.of<string[]>(imageUrl ? [imageUrl] : []);

    const syncedUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0 ? arr[0] : "";
    })({ arr: urls });

    const hasUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0;
    })({ arr: urls });

    return {
      [NAME]: "Photo D",
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <img src={syncedUrl} alt={label || "Photo"} style={{ maxWidth: "100%" }} />
          <ct-input $value={label} placeholder="Label..." />
        </ct-vstack>
      ),
      imageUrl: syncedUrl,
      label,
    };
  },
);

export default PhotoVariantDModule;
