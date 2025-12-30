/// <cts-enable />
/**
 * Photo Variant B - Add ImageData type (CT-1148 bisection)
 */
import { Cell, type Default, ImageData, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-b",
  label: "Photo B",
  icon: "📷",
};

export interface PhotoVariantBInput {
  image: Default<ImageData | null, null>;
  label: Default<string, "">;
}

// Explicit output to prevent VNode inference
interface PhotoVariantBOutput {
  [NAME]: unknown;
  [UI]: unknown;
  image: ImageData | null;
  label: string;
}

export const PhotoVariantBModule = recipe<PhotoVariantBInput, PhotoVariantBOutput>(
  "PhotoVariantBModule",
  ({ image: inputImage, label }) => {
    const images = Cell.of<ImageData[]>(inputImage ? [inputImage] : []);

    const syncedImage = lift(({ arr }: { arr: ImageData[] }) => {
      return arr && arr.length > 0 ? arr[0] : null;
    })({ arr: images });

    const imageUrl = lift(({ img }: { img: ImageData | null }) => {
      return img?.url || "";
    })({ img: syncedImage });

    return {
      [NAME]: "Photo B",
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <img src={imageUrl} alt={label || "Photo"} style={{ maxWidth: "100%" }} />
          <ct-input $value={label} placeholder="Label..." />
        </ct-vstack>
      ),
      image: syncedImage,
      label,
    };
  },
);

export default PhotoVariantBModule;
