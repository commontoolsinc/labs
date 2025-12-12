/// <cts-enable />
import {
  Cell,
  computed,
  derive,
  handler,
  NAME,
  pattern,
  UI,
} from "commontools";

// =============================================================================
// Types
// =============================================================================

type Coordinate = { row: number; col: number };

type ShipType = "carrier" | "battleship" | "cruiser" | "submarine" | "destroyer";

interface Ship {
  type: ShipType;
  start: Coordinate;
  orientation: "horizontal" | "vertical";
}

type SquareState = "empty" | "miss" | "hit";

interface PlayerBoard {
  ships: Ship[];
  shots: SquareState[][]; // 10x10 grid - shots RECEIVED from opponent
}

interface GameState {
  phase: "playing" | "finished";
  currentTurn: 1 | 2;
  player1: PlayerBoard;
  player2: PlayerBoard;
  winner: 1 | 2 | null;
  lastMessage: string;
}

// =============================================================================
// Constants
// =============================================================================

const SHIP_SIZES: Record<ShipType, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

const SHIP_NAMES: Record<ShipType, string> = {
  carrier: "Carrier",
  battleship: "Battleship",
  cruiser: "Cruiser",
  submarine: "Submarine",
  destroyer: "Destroyer",
};

const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const GRID_INDICES = ROWS.flatMap((r) => ROWS.map((c) => ({ row: r, col: c })));

// =============================================================================
// Helper Functions
// =============================================================================

function createEmptyGrid(): SquareState[][] {
  return Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => "empty" as SquareState)
  );
}

function getShipCoordinates(ship: Ship): Coordinate[] {
  const size = SHIP_SIZES[ship.type];
  const coords: Coordinate[] = [];
  for (let i = 0; i < size; i++) {
    if (ship.orientation === "horizontal") {
      coords.push({ row: ship.start.row, col: ship.start.col + i });
    } else {
      coords.push({ row: ship.start.row + i, col: ship.start.col });
    }
  }
  return coords;
}

function findShipAt(ships: Ship[], coord: Coordinate): Ship | null {
  for (const ship of ships) {
    const shipCoords = getShipCoordinates(ship);
    if (shipCoords.some((c) => c.row === coord.row && c.col === coord.col)) {
      return ship;
    }
  }
  return null;
}

function isShipSunk(ship: Ship, shots: SquareState[][]): boolean {
  const coords = getShipCoordinates(ship);
  return coords.every((c) => shots[c.row][c.col] === "hit");
}

function areAllShipsSunk(ships: Ship[], shots: SquareState[][]): boolean {
  return ships.every((ship) => isShipSunk(ship, shots));
}

function buildShipPositions(ships: Ship[]): Record<string, ShipType> {
  const positions: Record<string, ShipType> = {};
  for (const ship of ships) {
    const coords = getShipCoordinates(ship);
    for (const c of coords) {
      positions[`${c.row},${c.col}`] = ship.type;
    }
  }
  return positions;
}

// Default ship placements for testing
function createDefaultShips1(): Ship[] {
  return [
    { type: "carrier", start: { row: 0, col: 0 }, orientation: "horizontal" },
    { type: "battleship", start: { row: 2, col: 1 }, orientation: "horizontal" },
    { type: "cruiser", start: { row: 4, col: 3 }, orientation: "vertical" },
    { type: "submarine", start: { row: 5, col: 7 }, orientation: "horizontal" },
    { type: "destroyer", start: { row: 8, col: 5 }, orientation: "vertical" },
  ];
}

function createDefaultShips2(): Ship[] {
  return [
    { type: "carrier", start: { row: 1, col: 2 }, orientation: "vertical" },
    { type: "battleship", start: { row: 0, col: 6 }, orientation: "horizontal" },
    { type: "cruiser", start: { row: 3, col: 0 }, orientation: "horizontal" },
    { type: "submarine", start: { row: 7, col: 4 }, orientation: "vertical" },
    { type: "destroyer", start: { row: 9, col: 8 }, orientation: "horizontal" },
  ];
}

function createInitialState(): GameState {
  return {
    phase: "playing",
    currentTurn: 1,
    player1: {
      ships: createDefaultShips1(),
      shots: createEmptyGrid(),
    },
    player2: {
      ships: createDefaultShips2(),
      shots: createEmptyGrid(),
    },
    winner: null,
    lastMessage: "Player 1's turn - click on Player 2's board to fire!",
  };
}

// =============================================================================
// Pattern
// =============================================================================

interface Input {}

interface Output {
  game: Cell<GameState>;
}

export default pattern<Input, Output>(({}) => {
  // Create game state with Cell.of() for initial value
  const game = Cell.of<GameState>(createInitialState());
  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const fireShot = handler<
    unknown,
    { row: number; col: number; targetPlayer: 1 | 2; game: Cell<GameState> }
  >((_, { row, col, targetPlayer, game }) => {
    const state = game.get();

    // Can't fire if game is over
    if (state.phase === "finished") return;

    // Can only fire at opponent
    if (state.currentTurn === targetPlayer) return;

    const targetBoard = targetPlayer === 1 ? state.player1 : state.player2;
    const shots = targetBoard.shots;

    // Can't fire at same spot twice
    if (shots[row][col] !== "empty") return;

    // Check if hit
    const hitShip = findShipAt(targetBoard.ships, { row, col });
    const newShots = shots.map((r, ri) =>
      r.map((c, ci) => (ri === row && ci === col ? (hitShip ? "hit" : "miss") : c))
    );

    const newTargetBoard = { ...targetBoard, shots: newShots };

    // Build message
    let message = "";
    const coordStr = `${COLS[col]}${row + 1}`;

    if (hitShip) {
      if (isShipSunk(hitShip, newShots)) {
        message = `${coordStr}: Hit! You sunk the ${SHIP_NAMES[hitShip.type]}!`;
      } else {
        message = `${coordStr}: Hit!`;
      }
    } else {
      message = `${coordStr}: Miss.`;
    }

    // Check for win
    const allSunk = areAllShipsSunk(targetBoard.ships, newShots);

    if (allSunk) {
      game.set({
        ...state,
        player1: targetPlayer === 1 ? newTargetBoard : state.player1,
        player2: targetPlayer === 2 ? newTargetBoard : state.player2,
        phase: "finished",
        winner: state.currentTurn,
        lastMessage: `${message} Player ${state.currentTurn} wins!`,
      });
    } else {
      const nextTurn = state.currentTurn === 1 ? 2 : 1;
      game.set({
        ...state,
        player1: targetPlayer === 1 ? newTargetBoard : state.player1,
        player2: targetPlayer === 2 ? newTargetBoard : state.player2,
        currentTurn: nextTurn as 1 | 2,
        lastMessage: `${message} Player ${nextTurn}'s turn.`,
      });
    }
  });

  const resetGame = handler<unknown, { game: Cell<GameState> }>(
    (_, { game }) => {
      game.set(createInitialState());
    }
  );

  // ---------------------------------------------------------------------------
  // Computed Values - Pre-compute everything needed for rendering
  // ---------------------------------------------------------------------------

  // Using .get() since game is Cell<GameState> from Cell.of()
  const lastMessage = derive(game, (g) => g.get().lastMessage ?? "Player 1's turn - click on Player 2's board to fire!");
  const currentTurn = derive(game, (g) => g.get().currentTurn ?? 1);

  // Ship positions for each player (for display)
  const p1ShipPositions = computed(() => {
    const state = game.get();
    const ships = state.player1?.ships;
    return ships ? buildShipPositions(ships) : {};
  });
  const p2ShipPositions = computed(() => {
    const state = game.get();
    const ships = state.player2?.ships;
    return ships ? buildShipPositions(ships) : {};
  });

  // Grid cell data for each player
  const p1CellData = computed(() => {
    const state = game.get();
    const shots = state.player1?.shots;
    const shipPos = p1ShipPositions;
    return GRID_INDICES.map(({ row, col }) => ({
      row,
      col,
      shotState: (shots?.[row]?.[col] ?? "empty") as SquareState,
      hasShip: !!shipPos[`${row},${col}`],
    }));
  });

  const p2CellData = computed(() => {
    const state = game.get();
    const shots = state.player2?.shots;
    const shipPos = p2ShipPositions;
    return GRID_INDICES.map(({ row, col }) => ({
      row,
      col,
      shotState: (shots?.[row]?.[col] ?? "empty") as SquareState,
      hasShip: !!shipPos[`${row},${col}`],
    }));
  });

  // Is it player 1's turn to fire at player 2?
  const p1CanFire = computed(() => currentTurn === 1);
  const p2CanFire = computed(() => currentTurn === 2);

  // ---------------------------------------------------------------------------
  // Styles (constant, can define outside)
  // ---------------------------------------------------------------------------

  const gridContainerStyle = {
    display: "grid",
    gridTemplateColumns: "30px repeat(10, 32px)",
    gap: "2px",
    backgroundColor: "#000",
    padding: "2px",
  };

  const headerCellStyle = {
    backgroundColor: "#1a1a2e",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#888",
    fontSize: "12px",
    fontWeight: "bold",
    height: "30px",
  };

  const baseCellStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "16px",
    fontWeight: "bold",
    height: "32px",
    width: "32px",
  };

  // ---------------------------------------------------------------------------
  // Main UI
  // ---------------------------------------------------------------------------

  return {
    [NAME]: "Battleship",
    [UI]: (
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: "20px",
          backgroundColor: "#0f172a",
          color: "#e2e8f0",
          minHeight: "100vh",
        }}
      >
        <h1 style={{ textAlign: "center", margin: "0 0 10px 0" }}>
          BATTLESHIP
        </h1>
        <p style={{ textAlign: "center", color: "#94a3b8", margin: "0 0 20px 0" }}>
          Debug Mode - All ships visible
        </p>

        {/* Status bar */}
        <div
          style={{
            textAlign: "center",
            padding: "12px",
            backgroundColor: "#1e293b",
            borderRadius: "8px",
            marginBottom: "20px",
            fontSize: "18px",
          }}
        >
          {lastMessage}
        </div>

        {/* Game boards */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "40px",
            flexWrap: "wrap",
          }}
        >
          {/* Player 1's Board */}
          <div style={{ display: "inline-block" }}>
            <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
              Player 1
            </h3>
            <div style={gridContainerStyle}>
              {/* Header row */}
              <div style={headerCellStyle} />
              {COLS.map((c) => (
                <div style={headerCellStyle}>{c}</div>
              ))}

              {/* Row labels - positioned explicitly */}
              {ROWS.map((rowIdx) => (
                <div
                  style={{
                    ...headerCellStyle,
                    gridRow: rowIdx + 2,
                    gridColumn: 1,
                  }}
                >
                  {rowIdx + 1}
                </div>
              ))}

              {/* Grid cells - positioned explicitly */}
              {p1CellData.map((cell) => (
                <div
                  style={{
                    ...baseCellStyle,
                    gridRow: cell.row + 2,
                    gridColumn: cell.col + 2,
                    backgroundColor:
                      cell.shotState === "hit"
                        ? "#dc2626"
                        : cell.shotState === "miss"
                          ? "#374151"
                          : cell.hasShip
                            ? "#4a5568"
                            : "#1e3a5f",
                    cursor: p2CanFire && cell.shotState === "empty" ? "pointer" : "default",
                  }}
                  onClick={fireShot({
                    row: cell.row,
                    col: cell.col,
                    targetPlayer: 1,
                    game,
                  })}
                >
                  {cell.shotState === "hit" ? "X" : cell.shotState === "miss" ? "O" : ""}
                </div>
              ))}
            </div>
          </div>

          {/* Player 2's Board */}
          <div style={{ display: "inline-block" }}>
            <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
              Player 2
            </h3>
            <div style={gridContainerStyle}>
              {/* Header row */}
              <div style={headerCellStyle} />
              {COLS.map((c) => (
                <div style={headerCellStyle}>{c}</div>
              ))}

              {/* Row labels - positioned explicitly */}
              {ROWS.map((rowIdx) => (
                <div
                  style={{
                    ...headerCellStyle,
                    gridRow: rowIdx + 2,
                    gridColumn: 1,
                  }}
                >
                  {rowIdx + 1}
                </div>
              ))}

              {/* Grid cells - positioned explicitly */}
              {p2CellData.map((cell) => (
                <div
                  style={{
                    ...baseCellStyle,
                    gridRow: cell.row + 2,
                    gridColumn: cell.col + 2,
                    backgroundColor:
                      cell.shotState === "hit"
                        ? "#dc2626"
                        : cell.shotState === "miss"
                          ? "#374151"
                          : cell.hasShip
                            ? "#4a5568"
                            : "#1e3a5f",
                    cursor: p1CanFire && cell.shotState === "empty" ? "pointer" : "default",
                  }}
                  onClick={fireShot({
                    row: cell.row,
                    col: cell.col,
                    targetPlayer: 2,
                    game,
                  })}
                >
                  {cell.shotState === "hit" ? "X" : cell.shotState === "miss" ? "O" : ""}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Reset button */}
        <div style={{ textAlign: "center", marginTop: "20px" }}>
          <ct-button onClick={resetGame({ game })}>New Game</ct-button>
        </div>

        {/* Legend */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "20px",
            marginTop: "20px",
            fontSize: "14px",
            color: "#94a3b8",
          }}
        >
          <span>
            <span
              style={{
                display: "inline-block",
                width: "16px",
                height: "16px",
                backgroundColor: "#1e3a5f",
                marginRight: "4px",
                verticalAlign: "middle",
              }}
            />
            Unexplored
          </span>
          <span>
            <span
              style={{
                display: "inline-block",
                width: "16px",
                height: "16px",
                backgroundColor: "#4a5568",
                marginRight: "4px",
                verticalAlign: "middle",
              }}
            />
            Ship (debug)
          </span>
          <span>
            <span
              style={{
                display: "inline-block",
                width: "16px",
                height: "16px",
                backgroundColor: "#dc2626",
                marginRight: "4px",
                verticalAlign: "middle",
                textAlign: "center",
                color: "#fff",
                fontSize: "12px",
                lineHeight: "16px",
              }}
            >
              X
            </span>
            Hit
          </span>
          <span>
            <span
              style={{
                display: "inline-block",
                width: "16px",
                height: "16px",
                backgroundColor: "#374151",
                marginRight: "4px",
                verticalAlign: "middle",
                textAlign: "center",
                color: "#fff",
                fontSize: "12px",
                lineHeight: "16px",
              }}
            >
              O
            </span>
            Miss
          </span>
        </div>
      </div>
    ),
    game,
  };
});
