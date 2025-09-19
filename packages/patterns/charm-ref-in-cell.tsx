/// <cts-enable />
import {
  Cell,
  cell,
  createCell,
  Default,
  derive,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  recipe,
  toSchema,
  UI,
} from "commontools";

// full recipe state
interface RecipeState {
  charm: any;
  cellRef: Cell<{ charm: any }>;
  isInitialized: Cell<boolean>;
}
const RecipeStateSchema = toSchema<RecipeState>();

// what we pass into the recipe as input
// wraps the charm reference in an object { charm: any }
// instead of storing the charm directly. This avoids a "pointer of pointers"
// error that occurs when a Cell directly contains another Cell/charm reference.
type RecipeInOutput = {
  cellRef: Default<{ charm: any }, { charm: null }>;
};

// the simple charm (to which we'll store a reference within a cell)
const SimpleRecipe = recipe<{ id: string }>("Simple Recipe", ({ id }) => ({
  [NAME]: derive(id, (idValue) => `SimpleRecipe: ${idValue}`),
  [UI]: <div>Simple Recipe id {id}</div>,
}));

// Lift that stores a charm reference in a cell and navigates to it.
// Triggered when any input changes (charm, cellRef, or isInitialized).
//
// The isInitialized flag prevents infinite loops:
// - Without it: lift runs → sets cellRef → cellRef changes → lift runs again → loop
// - With it: lift runs once → sets isInitialized → subsequent runs skip the logic
//
// Each handler invocation creates its own isInitialized cell, ensuring
// independent tracking for multiple charm creations.
//
// We use a lift() here instead of executing inside of a handler because
// we want to know the passed in charm is initialized
const storeCharmAndNavigate = lift(
  RecipeStateSchema,
  undefined,
  ({ charm, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
      if (cellRef) {
        console.log(
          "storeCharmAndNavigate storing charm:",
          JSON.stringify(charm),
        );
        cellRef.set({ charm });
        isInitialized.set(true);
        return navigateTo(charm);
      } else {
        console.log("storeCharmAndNavigate undefined cellRef");
      }
    } else {
      console.log("storeCharmAndNavigate already initialized, skipping");
    }
    return undefined;
  },
);

// Handler that creates a new charm instance and stores its reference.
// 1. Creates a local isInitialized cell to track one-time execution
// 2. Instantiates SimpleRecipe charm
// 3. Uses storeCharmAndNavigate lift to save reference and navigate
const createSimpleRecipe = handler<unknown, { cellRef: Cell<{ charm: any }> }>(
  (_, { cellRef }) => {
    const isInitialized = cell(false);

    // Create a random 5-digit ID
    const randomId = Math.floor(10000 + Math.random() * 90000).toString();

    // create the charm
    const charm = SimpleRecipe({ id: randomId });

    // store the charm ref in a cell (pass isInitialized to prevent recursive calls)
    return storeCharmAndNavigate({ charm, cellRef, isInitialized });
  },
);

// Handler to navigate to the stored charm (just console.log for now)
const goToStoredCharm = handler<unknown, { cellRef: Cell<{ charm: any }> }>(
  (_, { cellRef }) => {
    console.log("goToStoredCharm clicked");
    const cellValue = cellRef.get();
    if (!cellValue.charm) {
      console.error("No charm found in cell!");
      return;
    }
    return navigateTo(cellValue.charm);
  },
);

export default recipe<RecipeInOutput, RecipeInOutput>(
  "Launcher",
  ({ cellRef }) => {
    return {
      [NAME]: "Launcher",
      [UI]: (
        <div>
          <div>
            Stored charm ID: {derive(cellRef, (innerCell) => {
              if (!innerCell) return "undefined";
              if (!innerCell.charm) return "no charm stored yet";
              return innerCell.charm[UI] || "charm has no UI";
            })}
          </div>
          <ct-button
            onClick={createSimpleRecipe({ cellRef })}
          >
            Create Sub Charm
          </ct-button>

          {ifElse(
            cellRef.charm,
            (
              <ct-button onClick={goToStoredCharm({ cellRef })}>
                Go to Stored Charm
              </ct-button>
            ),
            (
              <div>no subcharm</div>
            ),
          )}
        </div>
      ),
      cellRef,
    };
  },
);
