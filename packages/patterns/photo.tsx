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
  computed,
  type Default,
  handler,
  ifElse,
  ImageData,
  NAME,
  recipe,
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

// ===== Handlers =====

// Handler to clear the photo
const clearPhoto = handler<
  unknown,
  { images: Cell<ImageData[]> }
>((_event, { images }) => {
  images.set([]);
});

// ===== The Pattern =====
export const PhotoModule = recipe<PhotoModuleInput, PhotoModuleInput>(
  "PhotoModule",
  ({ image: _image, label }) => {
    // We use an array internally for ct-image-input compatibility
    // but the module only supports a single image
    // Note: _image is the input but we manage state via images array
    const images = Cell.of<ImageData[]>([]);

    // Sync image Cell with images array (first element)
    // When images array changes, update the single image Cell
    const syncedImage = computed(() => {
      const arr = images.get() || [];
      return arr.length > 0 ? arr[0] : null;
    });

    // Check if we have a photo
    const hasPhoto = computed(() => {
      const arr = images.get() || [];
      return arr.length > 0;
    });

    // Display text for NAME
    const displayText = computed(() => {
      const photoLabel = label || "";
      const hasImage = hasPhoto.get();
      if (photoLabel && hasImage) return photoLabel;
      if (hasImage) return "Photo uploaded";
      return "No photo";
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} ${displayText}`),
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
                  src={computed(() => syncedImage.get()?.url || "")}
                  alt={computed(() => label || "Uploaded photo")}
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
                computed(() => !!label),
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
