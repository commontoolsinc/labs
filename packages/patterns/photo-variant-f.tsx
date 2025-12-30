/// <cts-enable />
/**
 * Photo Variant F - Two lift() calls (CT-1148 bisection)
 */
import { Cell, type Default, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-f",
  label: "Photo F",
  icon: "📷",
};

export interface PhotoVariantFInput {
  label: Default<string, "">;
}

interface PhotoVariantFOutput {
  [NAME]: unknown;
  [UI]: unknown;
  label: string;
}

export const PhotoVariantFModule = recipe<PhotoVariantFInput, PhotoVariantFOutput>(
  "PhotoVariantFModule",
  ({ label }) => {
    const urls = Cell.of<string[]>([]);

    // TWO lift calls
    const syncedUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0 ? arr[0] : "";
    })({ arr: urls });

    const hasUrl = lift(({ arr }: { arr: string[] }) => {
      return arr && arr.length > 0;
    })({ arr: urls });

    return {
      [NAME]: "Photo F",
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <span>URL: {syncedUrl}, has: {hasUrl ? "yes" : "no"}</span>
          <ct-input $value={label} placeholder="Label..." />
        </ct-vstack>
      ),
      label,
    };
  },
);

export default PhotoVariantFModule;
