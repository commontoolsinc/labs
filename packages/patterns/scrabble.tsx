/// <cts-enable />
/**
 * Multiplayer Free-for-All Scrabble - Lobby Pattern
 *
 * ARCHITECTURE:
 * - ALL shared state stored as JSON STRINGS to bypass Cell array proxy issues
 * - bagJson, boardJson, playersJson, gameEventsJson, allRacksJson, allPlacedJson
 * - Parse functions handle BOTH string and object input (runtime may auto-deserialize)
 *
 * See: scrabble-game.tsx for the game room pattern
 */

import {
  cell,
  Cell,
  Default,
  derive,
  handler,
  NAME,
  navigateTo,
  pattern,
  str,
  UI,
} from "commontools";

import ScrabbleGame, {
  Letter,
  PlacedTile,
  Player,
  GameEvent,
  AllRacks,
  AllPlaced,
  createTileBag,
  drawTilesFromBag,
  getRandomColor,
  getInitials,
  parsePlayersJson,
  parseGameEventsJson,
  parseAllRacksJson,
  parseAllPlacedJson,
  MAX_PLAYERS,
} from "./scrabble-game.tsx";

// =============================================================================
// LOBBY PATTERN
// =============================================================================

interface LobbyInput {
  gameName: Default<string, "Scrabble Match">;
  boardJson: Cell<Default<string, "">>;  // JSON string of PlacedTile[]
  bagJson: Cell<Default<string, "">>;
  bagIndex: Cell<Default<number, 0>>;
  playersJson: Cell<Default<string, "[]">>;  // JSON string of Player[]
  gameEventsJson: Cell<Default<string, "[]">>;  // JSON string of GameEvent[]
  allRacksJson: Cell<Default<string, "{}">>;  // JSON string of AllRacks
  allPlacedJson: Cell<Default<string, "{}">>;  // JSON string of AllPlaced
}

interface LobbyOutput {
  gameName: string;
  boardJson: string;
  bagJson: string;
  bagIndex: number;
  playersJson: string;
  gameEventsJson: string;
  allRacksJson: string;
  allPlacedJson: string;
}

let createGameAndNavigate: (
  gameName: string,
  boardJson: Cell<string>,
  bagJson: Cell<string>,
  bagIndex: Cell<number>,
  playersJson: Cell<string>,
  gameEventsJson: Cell<string>,
  allRacksJson: Cell<string>,
  allPlacedJson: Cell<string>,
  myName: string
) => unknown = null as any;

const joinGame = handler<
  unknown,
  {
    gameName: string;
    nameInput: Cell<string>;
    boardJson: Cell<string>;
    bagJson: Cell<string>;
    bagIndex: Cell<number>;
    playersJson: Cell<string>;
    gameEventsJson: Cell<string>;
    allRacksJson: Cell<string>;
    allPlacedJson: Cell<string>;
  }
>((_event, { gameName, nameInput, boardJson, bagJson, bagIndex, playersJson, gameEventsJson, allRacksJson, allPlacedJson }) => {
  console.log("[joinGame] Handler started");
  const name = nameInput.get().trim();
  if (!name) {
    console.log("[joinGame] No name entered, returning");
    return;
  }
  console.log("[joinGame] Name:", name);

  // Lazy initialize bag if empty
  let currentBagJson = bagJson.get();
  if (!currentBagJson || currentBagJson === "") {
    console.log("[joinGame] Bag is empty, initializing fresh tile bag...");
    const freshBag = createTileBag();
    currentBagJson = JSON.stringify(freshBag);
    bagJson.set(currentBagJson);
    console.log("[joinGame] Fresh bag created with", freshBag.length, "tiles");
  }

  // Initialize board if empty
  let currentBoardJson = boardJson.get();
  if (!currentBoardJson || currentBoardJson === "") {
    boardJson.set("[]");
    currentBoardJson = "[]";
  }

  const existingPlayers = parsePlayersJson(playersJson.get());
  console.log("[joinGame] Existing players:", existingPlayers.length);

  if (existingPlayers.length >= MAX_PLAYERS) {
    console.log("[joinGame] Game is full");
    return;
  }

  // Check if name already exists (rejoining)
  const existingPlayer = existingPlayers.find((p) => p.name === name);
  if (existingPlayer) {
    console.log("[joinGame] Rejoining as existing player");
    nameInput.set("");
    if (createGameAndNavigate) {
      return createGameAndNavigate(gameName, boardJson, bagJson, bagIndex, playersJson, gameEventsJson, allRacksJson, allPlacedJson, name);
    }
    return;
  }

  // Draw 7 tiles
  console.log("[joinGame] Drawing tiles from bag...");
  const currentIndex = bagIndex.get();
  const drawnTiles = drawTilesFromBag(currentBagJson, currentIndex, 7);
  console.log("[joinGame] Drew tiles:", drawnTiles.map(t => t.char).join(","));

  const newIndex = currentIndex + drawnTiles.length;
  bagIndex.set(newIndex);
  console.log("[joinGame] Bag index updated to:", newIndex);

  // Store in allRacksJson (using JSON string to avoid Cell array corruption)
  console.log("[joinGame] Storing tiles in allRacksJson...");
  const currentAllRacks = parseAllRacksJson(allRacksJson.get());
  currentAllRacks[name] = drawnTiles;
  allRacksJson.set(JSON.stringify(currentAllRacks));
  console.log("[joinGame] allRacksJson updated for player:", name);

  // Initialize empty placed tiles (using JSON string to avoid Cell array corruption)
  const currentAllPlaced = parseAllPlacedJson(allPlacedJson.get());
  currentAllPlaced[name] = [];
  allPlacedJson.set(JSON.stringify(currentAllPlaced));

  // Add player (using JSON string to avoid Cell array corruption)
  const playerIndex = existingPlayers.length;
  console.log("[joinGame] Adding player at index:", playerIndex);
  const newPlayer: Player = {
    name,
    color: getRandomColor(playerIndex),
    score: 0,
    joinedAt: Date.now(),
  };
  existingPlayers.push(newPlayer);
  playersJson.set(JSON.stringify(existingPlayers));
  console.log("[joinGame] Player added");

  // Add join event (using JSON string to avoid Cell array corruption)
  const existingEvents = parseGameEventsJson(gameEventsJson.get());
  existingEvents.push({
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: "join",
    player: name,
    details: `${name} joined the game (drew ${drawnTiles.length} tiles)`,
    timestamp: Date.now(),
  });
  gameEventsJson.set(JSON.stringify(existingEvents));
  console.log("[joinGame] Event added");

  nameInput.set("");

  // Navigate to game room
  console.log("[joinGame] About to call createGameAndNavigate...");
  if (createGameAndNavigate) {
    console.log("[joinGame] createGameAndNavigate is defined, calling it...");
    const result = createGameAndNavigate(gameName, boardJson, bagJson, bagIndex, playersJson, gameEventsJson, allRacksJson, allPlacedJson, name);
    console.log("[joinGame] createGameAndNavigate returned:", result);
    return result;
  } else {
    console.log("[joinGame] ERROR: createGameAndNavigate is null!");
  }
});

const ScrabbleLobby = pattern<LobbyInput, LobbyOutput>(
  ({ gameName, boardJson, bagJson, bagIndex, playersJson, gameEventsJson, allRacksJson, allPlacedJson }) => {
    const nameInput = cell("");

    // Parse players from JSON for UI display - use derive() for proper reactivity
    const currentPlayers = derive(playersJson, (json: string) => parsePlayersJson(json));
    const playerCount = derive(currentPlayers, (p: Player[]) => p.length);
    const isFull = derive(currentPlayers, (p: Player[]) => p.length >= MAX_PLAYERS);

    return {
      [NAME]: str`${gameName} - Lobby`,
      [UI]: (
        <div
          style={{
            display: "flex",
            height: "100%",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            backgroundColor: "#2d5016",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "2rem",
            }}
          >
            <h1 style={{ marginBottom: "0.5rem", color: "#fff", fontSize: "2.5rem", fontWeight: "bold" }}>
              SCRABBLE
            </h1>
            <p style={{ marginBottom: "0.5rem", color: "#c5e1a5", fontSize: "1.2rem" }}>{gameName}</p>
            <p style={{ marginBottom: "2rem", color: "#a5d6a7" }}>Free-for-all multiplayer - no turns!</p>

            <div
              style={{
                width: "100%",
                maxWidth: "400px",
                padding: "1.5rem",
                backgroundColor: isFull ? "#fee2e2" : "#dbeafe",
                borderRadius: "12px",
                border: isFull ? "2px solid #ef4444" : "2px solid #3b82f6",
              }}
            >
              <div
                style={{
                  fontSize: "1rem",
                  fontWeight: "600",
                  marginBottom: "1rem",
                  color: isFull ? "#dc2626" : "#1e40af",
                }}
              >
                {isFull ? "Game Full - 2/2 Players" : `Enter Your Name (${playerCount}/2 players)`}
              </div>
              <ct-input
                $value={nameInput}
                placeholder="Your name..."
                style="width: 100%; margin-bottom: 1rem;"
                timingStrategy="immediate"
                disabled={isFull}
                onct-submit={joinGame({ gameName, nameInput, boardJson, bagJson, bagIndex, playersJson, gameEventsJson, allRacksJson, allPlacedJson })}
              />
              <ct-button
                style={`width: 100%; font-weight: 600; padding: 0.75rem; font-size: 1rem; ${
                  isFull
                    ? "background-color: #9ca3af; color: #6b7280; cursor: not-allowed;"
                    : "background-color: #3b82f6; color: white;"
                }`}
                disabled={isFull}
                onClick={joinGame({ gameName, nameInput, boardJson, bagJson, bagIndex, playersJson, gameEventsJson, allRacksJson, allPlacedJson })}
              >
                {isFull ? "Game Full" : "Join Game"}
              </ct-button>
            </div>

            <p
              style={{
                marginTop: "1.5rem",
                fontSize: "0.875rem",
                color: "#fef3c7",
                backgroundColor: "#78350f",
                padding: "0.75rem 1rem",
                borderRadius: "8px",
                maxWidth: "400px",
                textAlign: "center",
              }}
            >
              <strong>Tip:</strong> Both players can place and submit words at the same time!
            </p>
          </div>

          <div
            style={{
              width: "120px",
              padding: "1rem",
              backgroundColor: "#1a3009",
              borderLeft: "1px solid #4a7c23",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: "600",
                color: "#a5d6a7",
                textAlign: "center",
                marginBottom: "0.5rem",
              }}
            >
              PLAYERS
            </div>

            {[0, 1].map((slot) => {
              const hasPlayer = derive(currentPlayers, (p: Player[]) => !!p[slot]);
              const playerColor = derive(currentPlayers, (p: Player[]) => p[slot]?.color || "#3f3f46");
              const playerName = derive(currentPlayers, (p: Player[]) => p[slot]?.name || `Player ${slot + 1}`);
              const playerInitials = derive(currentPlayers, (p: Player[]) => p[slot] ? getInitials(p[slot].name) : "?");
              return (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    padding: "0.5rem",
                    backgroundColor: playerColor,
                    borderRadius: "8px",
                    opacity: hasPlayer ? 1 : 0.5,
                  }}
                >
                  <div
                    style={{
                      width: "48px",
                      height: "48px",
                      borderRadius: "50%",
                      backgroundColor: hasPlayer ? "rgba(255,255,255,0.2)" : "#52525b",
                      color: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: "600",
                      fontSize: "14px",
                    }}
                  >
                    {playerInitials}
                  </div>
                  <div
                    style={{
                      marginTop: "0.25rem",
                      fontSize: "0.75rem",
                      color: "white",
                      textAlign: "center",
                      maxWidth: "100px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {playerName}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ),
      gameName,
      boardJson,
      bagJson,
      bagIndex,
      playersJson,
      gameEventsJson,
      allRacksJson,
      allPlacedJson,
    };
  }
);

createGameAndNavigate = (
  gameName: string,
  boardJson: Cell<string>,
  bagJson: Cell<string>,
  bagIndex: Cell<number>,
  playersJson: Cell<string>,
  gameEventsJson: Cell<string>,
  allRacksJson: Cell<string>,
  allPlacedJson: Cell<string>,
  myName: string
) => {
  console.log("[createGameAndNavigate] Starting...");
  console.log("[createGameAndNavigate] myName:", myName);
  const racks = parseAllRacksJson(allRacksJson.get());
  console.log("[createGameAndNavigate] allRacksJson keys:", Object.keys(racks));

  console.log("[createGameAndNavigate] Creating ScrabbleGame instance...");
  const gameInstance = ScrabbleGame({
    gameName,
    boardJson,
    bagJson,
    bagIndex,
    playersJson,
    gameEventsJson,
    allRacksJson,
    allPlacedJson,
    myName,
  });
  console.log("[createGameAndNavigate] ScrabbleGame instance created:", gameInstance);

  console.log("[createGameAndNavigate] Calling navigateTo...");
  const navResult = navigateTo(gameInstance);
  console.log("[createGameAndNavigate] navigateTo returned:", navResult);
  return navResult;
};

export default ScrabbleLobby;
