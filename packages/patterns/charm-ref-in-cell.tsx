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

// this will be called whenever charm changes
// note: charm wont be undefined
// we need to make sure that the charm is not already in the list
// TODO: make the cellRef a list of charms
const storeCharmInCell = lift(
  {
    type: "object",
    properties: {
      charm: { type: "object" },
      cellRef: { type: "object", asCell: true }
    }
  },
  undefined,
  ({ charm, cellRef }) => {
    if (cellRef) {
      console.log("storeCharmInCell storing charm:", JSON.stringify(charm));
      cellRef.set(charm);
    } else {
      console.log("storeCharmInCell undefined cellRef");
    }
    return charm;
  }
);

// create a simple subrecipe
// we will save a reference to it in a cell so make it as simple as
// possible.
// we then call navigateTo() which will redirect the
// browser to the newly created charm
const createCounter = handler<unknown, { charm: any; cellRef: Cell<any> }>(
  (_, { charm, cellRef }) => {
    // store the charm ref in a cell
    storeCharmInCell({ charm, cellRef });

    // navigate to the charm
    return navigateTo(charm);
  },
);

// create the named cell inside the recipe body, so we do it just once
export default recipe("Launcher", () => {
  // cell to store  to the last charm we created
  const { cellRef } = createCellRef({
    isInitialized: cell(false),
    storedCellRef: cell(),
  });

  // TODO: show the list of charms in a list
  // TODO: allow user to navigate to a previously created charm
  return {
    [NAME]: "Launcher",
    [UI]: (
      <div>
        <div>Stored charm ID: {derive(cellRef, (innerCell) => {
          if (!innerCell) return "undefined";
          return innerCell[UI];
        })}</div>
        <ct-button
          onClick={createCounter({ charm: SimpleRecipe({}), cellRef })}
        >
          Create Sub Charm
        </ct-button>
      </div>
    ),
    cellRef,
  };
});
