/**
 * Battleship Multiplayer - Shared Types and Helpers
 *
 * Used by both battleship-lobby.tsx and battleship-room.tsx
 */

// =============================================================================
// Types
// =============================================================================

export type Coordinate = { row: number; col: number };

export type ShipType =
  | "carrier"
  | "battleship"
  | "cruiser"
  | "submarine"
  | "destroyer";

export interface Ship {
  type: ShipType;
  start: Coordinate;
  orientation: "horizontal" | "vertical";
}

export type SquareState = "empty" | "miss" | "hit";

export interface PlayerData {
  name: string;
  ships: Ship[];
  color: string;
  joinedAt: number;
}

export interface GameStateData {
  phase: "waiting" | "playing" | "finished";
  currentTurn: 1 | 2;
  winner: 1 | 2 | null;
  lastMessage: string;
}

// Shots keyed by player number ("1" or "2") - shots RECEIVED by that player
export type ShotsData = Record<string, SquareState[][]>;

// =============================================================================
// Constants
// =============================================================================

export const BOARD_SIZE = 10;

export const SHIP_SIZES: Record<ShipType, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

export const SHIP_NAMES: Record<ShipType, string> = {
  carrier: "Carrier",
  battleship: "Battleship",
  cruiser: "Cruiser",
  submarine: "Submarine",
  destroyer: "Destroyer",
};

export const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
export const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
export const GRID_INDICES = ROWS.flatMap((r) =>
  ROWS.map((c) => ({ row: r, col: c }))
);

export const PLAYER_COLORS = ["#3b82f6", "#ef4444"]; // Blue, Red

// =============================================================================
// Helper Functions
// =============================================================================

export function createEmptyGrid(): SquareState[][] {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => "empty" as SquareState)
  );
}

export function getShipCoordinates(ship: Ship): Coordinate[] {
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

export function findShipAt(ships: Ship[], coord: Coordinate): Ship | null {
  for (const ship of ships) {
    const shipCoords = getShipCoordinates(ship);
    if (shipCoords.some((c) => c.row === coord.row && c.col === coord.col)) {
      return ship;
    }
  }
  return null;
}

export function isShipSunk(ship: Ship, shots: SquareState[][]): boolean {
  const coords = getShipCoordinates(ship);
  return coords.every((c) => shots[c.row]?.[c.col] === "hit");
}

export function areAllShipsSunk(ships: Ship[], shots: SquareState[][]): boolean {
  return ships.every((ship) => isShipSunk(ship, shots));
}

export function buildShipPositions(ships: Ship[]): Record<string, ShipType> {
  const positions: Record<string, ShipType> = {};
  for (const ship of ships) {
    const coords = getShipCoordinates(ship);
    for (const c of coords) {
      positions[`${c.row},${c.col}`] = ship.type;
    }
  }
  return positions;
}

// =============================================================================
// Ship Placement
// =============================================================================

function canPlaceShip(
  ship: Ship,
  occupiedPositions: Set<string>
): boolean {
  const coords = getShipCoordinates(ship);
  // Check bounds
  for (const c of coords) {
    if (c.row < 0 || c.row >= BOARD_SIZE || c.col < 0 || c.col >= BOARD_SIZE) {
      return false;
    }
    if (occupiedPositions.has(`${c.row},${c.col}`)) {
      return false;
    }
  }
  return true;
}

export function generateRandomShips(): Ship[] {
  const ships: Ship[] = [];
  const occupiedPositions = new Set<string>();
  const shipTypes: ShipType[] = [
    "carrier",
    "battleship",
    "cruiser",
    "submarine",
    "destroyer",
  ];

  for (const type of shipTypes) {
    let placed = false;
    let attempts = 0;
    const maxAttempts = 100;

    while (!placed && attempts < maxAttempts) {
      attempts++;
      const orientation: "horizontal" | "vertical" =
        Math.random() < 0.5 ? "horizontal" : "vertical";
      const size = SHIP_SIZES[type];

      const maxRow = orientation === "vertical" ? BOARD_SIZE - size : BOARD_SIZE - 1;
      const maxCol = orientation === "horizontal" ? BOARD_SIZE - size : BOARD_SIZE - 1;

      const row = Math.floor(Math.random() * (maxRow + 1));
      const col = Math.floor(Math.random() * (maxCol + 1));

      const ship: Ship = { type, start: { row, col }, orientation };

      if (canPlaceShip(ship, occupiedPositions)) {
        ships.push(ship);
        const coords = getShipCoordinates(ship);
        for (const c of coords) {
          occupiedPositions.add(`${c.row},${c.col}`);
        }
        placed = true;
      }
    }

    if (!placed) {
      // Fallback: use a deterministic placement
      console.warn(`Failed to place ${type} randomly, using fallback`);
    }
  }

  return ships;
}

// =============================================================================
// JSON Parsing Helpers (handle both string and auto-deserialized objects)
// =============================================================================

export function parsePlayerJson(input: unknown): PlayerData | null {
  if (input === null || input === undefined) return null;
  if (input === "null" || input === "") return null;

  if (typeof input === "object" && !Array.isArray(input)) {
    try {
      const cloned = JSON.parse(JSON.stringify(input));
      if (cloned && typeof cloned.name === "string") {
        return cloned as PlayerData;
      }
    } catch (e) {
      console.error("[parsePlayerJson] Failed to clone object:", e);
    }
    return null;
  }

  if (typeof input === "string") {
    if (input === "null" || input === "") return null;
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed.name === "string") {
        return parsed as PlayerData;
      }
    } catch (e) {
      console.error("[parsePlayerJson] Failed to parse string:", e);
    }
    return null;
  }

  return null;
}

export function parseGameStateJson(input: unknown): GameStateData {
  const defaultState: GameStateData = {
    phase: "waiting",
    currentTurn: 1,
    winner: null,
    lastMessage: "Waiting for players...",
  };

  if (input === null || input === undefined) return defaultState;
  if (input === "{}" || input === "") return defaultState;

  if (typeof input === "object" && !Array.isArray(input)) {
    try {
      const cloned = JSON.parse(JSON.stringify(input));
      if (cloned && typeof cloned.phase === "string") {
        return cloned as GameStateData;
      }
    } catch (e) {
      console.error("[parseGameStateJson] Failed to clone object:", e);
    }
    return defaultState;
  }

  if (typeof input === "string") {
    if (input === "{}" || input === "") return defaultState;
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed.phase === "string") {
        return parsed as GameStateData;
      }
    } catch (e) {
      console.error("[parseGameStateJson] Failed to parse string:", e);
    }
    return defaultState;
  }

  return defaultState;
}

export function parseShotsJson(input: unknown): ShotsData {
  const defaultShots: ShotsData = {
    "1": createEmptyGrid(),
    "2": createEmptyGrid(),
  };

  if (input === null || input === undefined) return defaultShots;
  if (input === "{}" || input === "") return defaultShots;

  if (typeof input === "object" && !Array.isArray(input)) {
    try {
      const cloned = JSON.parse(JSON.stringify(input));
      if (cloned && (cloned["1"] || cloned["2"])) {
        return {
          "1": cloned["1"] || createEmptyGrid(),
          "2": cloned["2"] || createEmptyGrid(),
        };
      }
    } catch (e) {
      console.error("[parseShotsJson] Failed to clone object:", e);
    }
    return defaultShots;
  }

  if (typeof input === "string") {
    if (input === "{}" || input === "") return defaultShots;
    try {
      const parsed = JSON.parse(input);
      if (parsed && (parsed["1"] || parsed["2"])) {
        return {
          "1": parsed["1"] || createEmptyGrid(),
          "2": parsed["2"] || createEmptyGrid(),
        };
      }
    } catch (e) {
      console.error("[parseShotsJson] Failed to parse string:", e);
    }
    return defaultShots;
  }

  return defaultShots;
}

export function getRandomColor(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

export function getInitials(name: string): string {
  if (!name || typeof name !== "string") return "?";
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
