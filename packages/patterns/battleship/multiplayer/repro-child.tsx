/// <cts-enable />
/**
 * Child pattern in separate file (mimics room.tsx EXACTLY)
 *
 * Uses the ACTUAL RoomInput type from schemas.tsx
 */

import { action, computed, NAME, pattern, UI } from "commontools";
import type { RoomInput, RoomOutput } from "./schemas.tsx";

const ChildPattern = pattern<RoomInput, RoomOutput>(
  ({ player1, player2, myPlayerNumber, shots, gameState, myName, gameName: _gameName }) => {
    // Action to test reading opponent data (EXACTLY like battleship's fireShot)
    const fireShot = action<{ row: number; col: number }>(({ row, col }) => {
      console.log("[fireShot] Called with row:", row, "col:", col);

      const oppNum = myPlayerNumber === 1 ? 2 : 1;
      const opp = oppNum === 1 ? player1.get() : player2.get();

      if (!opp) {
        console.log("[fireShot] No opponent data");
        return;
      }

      // Log what we see - this is the key test
      console.log("[fireShot] opponent data:", opp);
      console.log("[fireShot] opp.ships:", opp.ships);
      console.log("[fireShot] opp.ships.length:", opp.ships?.length);
      if (opp.ships && opp.ships.length > 0) {
        console.log("[fireShot] opp.ships[0]:", opp.ships[0]);
        console.log("[fireShot] opp.ships[0]?.type:", opp.ships[0]?.type);
        console.log("[fireShot] opp.ships[0]?.start:", opp.ships[0]?.start);
        console.log("[fireShot] opp.ships[0]?.start?.row:", opp.ships[0]?.start?.row);
      }
    });

    // Also keep computed for comparison
    const opponentData = computed(() => {
      const oppNum = myPlayerNumber === 1 ? 2 : 1;
      const opp = oppNum === 1 ? player1.get() : player2.get();

      if (!opp) {
        console.log("[Computed] No opponent data");
        return null;
      }

      console.log("[Computed] opponent data:", opp);
      console.log("[Computed] opp.ships:", opp.ships);
      console.log("[Computed] opp.ships.length:", opp.ships?.length);
      if (opp.ships && opp.ships.length > 0) {
        console.log("[Computed] opp.ships[0]:", opp.ships[0]);
        console.log("[Computed] opp.ships[0]?.type:", opp.ships[0]?.type);
      }

      return opp;
    });

    const shipsList = computed(() => {
      const d = opponentData;
      if (!d) return "No opponent data";
      const ships = d.ships || [];
      const validShips = ships.filter((s) => s != null && s.type != null);
      return `Opponent ships: ${ships.length} total, ${validShips.length} valid. Types: ${
        validShips.map((s) => s.type).join(", ") || "(none)"
      }`;
    });

    // Also log shots and gameState to see if they resolve
    const _shotsData = computed(() => {
      const s = shots.get();
      console.log("[Computed] shots:", s);
      return s;
    });

    const _gameStateData = computed(() => {
      const g = gameState.get();
      console.log("[Computed] gameState:", g);
      return g;
    });

    return {
      [NAME]: computed(() => `Child (Player ${myPlayerNumber})`),
      [UI]: (
        <div style={{ padding: "20px", backgroundColor: "#1e293b", color: "#fff" }}>
          <h2>Child Pattern - Player {myPlayerNumber}</h2>
          <p>Opponent: {opponentData?.name || "null"}</p>
          <p>{shipsList}</p>
          <ct-button onClick={() => fireShot.send({ row: 0, col: 0 })}>
            Fire Shot (test reading opponent ships)
          </ct-button>
        </div>
      ),
      myPlayerNumber,
      myName,
      fireShot,
    };
  },
);

export default ChildPattern;
