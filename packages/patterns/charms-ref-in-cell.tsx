/// <cts-enable />
import {
  Cell,
  cell,
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

type Charm = {
  [NAME]: string;
  [UI]: string;
  [key: string]: any;
};

// Define interfaces for type safety
interface AddCharmState {
  charm: any;
  cellRef: Cell<Charm[]>;
  isInitialized: Cell<boolean>;
}
const AddCharmSchema = toSchema<AddCharmState>();

// Simple charm that will be instantiated multiple times
const SimpleRecipe = recipe<{ id: string }>("Simple Recipe", ({ id }) => ({
  [NAME]: derive(id, (idValue) => `SimpleRecipe: ${idValue}`),
  [UI]: <div>Simple Recipe id {id}</div>,
}));

// Lift that adds a charm to the array and navigates to it.
// The isInitialized flag prevents duplicate additions:
// - Without it: lift runs → adds to array → array changes → lift runs again → duplicate
// - With it: lift runs once → sets isInitialized → subsequent runs skip
const addCharmAndNavigate = lift(
  AddCharmSchema,
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

// Handler that creates a new charm instance and adds it to the array.
// Each invocation creates its own isInitialized cell for tracking.
const createSimpleRecipe = handler<unknown, { cellRef: Cell<Charm[]> }>(
  (_, { cellRef }) => {
    // Create isInitialized cell for this charm addition
    const isInitialized = cell(false);

    // Create a random 5-digit ID
    const randomId = Math.floor(10000 + Math.random() * 90000).toString();

    // Create the charm with unique ID
    const charm = SimpleRecipe({ id: randomId });

    // Store the charm in the array and navigate
    return addCharmAndNavigate({ charm, cellRef, isInitialized });
  },
);

// Handler to navigate to a specific charm from the list
const goToCharm = handler<unknown, { charm: Charm }>(
  (_, { charm }) => {
    console.log("goToCharm clicked");
    return navigateTo(charm);
  },
);

// Recipe input/output type
type RecipeInOutput = {
  cellRef: Default<Charm[], []>;
};

// Main recipe that manages an array of charm references
export default recipe<RecipeInOutput, RecipeInOutput>(
  "Charms Launcher",
  ({ cellRef }) => {
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
                  <ct-button
                    onClick={goToCharm({ charm })}
                  >
                    Go to Charm {derive(index, (i) => i + 1)}
                  </ct-button>
                  <span>
                    Charm {derive(index, (i) => i + 1)}:{" "}
                    {charm[NAME] || "Unnamed"}
                  </span>
                </li>
              ))}
            </ul>,
          )}

          <ct-button
            onClick={createSimpleRecipe({ cellRef })}
          >
            Create New Charm
          </ct-button>
        </div>
      ),
      cellRef,
    };
  },
);
