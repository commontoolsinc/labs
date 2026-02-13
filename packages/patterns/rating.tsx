/// <cts-enable />
/**
 * Rating Module - Pattern for 1-5 star ratings
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides interactive star rating with toggle-off support.
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "rating",
  label: "Rating",
  icon: "\u{2B50}", // star emoji
  schema: {
    rating: {
      type: "number",
      minimum: 1,
      maximum: 5,
      description: "Rating 1-5",
    },
  },
  fieldMapping: ["rating"],
};

// ===== Types =====
export interface RatingModuleInput {
  /** Rating from 1-5 stars */
  rating: Writable<Default<number | null, null>>;
}

// ===== Handlers =====

// Handler for rating selection - value is passed in context
const setRating = handler<
  unknown,
  { rating: Writable<number | null>; value: number }
>((_event, { rating, value }) => {
  const current = rating.get();
  // Toggle off if clicking the same rating
  rating.set(current === value ? null : value);
});

// ===== The Pattern =====
export const RatingModule = pattern<RatingModuleInput, RatingModuleInput>(
  "RatingModule",
  ({ rating }) => {
    const displayText = computed(() =>
      rating.get() ? `${rating.get()}/5` : "Not rated"
    );

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Rating: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "8px" }}>
          <ct-hstack style={{ gap: "4px", justifyContent: "center" }}>
            {[1, 2, 3, 4, 5].map((value, index) => (
              <button
                type="button"
                key={index}
                onClick={setRating({ rating, value })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "24px",
                  padding: "4px",
                  opacity: (rating.get() ?? 0) >= value ? "1" : "0.3",
                  transition: "opacity 0.1s, transform 0.1s",
                }}
                title={`Rate ${value} star${value > 1 ? "s" : ""}`}
              >
                {MODULE_METADATA.icon}
              </button>
            ))}
          </ct-hstack>
          <div
            style={{ textAlign: "center", color: "#6b7280", fontSize: "14px" }}
          >
            {displayText}
          </div>
        </ct-vstack>
      ),
      rating,
    };
  },
);

export default RatingModule;
