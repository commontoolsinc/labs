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
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";

import ScrabbleGame, {
  createTileBag,
  drawTilesFromBag,
  getRandomColor,
  parseAllPlacedJson,
  parseAllRacksJson,
  parseGameEventsJson,
  parsePlayersJson,
  Player,
} from "./scrabble-game.tsx";

// =============================================================================
// LOBBY PATTERN
// =============================================================================

interface LobbyInput {
  gameName: Default<string, "Scrabble Match">;
  boardJson: Writable<Default<string, "">>; // JSON string of PlacedTile[]
  bagJson: Writable<Default<string, "">>;
  bagIndex: Writable<Default<number, 0>>;
  playersJson: Writable<Default<string, "[]">>; // JSON string of Player[]
  gameEventsJson: Writable<Default<string, "[]">>; // JSON string of GameEvent[]
  allRacksJson: Writable<Default<string, "{}">>; // JSON string of AllRacks
  allPlacedJson: Writable<Default<string, "{}">>; // JSON string of AllPlaced
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
  boardJson: Writable<string>,
  bagJson: Writable<string>,
  bagIndex: Writable<number>,
  playersJson: Writable<string>,
  gameEventsJson: Writable<string>,
  allRacksJson: Writable<string>,
  allPlacedJson: Writable<string>,
  myName: string,
) => unknown = null as any;

// Handler for joining as a specific player slot (0 or 1)
const joinAsPlayer = handler<
  unknown,
  {
    gameName: string;
    nameInput: Writable<string>;
    playerSlot: number;
    boardJson: Writable<string>;
    bagJson: Writable<string>;
    bagIndex: Writable<number>;
    playersJson: Writable<string>;
    gameEventsJson: Writable<string>;
    allRacksJson: Writable<string>;
    allPlacedJson: Writable<string>;
  }
>((
  _event,
  {
    gameName,
    nameInput,
    playerSlot,
    boardJson,
    bagJson,
    bagIndex,
    playersJson,
    gameEventsJson,
    allRacksJson,
    allPlacedJson,
  },
) => {
  console.log(`[joinAsPlayer] Handler started for slot ${playerSlot}`);
  const name = nameInput.get().trim();
  if (!name) {
    console.log("[joinAsPlayer] No name entered, returning");
    return;
  }
  console.log("[joinAsPlayer] Name:", name, "Slot:", playerSlot);

  // Lazy initialize bag if empty
  let currentBagJson = bagJson.get();
  if (!currentBagJson || currentBagJson === "") {
    console.log("[joinAsPlayer] Bag is empty, initializing fresh tile bag...");
    const freshBag = createTileBag();
    currentBagJson = JSON.stringify(freshBag);
    bagJson.set(currentBagJson);
    console.log(
      "[joinAsPlayer] Fresh bag created with",
      freshBag.length,
      "tiles",
    );
  }

  // Initialize board if empty
  let currentBoardJson = boardJson.get();
  if (!currentBoardJson || currentBoardJson === "") {
    boardJson.set("[]");
    currentBoardJson = "[]";
  }

  // Draw 7 tiles for this player
  console.log("[joinAsPlayer] Drawing tiles from bag...");
  const currentIndex = bagIndex.get();
  const drawnTiles = drawTilesFromBag(currentBagJson, currentIndex, 7);
  console.log(
    "[joinAsPlayer] Drew tiles:",
    drawnTiles.map((t) => t.char).join(","),
  );

  const newIndex = currentIndex + drawnTiles.length;
  bagIndex.set(newIndex);
  console.log("[joinAsPlayer] Bag index updated to:", newIndex);

  // Store rack for this player
  const currentAllRacks = parseAllRacksJson(allRacksJson.get());
  currentAllRacks[name] = drawnTiles;
  allRacksJson.set(JSON.stringify(currentAllRacks));
  console.log("[joinAsPlayer] Rack stored for:", name);

  // Initialize empty placed tiles for this player
  const currentAllPlaced = parseAllPlacedJson(allPlacedJson.get());
  currentAllPlaced[name] = [];
  allPlacedJson.set(JSON.stringify(currentAllPlaced));

  // Create/update player at the specified slot
  const existingPlayers = parsePlayersJson(playersJson.get());
  const newPlayer: Player = {
    name,
    color: getRandomColor(playerSlot),
    score: 0,
    joinedAt: Temporal.Now.instant().epochMilliseconds,
  };

  // Ensure array is big enough and set at exact slot
  while (existingPlayers.length <= playerSlot) {
    existingPlayers.push(null as any);
  }
  existingPlayers[playerSlot] = newPlayer;
  // Filter out any null entries if slot 1 was set before slot 0
  const cleanedPlayers = existingPlayers.filter((p) => p !== null);
  playersJson.set(JSON.stringify(cleanedPlayers));
  console.log("[joinAsPlayer] Player added at slot:", playerSlot);

  // Add join event
  const existingEvents = parseGameEventsJson(gameEventsJson.get());
  existingEvents.push({
    id: `event-${randomUUID()}`,
    type: "join",
    player: name,
    details: `${name} joined as Player ${playerSlot + 1}`,
    timestamp: Temporal.Now.instant().epochMilliseconds,
  });
  gameEventsJson.set(JSON.stringify(existingEvents));

  nameInput.set("");

  // Navigate to game room
  console.log("[joinAsPlayer] Navigating to game room...");
  if (createGameAndNavigate) {
    return createGameAndNavigate(
      gameName,
      boardJson,
      bagJson,
      bagIndex,
      playersJson,
      gameEventsJson,
      allRacksJson,
      allPlacedJson,
      name,
    );
  }
});

// Handler to reset the lobby (clear all game state)
const resetLobby = handler<
  unknown,
  {
    boardJson: Writable<string>;
    bagJson: Writable<string>;
    bagIndex: Writable<number>;
    playersJson: Writable<string>;
    gameEventsJson: Writable<string>;
    allRacksJson: Writable<string>;
    allPlacedJson: Writable<string>;
  }
>((
  _event,
  {
    boardJson,
    bagJson,
    bagIndex,
    playersJson,
    gameEventsJson,
    allRacksJson,
    allPlacedJson,
  },
) => {
  console.log("[resetLobby] Resetting all game state...");

  // Clear all state
  boardJson.set("[]");
  bagIndex.set(0);
  playersJson.set("[]");
  gameEventsJson.set("[]");
  allRacksJson.set("{}");
  allPlacedJson.set("{}");

  // Initialize fresh bag
  const freshBag = createTileBag();
  bagJson.set(JSON.stringify(freshBag));

  console.log("[resetLobby] Game state reset complete");
});

const ScrabbleLobby = pattern<LobbyInput, LobbyOutput>(
  (
    {
      gameName,
      boardJson,
      bagJson,
      bagIndex,
      playersJson,
      gameEventsJson,
      allRacksJson,
      allPlacedJson,
    },
  ) => {
    // Separate name inputs for each player slot
    const player1NameInput = Writable.of("");
    const player2NameInput = Writable.of("");

    // Derive player data reactively from playersJson
    const player1 = computed(() => {
      const players = parsePlayersJson(playersJson.get());
      return players[0] || null;
    });
    const player2 = computed(() => {
      const players = parsePlayersJson(playersJson.get());
      return players[1] || null;
    });
    const player1Name = computed(() => player1?.name || null);
    const player2Name = computed(() => player2?.name || null);

    return {
      [NAME]: computed(() => `${gameName} - Lobby`),
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
            <h1
              style={{
                marginBottom: "0.5rem",
                color: "#fff",
                fontSize: "3rem",
                fontWeight: "700",
                letterSpacing: "-0.02em",
              }}
            >
              SCRABBLE
            </h1>
            <p
              style={{
                marginBottom: "2.5rem",
                color: "rgba(255,255,255,0.7)",
                fontSize: "1.1rem",
              }}
            >
              Free-for-all multiplayer — no turns!
            </p>

            {/* Two Player Join Sections */}
            <div
              style={{ display: "flex", gap: "1.5rem", marginBottom: "1.5rem" }}
            >
              {/* Player 1 Section */}
              <div
                style={{
                  width: "240px",
                  padding: "1.5rem",
                  backgroundColor: "white",
                  borderRadius: "16px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: "500",
                    color: "#86868b",
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
                          fontSize: "1.25rem",
                          fontWeight: "600",
                          color: "#1d1d1f",
                          marginBottom: "0.5rem",
                        }}
                      >
                        {player1Name}
                      </div>
                      <div style={{ fontSize: "0.875rem", color: "#86868b" }}>
                        Now playing
                      </div>
                    </div>
                  )
                  : (
                    <>
                      <ct-input
                        $value={player1NameInput}
                        placeholder="Your name"
                        style="width: 100%; margin-bottom: 1rem;"
                        timingStrategy="immediate"
                      />
                      <button
                        type="button"
                        style={{
                          width: "100%",
                          padding: "0.75rem 1.5rem",
                          fontSize: "1rem",
                          backgroundColor: "#3d7c1f",
                          color: "white",
                          fontWeight: "600",
                          border: "none",
                          borderRadius: "8px",
                          cursor: "pointer",
                        }}
                        onClick={joinAsPlayer({
                          gameName,
                          nameInput: player1NameInput,
                          playerSlot: 0,
                          boardJson,
                          bagJson,
                          bagIndex,
                          playersJson,
                          gameEventsJson,
                          allRacksJson,
                          allPlacedJson,
                        })}
                      >
                        Join
                      </button>
                    </>
                  )}
              </div>

              {/* Player 2 Section */}
              <div
                style={{
                  width: "240px",
                  padding: "1.5rem",
                  backgroundColor: "white",
                  borderRadius: "16px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: "500",
                    color: "#86868b",
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
                          fontSize: "1.25rem",
                          fontWeight: "600",
                          color: "#1d1d1f",
                          marginBottom: "0.5rem",
                        }}
                      >
                        {player2Name}
                      </div>
                      <div style={{ fontSize: "0.875rem", color: "#86868b" }}>
                        Now playing
                      </div>
                    </div>
                  )
                  : (
                    <>
                      <ct-input
                        $value={player2NameInput}
                        placeholder="Your name"
                        style="width: 100%; margin-bottom: 1rem;"
                        timingStrategy="immediate"
                      />
                      <button
                        type="button"
                        style={{
                          width: "100%",
                          padding: "0.75rem 1.5rem",
                          fontSize: "1rem",
                          backgroundColor: "#3d7c1f",
                          color: "white",
                          fontWeight: "600",
                          border: "none",
                          borderRadius: "8px",
                          cursor: "pointer",
                        }}
                        onClick={joinAsPlayer({
                          gameName,
                          nameInput: player2NameInput,
                          playerSlot: 1,
                          boardJson,
                          bagJson,
                          bagIndex,
                          playersJson,
                          gameEventsJson,
                          allRacksJson,
                          allPlacedJson,
                        })}
                      >
                        Join
                      </button>
                    </>
                  )}
              </div>
            </div>

            {/* Reset Button */}
            <button
              type="button"
              style={{
                marginTop: "1rem",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                background: "none",
                color: "rgba(255,255,255,0.6)",
                fontWeight: "400",
                border: "none",
                cursor: "pointer",
              }}
              onClick={resetLobby({
                boardJson,
                bagJson,
                bagIndex,
                playersJson,
                gameEventsJson,
                allRacksJson,
                allPlacedJson,
              })}
            >
              Reset
            </button>
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
  },
);

createGameAndNavigate = (
  gameName: string,
  boardJson: Writable<string>,
  bagJson: Writable<string>,
  bagIndex: Writable<number>,
  playersJson: Writable<string>,
  gameEventsJson: Writable<string>,
  allRacksJson: Writable<string>,
  allPlacedJson: Writable<string>,
  myName: string,
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
  console.log(
    "[createGameAndNavigate] ScrabbleGame instance created:",
    gameInstance,
  );

  console.log("[createGameAndNavigate] Calling navigateTo...");
  const navResult = navigateTo(gameInstance);
  console.log("[createGameAndNavigate] navigateTo returned:", navResult);
  return navResult;
};

export default ScrabbleLobby;
