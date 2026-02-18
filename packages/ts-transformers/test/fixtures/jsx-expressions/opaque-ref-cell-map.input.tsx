/// <cts-enable />
import {
  Cell,
  cell,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  OpaqueRef,
  pattern,
  UI,
} from "commontools";

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

// create the named cell inside the pattern body, so we do it just once
export default pattern(() => {
  // cell to store array of charms we created
  const { cellRef } = createCellRef({
    isInitialized: cell(false),
    storedCellRef: cell(),
  });

  // Type assertion to help TypeScript understand cellRef is an OpaqueRef<any[]>
  // Without this, TypeScript infers `any` and the closure transformer won't detect it
  const typedCellRef = cellRef as OpaqueRef<any[]>;

  return {
    [NAME]: "Charms Launcher",
    [UI]: (
      <div>
        <h3>Stored Charms:</h3>
        {ifElse(
          !typedCellRef?.length,
          <div>No charms created yet</div>,
          <ul>
            {typedCellRef.map((charm: any, index: number) => (
              <li>
                <ct-button
                  onClick={goToCharm({ charm })}
                >
                  Go to Charm {index + 1}
                </ct-button>
                <span>Charm {index + 1}: {charm[NAME] || "Unnamed"}</span>
              </li>
            ))}
          </ul>,
        )}

        <ct-button
          onClick={createSimplePattern({ cellRef })}
        >
          Create New Charm
        </ct-button>
      </div>
    ),
    cellRef,
  };
});
