/// <cts-enable />
import {
  computed,
  equals,
  NAME,
  pattern,
  SELF,
  UI,
  Writable,
} from "commontools";

type Piece = Writable<{ [NAME]?: string }>;

type Input = {
  pieces: Piece[];
};

export default pattern<Input>(({ pieces, [SELF]: self }) => {
  // Filter out self to prevent infinite recursion if this grid view
  // appears in the pieces list it's rendering
  const filtered = computed(() =>
    pieces.filter((piece: Piece) => !equals(piece, self))
  );

  return {
    [NAME]: "Grid View",
    [UI]: (
      <ct-grid columns="3" gap="4" padding="4">
        {filtered.map((piece: Piece) => (
          <div
            style={{
              border: "1px solid var(--ct-color-border, #e5e5e7)",
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "200px",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  transform: "scale(0.4)",
                  transformOrigin: "top left",
                  width: "250%",
                  height: "250%",
                  pointerEvents: "none",
                }}
              >
                <ct-render $cell={piece} />
              </div>
            </div>
            <div style={{ padding: "8px" }}>
              <ct-cell-link $cell={piece} />
            </div>
          </div>
        ))}
      </ct-grid>
    ),
  };
});
