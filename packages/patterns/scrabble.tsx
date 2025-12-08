/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
} from "commontools";
import { VALID_WORDS } from "./scrabble-words.ts";

// Declare browser's prompt function for TypeScript
declare function prompt(message: string): string | null;

// =============================================================================
// CONSTANTS
// =============================================================================

// Letter point values (standard Scrabble)
const LETTER_POINTS: Record<string, number> = {
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
const TILE_DISTRIBUTION: Record<string, number> = {
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

// Bonus square types
type BonusType = "none" | "DL" | "TL" | "DW" | "TW" | "star";

// Board size - standard Scrabble is 15x15
const BOARD_SIZE = 15;
const CELL_SIZE = 32;

// Pre-computed bonus map for O(1) lookup (key: "row,col")
// Standard 15x15 Scrabble board layout
const BONUS_MAP: Map<string, BonusType> = (() => {
  const map = new Map<string, BonusType>();

  // Center star (7,7)
  map.set("7,7", "star");

  // Triple Word squares (TW) - standard positions
  const twPositions = [
    [0, 0],
    [0, 7],
    [0, 14],
    [7, 0],
    [7, 14],
    [14, 0],
    [14, 7],
    [14, 14],
  ];
  for (const [r, c] of twPositions) map.set(`${r},${c}`, "TW");

  // Double Word squares (DW) - standard positions (diagonals + edges)
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

  // Triple Letter squares (TL) - standard positions
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

  // Double Letter squares (DL) - standard positions
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

// O(1) bonus type lookup
const getBonusType = (row: number, col: number): BonusType => {
  return BONUS_MAP.get(`${row},${col}`) || "none";
};

// Bonus colors and labels
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
// TYPES - WITH BLANK TILE SUPPORT
// =============================================================================

interface Letter {
  char: string;
  points: number;
  id: string;
  isBlank: boolean; // NEW: true for blank tiles
}

interface PlacedTile {
  letter: Letter;
  row: number;
  col: number;
}

// =============================================================================
// TILE BAG MECHANICS
// =============================================================================

// Create a shuffled tile bag with standard Scrabble distribution (100 tiles)
// Uses Fisher-Yates shuffle with Math.random() for uniform randomness
function createTileBag(): Letter[] {
  const bag: Letter[] = [];
  let tileId = Date.now(); // Use timestamp for unique IDs across games

  // Build the bag according to official Scrabble distribution
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

  // Fisher-Yates shuffle - each permutation equally likely
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }

  return bag;
}

// Draw tiles from bag (mutates bag, returns drawn tiles)
function drawTiles(bag: Letter[], count: number): Letter[] {
  const drawn: Letter[] = [];
  const toDraw = Math.min(count, bag.length);
  for (let i = 0; i < toDraw; i++) {
    const tile = bag.pop();
    if (tile) drawn.push(tile);
  }
  return drawn;
}

// Initialize bag and draw starting rack
const initialBag = createTileBag();
const defaultRack: Letter[] = drawTiles(initialBag, 7);

// Default placed tiles (empty) - tiles placed THIS turn (movable)
const defaultPlaced: PlacedTile[] = [];

// Default committed tiles (empty) - tiles from previous turns (immovable)
const defaultCommitted: PlacedTile[] = [];

// Default bag (remaining tiles after drawing rack)
const defaultBag: Letter[] = initialBag;

// =============================================================================
// COMMITTED TILES HELPERS - O(1) position checks and letter lookups
// =============================================================================

// Build set from committedTiles for O(1) position checks
function buildCommittedSet(tiles: readonly PlacedTile[]): Set<string> {
  const set = new Set<string>();
  for (const t of tiles) {
    set.add(`${t.row},${t.col}`);
  }
  return set;
}

// Build map from tiles for O(1) letter lookup by position
function buildTileMap(tiles: readonly PlacedTile[]): Map<string, Letter> {
  const map = new Map<string, Letter>();
  for (const t of tiles) {
    map.set(`${t.row},${t.col}`, t.letter);
  }
  return map;
}

// Get full word at position, extending through placed AND committed tiles
// Returns the word string and length
function getWordAt(
  row: number,
  col: number,
  direction: "horizontal" | "vertical",
  placedMap: Map<string, Letter>,
  committedMap: Map<string, Letter>,
): string {
  // Helper to get letter at position from either map
  const getLetterAt = (r: number, c: number): Letter | undefined => {
    const key = `${r},${c}`;
    return placedMap.get(key) || committedMap.get(key);
  };

  // Determine step direction
  const dRow = direction === "vertical" ? 1 : 0;
  const dCol = direction === "horizontal" ? 1 : 0;

  // Find the start of the word (extend backwards)
  let startRow = row;
  let startCol = col;
  while (
    startRow - dRow >= 0 &&
    startCol - dCol >= 0 &&
    getLetterAt(startRow - dRow, startCol - dCol)
  ) {
    startRow -= dRow;
    startCol -= dCol;
  }

  // Build the word (extend forwards from start)
  let word = "";
  let r = startRow;
  let c = startCol;
  while (r < BOARD_SIZE && c < BOARD_SIZE) {
    const letter = getLetterAt(r, c);
    if (!letter) break;
    word += letter.char;
    r += dRow;
    c += dCol;
  }

  return word;
}

// Check if a tile at (row, col) is part of any word (2+ letters)
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

// Find all unique words formed by placed tiles (including extensions through committed tiles)
function findAllWords(
  placed: readonly PlacedTile[],
  committed: readonly PlacedTile[],
): string[] {
  if (placed.length === 0) return [];

  const placedMap = buildTileMap(placed);
  const committedMap = buildTileMap(committed);
  const wordsSet = new Set<string>();

  // For each placed tile, check horizontal and vertical words through it
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

    // Only add words with 2+ letters
    if (hWord.length >= 2) wordsSet.add(hWord);
    if (vWord.length >= 2) wordsSet.add(vWord);
  }

  return Array.from(wordsSet);
}

// =============================================================================
// WORD VALIDATION HELPERS
// =============================================================================

// O(1) word validation using TWL06 Scrabble dictionary (178,691 words)
// Returns true if word is a valid Scrabble word
function isValidWord(word: string): boolean {
  if (word.length < 2) return false;
  return VALID_WORDS.has(word.toUpperCase());
}

// =============================================================================
// SCORING - PURE FUNCTIONS (no side effects, no Cell access)
// =============================================================================

// Types for scoring
interface TileInWord {
  char: string;
  points: number;
  row: number;
  col: number;
  isPlaced: boolean; // true if placed this turn, false if committed
}

interface WordWithPositions {
  word: string;
  tiles: TileInWord[];
}

interface WordScore {
  word: string;
  score: number;
  breakdown: string; // e.g., "CAT: (3+1+1)×2 = 10"
}

interface TurnScore {
  total: number;
  wordScores: WordScore[];
  bingoBonus: boolean;
}

// Find all words with position data for scoring
// Returns words with each tile's position and whether it was placed this turn
function findAllWordsWithPositions(
  placed: readonly PlacedTile[],
  committed: readonly PlacedTile[],
): WordWithPositions[] {
  if (placed.length === 0) return [];

  const placedMap = buildTileMap(placed);
  const committedMap = buildTileMap(committed);

  // Helper to get tile at position
  const getTileAt = (
    r: number,
    c: number,
  ): { letter: Letter; isPlaced: boolean } | undefined => {
    const key = `${r},${c}`;
    const placedLetter = placedMap.get(key);
    if (placedLetter) return { letter: placedLetter, isPlaced: true };
    const committedLetter = committedMap.get(key);
    if (committedLetter) return { letter: committedLetter, isPlaced: false };
    return undefined;
  };

  // Get word with positions at given start, extending in direction
  const getWordWithPositions = (
    startRow: number,
    startCol: number,
    direction: "horizontal" | "vertical",
  ): WordWithPositions | null => {
    const dRow = direction === "vertical" ? 1 : 0;
    const dCol = direction === "horizontal" ? 1 : 0;

    // Find actual start of word (extend backwards)
    let r = startRow;
    let c = startCol;
    while (r - dRow >= 0 && c - dCol >= 0 && getTileAt(r - dRow, c - dCol)) {
      r -= dRow;
      c -= dCol;
    }

    // Build word with positions
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

    // Only return words with 2+ letters
    if (tiles.length < 2) return null;

    return {
      word: tiles.map((t) => t.char).join(""),
      tiles,
    };
  };

  // Collect unique words (use word + start position as key to avoid duplicates)
  const wordsMap = new Map<string, WordWithPositions>();

  for (const tile of placed) {
    // Check horizontal word through this placed tile
    const hWord = getWordWithPositions(tile.row, tile.col, "horizontal");
    if (hWord) {
      const key = `H:${hWord.tiles[0].row},${hWord.tiles[0].col}:${hWord.word}`;
      wordsMap.set(key, hWord);
    }

    // Check vertical word through this placed tile
    const vWord = getWordWithPositions(tile.row, tile.col, "vertical");
    if (vWord) {
      const key = `V:${vWord.tiles[0].row},${vWord.tiles[0].col}:${vWord.word}`;
      wordsMap.set(key, vWord);
    }
  }

  return Array.from(wordsMap.values());
}

// Calculate score for a single word with bonus squares
// RULE: Letter multipliers (DL, TL) apply first, only to NEW tiles
// RULE: Word multipliers (DW, TW, star) apply after, stack multiplicatively
// RULE: Blank tiles (points=0) still trigger word multipliers
function calculateWordScore(wordData: WordWithPositions): WordScore {
  let baseScore = 0;
  let wordMultiplier = 1;
  const letterScores: string[] = [];

  for (const tile of wordData.tiles) {
    let tileScore = tile.points; // Blank tiles have points=0

    // Only placed tiles get bonus square benefits (one-time use)
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
      } else {
        letterScores.push(tile.points > 0 ? String(tile.points) : "0");
      }
    } else {
      // Committed tiles - just add their value
      letterScores.push(tile.points > 0 ? String(tile.points) : "0");
    }

    baseScore += tileScore;
  }

  const finalScore = baseScore * wordMultiplier;
  const multiplierStr = wordMultiplier > 1 ? `×${wordMultiplier}` : "";
  const breakdown = `${wordData.word}: (${
    letterScores.join("+")
  })${multiplierStr} = ${finalScore}`;

  return {
    word: wordData.word,
    score: finalScore,
    breakdown,
  };
}

// Main scoring function - PURE, no side effects
// RULE: Score each word separately (bonuses apply per word)
// RULE: Bingo bonus (+50) for using all 7 tiles
function calculateTurnScore(
  placed: readonly PlacedTile[],
  committed: readonly PlacedTile[],
): TurnScore {
  const wordsWithPositions = findAllWordsWithPositions(placed, committed);
  const wordScores = wordsWithPositions.map(calculateWordScore);
  const total = wordScores.reduce((sum, ws) => sum + ws.score, 0);

  // Bingo bonus: 50 points for using all 7 tiles in one turn
  const bingoBonus = placed.length === 7;

  return {
    total: total + (bingoBonus ? 50 : 0),
    wordScores,
    bingoBonus,
  };
}

// =============================================================================
// INPUT/OUTPUT TYPES
// =============================================================================

interface ScrabbleInput {
  rack: Default<Letter[], typeof defaultRack>;
  placed: Default<PlacedTile[], typeof defaultPlaced>;
  committed: Default<PlacedTile[], typeof defaultCommitted>;
  bag: Default<Letter[], typeof defaultBag>;
  message: Default<string, "Drag tiles from your rack to the board.">;
  score: Default<number, 0>; // Total accumulated score
  lastTurnScore: Default<number, 0>; // Score from most recent turn
}

interface ScrabbleOutput {
  rack: Letter[];
  placed: PlacedTile[];
  committed: PlacedTile[];
  bag: Letter[];
  message: string;
  score: number;
  lastTurnScore: number;
}

// =============================================================================
// HANDLERS - WITH BLANK TILE SUPPORT
// =============================================================================

// Handler for dropping a tile onto the board drop zone
// Handles both rack tiles (type="letter") and board tiles (type="board-tile")
// For blank tiles, prompts for letter assignment
// deno-lint-ignore no-explicit-any
const dropOnBoard = handler<
  any,
  {
    rack: Cell<Letter[]>;
    placed: Cell<PlacedTile[]>;
    committed: Cell<PlacedTile[]>;
    message: Cell<string>;
  }
>(
  // deno-lint-ignore no-explicit-any
  (event: any, { rack, placed, committed, message }) => {
    // Get the drag type to determine source (rack vs board)
    const dragType = event.detail?.type;
    const isFromBoard = dragType === "board-tile";

    // sourceCell may be a Cell or already a plain value depending on context
    const sourceCell = event.detail?.sourceCell;
    const rawLetter =
      (typeof sourceCell?.get === "function"
        ? sourceCell.get()
        : sourceCell) as Letter;

    // CRITICAL: Copy values immediately! The sourceCell is a reactive Proxy
    const sourceLetter: Letter = {
      char: rawLetter?.char,
      points: rawLetter?.points,
      id: rawLetter?.id,
      isBlank: rawLetter?.isBlank ?? false,
    };

    console.log(
      "Source letter received:",
      sourceLetter,
      "char:",
      sourceLetter.char,
      "from:",
      dragType,
    );

    // For blank tiles without assigned char, prompt for character
    if (sourceLetter.isBlank && !sourceLetter.char) {
      const chosenChar = prompt("Enter a letter for this blank tile (A-Z):");
      if (!chosenChar || !/^[A-Za-z]$/.test(chosenChar)) {
        message.set("Invalid letter. Blank tile not placed.");
        return;
      }
      // Assign the chosen character (uppercase internally, displayed lowercase)
      sourceLetter.char = chosenChar.toUpperCase();
    }

    if (!sourceLetter || (!sourceLetter.char && !sourceLetter.isBlank)) {
      message.set("Drop failed: no source letter");
      return;
    }

    const pointerX = event.detail?.pointerX;
    const pointerY = event.detail?.pointerY;

    if (pointerX === undefined || pointerY === undefined) {
      message.set("Drop failed: no coordinates");
      return;
    }

    const dropZoneRect = event.detail?.dropZoneRect;
    if (!dropZoneRect) {
      message.set("Drop failed: no drop zone rect");
      return;
    }

    // Calculate relative position within the drop zone
    const PADDING = 8;
    const relativeX = pointerX - dropZoneRect.left - PADDING;
    const relativeY = pointerY - dropZoneRect.top - PADDING;

    const cellWithGap = CELL_SIZE + 2;
    const col = Math.floor(relativeX / cellWithGap);
    const row = Math.floor(relativeY / cellWithGap);

    console.log("Drop calculation:", {
      pointerX,
      pointerY,
      "dropZoneRect.left": dropZoneRect.left,
      "dropZoneRect.top": dropZoneRect.top,
      relativeX,
      relativeY,
      cellWithGap,
      row,
      col,
    });

    // Bounds check
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
      message.set(`Drop outside board bounds`);
      return;
    }

    const currentRack = rack.get();
    const currentPlaced = placed.get();
    const currentCommitted = committed.get();

    // O(1) check: is this position occupied by a committed tile?
    const committedSet = buildCommittedSet(currentCommitted);
    if (committedSet.has(`${row},${col}`)) {
      message.set(`Position (${row}, ${col}) has a committed tile!`);
      return;
    }

    // Check if position is already occupied by a placed tile (from this turn)
    const existingTile = currentPlaced.find((t) =>
      t.row === row && t.col === col
    );
    if (existingTile && existingTile.letter.id !== sourceLetter.id) {
      message.set(`Position (${row}, ${col}) is occupied!`);
      return;
    }

    if (isFromBoard) {
      // Moving tile within board - update position
      const tileIndex = currentPlaced.findIndex((t) =>
        t.letter.id === sourceLetter.id
      );
      if (tileIndex < 0) {
        message.set("Tile not found on board");
        return;
      }

      // If dropping on same cell, do nothing
      if (
        currentPlaced[tileIndex].row === row &&
        currentPlaced[tileIndex].col === col
      ) {
        return;
      }

      // Update position
      const newPlaced = currentPlaced.map((t, i) =>
        i === tileIndex ? { ...t, row, col } : t
      );
      placed.set(newPlaced);
      message.set(`Moved ${sourceLetter.char} to (${row}, ${col})`);
    } else {
      // From rack - existing logic
      const rackIndex = currentRack.findIndex((l) => l.id === sourceLetter.id);
      if (rackIndex < 0) {
        message.set("Letter not in rack");
        return;
      }

      // Remove from rack
      const newRack = currentRack.filter((_, i) => i !== rackIndex);
      rack.set(newRack);

      // Add to placed tiles
      const newPlaced = [...currentPlaced, { letter: sourceLetter, row, col }];
      placed.set(newPlaced);

      message.set(`Placed ${sourceLetter.char} at (${row}, ${col})`);
    }
  },
);

// Handler for returning tile to rack OR reordering within rack
// deno-lint-ignore no-explicit-any
const returnToRack = handler<
  any,
  {
    rack: Cell<Letter[]>;
    placed: Cell<PlacedTile[]>;
    committed: Cell<PlacedTile[]>;
    message: Cell<string>;
  }
>(
  // deno-lint-ignore no-explicit-any
  (event: any, { rack, placed, committed: _committed, message }) => {
    const dragType = event.detail?.type;
    const isFromRack = dragType === "letter";

    const sourceCell = event.detail?.sourceCell;
    const rawLetter =
      (typeof sourceCell?.get === "function"
        ? sourceCell.get()
        : sourceCell) as Letter;

    // CRITICAL: Copy values immediately
    const sourceLetter: Letter = {
      char: rawLetter?.char,
      points: rawLetter?.points,
      id: rawLetter?.id,
      isBlank: rawLetter?.isBlank ?? false,
    };

    if (!sourceLetter || (!sourceLetter.char && !sourceLetter.isBlank)) return;

    if (isFromRack) {
      // Reordering within rack
      const currentRack = rack.get();
      const sourceIdx = currentRack.findIndex((l) => l.id === sourceLetter.id);
      if (sourceIdx < 0) return;

      const pointerX = event.detail?.pointerX;
      const dropZoneRect = event.detail?.dropZoneRect;

      if (pointerX === undefined || !dropZoneRect) {
        message.set("Reorder failed: no coordinates");
        return;
      }

      const PADDING = 8;
      const TILE_WIDTH = 44;
      const GAP = 8;
      const tileWithGap = TILE_WIDTH + GAP;

      const relativeX = pointerX - dropZoneRect.left - PADDING;
      let targetIdx = Math.floor(relativeX / tileWithGap);
      targetIdx = Math.max(0, Math.min(targetIdx, currentRack.length - 1));

      if (targetIdx === sourceIdx) return;

      const newRack = [...currentRack];
      const [removed] = newRack.splice(sourceIdx, 1);
      const adjustedTarget = sourceIdx < targetIdx ? targetIdx : targetIdx;
      newRack.splice(adjustedTarget, 0, removed);
      rack.set(newRack);

      message.set(
        `Moved ${sourceLetter.char || "blank"} to position ${targetIdx + 1}`,
      );
    } else {
      // From board - remove from placed tiles
      const currentPlaced = placed.get();
      const placedTile = currentPlaced.find((t) =>
        t.letter.id === sourceLetter.id
      );

      if (!placedTile) {
        return;
      }

      // When returning a blank tile to rack, clear its assigned character
      const returnedLetter: Letter = {
        ...sourceLetter,
        char: sourceLetter.isBlank ? "" : sourceLetter.char,
      };

      // Remove from placed
      placed.set(currentPlaced.filter((t) => t.letter.id !== sourceLetter.id));

      // Add back to rack
      rack.push(returnedLetter);

      message.set(`Returned ${sourceLetter.char || "blank"} to rack`);
    }
  },
);

// Clear all placed tiles
const clearBoard = handler<
  unknown,
  { rack: Cell<Letter[]>; placed: Cell<PlacedTile[]>; message: Cell<string> }
>((_event, { rack, placed, message }) => {
  const currentPlaced = placed.get();
  const currentRack = rack.get();

  // Return all placed tiles to rack (clear blank tile chars)
  const returnedLetters = currentPlaced.map((t) => ({
    ...t.letter,
    char: t.letter.isBlank ? "" : t.letter.char,
  }));
  rack.set([...currentRack, ...returnedLetters]);
  placed.set([]);
  message.set("Board cleared");
});

// Start a new game - fresh bag, new rack, clear board
const newGame = handler<
  unknown,
  {
    rack: Cell<Letter[]>;
    placed: Cell<PlacedTile[]>;
    committed: Cell<PlacedTile[]>;
    bag: Cell<Letter[]>;
    message: Cell<string>;
    score: Cell<number>;
    lastTurnScore: Cell<number>;
  }
>((_event, { rack, placed, committed, bag, message, score, lastTurnScore }) => {
  // Create a completely fresh bag with new random seed
  const freshBag = createTileBag();

  // Draw 7 tiles for the new rack
  const newRack = drawTiles(freshBag, 7);

  // Reset all game state
  rack.set(newRack);
  placed.set([]);
  committed.set([]);
  bag.set(freshBag);
  score.set(0);
  lastTurnScore.set(0);

  // Show blank count for debugging/verification
  const blankCount = newRack.filter((t) => t.isBlank).length;
  message.set(
    `New game started! ${freshBag.length} tiles in bag. (${blankCount} blank${
      blankCount !== 1 ? "s" : ""
    } in rack)`,
  );
});

// Submit turn - evaluate placement and move valid tiles to committed
const submitTurn = handler<
  unknown,
  {
    rack: Cell<Letter[]>;
    placed: Cell<PlacedTile[]>;
    committed: Cell<PlacedTile[]>;
    bag: Cell<Letter[]>;
    message: Cell<string>;
    score: Cell<number>;
    lastTurnScore: Cell<number>;
  }
>((_event, { rack, placed, committed, bag, message, score, lastTurnScore }) => {
  const currentPlaced = placed.get();
  const currentCommitted = committed.get();

  console.log("=== SUBMIT TURN START ===");
  console.log("currentPlaced raw:", JSON.stringify(currentPlaced));
  console.log(
    "currentPlaced mapped:",
    currentPlaced.map((t) => `${t.letter?.char}@(${t.row},${t.col})`),
  );

  if (currentPlaced.length === 0) {
    message.set("No tiles placed! Drag tiles to the board first.");
    return;
  }

  // === RULE 1: First word must cover center (7,7) ===
  const CENTER = 7;
  if (currentCommitted.length === 0) {
    const coversCenter = currentPlaced.some((t) =>
      t.row === CENTER && t.col === CENTER
    );
    if (!coversCenter) {
      const currentRack = rack.get();
      const returnedLetters = currentPlaced.map((t) => ({
        ...t.letter,
        char: t.letter.isBlank ? "" : t.letter.char,
      }));
      rack.set([...currentRack, ...returnedLetters]);
      placed.set([]);
      message.set(
        "First word must cover the center star (row 8, column 8) - tiles returned to rack.",
      );
      return;
    }
  }

  // === RULE 2: No islands - must connect to existing tiles ===
  if (currentCommitted.length > 0) {
    // Build set of committed positions for O(1) lookup
    const committedPositions = new Set<string>();
    for (const tile of currentCommitted) {
      committedPositions.add(`${tile.row},${tile.col}`);
    }

    // Check if any placed tile is adjacent to a committed tile
    const hasConnection = currentPlaced.some((tile) => {
      const neighbors = [
        `${tile.row - 1},${tile.col}`, // up
        `${tile.row + 1},${tile.col}`, // down
        `${tile.row},${tile.col - 1}`, // left
        `${tile.row},${tile.col + 1}`, // right
      ];
      return neighbors.some((pos) => committedPositions.has(pos));
    });

    if (!hasConnection) {
      const currentRack = rack.get();
      const returnedLetters = currentPlaced.map((t) => ({
        ...t.letter,
        char: t.letter.isBlank ? "" : t.letter.char,
      }));
      rack.set([...currentRack, ...returnedLetters]);
      placed.set([]);
      message.set(
        "Tiles must connect to existing words on the board - tiles returned to rack.",
      );
      return;
    }
  }

  // Find all words formed by placed tiles
  const allWords = findAllWords(currentPlaced, currentCommitted);

  const validWords = allWords.filter(isValidWord);
  const invalidWords = allWords.filter((w) => !isValidWord(w));

  if (invalidWords.length > 0) {
    const currentRack = rack.get();
    const returnedLetters = currentPlaced.map((t) => ({
      ...t.letter,
      char: t.letter.isBlank ? "" : t.letter.char,
    }));
    rack.set([...currentRack, ...returnedLetters]);
    placed.set([]);
    message.set(
      `Invalid words: ${invalidWords.join(", ")} - tiles returned to rack.`,
    );
    return;
  }

  if (validWords.length === 0) {
    const currentRack = rack.get();
    const returnedLetters = currentPlaced.map((t) => ({
      ...t.letter,
      char: t.letter.isBlank ? "" : t.letter.char,
    }));
    rack.set([...currentRack, ...returnedLetters]);
    placed.set([]);
    message.set(
      "No valid words formed - tiles must connect to form words (2+ letters).",
    );
    return;
  }

  // Build maps for O(1) lookup
  const placedMap = buildTileMap(currentPlaced);
  const committedMap = buildTileMap(currentCommitted);

  // Partition tiles: those in words vs orphans
  const tilesToCommit: PlacedTile[] = [];
  const tilesToReturn: PlacedTile[] = [];

  for (const tile of currentPlaced) {
    const isPartOfWord = isTilePartOfWord(
      tile.row,
      tile.col,
      placedMap,
      committedMap,
    );
    console.log(
      `Tile ${tile.letter.char} at (${tile.row},${tile.col}): isPartOfWord=${isPartOfWord}`,
    );

    if (isPartOfWord) {
      tilesToCommit.push(tile);
    } else {
      tilesToReturn.push(tile);
    }
  }

  console.log(
    "tilesToCommit:",
    tilesToCommit.map((t) => `${t.letter.char}@(${t.row},${t.col})`),
  );
  console.log("tilesToReturn:", tilesToReturn.map((t) => t.letter.char));

  // Deep copy tiles to avoid reactive proxy issues
  const copiedTiles = tilesToCommit.map((t) => ({
    letter: {
      char: t.letter.char,
      points: t.letter.points,
      id: t.letter.id,
      isBlank: t.letter.isBlank,
    },
    row: t.row,
    col: t.col,
  }));

  console.log(
    "copiedTiles:",
    copiedTiles.map((t) => `${t.letter.char}@(${t.row},${t.col})`),
  );

  // CRITICAL: Clear placed FIRST
  placed.set([]);

  // Return orphan tiles to rack (clear blank tile chars)
  if (tilesToReturn.length > 0) {
    const currentRack = rack.get();
    const returnedLetters = tilesToReturn.map((t) => ({
      ...t.letter,
      char: t.letter.isBlank ? "" : t.letter.char,
    }));
    rack.set([...currentRack, ...returnedLetters]);
  }

  // Draw new tiles from bag to refill rack
  const currentRack = rack.get();
  const tilesToDraw = 7 - currentRack.length;
  if (tilesToDraw > 0) {
    const currentBag = [...bag.get()]; // Copy bag
    const newTiles = drawTiles(currentBag, tilesToDraw);
    if (newTiles.length > 0) {
      rack.set([...currentRack, ...newTiles]);
      bag.set(currentBag);
    }
  }

  // Calculate score BEFORE committing (uses placed tiles)
  // PURE FUNCTION: no side effects, computes in one direction
  const turnResult = calculateTurnScore(tilesToCommit, currentCommitted);
  console.log(
    "Turn score:",
    turnResult.total,
    "Words:",
    turnResult.wordScores.map((w) => w.breakdown),
  );

  // Update scores imperatively (one-way data flow, no reactive cycles)
  const currentScore = score.get();
  score.set(currentScore + turnResult.total);
  lastTurnScore.set(turnResult.total);

  // NOW set committed with completely fresh data
  const currentCommittedData = JSON.parse(JSON.stringify(committed.get()));
  const newTilesData = copiedTiles.map((t) => ({
    letter: {
      char: t.letter.char,
      points: t.letter.points,
      id: t.letter.id,
      isBlank: t.letter.isBlank,
    },
    row: t.row,
    col: t.col,
  }));
  console.log("newTilesData being added:", JSON.stringify(newTilesData));
  currentCommittedData.push(...newTilesData);
  console.log("Final committed array:", JSON.stringify(currentCommittedData));
  committed.set(currentCommittedData);

  // Build message with score info
  const returnInfo = tilesToReturn.length > 0
    ? ` (returned ${
      tilesToReturn.map((t) => t.letter.char || "blank").join(", ")
    } to rack)`
    : "";
  const bingoInfo = turnResult.bingoBonus ? " BINGO! (+50)" : "";
  const scoreBreakdown = turnResult.wordScores.map((w) =>
    `${w.word}: ${w.score}`
  ).join(", ");
  message.set(
    `+${turnResult.total} points!${bingoInfo} [${scoreBreakdown}]${returnInfo}`,
  );
});

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<ScrabbleInput, ScrabbleOutput>(
  ({ rack, placed, committed, bag, message, score, lastTurnScore }) => {
    const rackCount = computed(() => rack.length);
    const bagCount = computed(() => bag.length);

    // CRITICAL: Pre-compute style strings AND display properties
    // This avoids VNode keying issues with Cell proxies
    interface TileWithStyles extends PlacedTile {
      styleLeft: string;
      styleTop: string;
      displayChar: string; // Pre-computed: lowercase if blank
      showPoints: boolean; // Pre-computed: false if blank
    }

    const committedTiles = computed((): TileWithStyles[] => {
      const raw = committed.get ? committed.get() : committed;
      const tiles = JSON.parse(JSON.stringify(raw)) as PlacedTile[];
      return tiles.map((t) => ({
        ...t,
        styleLeft: `${t.col * (CELL_SIZE + 2)}px`,
        styleTop: `${t.row * (CELL_SIZE + 2)}px`,
        displayChar: t.letter.isBlank
          ? (t.letter.char ? t.letter.char.toLowerCase() : "")
          : t.letter.char,
        showPoints: !t.letter.isBlank,
      }));
    });

    const placedTiles = computed((): TileWithStyles[] => {
      const raw = placed.get ? placed.get() : placed;
      const tiles = JSON.parse(JSON.stringify(raw)) as PlacedTile[];
      return tiles.map((t) => ({
        ...t,
        styleLeft: `${t.col * (CELL_SIZE + 2)}px`,
        styleTop: `${t.row * (CELL_SIZE + 2)}px`,
        displayChar: t.letter.isBlank
          ? (t.letter.char ? t.letter.char.toLowerCase() : "")
          : t.letter.char,
        showPoints: !t.letter.isBlank,
      }));
    });

    // Rack tiles also need pre-computed display properties
    interface RackTileWithDisplay extends Letter {
      displayChar: string;
      showPoints: boolean;
    }

    const rackTiles = computed((): RackTileWithDisplay[] => {
      const raw = rack.get ? rack.get() : rack;
      const tiles = JSON.parse(JSON.stringify(raw)) as Letter[];
      return tiles.map((t) => ({
        ...t,
        displayChar: t.isBlank ? "" : t.char,
        showPoints: !t.isBlank,
      }));
    });

    // Build board grid cells for display (static - not reactive cells)
    const boardCells: { row: number; col: number; bonus: BonusType }[] = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        boardCells.push({ row, col, bonus: getBonusType(row, col) });
      }
    }

    return {
      [NAME]: "Scrabble",
      [UI]: (
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            padding: "16px",
            backgroundColor: "#2d5016",
            minHeight: "100vh",
            color: "#fff",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "16px",
              padding: "8px 16px",
              backgroundColor: "#1a3009",
              borderRadius: "8px",
            }}
          >
            <div style={{ fontSize: "24px", fontWeight: "bold" }}>SCRABBLE</div>
            <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: "bold",
                  color: "#ffd700",
                }}
              >
                Score: {score}
              </div>
              <div style={{ fontSize: "12px", color: "#aaa" }}>
                Bag: {bagCount}
              </div>
            </div>
          </div>

          {/* Message */}
          <div
            style={{
              padding: "8px 16px",
              marginBottom: "16px",
              backgroundColor: "#1a3009",
              borderRadius: "4px",
              textAlign: "center",
            }}
          >
            {message}
          </div>

          {/* Board - ONE drop zone covering entire board */}
          <ct-drop-zone
            accept="letter,board-tile"
            onct-drop={dropOnBoard({ rack, placed, committed, message })}
          >
            <div
              style={{
                display: "inline-block",
                padding: "8px",
                backgroundColor: "#1a3009",
                borderRadius: "8px",
                marginBottom: "16px",
              }}
            >
              {/* Board container with relative positioning for overlay */}
              <div style={{ position: "relative" }}>
                {/* Grid of board cells */}
                <div
                  data-board-grid="true"
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
                {/* Committed tiles - NOT draggable, slightly darker background */}
                {/* Using pre-computed styleLeft/styleTop/displayChar/showPoints */}
                {committedTiles.map((tile, index) => (
                  <div
                    key={index}
                    data-tile-id={tile.letter.id}
                    data-row={tile.row}
                    data-col={tile.col}
                    style={{
                      position: "absolute",
                      left: tile.styleLeft,
                      top: tile.styleTop,
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
                    <span>{tile.displayChar}</span>
                    {tile.showPoints && (
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
                {/* Placed tiles (this turn) - draggable */}
                {/* Using pre-computed styleLeft/styleTop/displayChar/showPoints */}
                {placedTiles.map((tile, index) => (
                  <div
                    key={index + 1000}
                    style={{
                      position: "absolute",
                      left: tile.styleLeft,
                      top: tile.styleTop,
                    }}
                  >
                    <ct-drag-source $cell={tile.letter} type="board-tile">
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
                          border: "1px solid #8b7355",
                          borderRadius: "3px",
                          fontSize: "18px",
                          fontWeight: "bold",
                          cursor: "grab",
                          userSelect: "none",
                        }}
                      >
                        <span>{tile.displayChar}</span>
                        {tile.showPoints && (
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
                  </div>
                ))}
              </div>
            </div>
          </ct-drop-zone>

          {/* Rack with return drop zone */}
          <div
            style={{
              padding: "16px",
              backgroundColor: "#8b4513",
              borderRadius: "8px",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "8px",
              }}
            >
              <span style={{ fontWeight: "bold" }}>
                Your Rack ({rackCount} tiles):
              </span>
              <button
                type="button"
                onClick={submitTurn({
                  rack,
                  placed,
                  committed,
                  bag,
                  message,
                  score,
                  lastTurnScore,
                })}
                style={{
                  padding: "8px 20px",
                  backgroundColor: "#f5e6c8",
                  color: "#5a2d0c",
                  border: "2px solid #6b3410",
                  borderRadius: "6px",
                  fontSize: "14px",
                  fontWeight: "bold",
                  cursor: "pointer",
                  boxShadow: "2px 2px 4px rgba(0,0,0,0.3)",
                }}
              >
                Done
              </button>
            </div>
            <ct-drop-zone
              accept="board-tile,letter"
              onct-drop={returnToRack({ rack, placed, committed, message })}
            >
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  minHeight: "50px",
                  padding: "8px",
                  backgroundColor: "#6b3410",
                  borderRadius: "4px",
                  flexWrap: "wrap",
                }}
              >
                {rackTiles.map((letter, index) => (
                  <ct-drag-source key={index} $cell={letter} type="letter">
                    <div
                      style={{
                        width: "44px",
                        height: "44px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: letter.isBlank ? "#e8dcc8" : "#f5e6c8",
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
                      <span>{letter.displayChar}</span>
                      {letter.showPoints && (
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
          </div>

          {/* Controls */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
              marginBottom: "16px",
            }}
          >
            <ct-button onClick={clearBoard({ rack, placed, message })}>
              Clear Board
            </ct-button>
            <ct-button
              onClick={newGame({
                rack,
                placed,
                committed,
                bag,
                message,
                score,
                lastTurnScore,
              })}
            >
              New Game
            </ct-button>
          </div>

          {/* Instructions */}
          <div
            style={{
              padding: "8px 16px",
              backgroundColor: "#1a3009",
              borderRadius: "4px",
              fontSize: "12px",
              lineHeight: "1.5",
            }}
          >
            <strong>How to play:</strong>
            <br />
            1. Drag a tile from your rack to any cell on the board<br />
            2. Blank tiles will prompt you for a letter (displayed in
            lowercase)<br />
            3. Drag tiles from board back to rack to return them<br />
            4. Drag tiles within rack to reorder them<br />
            5. Click "Done" when finished placing tiles
          </div>
        </div>
      ),
      rack,
      placed,
      committed,
      bag,
      message,
      score,
      lastTurnScore,
    };
  },
);
