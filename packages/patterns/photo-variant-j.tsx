/// <cts-enable />
/**
 * Photo Variant J - Conditional Cell init with LOCAL variable (CT-1148)
 * Tests whether it's specifically input parameters or any conditional
 */
import { Cell, type Default, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-j",
  label: "Photo J",
  icon: "📷",
};

export interface PhotoVariantJInput {
  label: Default<string, "">;
}

interface PhotoVariantJOutput {
  [NAME]: unknown;
  [UI]: unknown;
  label: string;
}

export const PhotoVariantJModule = recipe<PhotoVariantJInput, PhotoVariantJOutput>(
  "PhotoVariantJModule",
  ({ label }) => {
    // Local constant - not from input
    const localUrl = "http://example.com/image.jpg";

    // Conditional Cell init with LOCAL variable (not input)
    const urls = Cell.of<string[]>(localUrl ? [localUrl] : []);

    const syncedUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0 ? arr[0] : "";
    })({ arr: urls });

    return {
      [NAME]: "Photo J",
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <span>URL: {syncedUrl}</span>
          <ct-input $value={label} placeholder="Label..." />
        </ct-vstack>
      ),
      label,
    };
  },
);

export default PhotoVariantJModule;
