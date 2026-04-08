import {
  Cell,
  cell,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  pattern,
  UI,
} from "commonfabric";

// the simple charm (to which we'll store references within a cell)
const SimplePattern = pattern(() => ({
  [NAME]: "Some Simple Pattern",
  [UI]: <div>Some Simple Pattern</div>,
}));

// Create a cell to store an array of charms
const createCellRef = lift(
  {
    type: "object",
    properties: {
      isInitialized: { type: "boolean", "default": false, asCell: true },
      storedCellRef: { type: "object", asCell: true },
    },
  },
  undefined,
  ({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
      console.log("Creating cellRef - first time");
      const newCellRef = Cell.for<any[]>("charmsArray");
      newCellRef.set([]);
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

// Add a charm to the array and navigate to it
// we get a new isInitialized passed in for each
// charm we add to the list. this makes sure
// we only try to add the charm once to the list
// and we only call navigateTo once
const addCharmAndNavigate = lift(
  {
    type: "object",
    properties: {
      charm: { type: "object" },
      cellRef: { type: "array", asCell: true },
      isInitialized: { type: "boolean", asCell: true },
    },
  },
  undefined,
  ({ charm, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
      if (cellRef) {
        cellRef.push(charm);
        isInitialized.set(true);
        return navigateTo(charm);
      } else {
        console.log("addCharmAndNavigate undefined cellRef");
      }
    }
    return undefined;
  },
);

// Create a new SimplePattern and add it to the array
const createSimplePattern = handler<unknown, { cellRef: Cell<any[]> }>(
  (_, { cellRef }) => {
    // Create isInitialized cell for this charm addition
    const isInitialized = cell(false);

    // Create the charm
    const charm = SimplePattern({});

    // Store the charm in the array and navigate
    return addCharmAndNavigate({ charm, cellRef, isInitialized });
  },
);

// Handler to navigate to a specific charm from the list
const goToCharm = handler<unknown, { charm: any }>(
  (_, { charm }) => {
    console.log("goToCharm clicked");
    return navigateTo(charm);
  },
);

// FIXTURE: opaque-ref-cell-map
// Verifies: a reactive factory result still rewrites JSX ifElse predicates after
//           the forbidden OpaqueRef cast is removed
//   ifElse(!cellRef?.length, <div>, <ul>) → ifElse(schema..., derive(...), <div>, <ul>)
//   cellRef.map((charm, index) => <li>...) → mapWithPattern(...) even with
//     `as { cellRef: any[] }`, because the cast does not change the reactive origin
// Context: Real-world pattern using Cell.for<any[]>(), handler, lift, and navigateTo
// create the named cell inside the pattern body, so we do it just once
export default pattern(() => {
  // cell to store array of charms we created
  const { cellRef } = createCellRef({
    isInitialized: cell(false),
    storedCellRef: cell(),
  }) as { cellRef: any[] };

  return {
    [NAME]: "Charms Launcher",
    [UI]: (
      <div>
        <h3>Stored Charms:</h3>
        {ifElse(
          !cellRef?.length,
          <div>No charms created yet</div>,
          <ul>
            {cellRef.map((charm: any, index: number) => (
              <li>
                <cf-button
                  onClick={goToCharm({ charm })}
                >
                  Go to Charm {index + 1}
                </cf-button>
                <span>Charm {index + 1}: {charm[NAME] || "Unnamed"}</span>
              </li>
            ))}
          </ul>,
        )}

        <cf-button
          onClick={createSimplePattern({ cellRef })}
        >
          Create New Charm
        </cf-button>
      </div>
    ),
    cellRef,
  };
});
