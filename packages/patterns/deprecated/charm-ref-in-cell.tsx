/// <cts-enable />
import {
  computed,
  Default,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  pattern,
  toSchema,
  UI,
  Writable,
} from "commontools";

// full pattern state
interface PatternState {
  piece: any;
  cellRef: Writable<{ piece: any }>;
  isInitialized: Writable<boolean>;
}
const PatternStateSchema = toSchema<PatternState>();

// what we pass into the pattern as input
// wraps the piece reference in an object { piece: any }
// instead of storing the piece directly. This avoids a "pointer of pointers"
// error that occurs when a Cell directly contains another Cell/piece reference.
type PatternInOutput = {
  cellRef: Default<{ piece: any }, { piece: null }>;
};

// the simple piece (to which we'll store a reference within a cell)
const SimplePiece = pattern(({ id }: { id: string }) => ({
  [NAME]: computed(() => `SimplePiece: ${id}`),
  [UI]: <div>Simple Piece id {id}</div>,
}));

// Lift that stores a piece reference in a cell and navigates to it.
// Triggered when any input changes (piece, cellRef, or isInitialized).
//
// The isInitialized flag prevents infinite loops:
// - Without it: lift runs → sets cellRef → cellRef changes → lift runs again → loop
// - With it: lift runs once → sets isInitialized → subsequent runs skip the logic
//
// Each handler invocation creates its own isInitialized cell, ensuring
// independent tracking for multiple piece creations.
//
// We use a lift() here instead of executing inside of a handler because
// we want to know the passed in piece is initialized
const storePieceAndNavigate = lift(
  PatternStateSchema,
  undefined,
  ({ piece, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
      if (cellRef) {
        console.log(
          "storePieceAndNavigate storing piece:",
          JSON.stringify(piece),
        );
        cellRef.set({ piece });
        isInitialized.set(true);
        return navigateTo(piece);
      } else {
        console.log("storePieceAndNavigate undefined cellRef");
      }
    } else {
      console.log("storePieceAndNavigate already initialized, skipping");
    }
    return undefined;
  },
);

// Handler that creates a new piece instance and stores its reference.
// 1. Creates a local isInitialized cell to track one-time execution
// 2. Instantiates SimplePiece piece
// 3. Uses storePieceAndNavigate lift to save reference and navigate
const createSimplePiece = handler<
  unknown,
  { cellRef: Writable<{ piece: any }> }
>(
  (_, { cellRef }) => {
    const isInitialized = Writable.of(false);

    // Create a random 5-digit ID
    const randomId = Math.floor(10000 + Math.random() * 90000).toString();

    // create the piece
    const piece = SimplePiece({ id: randomId });

    // store the piece ref in a cell (pass isInitialized to prevent recursive calls)
    return storePieceAndNavigate({ piece, cellRef, isInitialized });
  },
);

// Handler to navigate to the stored piece (just console.log for now)
const goToStoredPiece = handler<unknown, { cellRef: Writable<{ piece: any }> }>(
  (_, { cellRef }) => {
    console.log("goToStoredPiece clicked");
    const cellValue = cellRef.get();
    if (!cellValue.piece) {
      console.error("No piece found in cell!");
      return;
    }
    return navigateTo(cellValue.piece);
  },
);

export default pattern<PatternInOutput, PatternInOutput>(
  ({ cellRef }) => {
    return {
      [NAME]: "Launcher",
      [UI]: (
        <div>
          <div>
            Stored piece ID: {computed(() => {
              if (!cellRef) return "undefined";
              if (!cellRef.piece) return "no piece stored yet";
              return cellRef.piece[UI] || "piece has no UI";
            })}
          </div>
          <ct-button
            onClick={createSimplePiece({ cellRef })}
          >
            Create Sub Piece
          </ct-button>

          {ifElse(
            cellRef.piece,
            (
              <ct-button onClick={goToStoredPiece({ cellRef })}>
                Go to Stored Piece
              </ct-button>
            ),
            (
              <div>no subpiece</div>
            ),
          )}
        </div>
      ),
      cellRef,
    };
  },
);
