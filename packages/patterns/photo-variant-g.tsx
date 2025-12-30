/// <cts-enable />
/**
 * Photo Variant G - Two lift() calls + conditional Cell init (CT-1148 bisection)
 */
import { Cell, type Default, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-g",
  label: "Photo G",
  icon: "📷",
};

export interface PhotoVariantGInput {
  imageUrl: Default<string, "">;
  label: Default<string, "">;
}

interface PhotoVariantGOutput {
  [NAME]: unknown;
  [UI]: unknown;
  imageUrl: string;
  label: string;
}

export const PhotoVariantGModule = recipe<PhotoVariantGInput, PhotoVariantGOutput>(
  "PhotoVariantGModule",
  ({ imageUrl, label }) => {
    // Conditional Cell initialization (like the original)
    const urls = Cell.of<string[]>(imageUrl ? [imageUrl] : []);

    // TWO lift calls
    const syncedUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0 ? arr[0] : "";
    })({ arr: urls });

    const hasUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0;
    })({ arr: urls });

    return {
      [NAME]: "Photo G",
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

export default PhotoVariantGModule;
