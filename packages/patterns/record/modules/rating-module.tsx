/// <cts-enable />
/**
 * Rating Module - Sub-charm for 1-5 star ratings
 */
import { Cell, computed, type Default, handler, NAME, recipe, UI } from "commontools";

export interface RatingModuleInput {
  rating: Default<number | null, null>;
}

// Handler for rating selection - value is passed in context
const setRating = handler<
  unknown,
  { rating: Cell<number | null>; value: number }
>((_event, { rating, value }) => {
  const current = rating.get();
  // Toggle off if clicking the same rating
  rating.set(current === value ? null : value);
});

export const RatingModule = recipe<RatingModuleInput, RatingModuleInput>(
  "RatingModule",
  ({ rating }) => {
    const displayText = computed(() => rating ? `${rating}/5` : "Not rated");

    return {
      [NAME]: computed(() => `⭐ Rating: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "8px" }}>
          <ct-hstack style={{ gap: "4px", justifyContent: "center" }}>
            {[1, 2, 3, 4, 5].map((value, index) => (
              <button
                key={index}
                onClick={setRating({ rating, value })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "24px",
                  padding: "4px",
                  opacity: (rating ?? 0) >= value ? "1" : "0.3",
                  transition: "opacity 0.1s, transform 0.1s",
                }}
                title={`Rate ${value} star${value > 1 ? "s" : ""}`}
              >
                ⭐
              </button>
            ))}
          </ct-hstack>
          <div style={{ textAlign: "center", color: "#6b7280", fontSize: "14px" }}>
            {displayText}
          </div>
        </ct-vstack>
      ),
      rating,
    };
  }
);

export default RatingModule;
