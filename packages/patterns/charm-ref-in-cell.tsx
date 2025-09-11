/// <cts-enable />
import {
  Cell,
  createCell,
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
const createCellRef = lift(() => ({
  cellRef: createCell(undefined, "cellRef"),
}));

// this will be called whenever charm or cellRef changes
// note: charm wont be undefined
// we need to make sure that the charm is not already in the list
// TODO: make the cellRef a list of charms
const storeCharmInCell = lift(
  {
    type: "object",
    properties: {
      charm: { type: "object" },
      cellRef: { type: "object", asCell: true },
    },
    required: ["charm", "cellRef"],
  },
  undefined,
  // TODO: make sure charm is not on the list already
  ({ cellRef, charm }) => {
    console.log(
      "storeCharmInCell (lift) storing charm: ",
      JSON.stringify(charm),
    );
    cellRef.set(charm);
    return charm;
  },
);

// create a simple subrecipe
// we will save a reference to it in a cell so make it as simple as
// possible.
// we then call navigateTo() which will redirect the
// browser to the newly created charm
const createCounter = handler<unknown, { cellRef: Cell<any> }>(
  (_, { cellRef }) => {
    // create the charm
    const charm = SimpleRecipe({});

    // store the charm ref in a cell
    storeCharmInCell({ cellRef, charm });

    // navigate to the charm
    return navigateTo(charm);
  },
);

// create the named cell inside the recipe body, so we do it just once
export default recipe("Launcher", () => {
  // cell to store  to the last charm we created
  const { cellRef } = createCellRef({});

  // TODO: show the list of charms in a list
  // TODO: allow user to navigate to a previously created charm
  return {
    [NAME]: "Launcher",
    [UI]: (
      <div>
        <ct-button onClick={createCounter({ cellRef })}>
          Create Sub Charm
        </ct-button>
      </div>
    ),
    cellRef,
  };
});
