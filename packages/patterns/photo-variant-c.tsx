/// <cts-enable />
/**
 * Photo Variant C - ImageData type but NO lift() calls (CT-1148 bisection)
 */
import { type Default, ImageData, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-c",
  label: "Photo C",
  icon: "📷",
};

export interface PhotoVariantCInput {
  image: Default<ImageData | null, null>;
  label: Default<string, "">;
}

// Explicit output to prevent VNode inference
interface PhotoVariantCOutput {
  [NAME]: unknown;
  [UI]: unknown;
  image: ImageData | null;
  label: string;
}

export const PhotoVariantCModule = recipe<PhotoVariantCInput, PhotoVariantCOutput>(
  "PhotoVariantCModule",
  ({ image, label }) => {
    // NO lift() calls - just pass through
    return {
      [NAME]: "Photo C",
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <span>Image: {image ? "yes" : "no"}</span>
          <ct-input $value={label} placeholder="Label..." />
        </ct-vstack>
      ),
      image,
      label,
    };
  },
);

export default PhotoVariantCModule;
