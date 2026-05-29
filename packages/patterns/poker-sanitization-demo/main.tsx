// Poker sanitization demo — idiomatic CFC.
//
// Companion to docs/proposals/cfc-game-sanitization-memo.md.
//
// This version splits cleanly into what CFC ENFORCES today vs what the memo PROPOSES:
//
//   ENFORCED (real, idiomatic CFC):
//     - Each hand is a Confidential<Card[], [PokerHoleCards]> cell (real ifc.confidentiality).
//     - A cf-cfc-render-boundary with maxConfidentiality={[]} genuinely blocks every hand from
//       rendering — this is the one CFC mechanism the runtime actually enforces.
//     - The Showdown is a real integrity-gated declassification: a trusted-action surface
//       (data-ui-* + TrustedActionWrite) flips a cell that drives declassifyConfidentiality, so
//       ONLY that trusted gesture can reveal hands. Folded hands are never declassified.
//     - cf-cfc-label shows each hand's live label.
//
//   PROPOSED (memo §4 — NOT enforced today, shown as a clearly-labelled illustration):
//     - The graded reveal lattice (existence / cardinality / order) and per-reader projection.
//       CFC today is binary: a label is either blocked or declassified. "Bob sees the count but
//       not the cards" is the extension this memo argues for.
//
// Honest limitation (stated in-UI): the render boundary hides labelled content in a TRUSTED
// HOST; it does not encrypt the cell. A malicious runtime could still read the bytes. Real
// secrecy between mutually-distrusting players needs the per-reader materialization of §4.4.

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
// Domain types
// ===========================================================================

type Suit = "♠" | "♥" | "♦" | "♣";
type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";
type Card = { suit: Suit; rank: Rank };

// The CFC confidentiality atom carried by every hole-card hand. One shared Resource atom is
// enough: each hand has its own render boundary, so we declassify per-hand by toggling each
// boundary's declassify list — not by minting per-player atoms.
const POKER_HAND = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "PokerHoleCards",
  subject: "poker:hole-cards",
} as const;

type ConfHand = Confidential<Card[], readonly [typeof POKER_HAND]>;
type HandArg = { id: string; cards: Card[] };

// Idiomatic confidential-cell creation (mirrors cfc-render-policy-demo): a lift whose RETURN type
// is the Confidential cell, built with Cell.for(id).set(...). This is what attaches the
// ifc.confidentiality label the render boundary reads.
const makeHand = lift<HandArg, Writable<ConfHand>>((input) =>
  Cell.for<ConfHand>(input.id).set(input.cards as ConfHand)
);

// ===========================================================================
// Proposed reveal lattice (memo §4.1) — used only by the SIMULATED illustration below.
// ===========================================================================

type RevealLevel = "hidden" | "existence" | "cardinality" | "order" | "values";

// ===========================================================================
// Module-scope helpers
// ===========================================================================

const PHASES = ["predeal", "preflop", "flop", "turn", "river", "showdown"];

// Two preset deals so "New game" visibly changes the table. The hands' SECRECY comes from the
// CFC render boundary, not from how cards are chosen, so fixed presets are fine (and avoid the
// "deterministic shuffle from public state" leak the previous version had).
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
const FACE_DOWN = {
  ...CARD_BASE,
  background:
    "repeating-linear-gradient(45deg,#3b82f6,#3b82f6 5px,#2563eb 5px,#2563eb 10px)",
  color: "#dbeafe",
  border: "1px solid #1e3a8a",
  fontSize: "22px",
};
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
const FOLDED_BOX = { ...LOCK_BOX, background: "#f1f5f9", color: "#64748b", border: "1px dashed #94a3b8", fontStyle: "italic" };
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

const LEVEL_STYLE: Record<RevealLevel, { bg: string; fg: string; text: string }> = {
  values: { bg: "#dcfce7", fg: "#166534", text: "VALUES · full cards" },
  order: { bg: "#dbeafe", fg: "#1e40af", text: "ORDER · positions only" },
  cardinality: { bg: "#fef3c7", fg: "#92400e", text: "COUNT · how many" },
  existence: { bg: "#e5e7eb", fg: "#374151", text: "EXISTS · one bit" },
  hidden: { bg: "#1f2937", fg: "#cbd5e1", text: "HIDDEN" },
};

function pill(level: RevealLevel) {
  const s = LEVEL_STYLE[level];
  return (
    <span
      style={{
        display: "inline-block",
        background: s.bg,
        color: s.fg,
        borderRadius: "999px",
        padding: "3px 10px",
        fontSize: "11px",
        fontWeight: "700",
        letterSpacing: "0.3px",
        whiteSpace: "nowrap",
      }}
    >
      {s.text}
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

function backChip() {
  return <span style={FACE_DOWN}>🂠</span>;
}

// The ENFORCED hand: the actual cards rendered INSIDE a render boundary. When `declassified` is
// false the boundary blocks the whole subtree (the runtime refuses to render a labelled cell), so
// nothing shows; when true the boundary permits it. `$value` is the confidential cell whose live
// label the boundary checks.
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

// The trusted declassification. Its OUTPUT is typed TrustedActionWrite, and the button that
// triggers it lives in a surface carrying data-ui-event-integrity — so the write that reveals
// the hands is the one integrity-gated action in the whole pattern.
const setRevealed = handler<unknown, { revealed: Writable<boolean>; next: boolean }>(
  (_, s) => {
    s.revealed.set(s.next);
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
    typeof setRevealed,
    typeof SHOWDOWN_ACTION,
    typeof SHOWDOWN_SURFACE
  >;
  reveal: Stream<unknown>;
  conceal: Stream<unknown>;
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
  const phase = new Writable<string>("predeal");

  // Confidential views of the three hands (real ifc.confidentiality labels).
  const aliceConf: Writable<ConfHand> = makeHand({ id: "poker-hand-alice", cards: alice }) as never;
  const bobConf: Writable<ConfHand> = makeHand({ id: "poker-hand-bob", cards: bob }) as never;
  const charlieConf: Writable<ConfHand> = makeHand({ id: "poker-hand-charlie", cards: charlie }) as never;

  const game: GameState = {
    dealIndex, alice, bob, charlie, community, board,
    aliceFolded, bobFolded, charlieFolded, revealed, phase,
  };

  const start = newGame(game);
  const flop = dealStreet({ community, board, phase, count: 3, nextPhase: "flop" });
  const turn = dealStreet({ community, board, phase, count: 4, nextPhase: "turn" });
  const river = dealStreet({ community, board, phase, count: 5, nextPhase: "river" });
  const foldAlice = foldPlayer({ folded: aliceFolded });
  const foldBob = foldPlayer({ folded: bobFolded });
  const foldCharlie = foldPlayer({ folded: charlieFolded });
  const reveal = setRevealed({ revealed, next: true });
  const conceal = setRevealed({ revealed, next: false });

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

  const aliceNote = computed(() =>
    aliceFolded.get()
      ? <div style={FOLDED_BOX}>folded — stays confidential at showdown</div>
      : (revealed.get() ? "" : <div style={LOCK_BOX}>🔒 blocked by render boundary</div>)
  );
  const bobNote = computed(() =>
    bobFolded.get()
      ? <div style={FOLDED_BOX}>folded — stays confidential at showdown</div>
      : (revealed.get() ? "" : <div style={LOCK_BOX}>🔒 blocked by render boundary</div>)
  );
  const charlieNote = computed(() =>
    charlieFolded.get()
      ? <div style={FOLDED_BOX}>folded — stays confidential at showdown</div>
      : (revealed.get() ? "" : <div style={LOCK_BOX}>🔒 blocked by render boundary</div>)
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
        <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "900px" }}>
          {/* Intro */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>🃏 Confidential hands, revealed only at a trusted showdown</cf-heading>
              <cf-label>
                Each hand below is a <b>Confidential</b> cell. A <b>cf-cfc-render-boundary</b> with{" "}
                <code>maxConfidentiality=[]</code> blocks every hand from rendering — this is real,
                runtime-enforced CFC. Only the <b>trusted Showdown action</b> can declassify them,
                and folded hands never reveal. The chip under each hand is its live CFC label.
              </cf-label>
              <cf-label>{statusLine}</cf-label>
            </cf-vstack>
          </cf-card>

          {/* ENFORCED: confidential hands behind render boundaries */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🔒 Hands (enforced by CFC render boundary)</cf-heading>

              <div style={HAND_ROW}>
                <div style={NAME_COL}>Alice</div>
                {aliceCell}
                {aliceNote}
                <cf-cfc-label data-cfc-label-surface="alice" $value={aliceConf} />
              </div>
              <div style={HAND_ROW}>
                <div style={NAME_COL}>Bob</div>
                {bobCell}
                {bobNote}
                <cf-cfc-label data-cfc-label-surface="bob" $value={bobConf} />
              </div>
              <div style={HAND_ROW}>
                <div style={NAME_COL}>Charlie</div>
                {charlieCell}
                {charlieNote}
                <cf-cfc-label data-cfc-label-surface="charlie" $value={charlieConf} />
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

          {/* Trusted showdown surface — the one integrity-gated declassification */}
          <cf-card
            id="trusted-showdown-surface"
            data-ui-surface={SHOWDOWN_SURFACE}
            data-ui-pattern={SHOWDOWN_SURFACE}
            data-ui-event-integrity={SHOWDOWN_SURFACE}
          >
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🏆 Trusted Showdown</cf-heading>
              <cf-label>
                This button is a <b>trusted action</b> (data-ui-action + TrustedActionWrite). Its
                write is the only thing that declassifies the hands — untrusted code cannot flip
                it (memo §4.2/§6).
              </cf-label>
              <cf-hstack gap="2">
                <cf-button data-ui-action={SHOWDOWN_ACTION} onClick={reveal}>
                  Reveal hands (showdown)
                </cf-button>
                <cf-button onClick={conceal}>Re-conceal</cf-button>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {/* PROPOSED: the graded lattice (clearly simulated) */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🧪 Proposed extension (simulated — not enforced)</cf-heading>
              <cf-label style={{ color: "#64748b" }}>
                CFC today is binary: a hand is either blocked or fully declassified (above). The
                memo (§4) argues for a <b>graded, per-reader</b> lattice so an opponent could learn
                e.g. the <i>count</i> of your hand without the cards. CFC cannot express these
                middle levels today — shown here only as an illustration of the target shapes.
              </cf-label>
              <div style={{ ...ROW, gap: "8px" }}>{pill("values")}<span style={ROW}>{DEALS[0].hands[0].map(cardChip)}</span></div>
              <div style={{ ...ROW, gap: "8px" }}>{pill("order")}<span style={ROW}>{backChip()}{backChip()}</span><span style={{ color: "#64748b" }}>positions, faces hidden</span></div>
              <div style={{ ...ROW, gap: "8px" }}>{pill("cardinality")}<span style={ROW}>{backChip()}{backChip()}</span><span style={{ color: "#64748b" }}>×2 — count only</span></div>
              <div style={{ ...ROW, gap: "8px" }}>{pill("existence")}<span style={{ color: "#64748b" }}>a hand exists (e.g. folded)</span></div>
              <div style={{ ...ROW, gap: "8px" }}>{pill("hidden")}<span style={{ color: "#64748b" }}>nothing</span></div>
            </cf-vstack>
          </cf-card>

          {/* Honest limitation */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>⚠️ Honest limitation</cf-heading>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                The render boundary hides labelled content in a <b>trusted host</b>; it does not
                encrypt the cell. A malicious runtime could still read the bytes. Real secrecy
                between mutually-distrusting players needs the per-reader materialization the memo
                proposes in §4.4. This demo shows the policy surface, not a hardened deployment.
              </cf-label>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
    revealed,
    reveal,
    conceal,
  };
});
