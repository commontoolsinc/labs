/// <cts-enable />
import {
  Cell,
  cell,
  createCell,
  derive,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  recipe,
  UI,
} from "commontools";

import Chat from "./chatbot.tsx";

// this will be called whenever charm or selectedCharm changes
// pass isInitialized to make sure we dont call this each time
// we change selectedCharm, otherwise creates a loop
const storeCharm = lift(
  {
    type: "object",
    properties: {
      charm: { type: "object" },
      selectedCharm: { type: "object", asCell: true },
      charmsList: { type: "array", asCell: true },
      isInitialized: { type: "boolean", asCell: true },
    },
  },
  undefined,
  ({ charm, selectedCharm, charmsList, isInitialized }) => {
    if (!isInitialized.get()) {
      console.log(
        "storeCharm storing charm:",
        JSON.stringify(charm),
      );
      selectedCharm.set(charm);
      charmsList.push(charm);
      isInitialized.set(true);
      return charm;
    } else {
      console.log("storeCharm undefined selectedCharm");
    }
    return undefined;
  },
);

const createChatRecipe = handler<
  unknown,
  { selectedCharm: Cell<any>; charmsList: Cell<any[]> }
>(
  (_, { selectedCharm, charmsList }) => {
    const isInitialized = cell(false);

    // create the chat charm with a custom name including a random suffix
    const randomId = Math.random().toString(36).substring(2, 10); // Random 8-char string
    const charm = Chat({
      messages: [],
      tools: undefined,
      //name: `Chat-${randomId}`
    });
    // store the charm ref in a cell (pass isInitialized to prevent recursive calls)
    return storeCharm({ charm, selectedCharm, charmsList, isInitialized });
  },
);

const selectCharm = handler<unknown, { selectedCharm: Cell<any>; charm: any }>(
  (_, { selectedCharm, charm }) => {
    console.log("selectCharm: updating selectedCharm to ", charm);
    selectedCharm.set(charm);
    return selectedCharm;
  },
);

// Handler to navigate to the stored charm (just console.log for now)
const goToStoredCharm = handler<unknown, { selectedCharm: Cell<any> }>(
  (_, { selectedCharm }) => {
    console.log("goToStoredCharm clicked, selectedCharm=", selectedCharm);
  },
);

// create the named cell inside the recipe body, so we do it just once
export default recipe("Launcher", () => {
  // cell to store  to the last charm we created
  const selectedCharm = cell(undefined);
  const charmsList = cell([]);

  return {
    [NAME]: "Launcher",
    [UI]: (
      <div>
        <ct-button onClick={createChatRecipe({ selectedCharm, charmsList })}>
          Create New Chat
        </ct-button>

        <div>
          <h3>Chat List</h3>
        </div>
        <div>
          {charmsList.map((charm, i) => (
            <div>
              index={i} chat ID: {charm[NAME]}
              <ct-button
                onClick={selectCharm({
                  selectedCharm: selectedCharm,
                  charm: charm,
                })}
              >
                LOAD
              </ct-button>
            </div>
          ))}
        </div>

        <div>--- end chat list ---</div>
        <div>{selectedCharm}</div>
      </div>
    ),
    selectedCharm,
  };
});
