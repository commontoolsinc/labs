/// <cts-enable />
import {
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

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

interface Card {
  suit: Suit;
  rank: Rank;
}

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
  pile1: Writable<Default<Card[], typeof defaultPile1>>;
  pile2: Writable<Default<Card[], typeof defaultPile2>>;
}

interface CardPilesOutput {
  [NAME]: string;
  [UI]: VNode;
  pile1: Card[];
  pile2: Card[];
  shuffle: Stream<void>;
}

function getSuitSymbol(suit: Suit): string {
  switch (suit) {
    case "hearts":
      return "\u2665";
    case "diamonds":
      return "\u2666";
    case "clubs":
      return "\u2663";
    case "spades":
      return "\u2660";
  }
}

function getSuitColor(suit: Suit): string {
  return suit === "hearts" || suit === "diamonds" ? "#dc2626" : "#1e293b";
}

const moveToPile1 = handler<
  { detail: { sourceCell: Writable<Card> } },
  { pile1: Writable<Card[]>; pile2: Writable<Card[]> }
>((event, { pile1, pile2 }) => {
  const sourceCard = event.detail?.sourceCell;
  if (!sourceCard) return;
  pile2.remove(sourceCard);
  pile1.push(sourceCard);
});

const moveToPile2 = handler<
  { detail: { sourceCell: Writable<Card> } },
  { pile1: Writable<Card[]>; pile2: Writable<Card[]> }
>((event, { pile1, pile2 }) => {
  const sourceCard = event.detail?.sourceCell;
  if (!sourceCard) return;
  pile1.remove(sourceCard);
  pile2.push(sourceCard);
});

const shufflePiles = handler<
  void,
  { pile1: Writable<Card[]>; pile2: Writable<Card[]> }
>((_, { pile1, pile2 }) => {
  const all = [...pile1.get(), ...pile2.get()];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const mid = Math.ceil(all.length / 2);
  pile1.set(all.slice(0, mid));
  pile2.set(all.slice(mid));
});

const cardStyle = {
  width: "70px",
  height: "100px",
  background: "white",
  border: "2px solid var(--ct-color-border, #e2e8f0)",
  borderRadius: "8px",
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  padding: "6px",
  boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
  cursor: "grab",
  userSelect: "none",
} as const;

const pileStyle = {
  minWidth: "120px",
  minHeight: "180px",
  border: "2px dashed var(--ct-color-border, #cbd5e1)",
  borderRadius: "12px",
  padding: "1rem",
  background: "var(--ct-color-bg-secondary, #f8fafc)",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
} as const;

const pileLabelStyle = {
  fontSize: "12px",
  color: "var(--ct-color-text-secondary, #64748b)",
  fontWeight: "600",
  marginBottom: "0.5rem",
} as const;

const cardListStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  alignItems: "center",
} as const;

export default pattern<CardPilesInput, CardPilesOutput>(({ pile1, pile2 }) => {
  const shuffle = shufflePiles({ pile1, pile2 });

  return {
    [NAME]: "Card Piles",
    [UI]: (
      <ct-screen>
        <div style={{ padding: "1rem" }}>
          <ct-button onClick={shuffle}>Shuffle</ct-button>
        </div>
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
            <div style={pileStyle}>
              <div style={pileLabelStyle}>PILE 1</div>
              <div style={cardListStyle}>
                {pile1.map((card) => (
                  <ct-drag-source $cell={card} type="card">
                    <div style={cardStyle}>
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
            <div style={pileStyle}>
              <div style={pileLabelStyle}>PILE 2</div>
              <div style={cardListStyle}>
                {pile2.map((card) => (
                  <ct-drag-source $cell={card} type="card">
                    <div style={cardStyle}>
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
      </ct-screen>
    ),
    pile1,
    pile2,
    shuffle,
  };
});
