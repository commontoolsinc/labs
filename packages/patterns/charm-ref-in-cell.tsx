/// <cts-enable />
import {
  Cell,
  cell,
  createCell,
  derive,
  h,
  handler,
  lift,
  NAME,
  navigateTo,
  recipe,
  UI,
} from "commontools";

// the simple charm (to which we'll store a reference within a cell)
const SimpleRecipe = recipe("Simple Recipe", () => ({
  [NAME]: "Some Simple Recipe",
  [UI]: <div>Some Simple Recipe</div>,
}));

// We are going to dynamically create a charm via the `createCounter` function
// and store it (the reference to it) in a cell. We create the cell here.
// There are a few ways to do this:
// - Default values
// - cell()
// - createCell within a lift or derive (we'll use this for now)
// Use isInitialized and storedCellRef to ensure we only create the cell once
const createCellRef = lift(
  {
    type: "object",
    properties: {
      isInitialized: { type: "boolean", default: false, asCell: true },
      storedCellRef: { type: "object", asCell: true },
    },
  },
  undefined,
  ({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
      console.log("Creating cellRef");
      const newCellRef = createCell(undefined, "cellRef");
      storedCellRef.set(newCellRef);
      isInitialized.set(true);
      return {
        cellRef: newCellRef,
      };
    } else {
      console.log("cellRef already initialized");
    }
    // If already initialized, return the stored cellRef
    return {
      cellRef: storedCellRef,
    };
  },
);

// this will be called whenever charm or cellRef changes
// pass isInitialized to make sure we dont call this each time
// we change cellRef, otherwise creates a loop
// also, we need to only navigateTo if not initialized so that
// the other lifts we created compete and try to
// navigateTo at the same time.
// note there is a separate isInitialized for each created charm
const storeCharmAndNavigate = lift(
  {
    type: "object",
    properties: {
      charm: { type: "object" },
      cellRef: { type: "object", asCell: true },
      isInitialized: { type: "boolean", asCell: true },
    },
  },
  undefined,
  ({ charm, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
      if (cellRef) {
        console.log(
          "storeCharmAndNavigate storing charm:",
          JSON.stringify(charm),
        );
        cellRef.set(charm);
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

// create a simple subrecipe
// we will save a reference to it in a cell so make it as simple as
// possible.
// we then call navigateTo() which will redirect the
// browser to the newly created charm
const createSimpleRecipe = handler<unknown, { cellRef: Cell<any> }>(
  (_, { cellRef }) => {
    const isInitialized = cell(false);

    // create the charm
    const charm = SimpleRecipe({});

    // store the charm ref in a cell (pass isInitialized to prevent recursive calls)
    return storeCharmAndNavigate({ charm, cellRef, isInitialized });
  },
);

// Handler to navigate to the stored charm (just console.log for now)
const goToStoredCharm = handler<unknown, { cellRef: Cell<any> }>(
  (_, { cellRef }) => {
    console.log("goToStoredCharm clicked");
    return navigateTo(cellRef);
  },
);

// create the named cell inside the recipe body, so we do it just once
export default recipe("Launcher", () => {
  // cell to store  to the last charm we created
  const { cellRef } = createCellRef({
    isInitialized: cell(false),
    storedCellRef: cell(),
  });

  return {
    [NAME]: "Launcher",
    [UI]: (
      <div>
        <div>
          Stored charm ID: {derive(cellRef, (innerCell) => {
            if (!innerCell) return "undefined";
            return innerCell[UI];
          })}
        </div>
        <ct-button
          onClick={createSimpleRecipe({ cellRef })}
        >
          Create Sub Charm
        </ct-button>
        {derive(cellRef, (innerCell) => {
          if (!innerCell) return "no subcharm yet!";
          return (
            <ct-button onClick={goToStoredCharm({ cellRef: innerCell })}>
              Go to Stored Charm
            </ct-button>
          );
        })}
      </div>
    ),
    cellRef,
  };
});
