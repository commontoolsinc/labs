/**
 * Battleship Multiplayer
 *
 * A single shared game surface. Shared match state is scoped to the space, while
 * each viewer's name and assigned player slot are scoped per user.
 */

import {
  computed,
  handler,
  NAME,
  pattern,
  type PerSession,
  safeDateNow,
  Stream,
  UI,
  type VNode,
} from "commonfabric";

import BattleshipRoom from "./room.tsx";
import {
  createInitialShots,
  type GameState,
  type GameStateCell,
  generateRandomShips,
  getRandomColor,
  INITIAL_GAME_STATE,
  type LobbyState,
  normalizePlayerNumber,
  type PlayerCell,
  type PlayerData,
  type PlayerNameCell,
  type PlayerNumberCell,
  type ShotsCell,
  type ShotsState,
  trimmedName,
} from "./schemas.tsx";

interface LobbyOutput {
  [UI]: PerSession<VNode>;
  gameName: string;
  player1: PlayerData | null;
  player2: PlayerData | null;
  shots: ShotsState;
  gameState: GameState;
  myName: string;
  myPlayerNumber: 1 | 2 | null;
  joinWithName: Stream<string>;
  joinPlayer1: Stream<{ name: string }>;
  joinPlayer2: Stream<{ name: string }>;
  reset: Stream<void>;
}

const startIfReady = (
  player1: PlayerCell,
  player2: PlayerCell,
  shots: ShotsCell,
  gameState: GameStateCell,
) => {
  const p1 = player1.get();
  const p2 = player2.get();
  if (!p1 || !p2) return;

  shots.set(createInitialShots());
  gameState.set({
    phase: "playing",
    currentTurn: 1,
    winner: null,
    lastMessage: `${p1.name}'s turn - fire at the enemy fleet!`,
  });
};

const joinSlot = (
  slot: 1 | 2,
  name: string,
  player1: PlayerCell,
  player2: PlayerCell,
  shots: ShotsCell,
  gameState: GameStateCell,
) => {
  const playerData: PlayerData = {
    name,
    ships: generateRandomShips(),
    color: getRandomColor(slot - 1),
    joinedAt: safeDateNow(),
  };

  if (slot === 1) {
    player1.set(playerData);
  } else {
    player2.set(playerData);
  }
  startIfReady(player1, player2, shots, gameState);
  return playerData;
};

const joinAvailableSlot = (
  name: string,
  myName: PlayerNameCell,
  myPlayerNumber: PlayerNumberCell,
  player1: PlayerCell,
  player2: PlayerCell,
  shots: ShotsCell,
  gameState: GameStateCell,
) => {
  const existingSlot = normalizePlayerNumber(myPlayerNumber.get());
  if (existingSlot !== null) {
    const slotPlayer = existingSlot === 1 ? player1.get() : player2.get();
    if (slotPlayer && slotPlayer.name === trimmedName(myName.get())) {
      return false;
    }
    myName.set("");
    myPlayerNumber.set(null);
  }

  const slot = !player1.get() ? 1 : !player2.get() ? 2 : null;
  if (slot === null) return false;

  joinSlot(slot, name, player1, player2, shots, gameState);
  myName.set(name);
  myPlayerNumber.set(slot);
  return true;
};

const joinGame = handler<
  void,
  {
    joinName: PlayerNameCell;
    myName: PlayerNameCell;
    myPlayerNumber: PlayerNumberCell;
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
  }
>((
  _event,
  { joinName, myName, myPlayerNumber, player1, player2, shots, gameState },
) => {
  const name = trimmedName(joinName.get());
  if (!name) return;

  if (
    joinAvailableSlot(
      name,
      myName,
      myPlayerNumber,
      player1,
      player2,
      shots,
      gameState,
    )
  ) {
    joinName.set("");
  }
});

const joinWithName = handler<
  string,
  {
    myName: PlayerNameCell;
    myPlayerNumber: PlayerNumberCell;
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
  }
>((
  name,
  { myName, myPlayerNumber, player1, player2, shots, gameState },
) => {
  const trimmed = trimmedName(name);
  if (!trimmed) return;
  joinAvailableSlot(
    trimmed,
    myName,
    myPlayerNumber,
    player1,
    player2,
    shots,
    gameState,
  );
});

const joinPlayer = handler<
  { name: string },
  {
    slot: 1 | 2;
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
  }
>(({ name }, { slot, player1, player2, shots, gameState }) => {
  const trimmed = trimmedName(name);
  if (!trimmed) return;
  joinSlot(slot, trimmed, player1, player2, shots, gameState);
});

const resetGame = handler<
  void,
  {
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
    myName: PlayerNameCell;
    myPlayerNumber: PlayerNumberCell;
    joinName: PlayerNameCell;
  }
>((
  _event,
  { player1, player2, shots, gameState, myName, myPlayerNumber, joinName },
) => {
  player1.set(null);
  player2.set(null);
  shots.set(createInitialShots());
  gameState.set(INITIAL_GAME_STATE);
  myName.set("");
  myPlayerNumber.set(null);
  joinName.set("");
});

const BattleshipLobby = pattern<LobbyState, LobbyOutput>(
  (
    {
      gameName,
      player1,
      player2,
      shots,
      gameState,
      myName,
      myPlayerNumber,
      joinName,
    },
  ) => {
    const sharedCells = { player1, player2, shots, gameState };
    const join = joinGame({
      joinName,
      myName,
      myPlayerNumber,
      ...sharedCells,
    } as any);
    const joinWithNameStream = joinWithName({
      myName,
      myPlayerNumber,
      ...sharedCells,
    } as any);
    const joinPlayer1 = joinPlayer({
      slot: 1,
      ...sharedCells,
    } as any);
    const joinPlayer2 = joinPlayer({
      slot: 2,
      ...sharedCells,
    } as any);
    const reset = resetGame({
      ...sharedCells,
      myName,
      myPlayerNumber,
      joinName,
    } as any);

    const room = BattleshipRoom({
      gameName,
      ...sharedCells,
      myName,
      myPlayerNumber,
    } as any);

    const player1Data = computed(() => player1.get());
    const player2Data = computed(() => player2.get());
    const joined = computed(() => {
      const slot = normalizePlayerNumber(myPlayerNumber.get());
      if (slot === null) return false;
      const player = slot === 1 ? player1.get() : player2.get();
      return !!player && player.name === trimmedName(myName.get());
    });
    const isFull = computed(() => !!player1.get() && !!player2.get());
    const waitingLabel = computed(() => {
      const p1 = player1.get();
      const p2 = player2.get();
      if (p1 && p2) return "Both fleets are deployed.";
      if (p1) return "Waiting for a second captain.";
      return "Join to deploy the first fleet.";
    });

    return {
      [NAME]: computed(() => `${gameName} - Battleship`),
      [UI]: (
        <div
          style={{
            minHeight: "100vh",
            backgroundColor: "#0f172a",
            color: "#e2e8f0",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {joined ? room[UI] : (
            <div
              style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "32px",
              }}
            >
              <section
                style={{
                  width: "min(520px, 100%)",
                  border: "1px solid #334155",
                  borderRadius: "8px",
                  backgroundColor: "#162033",
                  padding: "24px",
                }}
              >
                <h1 style={{ margin: "0 0 8px", fontSize: "32px" }}>
                  BATTLESHIP
                </h1>
                <p style={{ margin: "0 0 20px", color: "#94a3b8" }}>
                  {waitingLabel}
                </p>

                <div
                  style={{
                    display: "grid",
                    gap: "10px",
                    marginBottom: "20px",
                  }}
                >
                  <div>
                    Player 1: {player1Data?.name ?? "Open"}
                  </div>
                  <div>
                    Player 2: {player2Data?.name ?? "Open"}
                  </div>
                </div>

                {isFull
                  ? (
                    <div style={{ color: "#fbbf24", marginBottom: "16px" }}>
                      This game already has two players.
                    </div>
                  )
                  : (
                    <div
                      style={{
                        display: "flex",
                        gap: "10px",
                        alignItems: "center",
                      }}
                    >
                      <cf-input
                        $value={joinName}
                        placeholder="Your name"
                        timing-strategy="immediate"
                        style="flex: 1;"
                      />
                      <cf-button onClick={join}>Join</cf-button>
                    </div>
                  )}

                <cf-button
                  variant="secondary"
                  style="margin-top: 20px;"
                  onClick={reset}
                >
                  Reset game
                </cf-button>
              </section>
            </div>
          )}
        </div>
      ),
      gameName,
      player1: player1Data,
      player2: player2Data,
      shots: computed(() => shots.get()),
      gameState: computed(() => gameState.get()),
      myName: computed(() => myName.get()),
      myPlayerNumber: computed(() =>
        normalizePlayerNumber(myPlayerNumber.get())
      ),
      joinWithName: joinWithNameStream,
      joinPlayer1,
      joinPlayer2,
      reset,
    };
  },
);

export default BattleshipLobby;
