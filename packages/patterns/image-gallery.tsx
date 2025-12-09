/// <cts-enable />
import { Cell, cell, ImageData, lift, NAME, recipe, UI } from "commontools";

interface Input {
  images: Cell<ImageData[]>;
}

// Sorting function lifted for reactivity
const sortByTimestamp = lift((imgs: ImageData[]) =>
  [...imgs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
);

export default recipe<Input>("Image Gallery", ({ images }) => {
  // Sort images by timestamp (newest first)
  const sortedImages = sortByTimestamp(images);

  return {
    [NAME]: "Image Gallery",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "600px", margin: "0 auto" }}>
        <h2 style={{ marginBottom: "1rem" }}>Image Gallery</h2>

        <ct-image-input
          multiple
          maxImages={50}
          showPreview={false}
          buttonText="Add Photos"
          $images={images}
        />

        <div
          style={{
            marginTop: "1rem",
            maxHeight: "70vh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          {sortedImages.map((img) => (
            <div
              key={img.id}
              style={{
                borderRadius: "8px",
                overflow: "hidden",
                backgroundColor: "#f5f5f5",
                flexShrink: 0,
              }}
            >
              <img
                src={img.url}
                alt={img.name}
                style={{
                  width: "100%",
                  height: "auto",
                  display: "block",
                }}
              />
              <div
                style={{
                  padding: "0.5rem",
                  fontSize: "0.85rem",
                  color: "#666",
                }}
              >
                {img.name}
                {img.timestamp && (
                  <span style={{ marginLeft: "0.5rem" }}>
                    {new Date(img.timestamp).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    images,
  };
});
