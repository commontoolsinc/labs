/// <cts-enable />
/**
 * Photo Minimal - Stripped down version for OOM bisection (CT-1148)
 *
 * Variant A: Minimal - just a string value, no ImageData, no ifElse, no settingsUI
 */
import { type Default, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

export const MODULE_METADATA: ModuleMetadata = {
  type: "photo-minimal",
  label: "Photo Minimal",
  icon: "📷",
};

export interface PhotoMinimalInput {
  label: Default<string, "">;
}

export const PhotoMinimalModule = recipe<PhotoMinimalInput, PhotoMinimalInput>(
  "PhotoMinimalModule",
  ({ label }) => ({
    [NAME]: "Photo Minimal",
    [UI]: (
      <ct-vstack style={{ gap: "12px" }}>
        <ct-input $value={label} placeholder="Label..." />
      </ct-vstack>
    ),
    label,
  }),
);

export default PhotoMinimalModule;
