/// <cts-enable />
/**
 * Photo Variant E - Single lift() call only (CT-1148 bisection)
 */
import { Cell, type Default, lift, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-variant-e",
  label: "Photo E",
  icon: "📷",
};

export interface PhotoVariantEInput {
  label: Default<string, "">;
}

// Explicit output
interface PhotoVariantEOutput {
  [NAME]: unknown;
  [UI]: unknown;
  label: string;
  hasLabel: boolean;
}

export const PhotoVariantEModule = recipe<PhotoVariantEInput, PhotoVariantEOutput>(
  "PhotoVariantEModule",
  ({ label }) => {
    // Just ONE lift call
    const hasLabel = lift(({ l }: { l: string }) => !!l)({ l: label });

    return {
      [NAME]: "Photo E",
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <span>Has label: {hasLabel ? "yes" : "no"}</span>
          <ct-input $value={label} placeholder="Label..." />
        </ct-vstack>
      ),
      label,
      hasLabel,
    };
  },
);

export default PhotoVariantEModule;
