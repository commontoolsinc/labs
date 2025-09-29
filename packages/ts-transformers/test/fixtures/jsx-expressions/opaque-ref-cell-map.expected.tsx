/// <cts-enable />
import { Cell, cell, createCell, derive, h, handler, ifElse, lift, NAME, navigateTo, recipe, UI, JSONSchema } from "commontools";
// the simple charm (to which we'll store references within a cell)
const SimpleRecipe = recipe("Simple Recipe", () => ({
    [NAME]: "Some Simple Recipe",
    [UI]: <div>Some Simple Recipe</div>,
}));
// Create a cell to store an array of charms
const createCellRef = lift({
    type: "object",
    properties: {
        isInitialized: { type: "boolean", default: false, asCell: true },
        storedCellRef: { type: "object", asCell: true },
    },
}, undefined, ({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
        console.log("Creating cellRef - first time");
        const newCellRef = createCell(undefined, "charmsArray");
        newCellRef.set([]);
        storedCellRef.set(newCellRef);
        isInitialized.set(true);
        return {
            cellRef: newCellRef,
        };
    }
    else {
        console.log("cellRef already initialized");
    }
    // If already initialized, return the stored cellRef
    return {
        cellRef: storedCellRef,
    };
});
// Add a charm to the array and navigate to it
// we get a new isInitialized passed in for each
// charm we add to the list. this makes sure
// we only try to add the charm once to the list
// and we only call navigateTo once
const addCharmAndNavigate = lift({
    type: "object",
    properties: {
        charm: { type: "object" },
        cellRef: { type: "array", asCell: true },
        isInitialized: { type: "boolean", asCell: true },
    },
}, undefined, ({ charm, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
        if (cellRef) {
            cellRef.push(charm);
            isInitialized.set(true);
            return navigateTo(charm);
        }
        else {
            console.log("addCharmAndNavigate undefined cellRef");
        }
    }
    return undefined;
});
// Create a new SimpleRecipe and add it to the array
const createSimpleRecipe = handler({} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        cellRef: {
            type: "array",
            items: true,
            asCell: true
        }
    },
    required: ["cellRef"]
} as const satisfies JSONSchema, (_, { cellRef }) => {
    // Create isInitialized cell for this charm addition
    const isInitialized = cell(false);
    // Create the charm
    const charm = SimpleRecipe({});
    // Store the charm in the array and navigate
    return addCharmAndNavigate({ charm, cellRef, isInitialized });
});
// Handler to navigate to a specific charm from the list
const goToCharm = handler({} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        charm: true
    },
    required: ["charm"]
} as const satisfies JSONSchema, (_, { charm }) => {
    console.log("goToCharm clicked");
    return navigateTo(charm);
});
// create the named cell inside the recipe body, so we do it just once
export default recipe("Charms Launcher", () => {
    // cell to store array of charms we created
    const { cellRef } = createCellRef({
        isInitialized: cell(false),
        storedCellRef: cell(),
    });
    return {
        [NAME]: "Charms Launcher",
        [UI]: (<div>
        <h3>Stored Charms:</h3>
        {ifElse(!cellRef?.length, <div>No charms created yet</div>, <ul>
            {cellRef.map((charm: any, index: number) => (<li>
                <ct-button onClick={goToCharm({ charm })}>
                  Go to Charm {derive(index, index => index + 1)}
                </ct-button>
                <span>Charm {derive(index, index => index + 1)}: {derive(charm, charm => charm[NAME] || "Unnamed")}</span>
              </li>))}
          </ul>)}

        <ct-button onClick={createSimpleRecipe({ cellRef })}>
          Create New Charm
        </ct-button>
      </div>),
        cellRef,
    };
});

