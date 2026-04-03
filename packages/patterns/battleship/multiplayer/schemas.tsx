/// <cts-enable />
/**
 * Battleship Multiplayer - Schemas
 *
 * Re-exports shared types and constants from the battleship shared infrastructure,
 * plus multiplayer-specific type definitions for proper typed Cells.
 *
 * This eliminates the JSON serialization hacks (player1Json, shotsJson, etc.)
 * in favor of properly typed Cell values.
 */

import { Default, Stream, Writable } from "commontools";

// ============ RE-EXPORT SHARED TYPES ============
export type {
  Coordinate,
  Ship,
  ShipType,
  SquareState,
} from "../shared/index.tsx";

// ============ RE-EXPORT SHARED CONSTANTS ============
export {
  BOARD_SIZE,
  COLS,
  GRID_INDICES,
  PLAYER_COLORS,
  ROWS,
  SHIP_NAMES,
  SHIP_SIZES,
} from "../shared/index.tsx";

// ============ RE-EXPORT SHARED GAME LOGIC ============
export {
  areAllShipsSunk,
  buildShipPositions,
  createEmptyGrid,
  findShipAt,
  generateRandomShips,
  getInitials,
  getRandomColor,
  getShipCoordinates,
  isShipSunk,
} from "../shared/index.tsx";

// ============ MULTIPLAYER-SPECIFIC TYPES ============

import type { Ship, SquareState } from "../shared/index.tsx";
import { createEmptyGrid } from "../shared/index.tsx";

// ============ PLAYER DATA ============

export interface PlayerData {
  name: string;
  ships: Ship[];
  color: string;
  joinedAt: number;
}

// ============ GAME STATE ============

export interface GameState {
  phase: "waiting" | "playing" | "finished";
  currentTurn: 1 | 2;
  winner: 1 | 2 | null;
  lastMessage: string;
}

// ============ SHOTS STATE ============

/**
 * Shots received by each player, indexed by player number.
 * - Key 1: shots that player 1 has received (fired by player 2)
 * - Key 2: shots that player 2 has received (fired by player 1)
 */
export interface ShotsState {
  1: SquareState[][];
  2: SquareState[][];
}

// ============ DEFAULT VALUES ============

export const INITIAL_GAME_STATE: GameState = {
  phase: "waiting",
  currentTurn: 1,
  winner: null,
  lastMessage: "Waiting for players...",
};

export function createInitialShots(): ShotsState {
  return {
    1: createEmptyGrid(),
    2: createEmptyGrid(),
  };
}

// ============ PATTERN INPUT/OUTPUT TYPES ============

/**
 * Lobby pattern owns all shared game state.
 * Uses proper typed Cells instead of JSON strings.
 *
 * Note: shots and gameState use inline default object literals
 * to provide initial values for the complex state objects.
 */
export interface LobbyState {
  gameName: Default<string, "Battleship">;
  player1: Writable<Default<PlayerData | null, null>>;
  player2: Writable<Default<PlayerData | null, null>>;
  shots: Writable<
    Default<
      ShotsState,
      { 1: []; 2: [] }
    >
  >;
  gameState: Writable<
    Default<
      GameState,
      { phase: "waiting"; currentTurn: 1; winner: null; lastMessage: "" }
    >
  >;
}

/**
 * Room pattern receives shared cells plus player identity.
 * The cells are passed by reference from the lobby.
 */
export interface RoomInput {
  gameName: string;
  player1: Writable<PlayerData | null>;
  player2: Writable<PlayerData | null>;
  shots: Writable<ShotsState>;
  gameState: Writable<GameState>;
  myName: string;
  myPlayerNumber: 1 | 2;
}

/**
 * Room pattern output exposes player identity and actions for testing.
 */
export interface RoomOutput {
  myName: string;
  myPlayerNumber: 1 | 2;
  /** Fire a shot at the enemy board - exported for testing */
  fireShot: Stream<{ row: number; col: number }>;
}
