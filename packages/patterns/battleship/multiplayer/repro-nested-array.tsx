/// <cts-enable />
/**
 * Minimal reproduction: NOW USING EXACT BATTLESHIP TYPES
 *
 * Uses LobbyState from schemas.tsx (exactly like lobby.tsx does)
 *
 * Run: deno task ct charm new packages/patterns/battleship/multiplayer/repro-nested-array.tsx --root packages/patterns/battleship
 */

import {
  computed,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";

// Import EXACT types from battleship schemas
import {
  createInitialShots,
  generateRandomShips,
  type GameState,
  getRandomColor,
  INITIAL_GAME_STATE,
  type LobbyState,
  type PlayerData,
  type ShotsState,
} from "./schemas.tsx";

// Import child pattern from separate file (like lobby imports room)
import ChildPattern from "./repro-child.tsx";

// Module-level navigation function (exactly like lobby.tsx)
let navigateToChild: ((
  gameName: string,
  player1: Writable<PlayerData | null>,
  player2: Writable<PlayerData | null>,
  shots: Writable<ShotsState>,
  gameState: Writable<GameState>,
  myName: string,
  myPlayerNumber: 1 | 2,
) => unknown) | null = null;

// Handler for Player 1 to join (sets player1 cell) - EXACTLY like lobby
const joinAsPlayer1 = handler<
  unknown,
  {
    gameName: string;
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>((_event, { gameName, player1, player2, shots, gameState }) => {
  const shipsArray = generateRandomShips();
  const data: PlayerData = {
    name: "Player One",
    ships: shipsArray,
    color: getRandomColor(0),
    joinedAt: Date.now(),
  };
  console.log("[Parent] Player 1 joining with ships:", shipsArray);
  console.log("[Parent] ships.length:", shipsArray.length);
  console.log("[Parent] ships[0]:", shipsArray[0]);
  player1.set(data);

  // Check if both players joined (like lobby does)
  const p1 = player1.get();
  const p2 = player2.get();
  if (p1 && p2) {
    gameState.set({
      phase: "playing",
      currentTurn: 1,
      winner: null,
      lastMessage: `${p1.name}'s turn!`,
    });
    shots.set(createInitialShots());
  }

  // Navigate to child (like lobby does)
  console.log("[Parent] Player 1 navigating to game...");
  if (navigateToChild) {
    return navigateToChild(gameName, player1, player2, shots, gameState, data.name, 1);
  }
});

// Handler for Player 2 to join (sets player2 cell) - EXACTLY like lobby
const joinAsPlayer2 = handler<
  unknown,
  {
    gameName: string;
    player1: Writable<PlayerData | null>;
    player2: Writable<PlayerData | null>;
    shots: Writable<ShotsState>;
    gameState: Writable<GameState>;
  }
>((_event, { gameName, player1, player2, shots, gameState }) => {
  const shipsArray = generateRandomShips();
  const data: PlayerData = {
    name: "Player Two",
    ships: shipsArray,
    color: getRandomColor(1),
    joinedAt: Date.now(),
  };
  console.log("[Parent] Player 2 joining with ships:", shipsArray);
  console.log("[Parent] ships.length:", shipsArray.length);
  console.log("[Parent] ships[0]:", shipsArray[0]);
  player2.set(data);

  // Check if both players joined (like lobby does)
  const p1 = player1.get();
  const p2 = player2.get();
  if (p1 && p2) {
    gameState.set({
      phase: "playing",
      currentTurn: 1,
      winner: null,
      lastMessage: `${p1.name}'s turn!`,
    });
    shots.set(createInitialShots());
  }

  // Navigate to child (like lobby does)
  console.log("[Parent] Player 2 navigating to game...");
  if (navigateToChild) {
    return navigateToChild(gameName, player1, player2, shots, gameState, data.name, 2);
  }
});

// Use LobbyState as input type (EXACTLY like lobby.tsx)
const ParentPattern = pattern<LobbyState, { gameName: string }>(
  ({ gameName, player1, player2, shots, gameState }) => {
    const p1Data = computed(() => player1.get());
    const p2Data = computed(() => player2.get());

    const status = computed(() => {
      const p1 = p1Data;
      const p2 = p2Data;
      if (p1 && p2) return "Both players joined - ready!";
      if (p1) return "Player 1 joined, waiting for Player 2...";
      if (p2) return "Player 2 joined, waiting for Player 1...";
      return "No players yet";
    });

    return {
      [NAME]: computed(() => `Repro: ${gameName}`),
      [UI]: (
        <div style={{ padding: "20px", backgroundColor: "#0f172a", color: "#fff" }}>
          <h1>Nested Array Repro (EXACT Battleship Types)</h1>
          <p>Status: {status}</p>

          <div style={{ display: "flex", gap: "20px", marginTop: "20px" }}>
            <div style={{ padding: "10px", backgroundColor: "#1e3a5f", borderRadius: "8px" }}>
              <h3>Player 1</h3>
              <p>{p1Data ? `Joined: ${p1Data.name}` : "Not joined"}</p>
              <ct-button onClick={joinAsPlayer1({ gameName, player1, player2, shots, gameState })}>
                Join as P1
              </ct-button>
            </div>

            <div style={{ padding: "10px", backgroundColor: "#5f1e3a", borderRadius: "8px" }}>
              <h3>Player 2</h3>
              <p>{p2Data ? `Joined: ${p2Data.name}` : "Not joined"}</p>
              <ct-button onClick={joinAsPlayer2({ gameName, player1, player2, shots, gameState })}>
                Join as P2
              </ct-button>
            </div>
          </div>
        </div>
      ),
      gameName,
    };
  },
);

// Navigation setup (EXACTLY like lobby.tsx)
navigateToChild = (
  gameName: string,
  player1: Writable<PlayerData | null>,
  player2: Writable<PlayerData | null>,
  shots: Writable<ShotsState>,
  gameState: Writable<GameState>,
  myName: string,
  myPlayerNumber: 1 | 2,
) => {
  console.log("[navigateToChild] Creating child with:", {
    gameName,
    myName,
    myPlayerNumber,
  });
  const child = ChildPattern({
    gameName,
    player1,
    player2,
    shots,
    gameState,
    myName,
    myPlayerNumber,
  });
  return navigateTo(child);
};

export default ParentPattern;
