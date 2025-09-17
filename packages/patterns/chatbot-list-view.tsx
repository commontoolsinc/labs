/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  ID,
  ifElse,
  lift,
  NAME,
  navigateTo,
  recipe,
  UI,
} from "commontools";

import Chat from "./chatbot.tsx";

type CharmEntry = {
  [ID]: string; // randomId is a string
  charm: any;
};

type Input = {
  selectedCharm: Default<any, undefined>;
  charmsList: Default<CharmEntry[], []>;
};

type Output = Input;

// this will be called whenever charm or selectedCharm changes
// pass isInitialized to make sure we dont call this each time
// we change selectedCharm, otherwise creates a loop
const storeCharm = lift(
  {
    type: "object",
    properties: {
      charm: { type: "object" },
      selectedCharm: { type: "object", asCell: true },
      charmsList: {
        type: "array",
        items: {
          type: "object",
          properties: {
            [ID]: { type: "string" }, // randomId is a string
            charm: { type: "object" },
          },
        },
        asCell: true,
      },
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

      // create the chat charm with a custom name including a random suffix
      const randomId = Math.random().toString(36).substring(2, 10); // Random 8-char string
      charmsList.push({ [ID]: randomId, charm });

      isInitialized.set(true);
      return charm;
    } else {
      console.log("storeCharm: already initialized");
    }
    return undefined;
  },
);

const createChatRecipe = handler<
  unknown,
  { selectedCharm: Cell<any>; charmsList: Cell<CharmEntry[]> }
>(
  (_, { selectedCharm, charmsList }) => {
    const isInitialized = cell(false);

    const charm = Chat({
      messages: [],
      tools: undefined,
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

// create the named cell inside the recipe body, so we do it just once
export default recipe<Input, Output>(
  "Launcher",
  ({ selectedCharm, charmsList }) => {
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
            {charmsList.map((charmEntry, i) => (
              <div>
                index={i} chat ID: {charmEntry.charm[NAME]}
                <ct-button
                  onClick={selectCharm({
                    selectedCharm: selectedCharm,
                    charm: charmEntry.charm,
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
      charmsList,
    };
  },
);
