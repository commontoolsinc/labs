// Poker sanitization demo — illustrative pattern grounding
// docs/proposals/cfc-game-sanitization-memo.md.
//
// This pattern DEMONSTRATES the four proposed CFC primitives by implementing them as ordinary
// module-scope TypeScript (since the runtime does not have them yet):
//
//   §4.1 facet labels        -> RevealLevel + FacetPolicy
//   §4.2 graded projection   -> revealLevelFor() + projectHand()   (the core "aha")
//   §4.3 blinded refs/reblind-> reblind() + epoch                  (shuffle severs linkage)
//   §4.4 materialization     -> handRow() is the per-reader materialization, run in computeds
//
// The "money shot" is the VIEWER SELECTOR: flip between Alice / Bob / Charlie / Spectator and
// watch the SAME canonical table state project into different shapes — values for the owner,
// cardinality for opponents, existence for a folded (mucked) hand, full values at showdown.
//
// Every place a real CFC primitive would replace this hand-rolled logic is marked `// CFC-WISH §x`.
//
// It is still a SKETCH: poker hand-ranking, betting rules, and turn order are intentionally
// omitted — only the state transitions that exercise sanitization are modelled.

import { computed, handler, NAME, pattern, UI, Writable } from "commonfabric";

// ===========================================================================
// Domain types
// ===========================================================================

type Suit = "♠" | "♥" | "♦" | "♣";
type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A";
type Card = { suit: Suit; rank: Rank };

// CFC-WISH §4.1: the ordered reveal lattice. Higher rank = more revealing. Mirrors boardgame's
// PolicyHidden ≺ PolicyNonEmpty ≺ PolicyLen ≺ PolicyOrder ≺ PolicyVisible exactly.
type RevealLevel = "hidden" | "existence" | "cardinality" | "order" | "values";
const LEVEL_RANK: Record<RevealLevel, number> = {
  hidden: 0,
  existence: 1,
  cardinality: 2,
  order: 3,
  values: 4,
};

// CFC-WISH §4.1: a FacetPolicy binds reveal levels to audiences (resolved via space roles).
type AudienceRule = { role: string; level: RevealLevel };
type FacetPolicy = { default: RevealLevel; audiences: AudienceRule[] };

// ===========================================================================
// Module-scope helpers (no closures allowed in the pattern body)
// ===========================================================================

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const RANKS: Rank[] = [
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
  "A",
];
const PHASES = ["predeal", "preflop", "flop", "turn", "river", "showdown"];

function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) {
    for (const r of RANKS) deck.push({ suit: s, rank: r });
  }
  return deck;
}

// Deterministic LCG shuffle so projections are replayable (memo §4.2 soundness note).
function shuffleDeterministic(deck: Card[], seed: number): Card[] {
  const out = deck.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function suitColor(suit: Suit): string {
  return suit === "♥" || suit === "♦" ? "#dc2626" : "#0f172a";
}

// CFC-WISH §4.1/§4.2: the policy a hand carries, as a function of game phase and fold state.
// In the real model this is a static schema `ifc.reveal` annotation whose audiences resolve
// against space roles; here phase/fold select among snapshots to show reveal TRANSITIONS.
function handPolicyFor(
  owner: string,
  phase: string,
  folded: boolean,
): FacetPolicy {
  if (folded) {
    // Muck: everyone learns a hand WAS folded (existence), never its contents. Owner still sees.
    return {
      default: "existence",
      audiences: [{ role: `self:${owner}`, level: "values" }],
    };
  }
  if (phase === "showdown") {
    // Showdown: graded declassification cardinality -> values for the whole table.
    return {
      default: "hidden",
      audiences: [
        { role: `self:${owner}`, level: "values" },
        { role: "table", level: "values" },
      ],
    };
  }
  // In play: owner sees values; the table sees only the count.
  return {
    default: "hidden",
    audiences: [
      { role: `self:${owner}`, level: "values" },
      { role: "table", level: "cardinality" },
    ],
  };
}

function viewerRoles(viewer: string, owner: string): string[] {
  const roles = ["table"]; // every viewer (incl. spectator) is a table-reader in this demo
  if (viewer === owner) roles.push(`self:${owner}`);
  return roles;
}

// CFC-WISH §4.2: revealLevelFor — least-restrictive-wins over the ordered lattice (== max rank).
function revealLevelFor(policy: FacetPolicy, roles: string[]): RevealLevel {
  let best = policy.default;
  for (const a of policy.audiences) {
    if (roles.includes(a.role) && LEVEL_RANK[a.level] > LEVEL_RANK[best]) {
      best = a.level;
    }
  }
  return best;
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
const FACE_UP = {
  ...CARD_BASE,
  background: "#ffffff",
  border: "1px solid #cbd5e1",
};
const FACE_DOWN = {
  ...CARD_BASE,
  background:
    "repeating-linear-gradient(45deg,#3b82f6,#3b82f6 5px,#2563eb 5px,#2563eb 10px)",
  color: "#dbeafe",
  border: "1px solid #1e3a8a",
  fontSize: "22px",
};
const FOLDED_BOX = {
  display: "inline-flex",
  alignItems: "center",
  height: "56px",
  padding: "0 14px",
  borderRadius: "7px",
  background: "#f1f5f9",
  color: "#64748b",
  border: "1px dashed #94a3b8",
  fontStyle: "italic",
  fontSize: "14px",
};
const HIDDEN_BOX = { ...FOLDED_BOX, color: "#94a3b8" };
const ROW = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "10px",
};
const HAND_ROW = {
  display: "flex",
  alignItems: "center",
  gap: "14px",
  padding: "10px 12px",
  borderRadius: "10px",
  border: "1px solid #e2e8f0",
  marginBottom: "8px",
};
const HAND_ROW_YOU = {
  ...HAND_ROW,
  border: "2px solid #6366f1",
  background: "#eef2ff",
};
const NAME_COL = { minWidth: "120px", fontWeight: "700", fontSize: "15px" };

// Per-level pill colors + short descriptor.
const LEVEL_STYLE: Record<
  RevealLevel,
  { bg: string; fg: string; text: string }
> = {
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
      {c.rank}
      {c.suit}
    </span>
  );
}

function backChip() {
  return <span style={FACE_DOWN}>🂠</span>;
}

// CFC-WISH §4.2/§4.4: the per-reader materialization, rendered. Produces the LOSSY visual this
// viewer is entitled to. This one function is the whole point of the memo, in running pixels.
function handRow(
  owner: string,
  cards: readonly Card[],
  viewer: string,
  phase: string,
  folded: boolean,
) {
  const level = revealLevelFor(
    handPolicyFor(owner, phase, folded),
    viewerRoles(viewer, owner),
  );
  const isYou = viewer === owner;
  const safe = (cards || []).filter((c) => c && c.rank);

  let visual;
  if (level === "values") {
    visual = <div style={ROW}>{safe.map(cardChip)}</div>;
  } else if (level === "order") {
    visual = <div style={ROW}>{safe.map(() => backChip())}</div>;
  } else if (level === "cardinality") {
    visual = (
      <div style={ROW}>
        {safe.map(() => backChip())}
        <span style={{ color: "#92400e", fontWeight: "700" }}>
          ×{safe.length} (count only)
        </span>
      </div>
    );
  } else if (level === "existence") {
    visual = <div style={FOLDED_BOX}>■ folded — contents never revealable</div>;
  } else {
    visual = <div style={HIDDEN_BOX}>— hidden —</div>;
  }

  return (
    <div style={isYou ? HAND_ROW_YOU : HAND_ROW}>
      <div style={NAME_COL}>
        {owner}
        {isYou ? " 👁 (you)" : ""}
      </div>
      {pill(level)}
      {visual}
    </div>
  );
}

function communityRow(board: readonly Card[]) {
  const safe = (board || []).filter((c) => c && c.rank);
  if (!safe.length) {
    return <div style={HIDDEN_BOX}>— no community cards yet —</div>;
  }
  return <div style={ROW}>{safe.map(cardChip)}</div>;
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

function viewerButtonLabel(name: string, active: string) {
  return active === name ? `✓ ${name}` : name;
}

// ===========================================================================
// Handlers
// ===========================================================================

const TRUSTED_SHOWDOWN_SURFACE = "TrustedShowdownSurface";
const TRUSTED_SHOWDOWN_ACTION = "TrustedShowdown";

type GameState = {
  deck: Writable<Card[]>;
  epoch: Writable<number>;
  drawn: Writable<number>;
  board: Writable<Card[]>;
  alice: Writable<Card[]>;
  bob: Writable<Card[]>;
  charlie: Writable<Card[]>;
  aliceFolded: Writable<boolean>;
  bobFolded: Writable<boolean>;
  charlieFolded: Writable<boolean>;
  phase: Writable<string>;
};

// CFC-WISH §4.3: New game = reblind (shuffle, bump epoch → all card linkage severed) + deal.
// One click takes you to a ready-to-play preflop table with fresh hidden hands.
const newGame = handler<unknown, GameState>((_, s) => {
  const nextEpoch = s.epoch.get() + 1;
  const d = shuffleDeterministic(freshDeck(), nextEpoch * 7919);
  s.deck.set(d);
  s.epoch.set(nextEpoch);
  s.alice.set([d[0], d[1]]);
  s.bob.set([d[2], d[3]]);
  s.charlie.set([d[4], d[5]]);
  s.drawn.set(6);
  s.board.set([]);
  s.aliceFolded.set(false);
  s.bobFolded.set(false);
  s.charlieFolded.set(false);
  s.phase.set("preflop");
});

// Reset back to an empty pre-deal table.
const resetTable = handler<unknown, GameState>((_, s) => {
  s.deck.set(freshDeck());
  s.drawn.set(0);
  s.board.set([]);
  s.alice.set([]);
  s.bob.set([]);
  s.charlie.set([]);
  s.aliceFolded.set(false);
  s.bobFolded.set(false);
  s.charlieFolded.set(false);
  s.phase.set("predeal");
});

type BoardState = {
  deck: Writable<Card[]>;
  drawn: Writable<number>;
  board: Writable<Card[]>;
  phase: Writable<string>;
};

// CFC-WISH §4.2: community cards are a public move + declassification UP the lattice
// (hidden -> values for the whole table).
const dealFlop = handler<unknown, BoardState>((_, s) => {
  const d = s.deck.get();
  const i = s.drawn.get();
  if (d.length < i + 3) return;
  s.board.set([d[i], d[i + 1], d[i + 2]]);
  s.drawn.set(i + 3);
  s.phase.set("flop");
});

const dealTurnOrRiver = handler<unknown, BoardState & { nextPhase: string }>(
  (_, s) => {
    const d = s.deck.get();
    const i = s.drawn.get();
    if (d.length < i + 1) return;
    s.board.set([...s.board.get(), d[i]]);
    s.drawn.set(i + 1);
    s.phase.set(s.nextPhase);
  },
);

const setPhase = handler<unknown, { phase: Writable<string>; next: string }>(
  (_, s) => {
    s.phase.set(s.next);
  },
);

// CFC-WISH §4.3: fold = publicMove hand -> muck (existence to the table). Everyone learns a hand
// folded; no one ever learns the contents.
const foldPlayer = handler<unknown, { folded: Writable<boolean> }>((_, s) => {
  s.folded.set(true);
});

const setViewer = handler<unknown, { viewer: Writable<string>; next: string }>(
  (_, s) => {
    s.viewer.set(s.next);
  },
);

// ===========================================================================
// Pattern
// ===========================================================================

export default pattern<unknown, { [NAME]: string; [UI]: unknown }>(() => {
  // canonical state (one true copy; never mutated by projection)
  const deck = new Writable<Card[]>(freshDeck());
  const epoch = new Writable<number>(0);
  const drawn = new Writable<number>(0);
  const board = new Writable<Card[]>([]);
  const phase = new Writable<string>("predeal");

  // CFC-WISH §4.4: in the proposed model these per-player hands are ONE shared cell projected
  // per reader. Today they are plain cells and handRow() does the per-reader materialization.
  const alice = new Writable<Card[]>([]);
  const bob = new Writable<Card[]>([]);
  const charlie = new Writable<Card[]>([]);
  const aliceFolded = new Writable<boolean>(false);
  const bobFolded = new Writable<boolean>(false);
  const charlieFolded = new Writable<boolean>(false);

  const viewer = new Writable<string>("Spectator");

  const game: GameState = {
    deck,
    epoch,
    drawn,
    board,
    alice,
    bob,
    charlie,
    aliceFolded,
    bobFolded,
    charlieFolded,
    phase,
  };

  // bound handler instances
  const startGame = newGame(game);
  const reset = resetTable(game);
  const flop = dealFlop({ deck, drawn, board, phase });
  const turn = dealTurnOrRiver({
    deck,
    drawn,
    board,
    phase,
    nextPhase: "turn",
  });
  const river = dealTurnOrRiver({
    deck,
    drawn,
    board,
    phase,
    nextPhase: "river",
  });
  const showdown = setPhase({ phase, next: "showdown" });

  const foldAlice = foldPlayer({ folded: aliceFolded });
  const foldBob = foldPlayer({ folded: bobFolded });
  const foldCharlie = foldPlayer({ folded: charlieFolded });

  const viewAlice = setViewer({ viewer, next: "Alice" });
  const viewBob = setViewer({ viewer, next: "Bob" });
  const viewCharlie = setViewer({ viewer, next: "Charlie" });
  const viewSpectator = setViewer({ viewer, next: "Spectator" });

  // derived (read-only) views
  const viewerBanner = computed(() =>
    `👁  You are looking at the table as: ${viewer.get()}`
  );
  const remaining = computed(() =>
    `${deck.get().length - drawn.get()} cards in the deck`
  );
  const linkage = computed(
    () =>
      `Deck epoch ${epoch.get()} — the last shuffle reblinded every card (linkage severed below the "order" level)`,
  );
  const stepper = computed(() => phaseStepper(phase.get()));
  const community = computed(() => communityRow(board.get()));

  // money shot: the SAME state, projected for the SELECTED viewer
  const aliceRow = computed(() =>
    handRow("Alice", alice.get(), viewer.get(), phase.get(), aliceFolded.get())
  );
  const bobRow = computed(() =>
    handRow("Bob", bob.get(), viewer.get(), phase.get(), bobFolded.get())
  );
  const charlieRow = computed(() =>
    handRow(
      "Charlie",
      charlie.get(),
      viewer.get(),
      phase.get(),
      charlieFolded.get(),
    )
  );

  const lblAlice = computed(() => viewerButtonLabel("Alice", viewer.get()));
  const lblBob = computed(() => viewerButtonLabel("Bob", viewer.get()));
  const lblCharlie = computed(() => viewerButtonLabel("Charlie", viewer.get()));
  const lblSpectator = computed(() =>
    viewerButtonLabel("Spectator", viewer.get())
  );

  return {
    [NAME]: "Poker sanitization demo",
    [UI]: (
      <cf-screen title="Poker sanitization demo">
        <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "880px" }}>
          {/* Intro */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>
                🃏 One canonical state, many reader projections
              </cf-heading>
              <cf-label>
                There is <b>one</b>{" "}
                true table state. Each viewer receives a different,
                partially-redacted projection of it. Switch the viewer and watch
                every hand re-project. The coloured pill on each hand shows the
                reveal level applied (memo §4.1/§4.2).
              </cf-label>
            </cf-vstack>
          </cf-card>

          {/* Viewer selector */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>{viewerBanner}</cf-heading>
              <cf-hstack gap="2">
                <cf-button onClick={viewAlice}>{lblAlice}</cf-button>
                <cf-button onClick={viewBob}>{lblBob}</cf-button>
                <cf-button onClick={viewCharlie}>{lblCharlie}</cf-button>
                <cf-button onClick={viewSpectator}>{lblSpectator}</cf-button>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {/* Hands (the projections) */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Hands, as this viewer sees them</cf-heading>
              <div>{aliceRow}</div>
              <div>{bobRow}</div>
              <div>{charlieRow}</div>
            </cf-vstack>
          </cf-card>

          {/* Public table */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🟢 Table (public to everyone)</cf-heading>
              {stepper}
              <cf-label>Community cards:</cf-label>
              <div>{community}</div>
              <cf-label>{remaining}</cf-label>
              <cf-label style={{ fontSize: "12px", color: "#64748b" }}>
                {linkage}
              </cf-label>
            </cf-vstack>
          </cf-card>

          {/* Controls */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Dealer controls</cf-heading>
              <cf-hstack gap="2">
                <cf-button onClick={startGame}>
                  🆕 New game (shuffle + deal)
                </cf-button>
                <cf-button onClick={flop}>Flop</cf-button>
                <cf-button onClick={turn}>Turn</cf-button>
                <cf-button onClick={river}>River</cf-button>
                <cf-button onClick={reset}>♻️ Reset</cf-button>
              </cf-hstack>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                Folding mucks a hand → it collapses to "exists only" for
                everyone, forever.
              </cf-label>
              <cf-hstack gap="2">
                <cf-button onClick={foldAlice}>Alice folds</cf-button>
                <cf-button onClick={foldBob}>Bob folds</cf-button>
                <cf-button onClick={foldCharlie}>Charlie folds</cf-button>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {/* Showdown */}
          <cf-card
            id="trusted-showdown-surface"
            data-ui-surface={TRUSTED_SHOWDOWN_SURFACE}
            data-ui-pattern={TRUSTED_SHOWDOWN_SURFACE}
            data-ui-event-integrity={TRUSTED_SHOWDOWN_SURFACE}
          >
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>🏆 Showdown</cf-heading>
              <cf-label>
                Reveals surviving hands to the whole table — a graded
                declassification event (count → values), gated by a trusted
                intent (memo §4.2/§6). Folded hands stay hidden.
              </cf-label>
              <cf-button
                data-ui-action={TRUSTED_SHOWDOWN_ACTION}
                onClick={showdown}
              >
                Reveal hands (showdown)
              </cf-button>
            </cf-vstack>
          </cf-card>

          {/* Legend */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Reveal lattice (legend)</cf-heading>
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                Each level reveals strictly more than the one below it. These
                mirror boardgame's PolicyHidden ≺ NonEmpty ≺ Len ≺ Order ≺
                Visible.
              </cf-label>
              <div style={{ ...ROW, gap: "8px" }}>
                {pill("values")}
                <span>owner sees their cards</span>
              </div>
              <div style={{ ...ROW, gap: "8px" }}>
                {pill("order")}
                <span>positions/slots, faces hidden</span>
              </div>
              <div style={{ ...ROW, gap: "8px" }}>
                {pill("cardinality")}
                <span>how many cards, nothing else</span>
              </div>
              <div style={{ ...ROW, gap: "8px" }}>
                {pill("existence")}
                <span>that a (folded) hand exists</span>
              </div>
              <div style={{ ...ROW, gap: "8px" }}>
                {pill("hidden")}
                <span>nothing at all</span>
              </div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
  };
});
