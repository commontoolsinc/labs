/// <cts-enable />
/**
 * Photo Module - Pattern for photo upload with optional label
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Supports uploading a single photo with an optional label.
 * Demonstrates the settingsUI pattern for module configuration.
 */
import {
  Cell,
  type Default,
  handler,
  ifElse,
  ImageData,
  lift,
  NAME,
  pattern,
  str,
  UI,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "photo",
  label: "Photo",
  icon: "\u{1F4F7}", // 📷 camera emoji
  schema: {
    photoUrl: { type: "string", description: "Photo data URL" },
    photoLabel: { type: "string", description: "Photo label/name" },
  },
  fieldMapping: ["photoUrl", "photoLabel"],
  allowMultiple: true,
  hasSettings: true,
};

// ===== Types =====
export interface PhotoModuleInput {
  /** The uploaded image data (null if no image) */
  image: Default<ImageData | null, null>;
  /** User-defined label for the photo */
  label: Default<string, "">;
}

// Output type with only data fields - prevents TypeScript OOM (CT-1143)
// by avoiding deep type inference on recursive VNode/RenderNode types.
// Extra fields like [UI], [NAME], and settingsUI are still returned but not type-checked.
interface PhotoModuleOutput {
  image: ImageData | null;
  label: string;
}

// ===== Handlers =====

// Handler to clear the photo
const clearPhoto = handler<
  unknown,
  { images: Cell<ImageData[]> }
>((_event, { images }) => {
  images.set([]);
});

// ===== The Pattern =====
export const PhotoModule = pattern<PhotoModuleInput, PhotoModuleOutput>(
  ({ image: inputImage, label }) => {
    // We use an array internally for ct-image-input compatibility
    // but the module only supports a single image
    // Initialize from input image if provided (for import/restore)
    const images = Cell.of<ImageData[]>(inputImage ? [inputImage] : []);

    // Sync image Cell with images array (first element)
    const syncedImage = lift(({ arr }: { arr: ImageData[] }) => {
      return arr && arr.length > 0 ? arr[0] : null;
    })({ arr: images });

    // Check if we have a photo - use lift for reactive boolean
    const hasPhoto = lift(({ arr }: { arr: ImageData[] }) => {
      return arr && arr.length > 0;
    })({ arr: images });

    // Display text for NAME
    const displayText = lift(
      ({ arr, photoLabel }: { arr: ImageData[]; photoLabel: string }) => {
        const hasImage = arr && arr.length > 0;
        if (photoLabel && hasImage) return photoLabel;
        if (hasImage) return "Photo uploaded";
        return "No photo";
      },
    )({ arr: images, photoLabel: label });

    // Get the image URL reactively
    const imageUrl = lift(({ img }: { img: ImageData | null }) => {
      return img?.url || "";
    })({ img: syncedImage });

    // Check if label is set
    const hasLabel = lift(({ l }: { l: string }) => !!l)({ l: label });

    return {
      [NAME]: str`${MODULE_METADATA.icon} ${displayText}`,
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          {ifElse(
            hasPhoto,
            // Photo is uploaded - show image with clear button
            <ct-vstack style={{ gap: "8px" }}>
              {/* Display the uploaded image */}
              <div
                style={{
                  position: "relative",
                  display: "inline-block",
                  maxWidth: "100%",
                }}
              >
                <img
                  src={imageUrl}
                  alt={label || "Uploaded photo"}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "300px",
                    borderRadius: "8px",
                    objectFit: "contain",
                  }}
                />
                {/* Clear button */}
                <button
                  type="button"
                  onClick={clearPhoto({ images })}
                  style={{
                    position: "absolute",
                    top: "8px",
                    right: "8px",
                    background: "rgba(0, 0, 0, 0.6)",
                    color: "white",
                    border: "none",
                    borderRadius: "50%",
                    width: "24px",
                    height: "24px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "14px",
                  }}
                  title="Clear photo"
                >
                  ✕
                </button>
              </div>
              {/* Label display (if set) */}
              {ifElse(
                hasLabel,
                <span
                  style={{
                    fontSize: "14px",
                    color: "#374151",
                    fontWeight: "500",
                  }}
                >
                  {label}
                </span>,
                null,
              )}
            </ct-vstack>,
            // No photo yet - show upload input
            <ct-image-input
              $images={images}
              maxImages={1}
              showPreview={false}
              style={{ width: "100%" }}
            />,
          )}
        </ct-vstack>
      ),
      // Settings UI - for configuring the label
      settingsUI: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Photo Label
            </label>
            <ct-input
              $value={label}
              placeholder="e.g., Profile Photo, Headshot..."
            />
          </ct-vstack>
        </ct-vstack>
      ),
      image: syncedImage,
      label,
    };
  },
);

export default PhotoModule;
