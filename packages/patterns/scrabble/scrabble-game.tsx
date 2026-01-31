/// <cts-enable />
/**
 * Multiplayer Free-for-All Scrabble - Game Room Pattern
 *
 * ARCHITECTURE:
 * - ALL shared state stored as JSON STRINGS (WORKAROUND for framework bug with Cell arrays)
 * - bagJson, boardJson, playersJson, gameEventsJson, allRacksJson, allPlacedJson
 * - Parse functions handle BOTH string and object input (runtime may auto-deserialize)
 *
 * See: scrabble.tsx for the lobby entry point
 */

import {
  computed,
  Default,
  handler,
  lift,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// Word dictionary for validation
import { VALID_WORDS } from "./scrabble-words.ts";

// =============================================================================
// TYPES (exported for lobby to use)
// =============================================================================

export interface Letter {
  char: string;
  points: number;
  id: string;
  isBlank: boolean;
}

export interface PlacedTile {
  letter: Letter;
  row: number;
  col: number;
}

export interface Player {
  name: string;
  color: string;
  score: number;
  joinedAt: number;
}

export interface GameEvent {
  id: string;
  type: "join" | "submit" | "word" | "system";
  player: string;
  details: string;
  timestamp: number;
}

// Types for scoring
interface TileInWord {
  char: string;
  points: number;
  row: number;
  col: number;
  isPlaced: boolean; // true if placed this turn
}

interface WordWithPositions {
  word: string;
  tiles: TileInWord[];
}

interface WordScore {
  word: string;
  score: number;
  breakdown: string;
}

interface TurnScore {
  total: number;
  wordScores: WordScore[];
  bingoBonus: boolean;
}

// Shared per-player state storage (keyed by player name)
export type AllRacks = Record<string, Letter[]>;
export type AllPlaced = Record<string, PlacedTile[]>;

// =============================================================================
// CONSTANTS (exported for lobby to use)
// =============================================================================

// Letter point values (standard Scrabble)
export const LETTER_POINTS: Record<string, number> = {
  A: 1,
  B: 3,
  C: 3,
  D: 2,
  E: 1,
  F: 4,
  G: 2,
  H: 4,
  I: 1,
  J: 8,
  K: 5,
  L: 1,
  M: 3,
  N: 1,
  O: 1,
  P: 3,
  Q: 10,
  R: 1,
  S: 1,
  T: 1,
  U: 1,
  V: 4,
  W: 4,
  X: 8,
  Y: 4,
  Z: 10,
  "": 0, // blank tile
};

// Tile distribution (standard Scrabble - 100 tiles)
export const TILE_DISTRIBUTION: Record<string, number> = {
  A: 9,
  B: 2,
  C: 2,
  D: 4,
  E: 12,
  F: 2,
  G: 3,
  H: 2,
  I: 9,
  J: 1,
  K: 1,
  L: 4,
  M: 2,
  N: 6,
  O: 8,
  P: 2,
  Q: 1,
  R: 6,
  S: 4,
  T: 6,
  U: 4,
  V: 2,
  W: 2,
  X: 1,
  Y: 2,
  Z: 1,
  "": 2, // blank tiles
};

// Board size - standard Scrabble is 15x15
export const BOARD_SIZE = 15;
const CELL_SIZE = 32;
export const MAX_PLAYERS = 2;

// Player colors
export const PLAYER_COLORS = ["#3b82f6", "#ef4444"]; // Blue, Red

// Bonus square types
type BonusType = "none" | "DL" | "TL" | "DW" | "TW" | "star";

// Pre-computed bonus map for O(1) lookup (key: "row,col")
const BONUS_MAP: Map<string, BonusType> = (() => {
  const map = new Map<string, BonusType>();
  map.set("7,7", "star");
  const twPositions = [[0, 0], [0, 7], [0, 14], [7, 0], [7, 14], [14, 0], [
    14,
    7,
  ], [14, 14]];
  for (const [r, c] of twPositions) map.set(`${r},${c}`, "TW");
  const dwPositions = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [1, 13],
    [2, 12],
    [3, 11],
    [4, 10],
    [13, 1],
    [12, 2],
    [11, 3],
    [10, 4],
    [13, 13],
    [12, 12],
    [11, 11],
    [10, 10],
  ];
  for (const [r, c] of dwPositions) map.set(`${r},${c}`, "DW");
  const tlPositions = [
    [1, 5],
    [1, 9],
    [5, 1],
    [5, 5],
    [5, 9],
    [5, 13],
    [9, 1],
    [9, 5],
    [9, 9],
    [9, 13],
    [13, 5],
    [13, 9],
  ];
  for (const [r, c] of tlPositions) map.set(`${r},${c}`, "TL");
  const dlPositions = [
    [0, 3],
    [0, 11],
    [2, 6],
    [2, 8],
    [3, 0],
    [3, 7],
    [3, 14],
    [6, 2],
    [6, 6],
    [6, 8],
    [6, 12],
    [7, 3],
    [7, 11],
    [8, 2],
    [8, 6],
    [8, 8],
    [8, 12],
    [11, 0],
    [11, 7],
    [11, 14],
    [12, 6],
    [12, 8],
    [14, 3],
    [14, 11],
  ];
  for (const [r, c] of dlPositions) map.set(`${r},${c}`, "DL");
  return map;
})();

const getBonusType = (row: number, col: number): BonusType =>
  BONUS_MAP.get(`${row},${col}`) || "none";

const BONUS_COLORS: Record<BonusType, { bg: string; text: string }> = {
  none: { bg: "#d4c4a8", text: "#666" },
  DL: { bg: "#a8d4e6", text: "#0066aa" },
  TL: { bg: "#4a90d9", text: "#fff" },
  DW: { bg: "#f5b7b1", text: "#aa0000" },
  TW: { bg: "#e74c3c", text: "#fff" },
  star: { bg: "#f5b7b1", text: "#aa0000" },
};

const BONUS_LABELS: Record<BonusType, string> = {
  none: "",
  DL: "DL",
  TL: "TL",
  DW: "DW",
  TW: "TW",
  star: "★",
};

// =============================================================================
// JSON PARSING HELPERS
// =============================================================================

export function createTileBag(): Letter[] {
  const bag: Letter[] = [];
  let tileId = Temporal.Now.instant().epochMilliseconds;
  for (const [letter, count] of Object.entries(TILE_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) {
      const isBlank = letter === "";
      bag.push({
        char: isBlank ? "" : letter,
        points: isBlank ? 0 : LETTER_POINTS[letter],
        id: `tile-${tileId++}`,
        isBlank,
      });
    }
  }
  // Fisher-Yates shuffle
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(
      secureRandom() * (i + 1),
    );
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

export function parseBagJson(bagJson: string): Letter[] {
  if (!bagJson || bagJson === "") return [];
  try {
    const parsed = JSON.parse(bagJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("[parseBagJson] Failed:", e);
    return [];
  }
}

export function parseBoardJson(boardJson: string): PlacedTile[] {
  if (!boardJson || boardJson === "") return [];
  try {
    const parsed = JSON.parse(boardJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("[parseBoardJson] Failed:", e);
    return [];
  }
}

export function parsePlayersJson(playersJson: string): Player[] {
  if (!playersJson || playersJson === "") return [];
  try {
    const parsed = JSON.parse(playersJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("[parsePlayersJson] Failed:", e);
    return [];
  }
}

export function parseGameEventsJson(eventsJson: string): GameEvent[] {
  if (!eventsJson || eventsJson === "") return [];
  try {
    const parsed = JSON.parse(eventsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("[parseGameEventsJson] Failed:", e);
    return [];
  }
}

// Handle both string (from lobby) and object (auto-deserialized by runtime) input
export function parseAllRacksJson(input: unknown): AllRacks {
  // Handle null/undefined
  if (input === null || input === undefined) {
    return {};
  }

  // If already an object (not array, not string), try to use it directly
  if (typeof input === "object" && !Array.isArray(input)) {
    // It might be a proxy - try to access keys
    try {
      const keys = Object.keys(input as object);
      if (keys.length > 0) {
        // Clone the object to break any proxy issues
        const cloned = JSON.parse(JSON.stringify(input));
        return cloned as AllRacks;
      }
    } catch (e) {
      console.error("[parseAllRacksJson] Failed to access object:", e);
    }
    return {};
  }

  // Handle string input
  if (typeof input === "string") {
    if (!input || input === "" || input === "{}") {
      return {};
    }
    try {
      const parsed = JSON.parse(input);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (e) {
      console.error("[parseAllRacksJson] Failed to parse string:", input, e);
      return {};
    }
  }

  return {};
}

// Handle both string (from lobby) and object (auto-deserialized by runtime) input
export function parseAllPlacedJson(input: unknown): AllPlaced {
  // Handle null/undefined
  if (input === null || input === undefined) return {};

  // If already an object (not array, not string), try to use it directly
  if (typeof input === "object" && !Array.isArray(input)) {
    try {
      const keys = Object.keys(input as object);
      if (keys.length > 0) {
        const cloned = JSON.parse(JSON.stringify(input));
        return cloned as AllPlaced;
      }
    } catch (e) {
      console.error("[parseAllPlacedJson] Failed to access object:", e);
    }
    return {};
  }

  // Handle string input
  if (typeof input === "string") {
    if (!input || input === "" || input === "{}") return {};
    try {
      const parsed = JSON.parse(input);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (e) {
      console.error("[parseAllPlacedJson] Failed to parse string:", input, e);
      return {};
    }
  }

  return {};
}

export function drawTilesFromBag(
  bagJson: string,
  bagIndex: number,
  count: number,
): Letter[] {
  const bag = parseBagJson(bagJson);
  const drawn: Letter[] = [];
  for (let i = 0; i < count && bagIndex + i < bag.length; i++) {
    const tile = bag[bagIndex + i];
    if (tile) drawn.push(tile);
  }
  return drawn;
}

export function getRandomColor(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

export function getInitials(name: string): string {
  if (!name || typeof name !== "string") return "?";
  return name.trim().split(/\s+/).map((word) => word[0]).join("").toUpperCase()
    .slice(0, 2);
}

// =============================================================================
// WORD FINDING & SCORING
// =============================================================================

function buildTileMap(tiles: readonly PlacedTile[]): Map<string, Letter> {
  const map = new Map<string, Letter>();
  for (const t of tiles) map.set(`${t.row},${t.col}`, t.letter);
  return map;
}

function getWordAt(
  row: number,
  col: number,
  direction: "horizontal" | "vertical",
  placedMap: Map<string, Letter>,
  committedMap: Map<string, Letter>,
): string {
  const getLetterAt = (r: number, c: number): Letter | undefined => {
    const key = `${r},${c}`;
    return placedMap.get(key) || committedMap.get(key);
  };
  const dRow = direction === "vertical" ? 1 : 0;
  const dCol = direction === "horizontal" ? 1 : 0;
  let startRow = row, startCol = col;
  while (
    startRow - dRow >= 0 && startCol - dCol >= 0 &&
    getLetterAt(startRow - dRow, startCol - dCol)
  ) {
    startRow -= dRow;
    startCol -= dCol;
  }
  let word = "";
  let r = startRow, c = startCol;
  while (r < BOARD_SIZE && c < BOARD_SIZE) {
    const letter = getLetterAt(r, c);
    if (!letter) break;
    word += letter.char;
    r += dRow;
    c += dCol;
  }
  return word;
}

function findAllWords(
  placed: readonly PlacedTile[],
  committed: readonly PlacedTile[],
): string[] {
  if (placed.length === 0) return [];
  const placedMap = buildTileMap(placed);
  const committedMap = buildTileMap(committed);
  const wordsSet = new Set<string>();
  for (const tile of placed) {
    const hWord = getWordAt(
      tile.row,
      tile.col,
      "horizontal",
      placedMap,
      committedMap,
    );
    const vWord = getWordAt(
      tile.row,
      tile.col,
      "vertical",
      placedMap,
      committedMap,
    );
    if (hWord.length >= 2) wordsSet.add(hWord);
    if (vWord.length >= 2) wordsSet.add(vWord);
  }
  return Array.from(wordsSet);
}

function isTilePartOfWord(
  row: number,
  col: number,
  placedMap: Map<string, Letter>,
  committedMap: Map<string, Letter>,
): boolean {
  const hWord = getWordAt(row, col, "horizontal", placedMap, committedMap);
  const vWord = getWordAt(row, col, "vertical", placedMap, committedMap);
  return hWord.length >= 2 || vWord.length >= 2;
}

function findAllWordsWithPositions(
  placed: readonly PlacedTile[],
  committed: readonly PlacedTile[],
): WordWithPositions[] {
  if (placed.length === 0) return [];
  const placedMap = buildTileMap(placed);
  const committedMap = buildTileMap(committed);
  const getTileAt = (
    r: number,
    c: number,
  ): { letter: Letter; isPlaced: boolean } | undefined => {
    const key = `${r},${c}`;
    const pl = placedMap.get(key);
    if (pl) return { letter: pl, isPlaced: true };
    const cl = committedMap.get(key);
    if (cl) return { letter: cl, isPlaced: false };
    return undefined;
  };
  const getWordWithPositions = (
    startRow: number,
    startCol: number,
    direction: "horizontal" | "vertical",
  ): WordWithPositions | null => {
    const dRow = direction === "vertical" ? 1 : 0;
    const dCol = direction === "horizontal" ? 1 : 0;
    let r = startRow, c = startCol;
    while (r - dRow >= 0 && c - dCol >= 0 && getTileAt(r - dRow, c - dCol)) {
      r -= dRow;
      c -= dCol;
    }
    const tiles: TileInWord[] = [];
    while (r < BOARD_SIZE && c < BOARD_SIZE) {
      const tile = getTileAt(r, c);
      if (!tile) break;
      tiles.push({
        char: tile.letter.char,
        points: tile.letter.points,
        row: r,
        col: c,
        isPlaced: tile.isPlaced,
      });
      r += dRow;
      c += dCol;
    }
    if (tiles.length < 2) return null;
    return { word: tiles.map((t) => t.char).join(""), tiles };
  };
  const wordsMap = new Map<string, WordWithPositions>();
  for (const tile of placed) {
    const hWord = getWordWithPositions(tile.row, tile.col, "horizontal");
    if (hWord) {
      wordsMap.set(
        `H:${hWord.tiles[0].row},${hWord.tiles[0].col}:${hWord.word}`,
        hWord,
      );
    }
    const vWord = getWordWithPositions(tile.row, tile.col, "vertical");
    if (vWord) {
      wordsMap.set(
        `V:${vWord.tiles[0].row},${vWord.tiles[0].col}:${vWord.word}`,
        vWord,
      );
    }
  }
  return Array.from(wordsMap.values());
}

function isValidWord(word: string): boolean {
  if (word.length < 2) return false;
  return VALID_WORDS.has(word.toUpperCase());
}

function calculateWordScore(wordData: WordWithPositions): WordScore {
  let baseScore = 0, wordMultiplier = 1;
  const letterScores: string[] = [];
  for (const tile of wordData.tiles) {
    let tileScore = tile.points;
    if (tile.isPlaced) {
      const bonus = getBonusType(tile.row, tile.col);
      if (bonus === "DL") {
        tileScore *= 2;
        letterScores.push(`${tile.char}×2`);
      } else if (bonus === "TL") {
        tileScore *= 3;
        letterScores.push(`${tile.char}×3`);
      } else if (bonus === "DW" || bonus === "star") {
        wordMultiplier *= 2;
        letterScores.push(tile.points > 0 ? String(tile.points) : "0");
      } else if (bonus === "TW") {
        wordMultiplier *= 3;
        letterScores.push(tile.points > 0 ? String(tile.points) : "0");
      } else letterScores.push(tile.points > 0 ? String(tile.points) : "0");
    } else {
      letterScores.push(tile.points > 0 ? String(tile.points) : "0");
    }
    baseScore += tileScore;
  }
  const finalScore = baseScore * wordMultiplier;
  const multiplierStr = wordMultiplier > 1 ? `×${wordMultiplier}` : "";
  return {
    word: wordData.word,
    score: finalScore,
    breakdown: `${wordData.word}: (${
      letterScores.join("+")
    })${multiplierStr} = ${finalScore}`,
  };
}

function calculateTurnScore(
  placed: readonly PlacedTile[],
  committed: readonly PlacedTile[],
): TurnScore {
  const wordsWithPositions = findAllWordsWithPositions(placed, committed);
  const wordScores = wordsWithPositions.map(calculateWordScore);
  const total = wordScores.reduce((sum, ws) => sum + ws.score, 0);
  const bingoBonus = placed.length === 7;
  return { total: total + (bingoBonus ? 50 : 0), wordScores, bingoBonus };
}

// =============================================================================
// HANDLERS
// =============================================================================

function buildBoardSet(tiles: readonly PlacedTile[]): Set<string> {
  const set = new Set<string>();
  for (const t of tiles) set.add(`${t.row},${t.col}`);
  return set;
}

// Helper to deep clone a letter (WORKAROUND for framework bug with reactive value serialization)
function sanitizeLetter(letter: Letter): Letter {
  return {
    char: String(letter.char || ""),
    points: Number(letter.points || 0),
    id: String(letter.id || ""),
    isBlank: Boolean(letter.isBlank),
  };
}

function updatePlayerRack(
  allRacksJson: Writable<string>,
  playerName: string,
  newRack: Letter[],
) {
  const current = parseAllRacksJson(allRacksJson.get());
  // Deep clone all letters (WORKAROUND for framework bug)
  current[playerName] = newRack.map(sanitizeLetter);
  allRacksJson.set(JSON.stringify(current));
}

function updatePlayerPlaced(
  allPlacedJson: Writable<string>,
  playerName: string,
  newPlaced: PlacedTile[],
) {
  const current = parseAllPlacedJson(allPlacedJson.get());
  current[playerName] = newPlaced;
  allPlacedJson.set(JSON.stringify(current));
}

const dropOnBoard = handler<
  any,
  {
    allRacksJson: Writable<string>;
    allPlacedJson: Writable<string>;
    myName: string;
    boardJson: Writable<string>;
    message: Writable<string>;
  }
>((event, { allRacksJson, allPlacedJson, myName, boardJson, message }) => {
  const cellWithGap = CELL_SIZE + 2;

  const dragType = event.detail?.type;
  const sourceData = event.detail?.sourceCell;
  const pointerX = event.detail?.pointerX;
  const pointerY = event.detail?.pointerY;
  const dropZoneRect = event.detail?.dropZoneRect;

  if (!sourceData || !dropZoneRect) return;

  const letterId = sourceData.id || sourceData.$alias?.id;
  if (!letterId) {
    message.set("Could not identify dragged tile");
    return;
  }

  // Calculate position - NO padding offset (dropZoneRect is already at grid origin)
  const relativeX = pointerX - dropZoneRect.left;
  const relativeY = pointerY - dropZoneRect.top;
  const col = Math.floor(relativeX / cellWithGap);
  const row = Math.floor(relativeY / cellWithGap);

  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    message.set("Drop outside board bounds");
    return;
  }

  const currentBoard = parseBoardJson(boardJson.get());
  const boardSet = buildBoardSet(currentBoard);
  if (boardSet.has(`${row},${col}`)) {
    message.set(`Position (${row}, ${col}) has a committed tile`);
    return;
  }

  const allRacks = parseAllRacksJson(allRacksJson.get());
  const allPlaced = parseAllPlacedJson(allPlacedJson.get());
  const currentRack = allRacks[myName] || [];
  const currentPlaced = allPlaced[myName] || [];

  if (dragType === "letter") {
    const rackIndex = currentRack.findIndex((l: Letter) => l.id === letterId);
    if (rackIndex === -1) {
      message.set("Tile not found in rack");
      return;
    }
    const rackLetter = currentRack[rackIndex];
    const sourceLetter: Letter = {
      char: rackLetter.char,
      points: rackLetter.points,
      id: rackLetter.id,
      isBlank: rackLetter.isBlank ?? false,
    };
    const existingTile = currentPlaced.find((t) =>
      t.row === row && t.col === col
    );
    if (existingTile && existingTile.letter.id !== letterId) {
      message.set(`Position (${row}, ${col}) is occupied`);
      return;
    }
    if (sourceLetter.isBlank && !sourceLetter.char) {
      const chosenChar = (globalThis as any).prompt?.(
        "Enter a letter for this blank tile (A-Z):",
      );
      if (!chosenChar || !/^[A-Za-z]$/.test(chosenChar)) {
        message.set("Invalid letter. Blank tile not placed.");
        return;
      }
      sourceLetter.char = chosenChar.toUpperCase();
    }
    updatePlayerRack(
      allRacksJson,
      myName,
      currentRack.filter((_: Letter, i: number) => i !== rackIndex),
    );
    updatePlayerPlaced(allPlacedJson, myName, [...currentPlaced, {
      letter: sourceLetter,
      row,
      col,
    }]);
    message.set(`Placed ${sourceLetter.char || "blank"} at (${row}, ${col})`);
  } else if (dragType === "board-tile") {
    const tileIndex = currentPlaced.findIndex((t: PlacedTile) =>
      t.letter.id === letterId
    );
    if (tileIndex === -1) {
      message.set("Tile not found on board");
      return;
    }
    const existingTile = currentPlaced.find((t) =>
      t.row === row && t.col === col
    );
    if (existingTile && existingTile.letter.id !== letterId) {
      message.set(`Position (${row}, ${col}) is occupied`);
      return;
    }
    const movedTile = currentPlaced[tileIndex];
    updatePlayerPlaced(
      allPlacedJson,
      myName,
      currentPlaced.map((t: PlacedTile, i: number) =>
        i === tileIndex ? { ...t, row, col } : t
      ),
    );
    message.set(
      `Moved ${movedTile.letter.char || "blank"} to (${row}, ${col})`,
    );
  }
});

const returnToRack = handler<
  any,
  {
    allRacksJson: Writable<string>;
    allPlacedJson: Writable<string>;
    myName: string;
    message: Writable<string>;
  }
>((event, { allRacksJson, allPlacedJson, myName, message }) => {
  const dragType = event.detail?.type;
  const sourceData = event.detail?.sourceCell;
  if (!sourceData) return;

  const letterId = sourceData.id || sourceData.$alias?.id;
  if (!letterId) {
    message.set("Could not identify dragged tile");
    return;
  }

  const allRacks = parseAllRacksJson(allRacksJson.get());
  const allPlaced = parseAllPlacedJson(allPlacedJson.get());
  const currentRack = allRacks[myName] || [];
  const currentPlaced = allPlaced[myName] || [];

  // Handle board tile being returned to rack
  if (dragType === "board-tile") {
    const tileIndex = currentPlaced.findIndex((t: PlacedTile) =>
      t.letter.id === letterId
    );
    if (tileIndex === -1) {
      message.set("Tile not found on board");
      return;
    }
    const placedTile = currentPlaced[tileIndex];
    const returnedLetter: Letter = {
      char: placedTile.letter.isBlank ? "" : placedTile.letter.char,
      points: placedTile.letter.points,
      id: placedTile.letter.id,
      isBlank: placedTile.letter.isBlank ?? false,
    };
    updatePlayerPlaced(
      allPlacedJson,
      myName,
      currentPlaced.filter((_: PlacedTile, i: number) => i !== tileIndex),
    );
    updatePlayerRack(allRacksJson, myName, [...currentRack, returnedLetter]);
    message.set(`Returned ${placedTile.letter.char || "blank"} to rack`);
    return;
  }

  // Handle rack tile being reordered within rack
  if (dragType === "letter") {
    const pointerX = event.detail?.pointerX;
    const dropZoneRect = event.detail?.dropZoneRect;
    if (!dropZoneRect) return;

    // Find the source tile index
    const sourceIndex = currentRack.findIndex((l: Letter) => l.id === letterId);
    if (sourceIndex === -1) return;

    // Calculate target position based on drop location
    const TILE_WIDTH = 52; // 44px tile + 8px gap
    const relativeX = pointerX - dropZoneRect.left - 8; // subtract padding
    let targetIndex = Math.floor(relativeX / TILE_WIDTH);
    targetIndex = Math.max(0, Math.min(targetIndex, currentRack.length - 1));

    // If same position, do nothing
    if (targetIndex === sourceIndex) return;

    // Reorder the rack
    const newRack = [...currentRack];
    const [movedTile] = newRack.splice(sourceIndex, 1);
    newRack.splice(targetIndex, 0, movedTile);

    updatePlayerRack(allRacksJson, myName, newRack);
    message.set("");
  }
});

const clearBoard = handler<
  unknown,
  {
    allRacksJson: Writable<string>;
    allPlacedJson: Writable<string>;
    myName: string;
    message: Writable<string>;
  }
>((_event, { allRacksJson, allPlacedJson, myName, message }) => {
  const allRacks = parseAllRacksJson(allRacksJson.get());
  const allPlaced = parseAllPlacedJson(allPlacedJson.get());
  const currentRack = allRacks[myName] || [];
  const currentPlaced = allPlaced[myName] || [];
  if (currentPlaced.length === 0) return;
  const returnedTiles = currentPlaced.map((tile) => ({
    char: tile.letter.isBlank ? "" : tile.letter.char,
    points: tile.letter.points,
    id: tile.letter.id,
    isBlank: tile.letter.isBlank ?? false,
  }));
  updatePlayerRack(allRacksJson, myName, [...currentRack, ...returnedTiles]);
  updatePlayerPlaced(allPlacedJson, myName, []);
  message.set("Cleared all tiles from board");
});

const submitTurn = handler<
  unknown,
  {
    allRacksJson: Writable<string>;
    allPlacedJson: Writable<string>;
    myName: string;
    boardJson: Writable<string>;
    bagJson: Writable<string>;
    bagIndex: Writable<number>;
    playersJson: Writable<string>;
    gameEventsJson: Writable<string>;
    message: Writable<string>;
  }
>((
  _event,
  {
    allRacksJson,
    allPlacedJson,
    myName,
    boardJson,
    bagJson,
    bagIndex,
    playersJson,
    gameEventsJson,
    message,
  },
) => {
  const allRacks = parseAllRacksJson(allRacksJson.get());
  const allPlaced = parseAllPlacedJson(allPlacedJson.get());
  const currentRack = allRacks[myName] || [];
  const currentPlaced = allPlaced[myName] || [];
  const currentBoard = parseBoardJson(boardJson.get());

  if (currentPlaced.length === 0) {
    message.set("No tiles placed on board.");
    return;
  }

  const returnTilesToRack = (tiles: PlacedTile[]) => {
    const letters = tiles.map((t) => ({
      ...t.letter,
      char: t.letter.isBlank ? "" : t.letter.char,
    }));
    updatePlayerRack(allRacksJson, myName, [...currentRack, ...letters]);
  };

  // Check for conflicts with current board
  const boardSet = buildBoardSet(currentBoard);
  const conflictingTiles: PlacedTile[] = [];
  const validTiles: PlacedTile[] = [];
  for (const tile of currentPlaced) {
    if (boardSet.has(`${tile.row},${tile.col}`)) conflictingTiles.push(tile);
    else validTiles.push(tile);
  }
  if (conflictingTiles.length > 0) {
    returnTilesToRack(conflictingTiles);
    updatePlayerPlaced(allPlacedJson, myName, validTiles);
    message.set(
      `${conflictingTiles.length} tile(s) returned - positions taken by another player.`,
    );
    return;
  }

  // First word must cover center
  const CENTER = 7;
  if (currentBoard.length === 0) {
    const coversCenter = currentPlaced.some((t) =>
      t.row === CENTER && t.col === CENTER
    );
    if (!coversCenter) {
      returnTilesToRack(currentPlaced);
      updatePlayerPlaced(allPlacedJson, myName, []);
      message.set(
        "First word must cover the center star - tiles returned to rack.",
      );
      return;
    }
  }

  // Must connect to existing tiles
  if (currentBoard.length > 0) {
    const committedPositions = new Set(
      currentBoard.map((tile) => `${tile.row},${tile.col}`),
    );
    const hasConnection = currentPlaced.some((tile) => {
      const neighbors = [
        `${tile.row - 1},${tile.col}`,
        `${tile.row + 1},${tile.col}`,
        `${tile.row},${tile.col - 1}`,
        `${tile.row},${tile.col + 1}`,
      ];
      return neighbors.some((pos) => committedPositions.has(pos));
    });
    if (!hasConnection) {
      returnTilesToRack(currentPlaced);
      updatePlayerPlaced(allPlacedJson, myName, []);
      message.set(
        "Tiles must connect to existing words - tiles returned to rack.",
      );
      return;
    }
  }

  // Validate words
  const allWords = findAllWords(currentPlaced, currentBoard);
  const invalidWords = allWords.filter((w) => !isValidWord(w));
  if (invalidWords.length > 0) {
    returnTilesToRack(currentPlaced);
    updatePlayerPlaced(allPlacedJson, myName, []);
    message.set(
      `Invalid words: ${invalidWords.join(", ")} - tiles returned to rack.`,
    );
    return;
  }

  const validWords = allWords.filter(isValidWord);
  if (validWords.length === 0) {
    returnTilesToRack(currentPlaced);
    updatePlayerPlaced(allPlacedJson, myName, []);
    message.set("No valid words formed - tiles returned to rack.");
    return;
  }

  // Identify tiles that are part of valid words
  const placedMap = buildTileMap(currentPlaced);
  const committedMap = buildTileMap(currentBoard);
  const tilesInWords: PlacedTile[] = [];
  const orphanTiles: PlacedTile[] = [];
  for (const tile of currentPlaced) {
    if (isTilePartOfWord(tile.row, tile.col, placedMap, committedMap)) {
      tilesInWords.push(tile);
    } else orphanTiles.push(tile);
  }
  if (orphanTiles.length > 0) returnTilesToRack(orphanTiles);

  // Calculate score
  const turnScore = calculateTurnScore(tilesInWords, currentBoard);

  // Update player score (using JSON string to avoid Cell array corruption)
  const parsedPlayers = parsePlayersJson(playersJson.get());
  const updatedPlayers = parsedPlayers.map((p: Player) =>
    p?.name === myName ? { ...p, score: p.score + turnScore.total } : p
  );
  playersJson.set(JSON.stringify(updatedPlayers));

  // Clear placed tiles FIRST to avoid intermediate render state
  // where tiles exist in both myPlaced and board simultaneously
  updatePlayerPlaced(allPlacedJson, myName, []);

  // Then commit tiles to board - tiles transition cleanly
  const newBoard = [...currentBoard, ...tilesInWords];
  boardJson.set(JSON.stringify(newBoard));

  // Draw replacement tiles
  const updatedRacks = parseAllRacksJson(allRacksJson.get());
  const updatedRack = updatedRacks[myName] || [];
  const tilesToDraw = Math.min(tilesInWords.length, 7 - updatedRack.length);
  if (tilesToDraw > 0) {
    const currentBagJson = bagJson.get();
    const currentIndex = bagIndex.get();
    const drawnTiles = drawTilesFromBag(
      currentBagJson,
      currentIndex,
      tilesToDraw,
    );
    bagIndex.set(currentIndex + drawnTiles.length);
    updatePlayerRack(allRacksJson, myName, [...updatedRack, ...drawnTiles]);
  }

  // Add game event (using JSON string to avoid Cell array corruption)
  const wordsStr = turnScore.wordScores.map((ws) => ws.word).join(", ");
  const bonusStr = turnScore.bingoBonus ? " + BINGO!" : "";
  const parsedEvents = parseGameEventsJson(gameEventsJson.get());
  parsedEvents.push({
    id: `evt-${crypto.randomUUID()}`,
    type: "word",
    player: myName,
    details: `${myName}: ${wordsStr} (+${turnScore.total}${bonusStr})`,
    timestamp: Temporal.Now.instant().epochMilliseconds,
  });
  gameEventsJson.set(JSON.stringify(parsedEvents));

  const scoreBreakdown = turnScore.wordScores.map((ws) => ws.breakdown).join(
    "; ",
  );
  message.set(`Scored ${turnScore.total}! ${scoreBreakdown}${bonusStr}`);
});

// =============================================================================
// LIFT FUNCTIONS FOR REACTIVE PARSING
// =============================================================================

// Parse racks from JSON - receives unwrapped string values
const parseRack = lift<
  { allRacksJson: string; myName: string },
  Letter[]
>(({ allRacksJson, myName }) => {
  const racks = parseAllRacksJson(allRacksJson);
  const name = String(myName || "");
  const rack = racks[name] || [];
  // Deep clone to ensure clean objects for render
  return rack.map((letter: Letter) => ({
    char: String(letter.char || ""),
    points: Number(letter.points || 0),
    id: String(letter.id || ""),
    isBlank: Boolean(letter.isBlank),
  }));
});

// Parse players from JSON
const parsePlayers = lift<{ playersJson: string }, Player[]>(
  ({ playersJson }) => parsePlayersJson(playersJson),
);

// Parse game events from JSON
const parseEvents = lift<{ gameEventsJson: string }, GameEvent[]>(
  ({ gameEventsJson }) => parseGameEventsJson(gameEventsJson),
);

// Parse placed tiles from JSON
const parsePlaced = lift<
  { allPlacedJson: string; myName: string; cellWithGap: number },
  { letter: Letter; row: number; col: number; leftPx: string; topPx: string }[]
>(({ allPlacedJson, myName, cellWithGap }) => {
  const placed = parseAllPlacedJson(allPlacedJson);
  const name = String(myName || "");
  const tiles = placed[name] || [];
  return tiles.map((t: PlacedTile) => ({
    letter: t.letter,
    row: t.row,
    col: t.col,
    leftPx: `${t.col * cellWithGap}px`,
    topPx: `${t.row * cellWithGap}px`,
  }));
});

// Parse board tiles from JSON
const parseBoard = lift<
  { boardJson: string; cellWithGap: number },
  { letter: Letter; row: number; col: number; leftPx: string; topPx: string }[]
>(({ boardJson, cellWithGap }) => {
  const tiles = parseBoardJson(boardJson);
  return tiles.map((t) => ({
    letter: t.letter,
    row: t.row,
    col: t.col,
    leftPx: `${t.col * cellWithGap}px`,
    topPx: `${t.row * cellWithGap}px`,
  }));
});

// Get board version (length of boardJson for re-render tracking)
const getBoardVersion = lift<{ boardJson: string }, number>(
  ({ boardJson }) => boardJson?.length || 0,
);

// Get rack count
const getRackCount = lift<{ rack: Letter[] }, number>(
  ({ rack }) => (Array.isArray(rack) ? rack.length : 0),
);

// Get bag count
const getBagCount = lift<{ bagJson: string; bagIndex: number }, number>(
  ({ bagJson, bagIndex }) => {
    const bag = parseBagJson(bagJson);
    return Math.max(0, bag.length - bagIndex);
  },
);

// =============================================================================
// GAME PATTERN
// =============================================================================

interface GameInput {
  gameName: Default<string, "Scrabble Match">;
  boardJson: Writable<Default<string, "">>; // JSON string of PlacedTile[]
  bagJson: Writable<Default<string, "">>;
  bagIndex: Writable<Default<number, 0>>;
  playersJson: Writable<Default<string, "[]">>; // JSON string of Player[]
  gameEventsJson: Writable<Default<string, "[]">>; // JSON string of GameEvent[]
  allRacksJson: Writable<Default<string, "{}">>; // JSON string of AllRacks
  allPlacedJson: Writable<Default<string, "{}">>; // JSON string of AllPlaced
  myName: Default<string, "">;
}

interface GameOutput {
  myName: string;
}

const ScrabbleGame = pattern<GameInput, GameOutput>(
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
      myName,
    },
  ) => {
    // Pre-compute position styles constant
    const CELL_WITH_GAP = CELL_SIZE + 2;

    // Use lift functions for reactive parsing
    const myRack = parseRack({ allRacksJson, myName });
    const currentPlayers = parsePlayers({ playersJson });
    const currentGameEvents = parseEvents({ gameEventsJson });
    const myPlaced = parsePlaced({
      allPlacedJson,
      myName,
      cellWithGap: CELL_WITH_GAP,
    });
    const currentBoard = parseBoard({ boardJson, cellWithGap: CELL_WITH_GAP });
    const _boardVersion = getBoardVersion({ boardJson });
    const rackCount = getRackCount({ rack: myRack });
    const bagCount = getBagCount({ bagJson, bagIndex });

    const boardCells: { row: number; col: number; bonus: BonusType }[] = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        boardCells.push({ row, col, bonus: getBonusType(row, col) });
      }
    }

    const message = Writable.of("");

    return {
      [NAME]: computed(() => `Scrabble: ${myName}`),
      [UI]: (
        <div
          style={{
            display: "flex",
            height: "100%",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            backgroundColor: "#2d5016",
            color: "#fff",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              padding: "1rem",
              overflow: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.5rem",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "1.25rem" }}>{gameName}</h2>
              <span style={{ color: "#a5d6a7", fontSize: "0.875rem" }}>
                Playing as <strong>{myName}</strong>
              </span>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: "1rem",
              }}
            >
              <div
                style={{
                  display: "inline-block",
                  backgroundColor: "#1a3009",
                  borderRadius: "8px",
                }}
              >
                <ct-drop-zone
                  accept="letter,board-tile"
                  onct-drop={dropOnBoard({
                    allRacksJson,
                    allPlacedJson,
                    myName,
                    boardJson,
                    message,
                  })}
                >
                  <div style={{ position: "relative" }}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          `repeat(${BOARD_SIZE}, ${CELL_SIZE}px)`,
                        gap: "2px",
                      }}
                    >
                      {boardCells.map((cell) => {
                        const colors = BONUS_COLORS[cell.bonus];
                        const label = BONUS_LABELS[cell.bonus];
                        return (
                          <div
                            style={{
                              width: `${CELL_SIZE}px`,
                              height: `${CELL_SIZE}px`,
                              boxSizing: "border-box",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: colors.bg,
                              color: colors.text,
                              border: "1px solid #8b7355",
                              borderRadius: "3px",
                              fontSize: "10px",
                              fontWeight: "bold",
                            }}
                          >
                            <span>{label}</span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Committed tiles from shared board - using pre-computed positions */}
                    {currentBoard.map((tile: any) => (
                      <div
                        style={{
                          position: "absolute",
                          left: tile.leftPx,
                          top: tile.topPx,
                          width: `${CELL_SIZE}px`,
                          height: `${CELL_SIZE}px`,
                          boxSizing: "border-box",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: "#e0d4b8",
                          color: "#333",
                          border: "2px solid #6b5a45",
                          borderRadius: "3px",
                          fontSize: "18px",
                          fontWeight: "bold",
                          cursor: "default",
                          userSelect: "none",
                        }}
                      >
                        <span>
                          {tile.letter.isBlank
                            ? (tile.letter.char || "").toLowerCase()
                            : tile.letter.char}
                        </span>
                        {!tile.letter.isBlank && (
                          <span
                            style={{
                              position: "absolute",
                              bottom: "2px",
                              right: "3px",
                              fontSize: "8px",
                            }}
                          >
                            {tile.letter.points}
                          </span>
                        )}
                      </div>
                    ))}

                    {/* My placed tiles (this turn) - using pre-computed positions */}
                    {myPlaced.map((tile: any) => (
                      <ct-drag-source
                        $cell={{ id: tile.letter.id } as any}
                        type="board-tile"
                        style={{
                          position: "absolute",
                          left: tile.leftPx,
                          top: tile.topPx,
                        }}
                      >
                        <div
                          style={{
                            width: `${CELL_SIZE}px`,
                            height: `${CELL_SIZE}px`,
                            boxSizing: "border-box",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: "#f5e6c8",
                            color: "#333",
                            border: "2px solid #fbbf24",
                            borderRadius: "3px",
                            fontSize: "18px",
                            fontWeight: "bold",
                            cursor: "grab",
                            userSelect: "none",
                          }}
                        >
                          <span>
                            {tile.letter.isBlank
                              ? (tile.letter.char || "").toLowerCase()
                              : tile.letter.char}
                          </span>
                          {!tile.letter.isBlank && (
                            <span
                              style={{
                                position: "absolute",
                                bottom: "2px",
                                right: "3px",
                                fontSize: "8px",
                              }}
                            >
                              {tile.letter.points}
                            </span>
                          )}
                        </div>
                      </ct-drag-source>
                    ))}
                  </div>
                </ct-drop-zone>
              </div>
            </div>

            {/* Rack */}
            <div
              style={{
                padding: "1rem",
                backgroundColor: "#8b4513",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.5rem",
                }}
              >
                <span style={{ fontWeight: "bold" }}>
                  Your Rack ({rackCount} tiles)
                </span>
                <span style={{ color: "#ffd700", fontSize: "0.875rem" }}>
                  Bag: {bagCount} tiles remaining
                </span>
              </div>
              <ct-drop-zone
                accept="board-tile,letter"
                onct-drop={returnToRack({
                  allRacksJson,
                  allPlacedJson,
                  myName,
                  message,
                })}
              >
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    minHeight: "50px",
                    backgroundColor: "#6b3410",
                    padding: "8px",
                    borderRadius: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  {myRack.map((letter: Letter) => (
                    <ct-drag-source
                      $cell={{ id: letter.id } as any}
                      type="letter"
                    >
                      <div
                        style={{
                          width: "44px",
                          height: "44px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: letter.isBlank
                            ? "#e8dcc8"
                            : "#f5e6c8",
                          border: letter.isBlank
                            ? "2px dashed #8b7355"
                            : "2px solid #8b7355",
                          borderRadius: "4px",
                          fontSize: "22px",
                          fontWeight: "bold",
                          color: "#333",
                          cursor: "grab",
                          userSelect: "none",
                          boxShadow: "2px 2px 4px rgba(0,0,0,0.2)",
                          position: "relative",
                        }}
                      >
                        {letter.isBlank ? "" : letter.char}
                        {!letter.isBlank && (
                          <span
                            style={{
                              position: "absolute",
                              bottom: "2px",
                              right: "4px",
                              fontSize: "10px",
                            }}
                          >
                            {letter.points}
                          </span>
                        )}
                      </div>
                    </ct-drag-source>
                  ))}
                </div>
              </ct-drop-zone>
              <div
                style={{
                  marginTop: "0.5rem",
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                <ct-button
                  onClick={submitTurn({
                    allRacksJson,
                    allPlacedJson,
                    myName,
                    boardJson,
                    bagJson,
                    bagIndex,
                    playersJson,
                    gameEventsJson,
                    message,
                  })}
                  style={{ backgroundColor: "#22c55e" }}
                >
                  Submit Word
                </ct-button>
                <ct-button
                  onClick={clearBoard({
                    allRacksJson,
                    allPlacedJson,
                    myName,
                    message,
                  })}
                >
                  Clear Board
                </ct-button>
              </div>
              <div
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.875rem",
                  color: "#f5e6c8",
                  fontStyle: "italic",
                  textAlign: "center",
                  minHeight: "1.5em",
                }}
              >
                {message}
              </div>
            </div>
          </div>

          {/* Players Sidebar */}
          <div
            style={{
              width: "130px",
              padding: "1rem",
              backgroundColor: "#1a3009",
              borderLeft: "1px solid #4a7c23",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: "600",
                color: "#a5d6a7",
                textAlign: "center",
                paddingBottom: "0.5rem",
                borderBottom: "1px solid #4a7c23",
              }}
            >
              PLAYERS
            </div>
            {currentPlayers.map((player: Player) => (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "0.75rem 0.5rem",
                  backgroundColor: player.color,
                  borderRadius: "8px",
                  border: player.name === myName ? "3px solid #fbbf24" : "none",
                  boxShadow: player.name === myName
                    ? "0 0 8px rgba(251, 191, 36, 0.5)"
                    : "none",
                }}
              >
                <div
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "50%",
                    backgroundColor: "rgba(255,255,255,0.2)",
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: "600",
                    fontSize: "16px",
                  }}
                >
                  {getInitials(player.name)}
                </div>
                <div
                  style={{
                    marginTop: "0.5rem",
                    fontSize: "0.875rem",
                    color: "white",
                    textAlign: "center",
                    fontWeight: player.name === myName ? "bold" : "normal",
                    maxWidth: "100px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {player.name}
                  {player.name === myName && " (you)"}
                </div>
                <div
                  style={{
                    marginTop: "0.25rem",
                    fontSize: "1.5rem",
                    fontWeight: "bold",
                    color: "#fef08a",
                  }}
                >
                  {player.score}
                </div>
              </div>
            ))}
            <div
              style={{
                marginTop: "auto",
                fontSize: "0.75rem",
                fontWeight: "600",
                color: "#a5d6a7",
                textAlign: "center",
                paddingTop: "0.5rem",
                borderTop: "1px solid #4a7c23",
              }}
            >
              RECENT
            </div>
            <div
              style={{
                fontSize: "0.625rem",
                color: "#9ca3af",
                maxHeight: "100px",
                overflow: "auto",
              }}
            >
              {currentGameEvents.map((event: GameEvent) => (
                <div style={{ marginBottom: "4px" }}>{event.details}</div>
              ))}
            </div>
          </div>
        </div>
      ),
      myName,
    };
  },
);

export default ScrabbleGame;
