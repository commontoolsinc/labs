/// <cts-enable />
/**
 * Battleship Multiplayer - Lobby Pattern
 *
 * ARCHITECTURE:
 * - Two-player lobby where each player joins from their own browser
 * - Shared state stored as JSON strings (workaround for Cell array proxy issues)
 * - Each player navigates to their own game room instance with myName parameter
 *
 * See: battleship-room.tsx for the game room pattern
 */

import {
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";

import BattleshipRoom from "./battleship-room.tsx";
import {
  createEmptyGrid,
  generateRandomShips,
  getRandomColor,
  parseGameStateJson,
  parsePlayerJson,
  PlayerData,
} from "./battleship-types.ts";

// =============================================================================
// LOBBY PATTERN
// =============================================================================

interface LobbyInput {
  gameName: Default<string, "Battleship">;
  player1Json: Writable<Default<string, "null">>;
  player2Json: Writable<Default<string, "null">>;
  shotsJson: Writable<Default<string, "{}">>;
  gameStateJson: Writable<Default<string, "{}">>;
}

interface LobbyOutput {
  gameName: string;
  player1Json: string;
  player2Json: string;
  shotsJson: string;
  gameStateJson: string;
}

// Module-level function for navigation (pattern from Scrabble)
let createGameAndNavigate: (
  gameName: string,
  player1Json: Writable<string>,
  player2Json: Writable<string>,
  shotsJson: Writable<string>,
  gameStateJson: Writable<string>,
  myName: string,
  myPlayerNumber: 1 | 2,
) => unknown = null as any;

// Handler for joining as a specific player slot
const joinAsPlayer = handler<
  unknown,
  {
    gameName: string;
    nameInput: Writable<string>;
    playerSlot: 1 | 2;
    player1Json: Writable<string>;
    player2Json: Writable<string>;
    shotsJson: Writable<string>;
    gameStateJson: Writable<string>;
  }
>(
  (
    _event,
    {
      gameName,
      nameInput,
      playerSlot,
      player1Json,
      player2Json,
      shotsJson,
      gameStateJson,
    },
  ) => {
    console.log(`[joinAsPlayer] Handler started for slot ${playerSlot}`);
    const name = nameInput.get().trim();
    if (!name) {
      console.log("[joinAsPlayer] No name entered, returning");
      return;
    }
    console.log("[joinAsPlayer] Name:", name, "Slot:", playerSlot);

    // Generate random ships for this player
    const ships = generateRandomShips();
    console.log("[joinAsPlayer] Generated ships:", ships.length);

    // Create player data
    const playerData: PlayerData = {
      name,
      ships,
      color: getRandomColor(playerSlot - 1),
      joinedAt: Date.now(),
    };

    // Store player data
    if (playerSlot === 1) {
      player1Json.set(JSON.stringify(playerData));
    } else {
      player2Json.set(JSON.stringify(playerData));
    }

    // Check if both players have joined
    const p1 = parsePlayerJson(player1Json.get());
    const p2 = parsePlayerJson(player2Json.get());

    if (p1 && p2) {
      // Both players joined - initialize game state
      const initialState = {
        phase: "playing",
        currentTurn: 1,
        winner: null,
        lastMessage: `${p1.name}'s turn - fire at the enemy fleet!`,
      };
      gameStateJson.set(JSON.stringify(initialState));

      // Initialize shots grids
      const initialShots = {
        "1": createEmptyGrid(),
        "2": createEmptyGrid(),
      };
      shotsJson.set(JSON.stringify(initialShots));
    }

    nameInput.set("");

    // Navigate to game room
    console.log("[joinAsPlayer] Navigating to game room...");
    if (createGameAndNavigate) {
      return createGameAndNavigate(
        gameName,
        player1Json,
        player2Json,
        shotsJson,
        gameStateJson,
        name,
        playerSlot,
      );
    }
  },
);

// Handler to rejoin an existing game
const rejoinGame = handler<
  unknown,
  {
    gameName: string;
    playerSlot: 1 | 2;
    player1Json: Writable<string>;
    player2Json: Writable<string>;
    shotsJson: Writable<string>;
    gameStateJson: Writable<string>;
  }
>(
  (
    _event,
    {
      gameName,
      playerSlot,
      player1Json,
      player2Json,
      shotsJson,
      gameStateJson,
    },
  ) => {
    const playerJson = playerSlot === 1 ? player1Json : player2Json;
    const playerData = parsePlayerJson(playerJson.get());
    if (!playerData) return;

    console.log("[rejoinGame] Rejoining as:", playerData.name);
    if (createGameAndNavigate) {
      return createGameAndNavigate(
        gameName,
        player1Json,
        player2Json,
        shotsJson,
        gameStateJson,
        playerData.name,
        playerSlot,
      );
    }
  },
);

// Handler to reset the lobby
const resetLobby = handler<
  unknown,
  {
    player1Json: Writable<string>;
    player2Json: Writable<string>;
    shotsJson: Writable<string>;
    gameStateJson: Writable<string>;
  }
>((_event, { player1Json, player2Json, shotsJson, gameStateJson }) => {
  console.log("[resetLobby] Resetting all game state...");
  player1Json.set("null");
  player2Json.set("null");
  shotsJson.set("{}");
  gameStateJson.set("{}");
  console.log("[resetLobby] Game state reset complete");
});

const BattleshipLobby = pattern<LobbyInput, LobbyOutput>(
  ({ gameName, player1Json, player2Json, shotsJson, gameStateJson }) => {
    // Separate name inputs for each player slot
    const player1NameInput = Writable.of("");
    const player2NameInput = Writable.of("");

    // Derive player data reactively
    const player1 = computed(() => parsePlayerJson(player1Json.get()));
    const player2 = computed(() => parsePlayerJson(player2Json.get()));
    const player1Name = computed(() => player1?.name || null);
    const player2Name = computed(() => player2?.name || null);

    // Game state
    const gameState = computed(() => parseGameStateJson(gameStateJson.get()));
    const isGameStarted = computed(() => gameState.phase === "playing");

    return {
      [NAME]: computed(() => `${gameName} - Lobby`),
      [UI]: (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            backgroundColor: "#0f172a",
            color: "#e2e8f0",
            padding: "2rem",
          }}
        >
          <h1
            style={{
              marginBottom: "0.5rem",
              fontSize: "3rem",
              fontWeight: "700",
              letterSpacing: "-0.02em",
            }}
          >
            BATTLESHIP
          </h1>
          <p
            style={{
              marginBottom: "2.5rem",
              color: "rgba(255,255,255,0.6)",
              fontSize: "1.1rem",
            }}
          >
            Two-player naval combat — open on two devices!
          </p>

          {/* Two Player Join Sections */}
          <div
            style={{ display: "flex", gap: "1.5rem", marginBottom: "1.5rem" }}
          >
            {/* Player 1 Section */}
            <div
              style={{
                width: "260px",
                padding: "1.5rem",
                backgroundColor: "#1e293b",
                borderRadius: "16px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                border: "2px solid #3b82f6",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: "500",
                  color: "#3b82f6",
                  marginBottom: "0.75rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Player 1
              </div>
              {player1Name
                ? (
                  <div style={{ textAlign: "center", padding: "0.5rem 0" }}>
                    <div
                      style={{
                        width: "60px",
                        height: "60px",
                        borderRadius: "50%",
                        backgroundColor: "#3b82f6",
                        color: "white",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: "600",
                        fontSize: "20px",
                        margin: "0 auto 0.75rem",
                      }}
                    >
                      {player1Name}
                    </div>
                    <div
                      style={{
                        fontSize: "1.25rem",
                        fontWeight: "600",
                        color: "#fff",
                        marginBottom: "0.5rem",
                      }}
                    >
                      {player1Name}
                    </div>
                    <div style={{ fontSize: "0.875rem", color: "#94a3b8" }}>
                      {isGameStarted ? "In Game" : "Ready"}
                    </div>
                    {isGameStarted
                      ? (
                        <button
                          type="button"
                          style={{
                            marginTop: "1rem",
                            width: "100%",
                            padding: "0.75rem 1.5rem",
                            fontSize: "0.875rem",
                            backgroundColor: "#1e40af",
                            color: "white",
                            fontWeight: "600",
                            border: "none",
                            borderRadius: "8px",
                            cursor: "pointer",
                          }}
                          onClick={rejoinGame({
                            gameName,
                            playerSlot: 1,
                            player1Json,
                            player2Json,
                            shotsJson,
                            gameStateJson,
                          })}
                        >
                          Rejoin Game
                        </button>
                      )
                      : <></>}
                  </div>
                )
                : (
                  <>
                    <ct-input
                      $value={player1NameInput}
                      placeholder="Your name"
                      style="width: 100%; margin-bottom: 1rem;"
                    />
                    <button
                      type="button"
                      style={{
                        width: "100%",
                        padding: "0.75rem 1.5rem",
                        fontSize: "1rem",
                        backgroundColor: "#3b82f6",
                        color: "white",
                        fontWeight: "600",
                        border: "none",
                        borderRadius: "8px",
                        cursor: "pointer",
                      }}
                      onClick={joinAsPlayer({
                        gameName,
                        nameInput: player1NameInput,
                        playerSlot: 1,
                        player1Json,
                        player2Json,
                        shotsJson,
                        gameStateJson,
                      })}
                    >
                      Join as Player 1
                    </button>
                  </>
                )}
            </div>

            {/* Player 2 Section */}
            <div
              style={{
                width: "260px",
                padding: "1.5rem",
                backgroundColor: "#1e293b",
                borderRadius: "16px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                border: "2px solid #ef4444",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: "500",
                  color: "#ef4444",
                  marginBottom: "0.75rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Player 2
              </div>
              {player2Name
                ? (
                  <div style={{ textAlign: "center", padding: "0.5rem 0" }}>
                    <div
                      style={{
                        width: "60px",
                        height: "60px",
                        borderRadius: "50%",
                        backgroundColor: "#ef4444",
                        color: "white",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: "600",
                        fontSize: "20px",
                        margin: "0 auto 0.75rem",
                      }}
                    >
                      {player2Name}
                    </div>
                    <div
                      style={{
                        fontSize: "1.25rem",
                        fontWeight: "600",
                        color: "#fff",
                        marginBottom: "0.5rem",
                      }}
                    >
                      {player2Name}
                    </div>
                    <div style={{ fontSize: "0.875rem", color: "#94a3b8" }}>
                      {isGameStarted ? "In Game" : "Ready"}
                    </div>
                    {isGameStarted
                      ? (
                        <button
                          type="button"
                          style={{
                            marginTop: "1rem",
                            width: "100%",
                            padding: "0.75rem 1.5rem",
                            fontSize: "0.875rem",
                            backgroundColor: "#991b1b",
                            color: "white",
                            fontWeight: "600",
                            border: "none",
                            borderRadius: "8px",
                            cursor: "pointer",
                          }}
                          onClick={rejoinGame({
                            gameName,
                            playerSlot: 2,
                            player1Json,
                            player2Json,
                            shotsJson,
                            gameStateJson,
                          })}
                        >
                          Rejoin Game
                        </button>
                      )
                      : <></>}
                  </div>
                )
                : (
                  <>
                    <ct-input
                      $value={player2NameInput}
                      placeholder="Your name"
                      style="width: 100%; margin-bottom: 1rem;"
                    />
                    <button
                      type="button"
                      style={{
                        width: "100%",
                        padding: "0.75rem 1.5rem",
                        fontSize: "1rem",
                        backgroundColor: "#ef4444",
                        color: "white",
                        fontWeight: "600",
                        border: "none",
                        borderRadius: "8px",
                        cursor: "pointer",
                      }}
                      onClick={joinAsPlayer({
                        gameName,
                        nameInput: player2NameInput,
                        playerSlot: 2,
                        player1Json,
                        player2Json,
                        shotsJson,
                        gameStateJson,
                      })}
                    >
                      Join as Player 2
                    </button>
                  </>
                )}
            </div>
          </div>

          {/* Status message */}
          <div
            style={{
              marginTop: "1rem",
              padding: "1rem 2rem",
              backgroundColor: "#1e293b",
              borderRadius: "8px",
              fontSize: "0.875rem",
              color: "#94a3b8",
            }}
          >
            {isGameStarted
              ? "Game in progress! Click 'Rejoin Game' to continue playing."
              : player1Name && player2Name
              ? "Both players ready - game starting!"
              : player1Name || player2Name
              ? "Waiting for the other player to join..."
              : "Each player should join from their own device"}
          </div>

          {/* Reset Button */}
          <button
            type="button"
            style={{
              marginTop: "2rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              background: "none",
              color: "rgba(255,255,255,0.4)",
              fontWeight: "400",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "4px",
              cursor: "pointer",
            }}
            onClick={resetLobby({
              player1Json,
              player2Json,
              shotsJson,
              gameStateJson,
            })}
          >
            Reset Game
          </button>
        </div>
      ),
      gameName,
      player1Json,
      player2Json,
      shotsJson,
      gameStateJson,
    };
  },
);

// Navigation function setup
createGameAndNavigate = (
  gameName: string,
  player1Json: Writable<string>,
  player2Json: Writable<string>,
  shotsJson: Writable<string>,
  gameStateJson: Writable<string>,
  myName: string,
  myPlayerNumber: 1 | 2,
) => {
  console.log("[createGameAndNavigate] Starting...");
  console.log(
    "[createGameAndNavigate] myName:",
    myName,
    "myPlayerNumber:",
    myPlayerNumber,
  );

  const gameInstance = BattleshipRoom({
    gameName,
    player1Json,
    player2Json,
    shotsJson,
    gameStateJson,
    myName,
    myPlayerNumber,
  });

  console.log("[createGameAndNavigate] Game instance created");
  return navigateTo(gameInstance);
};

export default BattleshipLobby;
