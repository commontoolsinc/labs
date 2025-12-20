/// <cts-enable />
/**
 * Gift Preferences Module - Sub-charm for gift giving preferences
 */
import { Cell, computed, type Default, handler, NAME, recipe, UI } from "commontools";

export interface GiftPrefsModuleInput {
  giftTier: Default<string, "">;
  favorites: Default<string[], []>;
  avoid: Default<string[], []>;
}

const TIER_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "always", label: "🎁 Always (exchange gifts)" },
  { value: "occasions", label: "🎂 Occasions only" },
  { value: "reciprocal", label: "↔️ Reciprocal (if they give)" },
  { value: "none", label: "⛔ None (no gift exchange)" },
];

// Handler to add a favorite
const addFavorite = handler<
  unknown,
  { favorites: Cell<string[]>; favoriteInput: Cell<string> }
>((_event, { favorites, favoriteInput }) => {
  const newItem = favoriteInput.get().trim();
  if (!newItem) return;
  const current = favorites.get() || [];
  if (!current.includes(newItem)) {
    favorites.set([...current, newItem]);
  }
  favoriteInput.set("");
});

// Handler to remove a favorite by index
const removeFavorite = handler<
  unknown,
  { favorites: Cell<string[]>; index: number }
>((_event, { favorites, index }) => {
  favorites.set((favorites.get() || []).toSpliced(index, 1));
});

// Handler to add an avoid item
const addAvoid = handler<
  unknown,
  { avoid: Cell<string[]>; avoidInput: Cell<string> }
>((_event, { avoid, avoidInput }) => {
  const newItem = avoidInput.get().trim();
  if (!newItem) return;
  const current = avoid.get() || [];
  if (!current.includes(newItem)) {
    avoid.set([...current, newItem]);
  }
  avoidInput.set("");
});

// Handler to remove an avoid item by index
const removeAvoid = handler<
  unknown,
  { avoid: Cell<string[]>; index: number }
>((_event, { avoid, index }) => {
  avoid.set((avoid.get() || []).toSpliced(index, 1));
});

export const GiftPrefsModule = recipe<GiftPrefsModuleInput, GiftPrefsModuleInput>(
  "GiftPrefsModule",
  ({ giftTier, favorites, avoid }) => {
    const favoriteInput = Cell.of<string>("");
    const avoidInput = Cell.of<string>("");

    const displayText = computed(() => {
      const opt = TIER_OPTIONS.find((o) => o.value === giftTier);
      return opt?.label || "Not set";
    });

    return {
      [NAME]: computed(() => `🎁 Gift Prefs: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "16px" }}>
          {/* Gift tier */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Gift Giving Tier
            </label>
            <ct-select $value={giftTier} items={TIER_OPTIONS} />
          </ct-vstack>

          {/* Favorites */}
          <ct-vstack style={{ gap: "8px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Favorites / Likes
            </label>
            <ct-hstack style={{ gap: "8px" }}>
              <ct-input
                $value={favoriteInput}
                placeholder="Add favorite..."
                style={{ flex: "1" }}
              />
              <ct-button onClick={addFavorite({ favorites, favoriteInput })}>
                +
              </ct-button>
            </ct-hstack>
            <ct-hstack style={{ gap: "6px", flexWrap: "wrap" }}>
              {favorites.map((item: string, index: number) => (
                <span
                  key={index}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    background: "#dcfce7",
                    borderRadius: "12px",
                    padding: "4px 10px",
                    fontSize: "13px",
                    color: "#166534",
                  }}
                >
                  {item}
                  <button
                    onClick={removeFavorite({ favorites, index })}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#166534",
                      padding: "0",
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </ct-hstack>
          </ct-vstack>

          {/* Avoid */}
          <ct-vstack style={{ gap: "8px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Avoid / Dislikes
            </label>
            <ct-hstack style={{ gap: "8px" }}>
              <ct-input
                $value={avoidInput}
                placeholder="Add item to avoid..."
                style={{ flex: "1" }}
              />
              <ct-button onClick={addAvoid({ avoid, avoidInput })}>+</ct-button>
            </ct-hstack>
            <ct-hstack style={{ gap: "6px", flexWrap: "wrap" }}>
              {avoid.map((item: string, index: number) => (
                <span
                  key={index}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    background: "#fee2e2",
                    borderRadius: "12px",
                    padding: "4px 10px",
                    fontSize: "13px",
                    color: "#991b1b",
                  }}
                >
                  {item}
                  <button
                    onClick={removeAvoid({ avoid, index })}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#991b1b",
                      padding: "0",
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </ct-hstack>
          </ct-vstack>
        </ct-vstack>
      ),
      giftTier,
      favorites,
      avoid,
    };
  }
);

export default GiftPrefsModule;
