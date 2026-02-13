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

type Piece = {
  [NAME]: string;
  [UI]: string;
  [key: string]: any;
};

// Define interfaces for type safety
interface AddPieceState {
  piece: any;
  cellRef: Writable<Piece[]>;
  isInitialized: Writable<boolean>;
}
const AddPieceSchema = toSchema<AddPieceState>();

// Simple piece that will be instantiated multiple times
const SimplePiece = pattern<{ id: string }>(({ id }) => ({
  [NAME]: computed(() => `SimplePiece: ${id}`),
  [UI]: <div>Simple Piece id {id}</div>,
}));

// Lift that adds a piece to the array and navigates to it.
// The isInitialized flag prevents duplicate additions:
// - Without it: lift runs → adds to array → array changes → lift runs again → duplicate
// - With it: lift runs once → sets isInitialized → subsequent runs skip
const addPieceAndNavigate = lift(
  AddPieceSchema,
  undefined,
  ({ piece, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
      if (cellRef) {
        cellRef.push(piece);
        isInitialized.set(true);
        return navigateTo(piece);
      } else {
        console.log("addPieceAndNavigate undefined cellRef");
      }
    }
    return undefined;
  },
);

// Handler that creates a new piece instance and adds it to the array.
// Each invocation creates its own isInitialized cell for tracking.
const createSimplePiece = handler<unknown, { cellRef: Writable<Piece[]> }>(
  (_, { cellRef }) => {
    // Create isInitialized cell for this piece addition
    const isInitialized = Writable.of(false);

    // Create a random 5-digit ID
    const randomId = Math.floor(10000 + Math.random() * 90000).toString();

    // Create the piece with unique ID
    const piece = SimplePiece({ id: randomId });

    // Store the piece in the array and navigate
    return addPieceAndNavigate({ piece, cellRef, isInitialized });
  },
);

// Handler to navigate to a specific piece from the list
const goToPiece = handler<unknown, { piece: Piece }>(
  (_, { piece }) => {
    console.log("goToPiece clicked");
    return navigateTo(piece);
  },
);

// Pattern input/output type
type PatternInOutput = {
  cellRef: Default<Piece[], []>;
};

// Main pattern that manages an array of piece references
export default pattern<PatternInOutput, PatternInOutput>(
  "Pieces Launcher",
  ({ cellRef }) => {
    return {
      [NAME]: "Pieces Launcher",
      [UI]: (
        <div>
          <h3>Stored Pieces:</h3>
          {ifElse(
            !cellRef?.length,
            <div>No pieces created yet</div>,
            <ul>
              {cellRef.map((piece: any, index: number) => (
                <li>
                  <ct-button
                    onClick={goToPiece({ piece })}
                  >
                    Go to Piece {computed(() => index + 1)}
                  </ct-button>
                  <span>
                    Piece {computed(() => index + 1)}:{" "}
                    {piece[NAME] || "Unnamed"}
                  </span>
                </li>
              ))}
            </ul>,
          )}

          <ct-button
            onClick={createSimplePiece({ cellRef })}
          >
            Create New Piece
          </ct-button>
        </div>
      ),
      cellRef,
    };
  },
);
