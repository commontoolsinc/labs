/// <cts-enable />
/**
 * Battleship Multiplayer - Game Room Pattern
 *
 * ARCHITECTURE:
 * - Each player has their own instance with shared state Cells
 * - myName and myPlayerNumber determine what this player can see
 * - Ships are only visible on your own board
 * - Shots you've fired are visible on enemy board
 *
 * See: battleship-lobby.tsx for the lobby entry point
 */

import {
  computed,
  Default,
  derive,
  handler,
  lift,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

import {
  areAllShipsSunk,
  buildShipPositions,
  COLS,
  findShipAt,
  GameStateData,
  getInitials,
  GRID_INDICES,
  isShipSunk,
  parseGameStateJson,
  parsePlayerJson,
  parseShotsJson,
  PlayerData,
  ROWS,
  SHIP_NAMES,
  ShotsData,
  SquareState,
} from "./types.ts";

// =============================================================================
// GAME ROOM PATTERN
// =============================================================================

interface GameInput {
  gameName: Default<string, "Battleship">;
  player1Json: Writable<Default<string, "null">>;
  player2Json: Writable<Default<string, "null">>;
  shotsJson: Writable<Default<string, "{}">>;
  gameStateJson: Writable<Default<string, "{}">>;
  myName: Default<string, "">;
  myPlayerNumber: Default<number, 1>;
}

interface GameOutput {
  myName: string;
  myPlayerNumber: number;
}

// =============================================================================
// HANDLERS
// =============================================================================

const fireShot = handler<
  unknown,
  {
    row: number;
    col: number;
    myPlayerNumber: number;
    player1Json: Writable<string>;
    player2Json: Writable<string>;
    shotsJson: Writable<string>;
    gameStateJson: Writable<string>;
  }
>(
  (
    _,
    {
      row,
      col,
      myPlayerNumber,
      player1Json,
      player2Json,
      shotsJson,
      gameStateJson,
    },
  ) => {
    const gameState = parseGameStateJson(gameStateJson.get());

    // Can't fire if game is over
    if (gameState.phase === "finished") return;

    // Can only fire on your turn
    if (gameState.currentTurn !== myPlayerNumber) return;

    // Get current shots
    const shots = parseShotsJson(shotsJson.get());

    // Target the opponent's board (shots are stored as "shots received by player X")
    const targetPlayerNum = myPlayerNumber === 1 ? 2 : 1;
    const targetShots = shots[String(targetPlayerNum)];

    // Can't fire at same spot twice
    if (targetShots[row]?.[col] !== "empty") return;

    // Get opponent's ships
    const opponentJson = targetPlayerNum === 1
      ? player1Json.get()
      : player2Json.get();
    const opponentData = parsePlayerJson(opponentJson);
    if (!opponentData) return;

    // Check if hit
    const hitShip = findShipAt(opponentData.ships, { row, col });

    // Update shots grid
    const newShots = targetShots.map((r, ri) =>
      r.map((c, ci) =>
        ri === row && ci === col ? (hitShip ? "hit" : "miss") : c
      )
    );

    const updatedShotsData: ShotsData = {
      ...shots,
      [String(targetPlayerNum)]: newShots,
    };
    shotsJson.set(JSON.stringify(updatedShotsData));

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
    const allSunk = areAllShipsSunk(opponentData.ships, newShots);

    if (allSunk) {
      // Get winner's name
      const winnerJson = myPlayerNumber === 1
        ? player1Json.get()
        : player2Json.get();
      const winnerData = parsePlayerJson(winnerJson);
      const winnerName = winnerData?.name || `Player ${myPlayerNumber}`;

      const newState: GameStateData = {
        ...gameState,
        phase: "finished",
        winner: myPlayerNumber as 1 | 2,
        lastMessage: `${message} ${winnerName} wins!`,
      };
      gameStateJson.set(JSON.stringify(newState));
    } else {
      // Switch turns
      const nextTurn = myPlayerNumber === 1 ? 2 : 1;
      const nextPlayerJson = nextTurn === 1
        ? player1Json.get()
        : player2Json.get();
      const nextPlayerData = parsePlayerJson(nextPlayerJson);
      const nextPlayerName = nextPlayerData?.name || `Player ${nextTurn}`;

      const newState: GameStateData = {
        ...gameState,
        currentTurn: nextTurn as 1 | 2,
        lastMessage: `${message} ${nextPlayerName}'s turn.`,
      };
      gameStateJson.set(JSON.stringify(newState));
    }
  },
);

// =============================================================================
// LIFT FUNCTIONS
// =============================================================================

// Parse my player data based on myPlayerNumber
const parseMyData = lift<
  { player1Json: string; player2Json: string; myPlayerNumber: number },
  PlayerData | null
>(({ player1Json, player2Json, myPlayerNumber }) => {
  const playerJson = myPlayerNumber === 1 ? player1Json : player2Json;
  return parsePlayerJson(playerJson);
});

// Parse both players for display
const parsePlayer1 = lift<{ player1Json: string }, PlayerData | null>(
  ({ player1Json }) => parsePlayerJson(player1Json),
);

const parsePlayer2 = lift<{ player2Json: string }, PlayerData | null>(
  ({ player2Json }) => parsePlayerJson(player2Json),
);

const parseState = lift<{ gameStateJson: string }, GameStateData>(
  ({ gameStateJson }) => parseGameStateJson(gameStateJson),
);

// Parse my board cells (my ships + shots I received)
const parseMyBoardCells = lift<
  {
    player1Json: string;
    player2Json: string;
    shotsJson: string;
    myPlayerNumber: number;
  },
  {
    row: number;
    col: number;
    bgColor: string;
    content: string;
    gridRow: string;
    gridCol: string;
  }[]
>(({ player1Json, player2Json, shotsJson, myPlayerNumber }) => {
  const playerJson = myPlayerNumber === 1 ? player1Json : player2Json;
  const playerData = parsePlayerJson(playerJson);
  const shots = parseShotsJson(shotsJson);

  const myShips = playerData?.ships || [];
  const myShots = shots[String(myPlayerNumber)] || [];
  const shipPositions = buildShipPositions(myShips);

  return GRID_INDICES.map(({ row, col }) => {
    const shotState: SquareState = myShots[row]?.[col] ?? "empty";
    const hasShip = !!shipPositions[`${row},${col}`];
    const bgColor = shotState === "hit"
      ? "#dc2626"
      : shotState === "miss"
      ? "#374151"
      : hasShip
      ? "#22c55e"
      : "#1e3a5f";
    const content = shotState === "hit" ? "X" : shotState === "miss" ? "O" : "";
    return {
      row,
      col,
      bgColor,
      content,
      gridRow: `${row + 2}`,
      gridCol: `${col + 2}`,
    };
  });
});

// Parse enemy board cells (shots I've fired - no ships visible!)
const parseEnemyBoardCells = lift<
  {
    shotsJson: string;
    gameStateJson: string;
    myPlayerNumber: number;
  },
  {
    row: number;
    col: number;
    bgColor: string;
    content: string;
    gridRow: string;
    gridCol: string;
    cursor: string;
  }[]
>(({ shotsJson, gameStateJson, myPlayerNumber }) => {
  const shots = parseShotsJson(shotsJson);
  const gameState = parseGameStateJson(gameStateJson);
  const isFinished = gameState.phase === "finished";

  const oppNum = myPlayerNumber === 1 ? 2 : 1;
  const oppShots = shots[String(oppNum)] || [];

  return GRID_INDICES.map(({ row, col }) => {
    const shotState: SquareState = oppShots[row]?.[col] ?? "empty";
    const bgColor = shotState === "hit"
      ? "#dc2626"
      : shotState === "miss"
      ? "#374151"
      : "#1e3a5f";
    const content = shotState === "hit" ? "X" : shotState === "miss" ? "O" : "";
    const canClick = shotState === "empty" && !isFinished;
    return {
      row,
      col,
      bgColor,
      content,
      gridRow: `${row + 2}`,
      gridCol: `${col + 2}`,
      cursor: canClick ? "pointer" : "default",
    };
  });
});

// =============================================================================
// PATTERN
// =============================================================================

const BattleshipRoom = pattern<GameInput, GameOutput>(
  ({
    gameName: _gameName,
    player1Json,
    player2Json,
    shotsJson,
    gameStateJson,
    myName,
    myPlayerNumber,
  }) => {
    // Parse shared state reactively using lift functions
    const player1 = parsePlayer1({ player1Json });
    const player2 = parsePlayer2({ player2Json });
    const gameState = parseState({ gameStateJson });
    const myData = parseMyData({ player1Json, player2Json, myPlayerNumber });

    // Board cells via lift (all logic inside the lift function)
    const myBoardCells = parseMyBoardCells({
      player1Json,
      player2Json,
      shotsJson,
      myPlayerNumber,
    });
    const enemyBoardCells = parseEnemyBoardCells({
      shotsJson,
      gameStateJson,
      myPlayerNumber,
    });

    // Derived values for display
    const myColor = derive(myData, (md) => md?.color || "#3b82f6");
    const showTurnIndicator = derive(
      gameState,
      (gs) =>
        gs.currentTurn === myPlayerNumber && gs.phase !== "finished"
          ? "block"
          : "none",
    );

    // Player display values
    const player1Color = derive(player1, (p) => p?.color || "#3b82f6");
    const player1Name = derive(player1, (p) => p?.name || "Player 1");
    const player1Initials = derive(
      player1,
      (p) => getInitials(p?.name || "P1"),
    );
    const player1BgColor = derive(
      gameState,
      (gs) => gs.currentTurn === 1 ? "#1e40af" : "#1e293b",
    );
    const player1Status = derive(
      gameState,
      (gs) => gs.currentTurn === 1 ? "Active" : "Waiting",
    );

    const player2Color = derive(player2, (p) => p?.color || "#ef4444");
    const player2Name = derive(player2, (p) => p?.name || "Player 2");
    const player2Initials = derive(
      player2,
      (p) => getInitials(p?.name || "P2"),
    );
    const player2BgColor = derive(
      gameState,
      (gs) => gs.currentTurn === 2 ? "#1e40af" : "#1e293b",
    );
    const player2Status = derive(
      gameState,
      (gs) => gs.currentTurn === 2 ? "Active" : "Waiting",
    );

    const lastMessage = derive(gameState, (gs) => gs.lastMessage);

    // Styles
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

    // Status display - use derive chains for reactive values
    const statusBgColor = derive(gameState, (gs) => {
      const finished = gs.phase === "finished";
      const won = gs.winner === myPlayerNumber;
      const myTurn = gs.currentTurn === myPlayerNumber;
      return finished
        ? (won ? "#166534" : "#991b1b")
        : myTurn
        ? "#1e40af"
        : "#1e293b";
    });

    const statusMessage = derive(gameState, (gs) => {
      const finished = gs.phase === "finished";
      const won = gs.winner === myPlayerNumber;
      const myTurn = gs.currentTurn === myPlayerNumber;
      if (finished) {
        return won
          ? "Victory! You sunk all enemy ships!"
          : "Defeat. Your fleet was destroyed.";
      }
      return myTurn
        ? "Your turn - fire at the enemy fleet!"
        : "Waiting for opponent...";
    });

    return {
      [NAME]: computed(() => `Battleship: ${myName}`),
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
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "20px",
            }}
          >
            <h1 style={{ margin: "0", fontSize: "1.5rem" }}>BATTLESHIP</h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <span style={{ color: "#94a3b8", fontSize: "0.875rem" }}>
                Playing as
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "4px 12px",
                  backgroundColor: myColor,
                  borderRadius: "20px",
                }}
              >
                <div
                  style={{
                    width: "24px",
                    height: "24px",
                    borderRadius: "50%",
                    backgroundColor: "rgba(255,255,255,0.2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    fontWeight: "bold",
                  }}
                >
                  {getInitials(myName)}
                </div>
                <span style={{ fontWeight: "600" }}>{myName}</span>
              </div>
            </div>
          </div>

          {/* Status bar */}
          <div
            style={{
              textAlign: "center",
              padding: "16px",
              backgroundColor: statusBgColor,
              borderRadius: "8px",
              marginBottom: "20px",
              fontSize: "18px",
              fontWeight: "500",
            }}
          >
            {statusMessage}
          </div>

          {/* Turn indicator */}
          <div
            style={{
              display: showTurnIndicator,
              textAlign: "center",
              marginBottom: "12px",
            }}
          >
            <span
              style={{
                display: "inline-block",
                padding: "6px 16px",
                backgroundColor: "#22c55e",
                borderRadius: "20px",
                fontSize: "14px",
                fontWeight: "600",
                animation: "pulse 2s infinite",
              }}
            >
              YOUR TURN
            </span>
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
            {/* My Board (left) */}
            <div style={{ display: "inline-block" }}>
              <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
                Your Fleet
              </h3>
              <div style={gridContainerStyle}>
                <div style={headerCellStyle} />
                {COLS.map((c, i) => (
                  <div key={i} style={headerCellStyle}>{c}</div>
                ))}
                {ROWS.map((rowIdx) => (
                  <div
                    style={{
                      ...headerCellStyle,
                      gridRow: `${rowIdx + 2}`,
                      gridColumn: "1",
                    }}
                  >
                    {rowIdx + 1}
                  </div>
                ))}
                {myBoardCells.map((cell) => (
                  <div
                    style={{
                      ...baseCellStyle,
                      gridRow: cell.gridRow,
                      gridColumn: cell.gridCol,
                      backgroundColor: cell.bgColor,
                    }}
                  >
                    {cell.content}
                  </div>
                ))}
              </div>
            </div>

            {/* Enemy Board (right) */}
            <div style={{ display: "inline-block" }}>
              <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
                Enemy Waters
              </h3>
              <div style={gridContainerStyle}>
                <div style={headerCellStyle} />
                {COLS.map((c, i) => (
                  <div key={i} style={headerCellStyle}>{c}</div>
                ))}
                {ROWS.map((rowIdx) => (
                  <div
                    style={{
                      ...headerCellStyle,
                      gridRow: `${rowIdx + 2}`,
                      gridColumn: "1",
                    }}
                  >
                    {rowIdx + 1}
                  </div>
                ))}
                {enemyBoardCells.map((cell) => (
                  <div
                    style={{
                      ...baseCellStyle,
                      gridRow: cell.gridRow,
                      gridColumn: cell.gridCol,
                      backgroundColor: cell.bgColor,
                      cursor: cell.cursor,
                    }}
                    onClick={fireShot({
                      row: cell.row,
                      col: cell.col,
                      myPlayerNumber,
                      player1Json,
                      player2Json,
                      shotsJson,
                      gameStateJson,
                    })}
                  >
                    {cell.content}
                  </div>
                ))}
              </div>
            </div>
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
                  backgroundColor: "#22c55e",
                  marginRight: "4px",
                  verticalAlign: "middle",
                }}
              />
              Your Ship
            </span>
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
              Unknown
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

          {/* Players sidebar */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "16px",
              marginTop: "24px",
            }}
          >
            {/* Player 1 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 16px",
                backgroundColor: player1BgColor,
                borderRadius: "8px",
                border: myPlayerNumber === 1
                  ? "2px solid #fbbf24"
                  : "2px solid transparent",
              }}
            >
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  backgroundColor: player1Color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "bold",
                  fontSize: "12px",
                }}
              >
                {player1Initials}
              </div>
              <div>
                <div style={{ fontWeight: "600", fontSize: "14px" }}>
                  {player1Name}
                  {myPlayerNumber === 1 ? " (you)" : ""}
                </div>
                <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                  {player1Status}
                </div>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                color: "#64748b",
                fontSize: "20px",
              }}
            >
              vs
            </div>

            {/* Player 2 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 16px",
                backgroundColor: player2BgColor,
                borderRadius: "8px",
                border: myPlayerNumber === 2
                  ? "2px solid #fbbf24"
                  : "2px solid transparent",
              }}
            >
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  backgroundColor: player2Color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "bold",
                  fontSize: "12px",
                }}
              >
                {player2Initials}
              </div>
              <div>
                <div style={{ fontWeight: "600", fontSize: "14px" }}>
                  {player2Name}
                  {myPlayerNumber === 2 ? " (you)" : ""}
                </div>
                <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                  {player2Status}
                </div>
              </div>
            </div>
          </div>

          {/* Last message from game state */}
          <div
            style={{
              textAlign: "center",
              marginTop: "16px",
              padding: "12px",
              backgroundColor: "#1e293b",
              borderRadius: "8px",
              fontSize: "14px",
              color: "#94a3b8",
            }}
          >
            {lastMessage}
          </div>
        </div>
      ),
      myName,
      myPlayerNumber,
    };
  },
);

export default BattleshipRoom;
