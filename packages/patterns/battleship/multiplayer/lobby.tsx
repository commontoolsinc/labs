/// <cts-enable />
/**
 * Battleship Multiplayer - Lobby Pattern
 *
 * ARCHITECTURE:
 * - Two-player lobby where each player joins from their own browser
 * - Shared state stored as properly typed Cells (no JSON serialization)
 * - Each player navigates to their own game room instance with myName parameter
 *
 * See: room.tsx for the game room pattern
 */

import {
  computed,
  handler,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

import BattleshipRoom from "./room.tsx";
import {
  createInitialShots,
  type GameState,
  generateRandomShips,
  getRandomColor,
  INITIAL_GAME_STATE,
  type LobbyState,
  type PlayerData,
  type ShotsState,
} from "./schemas.tsx";

// =============================================================================
// LOBBY PATTERN
// =============================================================================

interface LobbyOutput {
  gameName: string;
  player1: PlayerData | null;
  player2: PlayerData | null;
  shots: ShotsState;
  gameState: GameState;
  // Streams for testing and programmatic control
  joinPlayer1: Stream<{ name: string }>;
  joinPlayer2: Stream<{ name: string }>;
  reset: Stream<void>;
}

// Module-level function for navigation (pattern from Scrabble)
let createGameAndNavigate: (
  gameName: string,
  player1: Writable<PlayerData | null>,
  player2: Writable<PlayerData | null>,
  shots: Writable<ShotsState>,
  gameState: Writable<GameState>,
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
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>(
  (
    _event,
    {
      gameName,
      nameInput,
      playerSlot,
      player1,
      player2,
      shots,
      gameState,
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

    // Store player data directly (no JSON serialization)
    if (playerSlot === 1) {
      player1.set(playerData);
    } else {
      player2.set(playerData);
    }

    // Check if both players have joined
    const p1 = player1.get();
    const p2 = player2.get();

    if (p1 && p2) {
      // Both players joined - initialize game state
      gameState.set({
        phase: "playing",
        currentTurn: 1,
        winner: null,
        lastMessage: `${p1.name}'s turn - fire at the enemy fleet!`,
      });

      // Initialize shots grids
      shots.set(createInitialShots());
    }

    nameInput.set("");

    // Navigate to game room
    console.log("[joinAsPlayer] Navigating to game room...");
    if (createGameAndNavigate) {
      return createGameAndNavigate(
        gameName,
        player1,
        player2,
        shots,
        gameState,
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
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>(
  (
    _event,
    {
      gameName,
      playerSlot,
      player1,
      player2,
      shots,
      gameState,
    },
  ) => {
    const playerData = playerSlot === 1 ? player1.get() : player2.get();
    if (!playerData) return;

    console.log("[rejoinGame] Rejoining as:", playerData.name);
    if (createGameAndNavigate) {
      return createGameAndNavigate(
        gameName,
        player1,
        player2,
        shots,
        gameState,
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
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>((_event, { player1, player2, shots, gameState }) => {
  console.log("[resetLobby] Resetting all game state...");
  player1.set(null);
  player2.set(null);
  shots.set(createInitialShots());
  gameState.set(INITIAL_GAME_STATE);
  console.log("[resetLobby] Game state reset complete");
});

// Programmatic handler for joining as Player 1 (for testing)
const joinPlayer1Handler = handler<
  { name: string },
  {
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>(({ name }, { player1, player2, shots, gameState }) => {
  if (!name || !name.trim()) return;

  const playerData: PlayerData = {
    name: name.trim(),
    ships: generateRandomShips(),
    color: getRandomColor(0),
    joinedAt: Date.now(),
  };

  player1.set(playerData);

  // Check if both players have joined
  const p1 = player1.get();
  const p2 = player2.get();

  if (p1 && p2) {
    gameState.set({
      phase: "playing",
      currentTurn: 1,
      winner: null,
      lastMessage: `${p1.name}'s turn - fire at the enemy fleet!`,
    });
    shots.set(createInitialShots());
  }
});

// Programmatic handler for joining as Player 2 (for testing)
const joinPlayer2Handler = handler<
  { name: string },
  {
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>(({ name }, { player1, player2, shots, gameState }) => {
  if (!name || !name.trim()) return;

  const playerData: PlayerData = {
    name: name.trim(),
    ships: generateRandomShips(),
    color: getRandomColor(1),
    joinedAt: Date.now(),
  };

  player2.set(playerData);

  // Check if both players have joined
  const p1 = player1.get();
  const p2 = player2.get();

  if (p1 && p2) {
    gameState.set({
      phase: "playing",
      currentTurn: 1,
      winner: null,
      lastMessage: `${p1.name}'s turn - fire at the enemy fleet!`,
    });
    shots.set(createInitialShots());
  }
});

// Programmatic reset handler (for testing)
const resetHandler = handler<
  void,
  {
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>((_event, { player1, player2, shots, gameState }) => {
  player1.set(null);
  player2.set(null);
  shots.set(createInitialShots());
  gameState.set(INITIAL_GAME_STATE);
});

const BattleshipLobby = pattern<LobbyState, LobbyOutput>(
  ({ gameName, player1, player2, shots, gameState }) => {
    // Separate name inputs for each player slot
    const player1NameInput = Writable.of("");
    const player2NameInput = Writable.of("");

    // Derive player names reactively (direct Cell access, no JSON parsing)
    const player1Data = computed(() => player1.get());
    const player2Data = computed(() => player2.get());
    const player1Name = computed(() => player1Data?.name || null);
    const player2Name = computed(() => player2Data?.name || null);

    // Game state
    const gameStateData = computed(() => gameState.get());
    const isGameStarted = computed(() => gameStateData.phase === "playing");

    // Programmatic handlers for testing
    const joinPlayer1 = joinPlayer1Handler({
      player1,
      player2,
      shots,
      gameState,
    });
    const joinPlayer2 = joinPlayer2Handler({
      player1,
      player2,
      shots,
      gameState,
    });
    const reset = resetHandler({ player1, player2, shots, gameState });

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
                        <ct-button
                          style="margin-top: 1rem; width: 100%;"
                          onClick={rejoinGame({
                            gameName,
                            playerSlot: 1,
                            player1,
                            player2,
                            shots,
                            gameState,
                          })}
                        >
                          Rejoin Game
                        </ct-button>
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
                    <ct-button
                      style="width: 100%;"
                      onClick={joinAsPlayer({
                        gameName,
                        nameInput: player1NameInput,
                        playerSlot: 1,
                        player1,
                        player2,
                        shots,
                        gameState,
                      })}
                    >
                      Join as Player 1
                    </ct-button>
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
                        <ct-button
                          style="margin-top: 1rem; width: 100%;"
                          onClick={rejoinGame({
                            gameName,
                            playerSlot: 2,
                            player1,
                            player2,
                            shots,
                            gameState,
                          })}
                        >
                          Rejoin Game
                        </ct-button>
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
                    <ct-button
                      style="width: 100%;"
                      onClick={joinAsPlayer({
                        gameName,
                        nameInput: player2NameInput,
                        playerSlot: 2,
                        player1,
                        player2,
                        shots,
                        gameState,
                      })}
                    >
                      Join as Player 2
                    </ct-button>
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
          <ct-button
            variant="secondary"
            style="margin-top: 2rem;"
            onClick={resetLobby({
              player1,
              player2,
              shots,
              gameState,
            })}
          >
            Reset Game
          </ct-button>
        </div>
      ),
      gameName,
      player1: player1Data,
      player2: player2Data,
      shots: computed(() => shots.get()),
      gameState: gameStateData,
      // Streams for testing and programmatic control
      joinPlayer1,
      joinPlayer2,
      reset,
    };
  },
);

// Navigation function setup
createGameAndNavigate = (
  gameName: string,
  player1: Writable<PlayerData | null>,
  player2: Writable<PlayerData | null>,
  shots: Writable<ShotsState>,
  gameState: Writable<GameState>,
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

  // Pass typed Cells to BattleshipRoom
  const gameInstance = BattleshipRoom({
    gameName,
    player1,
    player2,
    shots,
    gameState,
    myName,
    myPlayerNumber,
  });

  console.log("[createGameAndNavigate] Game instance created");
  return navigateTo(gameInstance);
};

export default BattleshipLobby;
