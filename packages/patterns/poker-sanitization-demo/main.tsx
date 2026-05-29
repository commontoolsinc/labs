// Poker sanitization demo — idiomatic CFC, reducer + relabel-policy model.
//
// Companion to docs/proposals/cfc-game-sanitization-memo.md.
//
// CFC access is BINARY per (value, principal); "graded reveal" is NOT a new label dimension.
// "Bob sees the COUNT of Alice's hand, not the cards" is a REDUCER (a trusted transform,
// count = hand.length) whose output is its own Confidential cell, RELABELLED to a lower audience
// by a policy keyed to the reducer's identity. This demo shows three things, each labelled:
//
//   ENFORCED (real, idiomatic CFC):
//     - Each hand is a Confidential<Card[], [PokerHoleCards]> cell; a cf-cfc-render-boundary with
//       maxConfidentiality={[]} genuinely blocks it (the one mechanism the runtime enforces).
//     - The Showdown is a trusted-action declassification (the "identity reducer" relabel):
//       data-ui-* + TrustedActionWrite; folded hands are never declassified.
//     - The COUNT is its own Confidential cell behind its OWN boundary, released to the table by
//       its own trusted action — demonstrating "the reduced value is its own binary-access cell".
//     - cf-cfc-label shows the live labels.
//
//   SIMULATED (no runtime primitive exists; labelled as such in-UI):
//     - The reducer MINTING a `ReducedBy{count}` integrity atom and the relabel being GATED on it
//       (we drive the relabel from a trusted action instead).
//     - Per-recipient MATERIALIZATION: routing Alice the cards but Bob the count. This demo runs
//       in one trusted host and shows both on one screen; it does not route per reader.
//
//   OUT OF SCOPE: recombination (multiple reducers on one secret, §14.3.2) and unlinkability
//   (shuffles). Stated in-UI.

import {
  Cell,
  computed,
  type Confidential,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";

// ===========================================================================
// Domain types + confidential cells
// ===========================================================================

type Suit = "♠" | "♥" | "♦" | "♣";
type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";
type Card = { suit: Suit; rank: Rank };

// The atom on a hole-card hand. One shared atom is fine: each hand has its own render boundary,
// so we declassify per-hand by toggling each boundary's declassify list.
const POKER_HAND = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "PokerHoleCards",
  subject: "poker:hole-cards",
} as const;

// A SEPARATE atom for the DERIVED count value. This is the point: the reducer's output is its own
// labelled, binary-access cell — not a "lower level" of the hand's label.
const POKER_HAND_COUNT = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "PokerHandCount",
  subject: "poker:hand-count",
} as const;

type ConfHand = Confidential<Card[], readonly [typeof POKER_HAND]>;
type ConfCount = Confidential<number, readonly [typeof POKER_HAND_COUNT]>;

// Idiomatic confidential-cell creation (mirrors cfc-render-policy-demo): a lift whose RETURN type
// is the Confidential cell, built with Cell.for(id).set(...). This attaches the ifc.confidentiality
// label the render boundary reads.
const makeHand = lift<{ id: string; cards: Card[] }, Writable<ConfHand>>((input) =>
  Cell.for<ConfHand>(input.id).set(input.cards as ConfHand)
);
const makeCount = lift<{ id: string; n: number }, Writable<ConfCount>>((input) =>
  Cell.for<ConfCount>(input.id).set(input.n as ConfCount)
);

// ===========================================================================
// Module-scope helpers
// ===========================================================================

const PHASES = ["predeal", "preflop", "flop", "turn", "river", "showdown"];

// Two preset deals so "New game" visibly changes the table. The hands' SECRECY comes from the CFC
// render boundary, not from how cards are chosen, so fixed presets are fine.
const DEALS: { hands: Card[][]; community: Card[] }[] = [
  {
    hands: [
      [{ suit: "♠", rank: "A" }, { suit: "♥", rank: "A" }],
      [{ suit: "♦", rank: "K" }, { suit: "♣", rank: "K" }],
      [{ suit: "♥", rank: "7" }, { suit: "♦", rank: "2" }],
    ],
    community: [
      { suit: "♠", rank: "Q" }, { suit: "♦", rank: "J" }, { suit: "♣", rank: "10" },
      { suit: "♥", rank: "9" }, { suit: "♠", rank: "3" },
    ],
  },
  {
    hands: [
      [{ suit: "♥", rank: "10" }, { suit: "♥", rank: "6" }],
      [{ suit: "♠", rank: "6" }, { suit: "♥", rank: "9" }],
      [{ suit: "♣", rank: "Q" }, { suit: "♦", rank: "Q" }],
    ],
    community: [
      { suit: "♣", rank: "8" }, { suit: "♥", rank: "2" }, { suit: "♣", rank: "J" },
      { suit: "♦", rank: "4" }, { suit: "♣", rank: "A" },
    ],
  },
];

function suitColor(suit: Suit): string {
  return suit === "♥" || suit === "♦" ? "#dc2626" : "#0f172a";
}

// ---------------------------------------------------------------------------
// Visual styles
// ---------------------------------------------------------------------------

const CARD_BASE = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "40px",
  height: "56px",
  borderRadius: "7px",
  fontSize: "20px",
  fontWeight: "700",
  margin: "0 4px 0 0",
  padding: "0 4px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
};
const FACE_UP = { ...CARD_BASE, background: "#ffffff", border: "1px solid #cbd5e1" };
const LOCK_BOX = {
  display: "inline-flex",
  alignItems: "center",
  height: "56px",
  padding: "0 14px",
  borderRadius: "7px",
  background: "#fff7ed",
  color: "#9a3412",
  border: "1px dashed #fdba74",
  fontSize: "13px",
  fontWeight: "600",
};
const FOLDED_BOX = {
  ...LOCK_BOX,
  background: "#f1f5f9",
  color: "#64748b",
  border: "1px dashed #94a3b8",
  fontStyle: "italic",
};
const ROW = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px" };
const HAND_ROW = {
  display: "flex",
  alignItems: "center",
  gap: "14px",
  padding: "10px 12px",
  borderRadius: "10px",
  border: "1px solid #e2e8f0",
  marginBottom: "8px",
  flexWrap: "wrap",
};
const NAME_COL = { minWidth: "90px", fontWeight: "700", fontSize: "15px" };

// ENFORCED / SIMULATED / OUT OF SCOPE badge — replaces the retired reveal-level "pill".
type Badge = "ENFORCED" | "SIMULATED" | "OUT OF SCOPE";
const BADGE_STYLE: Record<Badge, { bg: string; fg: string }> = {
  "ENFORCED": { bg: "#dcfce7", fg: "#166534" },
  "SIMULATED": { bg: "#fef3c7", fg: "#92400e" },
  "OUT OF SCOPE": { bg: "#e5e7eb", fg: "#374151" },
};

function badge(kind: Badge) {
  const s = BADGE_STYLE[kind];
  return (
    <span
      style={{
        display: "inline-block",
        background: s.bg,
        color: s.fg,
        borderRadius: "999px",
        padding: "2px 8px",
        fontSize: "10px",
        fontWeight: "700",
        letterSpacing: "0.3px",
        whiteSpace: "nowrap",
      }}
    >
      {kind}
    </span>
  );
}

function cardChip(c: Card) {
  return (
    <span style={{ ...FACE_UP, color: suitColor(c.suit) }}>
      {c.rank}{c.suit}
    </span>
  );
}

// The ENFORCED hand: cards rendered INSIDE a render boundary. When `declassified` is false the
// boundary blocks the subtree (the runtime refuses to render a labelled cell); when true it
// permits it. `$value` is the confidential cell whose live label the boundary checks.
function handBoundary(
  confCell: Writable<ConfHand>,
  cardsCell: Writable<Card[]>,
  declassified: boolean,
) {
  return (
    <cf-cfc-render-boundary
      maxConfidentiality={[]}
      declassifyConfidentiality={declassified ? [POKER_HAND] : []}
      $value={confCell}
    >
      <div style={ROW}>{cardsCell.get().map(cardChip)}</div>
    </cf-cfc-render-boundary>
  );
}

// The DERIVED count value behind its OWN boundary, with its OWN atom. Blocked until the relabel
// (trusted "Release count" action) fires.
function countBoundary(
  confCell: Writable<ConfCount>,
  countVal: number,
  released: boolean,
) {
  return (
    <cf-cfc-render-boundary
      maxConfidentiality={[]}
      declassifyConfidentiality={released ? [POKER_HAND_COUNT] : []}
      $value={confCell}
    >
      <span style={{ fontWeight: "700", fontSize: "16px" }}>{countVal} cards</span>
    </cf-cfc-render-boundary>
  );
}

// A labelled stage box in the reducer pipeline.
function stageBox(title: string, body: unknown, kind: Badge) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        padding: "10px",
        minWidth: "150px",
        background: "#ffffff",
      }}
    >
      <div style={{ fontSize: "12px", fontWeight: "700", marginBottom: "6px" }}>{title}</div>
      <div style={{ marginBottom: "6px", minHeight: "30px" }}>{body}</div>
      {badge(kind)}
    </div>
  );
}

function pipelineArrow(label: string) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        color: "#64748b",
        fontSize: "10px",
        padding: "0 2px",
        maxWidth: "90px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "22px", lineHeight: "1" }}>→</div>
      <div>{label}</div>
    </div>
  );
}

function noteFor(folded: boolean, shown: boolean) {
  if (folded) {
    return <div style={FOLDED_BOX}>folded — stays confidential at showdown</div>;
  }
  return shown ? "" : <div style={LOCK_BOX}>🔒 blocked by render boundary</div>;
}

function phaseStepper(current: string) {
  return (
    <div style={{ ...ROW, gap: "6px" }}>
      {PHASES.map((p) => (
        <span
          style={{
            padding: "4px 10px",
            borderRadius: "6px",
            fontSize: "12px",
            fontWeight: p === current ? "700" : "500",
            background: p === current ? "#6366f1" : "#f1f5f9",
            color: p === current ? "#ffffff" : "#64748b",
          }}
        >
          {p}
        </span>
      ))}
    </div>
  );
}

// ===========================================================================
// Handlers
// ===========================================================================

const SHOWDOWN_SURFACE = "TrustedShowdownSurface";
const SHOWDOWN_ACTION = "TrustedShowdownReveal";
const COUNT_SURFACE = "TrustedCountReducerSurface";
const COUNT_ACTION = "TrustedReleaseCount";

type GameState = {
  dealIndex: Writable<number>;
  alice: Writable<Card[]>;
  bob: Writable<Card[]>;
  charlie: Writable<Card[]>;
  community: Writable<Card[]>;
  board: Writable<Card[]>;
  aliceFolded: Writable<boolean>;
  bobFolded: Writable<boolean>;
  charlieFolded: Writable<boolean>;
  revealed: Writable<boolean>;
  countReleased: Writable<boolean>;
  phase: Writable<string>;
};

const newGame = handler<unknown, GameState>((_, s) => {
  const next = (s.dealIndex.get() + 1) % DEALS.length;
  const deal = DEALS[next];
  s.dealIndex.set(next);
  s.alice.set(deal.hands[0]);
  s.bob.set(deal.hands[1]);
  s.charlie.set(deal.hands[2]);
  s.community.set(deal.community);
  s.board.set([]);
  s.aliceFolded.set(false);
  s.bobFolded.set(false);
  s.charlieFolded.set(false);
  s.revealed.set(false); // re-conceal: hands go back behind the render boundary
  s.countReleased.set(false);
  s.phase.set("preflop");
});

type BoardState = {
  community: Writable<Card[]>;
  board: Writable<Card[]>;
  phase: Writable<string>;
  count: number;
  nextPhase: string;
};

const dealStreet = handler<unknown, BoardState>((_, s) => {
  s.board.set(s.community.get().slice(0, s.count));
  s.phase.set(s.nextPhase);
});

const foldPlayer = handler<unknown, { folded: Writable<boolean> }>((_, s) => {
  s.folded.set(true);
});

// Generic trusted relabel: flips the boolean that drives a render boundary's declassify list.
// Used for BOTH the showdown (hands) and the count release — each from its own trusted surface.
const setBool = handler<unknown, { cell: Writable<boolean>; next: boolean }>(
  (_, s) => {
    s.cell.set(s.next);
  },
);

// ===========================================================================
// Pattern
// ===========================================================================

type PokerOutput = {
  [NAME]: string;
  [UI]: unknown;
  revealed: TrustedActionWrite<
    boolean,
    typeof setBool,
    typeof SHOWDOWN_ACTION,
    typeof SHOWDOWN_SURFACE
  >;
  countReleased: TrustedActionWrite<
    boolean,
    typeof setBool,
    typeof COUNT_ACTION,
    typeof COUNT_SURFACE
  >;
  reveal: Stream<unknown>;
  releaseCount: Stream<unknown>;
};

export default pattern<unknown, PokerOutput>(() => {
  const dealIndex = new Writable<number>(0);
  const alice = new Writable<Card[]>(DEALS[0].hands[0]);
  const bob = new Writable<Card[]>(DEALS[0].hands[1]);
  const charlie = new Writable<Card[]>(DEALS[0].hands[2]);
  const community = new Writable<Card[]>(DEALS[0].community);
  const board = new Writable<Card[]>([]);
  const aliceFolded = new Writable<boolean>(false);
  const bobFolded = new Writable<boolean>(false);
  const charlieFolded = new Writable<boolean>(false);
  const revealed = new Writable<boolean>(false);
  const countReleased = new Writable<boolean>(false);
  const phase = new Writable<string>("predeal");

  // Confidential views of the three hands (real ifc.confidentiality labels).
  const aliceConf: Writable<ConfHand> = makeHand({ id: "poker-hand-alice", cards: alice }) as never;
  const bobConf: Writable<ConfHand> = makeHand({ id: "poker-hand-bob", cards: bob }) as never;
  const charlieConf: Writable<ConfHand> = makeHand({ id: "poker-hand-charlie", cards: charlie }) as never;

  // THE REDUCER: count = hand.length. A plain transform. In the CFC model its output inherits the
  // hand's confidentiality and mints a resolution-reduction integrity atom (ReducedBy{count});
  // here we model the count as its own Confidential cell with its own atom. The integrity-minting
  // and integrity-GATING are simulated; the second confidential cell + its boundary are real.
  const aliceCount = computed(() => alice.get().length);
  const aliceCountConf: Writable<ConfCount> = makeCount({ id: "poker-count-alice", n: aliceCount }) as never;

  const game: GameState = {
    dealIndex, alice, bob, charlie, community, board,
    aliceFolded, bobFolded, charlieFolded, revealed, countReleased, phase,
  };

  const start = newGame(game);
  const flop = dealStreet({ community, board, phase, count: 3, nextPhase: "flop" });
  const turn = dealStreet({ community, board, phase, count: 4, nextPhase: "turn" });
  const river = dealStreet({ community, board, phase, count: 5, nextPhase: "river" });
  const foldAlice = foldPlayer({ folded: aliceFolded });
  const foldBob = foldPlayer({ folded: bobFolded });
  const foldCharlie = foldPlayer({ folded: charlieFolded });
  const reveal = setBool({ cell: revealed, next: true });
  const conceal = setBool({ cell: revealed, next: false });
  const releaseCount = setBool({ cell: countReleased, next: true });
  const hideCount = setBool({ cell: countReleased, next: false });

  // Each hand's render boundary, rebuilt when the deal changes or the showdown flips. Folded
  // hands are never declassified — they stay behind the boundary even at showdown.
  const aliceCell = computed(() => {
    dealIndex.get();
    return handBoundary(aliceConf, alice, revealed.get() && !aliceFolded.get());
  });
  const bobCell = computed(() => {
    dealIndex.get();
    return handBoundary(bobConf, bob, revealed.get() && !bobFolded.get());
  });
  const charlieCell = computed(() => {
    dealIndex.get();
    return handBoundary(charlieConf, charlie, revealed.get() && !charlieFolded.get());
  });

  const aliceNote = computed(() => noteFor(aliceFolded.get(), revealed.get()));
  const bobNote = computed(() => noteFor(bobFolded.get(), revealed.get()));
  const charlieNote = computed(() => noteFor(charlieFolded.get(), revealed.get()));

  // The reducer pipeline's stage 3 (the count cell) + its blocked/released note.
  const countCell = computed(() => {
    dealIndex.get();
    return countBoundary(aliceCountConf, alice.get().length, countReleased.get());
  });
  const countNote = computed(() =>
    countReleased.get() ? "" : <span style={{ fontSize: "11px", color: "#9a3412" }}>🔒 blocked</span>
  );
  const countStatus = computed(() =>
    countReleased.get()
      ? "Released: the table now sees the count (a separate labelled value)."
      : "The count cell is confidential until the trusted relabel fires."
  );

  const stepper = computed(() => phaseStepper(phase.get()));
  const statusLine = computed(() =>
    revealed.get()
      ? "Showdown: hands declassified by the trusted reveal action."
      : "Hands are confidential — the render boundary is blocking them."
  );
  const boardDisplay = computed(() => {
    const b = (board.get() || []).filter((c) => c && c.rank);
    return b.length ? "" : "(no community cards yet — deal the flop)";
  });

  return {
    [NAME]: "Poker sanitization demo (idiomatic CFC)",
    [UI]: (
      <cf-screen title="Poker sanitization demo">
        <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "920px" }}>
          {/* Intro */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>🃏 Confidential hands + a reducer that releases the count</cf-heading>
              <cf-label>
                CFC access is <b>binary</b> per value. Each hand is a <b>Confidential</b> cell that a{" "}
                <b>cf-cfc-render-boundary</b> genuinely blocks. To let the table learn the{" "}
                <i>count</i> without the cards, we don't add a "reveal level" — we run a{" "}
                <b>reducer</b> (count = hand.length) into its <b>own</b> Confidential cell and{" "}
                <b>relabel</b> that to the table. Each section is tagged by what CFC enforces.
              </cf-label>
              <cf-label>{statusLine}</cf-label>
            </cf-vstack>
          </cf-card>

          {/* ENFORCED: confidential hands behind render boundaries */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-hstack gap="2" style={{ alignItems: "center" }}>
                <cf-heading level={3}>🔒 Hands (CFC render boundary)</cf-heading>
                {badge("ENFORCED")}
              </cf-hstack>
              <div style={HAND_ROW}>
                <div style={NAME_COL}>Alice</div>
                {aliceCell}
                {aliceNote}
              </div>
              <div style={HAND_ROW}>
                <div style={NAME_COL}>Bob</div>
                {bobCell}
                {bobNote}
              </div>
              <div style={HAND_ROW}>
                <div style={NAME_COL}>Charlie</div>
                {charlieCell}
                {charlieNote}
              </div>
            </cf-vstack>
          </cf-card>

          {/* REDUCER + RELABEL pipeline (a trusted surface) */}
          <cf-card
            id="trusted-count-surface"
            data-ui-surface={COUNT_SURFACE}
            data-ui-pattern={COUNT_SURFACE}
            data-ui-event-integrity={COUNT_SURFACE}
          >
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🔢 Reducer + relabel: release the count to the table</cf-heading>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                "Bob sees the count, not the cards" is a reducer whose output is its own
                binary-access cell, relabelled to the table by a trusted action — not a new label
                level. Read left → right:
              </cf-label>
              <div style={{ display: "flex", alignItems: "stretch", flexWrap: "wrap", gap: "4px" }}>
                {stageBox("Alice's secret hand", handBoundary(aliceConf, alice, false), "ENFORCED")}
                {pipelineArrow("reducer count = hand.length")}
                {stageBox(
                  "Reducer output",
                  <span style={{ fontSize: "12px", color: "#64748b" }}>
                    mints <code>ReducedBy&#123;count&#125;</code>; inherits the hand's label
                  </span>,
                  "SIMULATED",
                )}
                {pipelineArrow("relabel [Alice] → [table]")}
                {stageBox(
                  "Count cell (own atom)",
                  <span style={{ ...ROW, gap: "6px" }}>{countCell}{countNote}</span>,
                  "ENFORCED",
                )}
              </div>
              <cf-label style={{ fontSize: "12px", color: "#64748b" }}>{countStatus}</cf-label>
              <cf-hstack gap="2">
                <cf-button data-ui-action={COUNT_ACTION} onClick={releaseCount}>
                  Release count to table (trusted relabel)
                </cf-button>
                <cf-button onClick={hideCount}>Re-conceal count</cf-button>
              </cf-hstack>
              <div
                style={{
                  fontSize: "11px",
                  maxHeight: "90px",
                  overflow: "auto",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "8px",
                }}
              >
                <cf-cfc-label data-cfc-label-surface="alice-count" $value={aliceCountConf} />
              </div>
            </cf-vstack>
          </cf-card>

          {/* Live label on a hand */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🏷️ Live CFC label on a hand</cf-heading>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                The actual <code>ifc.confidentiality</code> the runtime attached to Alice's hand —
                what the render boundary reads to decide whether to show it.
              </cf-label>
              <div
                style={{
                  fontSize: "11px",
                  maxHeight: "100px",
                  overflow: "auto",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "8px",
                }}
              >
                <cf-cfc-label data-cfc-label-surface="alice" $value={aliceConf} />
              </div>
            </cf-vstack>
          </cf-card>

          {/* Public table */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🟢 Community cards (public — no label)</cf-heading>
              {stepper}
              <div style={ROW}>
                {board.map(cardChip)}
                <span style={{ color: "#64748b", fontSize: "13px" }}>{boardDisplay}</span>
              </div>
            </cf-vstack>
          </cf-card>

          {/* Controls */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Dealer controls</cf-heading>
              <cf-hstack gap="2">
                <cf-button onClick={start}>🆕 New game (re-deal + conceal)</cf-button>
                <cf-button onClick={flop}>Flop</cf-button>
                <cf-button onClick={turn}>Turn</cf-button>
                <cf-button onClick={river}>River</cf-button>
              </cf-hstack>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                Folding keeps a hand confidential through the showdown.
              </cf-label>
              <cf-hstack gap="2">
                <cf-button onClick={foldAlice}>Alice folds</cf-button>
                <cf-button onClick={foldBob}>Bob folds</cf-button>
                <cf-button onClick={foldCharlie}>Charlie folds</cf-button>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {/* Trusted showdown surface — the identity-reducer relabel */}
          <cf-card
            id="trusted-showdown-surface"
            data-ui-surface={SHOWDOWN_SURFACE}
            data-ui-pattern={SHOWDOWN_SURFACE}
            data-ui-event-integrity={SHOWDOWN_SURFACE}
          >
            <cf-vstack slot="content" gap="2">
              <cf-hstack gap="2" style={{ alignItems: "center" }}>
                <cf-heading level={3}>🏆 Trusted Showdown</cf-heading>
                {badge("ENFORCED")}
              </cf-hstack>
              <cf-label>
                The "identity reducer" relabel: a <b>trusted action</b> (data-ui-action +
                TrustedActionWrite) is the only thing that declassifies the full hands. Folded
                hands stay confidential.
              </cf-label>
              <cf-hstack gap="2">
                <cf-button data-ui-action={SHOWDOWN_ACTION} onClick={reveal}>
                  Reveal hands (showdown)
                </cf-button>
                <cf-button onClick={conceal}>Re-conceal</cf-button>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {/* The materialization gap */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-hstack gap="2" style={{ alignItems: "center" }}>
                <cf-heading level={3}>🧭 The materialization gap</cf-heading>
                {badge("SIMULATED")}
              </cf-hstack>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                Reducers + relabels give the right labels. The piece CFC does <b>not</b> have is a
                per-recipient <b>materialization</b> layer that runs the right reducer for each
                reader and routes them only their projection:
              </cf-label>
              <div
                style={{
                  border: "1px dashed #fdba74",
                  borderRadius: "10px",
                  padding: "10px",
                  background: "#fffbeb",
                  fontSize: "13px",
                }}
              >
                <div>reader <b>Alice</b> &nbsp;→&nbsp; her cards (satisfies <code>HoleCards(Alice)</code>)</div>
                <div>reader <b>Bob</b> &nbsp;&nbsp;&nbsp;→&nbsp; the count (satisfies <code>[table]</code>)</div>
                <div style={{ marginTop: "6px", color: "#9a3412" }}>
                  This routing is simulated: the demo runs in one trusted host and shows both
                  projections on one screen; it does not serve different bytes to different readers.
                </div>
              </div>
            </cf-vstack>
          </cf-card>

          {/* Honest limitation + out of scope */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>⚠️ Scope & honest limitations</cf-heading>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                The render boundary hides labelled content in a <b>trusted host</b>; it does not
                encrypt the cell, so real secrecy between mutually-distrusting players needs the
                per-recipient materialization above. Two properties are <b>out of scope</b> for CFC
                today: {badge("OUT OF SCOPE")} <b>recombination</b> (publishing several reducers of
                one secret can leak more than any one — §14.3.2) and <b>unlinkability</b> (a shuffle
                where you can't trace a card — a relational property CFC's lattice doesn't model).
              </cf-label>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
    revealed,
    countReleased,
    reveal,
    releaseCount,
  };
});
