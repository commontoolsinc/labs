/// <cts-enable />
/**
 * Battleship Pass-and-Play - Shared Schemas
 *
 * Type definitions, constants, and helper functions used by the
 * pass-and-play Battleship game pattern.
 */

// ============ CORE TYPES ============

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

export interface PlayerBoard {
  ships: Ship[];
  shots: SquareState[][]; // 10x10 grid - shots RECEIVED from opponent
}

export interface GameState {
  phase: "playing" | "finished";
  currentTurn: 1 | 2;
  player1: PlayerBoard;
  player2: PlayerBoard;
  winner: 1 | 2 | null;
  lastMessage: string;
  viewingAs: 1 | 2 | null; // null = full transition screen (ready to reveal)
  awaitingPass: boolean; // true = show result + pass button, board locked
}

// ============ CONSTANTS ============

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

// ============ HELPER FUNCTIONS ============

export function createEmptyGrid(): SquareState[][] {
  return Array.from(
    { length: 10 },
    () => Array.from({ length: 10 }, () => "empty" as SquareState),
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
  return coords.every((c) => shots[c.row][c.col] === "hit");
}

export function areAllShipsSunk(
  ships: Ship[],
  shots: SquareState[][],
): boolean {
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

// Default ship placements for testing
export function createDefaultShips1(): Ship[] {
  return [
    { type: "carrier", start: { row: 0, col: 0 }, orientation: "horizontal" },
    {
      type: "battleship",
      start: { row: 2, col: 1 },
      orientation: "horizontal",
    },
    { type: "cruiser", start: { row: 4, col: 3 }, orientation: "vertical" },
    { type: "submarine", start: { row: 5, col: 7 }, orientation: "horizontal" },
    { type: "destroyer", start: { row: 8, col: 5 }, orientation: "vertical" },
  ];
}

export function createDefaultShips2(): Ship[] {
  return [
    { type: "carrier", start: { row: 1, col: 2 }, orientation: "vertical" },
    {
      type: "battleship",
      start: { row: 0, col: 6 },
      orientation: "horizontal",
    },
    { type: "cruiser", start: { row: 3, col: 0 }, orientation: "horizontal" },
    { type: "submarine", start: { row: 7, col: 4 }, orientation: "vertical" },
    { type: "destroyer", start: { row: 9, col: 8 }, orientation: "horizontal" },
  ];
}

export function createInitialState(): GameState {
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
    lastMessage: "Player 1's turn",
    viewingAs: null, // Start with transition screen
    awaitingPass: false,
  };
}
