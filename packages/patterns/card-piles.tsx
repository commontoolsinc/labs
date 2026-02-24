/// <cts-enable />
import {
  computed,
  Default,
  handler,
  lift,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// Card suits and ranks
const SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;
const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;
type Suit = (typeof SUITS)[number];
type Rank = (typeof RANKS)[number];

// Card interface
interface Card {
  suit: Suit;
  rank: Rank;
}

// Generate unique random cards for defaults
const defaultPile1: Card[] = [
  { suit: "hearts", rank: "A" },
  { suit: "spades", rank: "K" },
  { suit: "diamonds", rank: "7" },
];

const defaultPile2: Card[] = [
  { suit: "clubs", rank: "Q" },
  { suit: "hearts", rank: "10" },
  { suit: "spades", rank: "3" },
];

interface CardPilesInput {
  pile1: Default<Card[], typeof defaultPile1>;
  pile2: Default<Card[], typeof defaultPile2>;
}

interface CardPilesOutput {
  pile1: Card[];
  pile2: Card[];
}

// Get suit symbol
const getSuitSymbol = lift((suit: Suit): string => {
  switch (suit) {
    case "hearts":
      return "♥";
    case "diamonds":
      return "♦";
    case "clubs":
      return "♣";
    case "spades":
      return "♠";
  }
});

// Get suit color
const getSuitColor = lift((suit: Suit): string => {
  return suit === "hearts" || suit === "diamonds" ? "#dc2626" : "#1e293b";
});

// Handler to move a card to pile 1
const moveToPile1 = handler<
  { detail: { sourceCell: Writable } },
  { pile1: Writable<Card[]>; pile2: Writable<Card[]> }
>((event, { pile1, pile2 }) => {
  const sourceCard = event.detail?.sourceCell?.get() as Card;
  if (!sourceCard) return;

  // Remove from pile2 if present
  const p2 = pile2.get();
  const idx2 = p2.findIndex(
    (c) => c.rank === sourceCard.rank && c.suit === sourceCard.suit,
  );
  if (idx2 >= 0) {
    pile2.set(p2.filter((_, i) => i !== idx2));
    pile1.push(sourceCard);
  }
});

// Handler to move a card to pile 2
const moveToPile2 = handler<
  { detail: { sourceCell: Writable } },
  { pile1: Writable<Card[]>; pile2: Writable<Card[]> }
>((event, { pile1, pile2 }) => {
  const sourceCard = event.detail?.sourceCell?.get() as Card;
  if (!sourceCard) return;

  // Remove from pile1 if present
  const p1 = pile1.get();
  const idx1 = p1.findIndex(
    (c) => c.rank === sourceCard.rank && c.suit === sourceCard.suit,
  );
  if (idx1 >= 0) {
    pile1.set(p1.filter((_, i) => i !== idx1));
    pile2.push(sourceCard);
  }
});

export default pattern<CardPilesInput, CardPilesOutput>(({ pile1, pile2 }) => {
  // Create computed versions to ensure reactivity
  const cards1 = computed(() => pile1);
  const cards2 = computed(() => pile2);

  return {
    [NAME]: "Card Piles",
    [UI]: (
      <div
        style={{
          display: "flex",
          gap: "2rem",
          padding: "1.5rem",
          flexWrap: "wrap",
          minHeight: "200px",
        }}
      >
        <ct-drop-zone
          accept="card,cell-link"
          onct-drop={moveToPile1({ pile1, pile2 })}
        >
          <div
            style={{
              minWidth: "120px",
              minHeight: "180px",
              border: "2px dashed #cbd5e1",
              borderRadius: "12px",
              padding: "1rem",
              background: "#f8fafc",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                fontSize: "12px",
                color: "#64748b",
                fontWeight: "600",
                marginBottom: "0.5rem",
              }}
            >
              PILE 1
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                alignItems: "center",
              }}
            >
              {cards1.map((card) => (
                <ct-drag-source $cell={card} type="card">
                  <div
                    style={{
                      width: "70px",
                      height: "100px",
                      background: "white",
                      border: "2px solid #e2e8f0",
                      borderRadius: "8px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      padding: "6px",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                      cursor: "grab",
                      userSelect: "none",
                    }}
                  >
                    <div
                      style={{
                        color: getSuitColor(card.suit),
                        fontSize: "14px",
                        fontWeight: "bold",
                      }}
                    >
                      {card.rank}
                      <span style={{ marginLeft: "2px" }}>
                        {getSuitSymbol(card.suit)}
                      </span>
                    </div>
                    <div
                      style={{
                        color: getSuitColor(card.suit),
                        fontSize: "28px",
                        textAlign: "center",
                        lineHeight: "1",
                      }}
                    >
                      {getSuitSymbol(card.suit)}
                    </div>
                    <div
                      style={{
                        color: getSuitColor(card.suit),
                        fontSize: "14px",
                        fontWeight: "bold",
                        textAlign: "right",
                        transform: "rotate(180deg)",
                      }}
                    >
                      {card.rank}
                      <span style={{ marginLeft: "2px" }}>
                        {getSuitSymbol(card.suit)}
                      </span>
                    </div>
                  </div>
                </ct-drag-source>
              ))}
            </div>
          </div>
        </ct-drop-zone>

        <ct-drop-zone
          accept="card,cell-link"
          onct-drop={moveToPile2({ pile1, pile2 })}
        >
          <div
            style={{
              minWidth: "120px",
              minHeight: "180px",
              border: "2px dashed #cbd5e1",
              borderRadius: "12px",
              padding: "1rem",
              background: "#f8fafc",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                fontSize: "12px",
                color: "#64748b",
                fontWeight: "600",
                marginBottom: "0.5rem",
              }}
            >
              PILE 2
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                alignItems: "center",
              }}
            >
              {cards2.map((card) => (
                <ct-drag-source $cell={card} type="card">
                  <div
                    style={{
                      width: "70px",
                      height: "100px",
                      background: "white",
                      border: "2px solid #e2e8f0",
                      borderRadius: "8px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      padding: "6px",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                      cursor: "grab",
                      userSelect: "none",
                    }}
                  >
                    <div
                      style={{
                        color: getSuitColor(card.suit),
                        fontSize: "14px",
                        fontWeight: "bold",
                      }}
                    >
                      {card.rank}
                      <span style={{ marginLeft: "2px" }}>
                        {getSuitSymbol(card.suit)}
                      </span>
                    </div>
                    <div
                      style={{
                        color: getSuitColor(card.suit),
                        fontSize: "28px",
                        textAlign: "center",
                        lineHeight: "1",
                      }}
                    >
                      {getSuitSymbol(card.suit)}
                    </div>
                    <div
                      style={{
                        color: getSuitColor(card.suit),
                        fontSize: "14px",
                        fontWeight: "bold",
                        textAlign: "right",
                        transform: "rotate(180deg)",
                      }}
                    >
                      {card.rank}
                      <span style={{ marginLeft: "2px" }}>
                        {getSuitSymbol(card.suit)}
                      </span>
                    </div>
                  </div>
                </ct-drag-source>
              ))}
            </div>
          </div>
        </ct-drop-zone>
      </div>
    ),
    pile1,
    pile2,
  };
});
