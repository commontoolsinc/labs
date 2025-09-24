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
  OpaqueRef,
  recipe,
  UI,
} from "commontools";

import Chat from "./chatbot-note-composed.tsx";

export type MentionableCharm = {
  [NAME]: string;
  content?: string;
  mentioned?: MentionableCharm[];
};

type CharmEntry = {
  [ID]: string; // randomId is a string
  local_id: string; // same as ID but easier to access
  charm: any;
};

type Input = {
  selectedCharm: Default<{ charm: any }, { charm: undefined }>;
  charmsList: Default<CharmEntry[], []>;
  allCharms: Cell<any[]>;
};

type Output = {
  selectedCharm: Default<{ charm: any }, { charm: undefined }>;
};

// this will be called whenever charm or selectedCharm changes
// pass isInitialized to make sure we dont call this each time
// we change selectedCharm, otherwise creates a loop
const storeCharm = lift(
  {
    type: "object",
    properties: {
      charm: { type: "object" },
      selectedCharm: {
        type: "object",
        properties: {
          charm: { type: "object" },
        },
        asCell: true,
      },
      charmsList: {
        type: "array",
        items: {
          type: "object",
          properties: {
            local_id: { type: "string" }, // display ID for the charm
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
        charm,
      );
      selectedCharm.set({ charm });

      // create the chat charm with a custom name including a random suffix
      const randomId = Math.random().toString(36).substring(2, 10); // Random 8-char string
      charmsList.push({ [ID]: randomId, local_id: randomId, charm });

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
  {
    selectedCharm: Cell<{ charm: any }>;
    charmsList: Cell<CharmEntry[]>;
    allCharms: Cell<any[]>;
  }
>(
  (_, { selectedCharm, charmsList, allCharms }) => {
    const isInitialized = cell(false);

    const charm = Chat({
      title: "New Chat",
      messages: [],
      expandChat: false,
      content: "",
      allCharms,
    });
    // store the charm ref in a cell (pass isInitialized to prevent recursive calls)
    return storeCharm({ charm, selectedCharm, charmsList, isInitialized });
  },
);

const selectCharm = handler<
  unknown,
  { selectedCharm: Cell<{ charm: any }>; charm: any }
>(
  (_, { selectedCharm, charm }) => {
    console.log("selectCharm: updating selectedCharm to ", charm);
    selectedCharm.set({ charm });
    return selectedCharm;
  },
);

const logCharmsList = lift(
  {
    type: "object",
    properties: {
      charmsList: {
        type: "array",
        items: {
          type: "object",
          properties: {
            local_id: { type: "string" }, // display ID for the charm
            charm: { type: "object" },
          },
        },
        asCell: true,
      },
    },
  },
  undefined,
  ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
  },
);

const handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Cell<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

const combineLists = lift(
  (
    { allCharms, charmsList }: { allCharms: any[]; charmsList: CharmEntry[] },
  ) => {
    return [...charmsList.map((c) => c.charm), ...allCharms];
  },
);

const getSelectedCharm = lift<
  { entry: { charm: any | undefined } },
  {
    chat: unknown;
    note: unknown;
    backlinks: MentionableCharm[];
    mentioned: MentionableCharm[];
  } | undefined
>(
  ({ entry }) => {
    return entry?.charm;
  },
);

// create the named cell inside the recipe body, so we do it just once
export default recipe<Input, Output>(
  "Launcher",
  ({ selectedCharm, charmsList, allCharms }) => {
    logCharmsList({ charmsList });

    const combined = combineLists({
      allCharms: allCharms as unknown as any[],
      charmsList,
    });

    const selected = getSelectedCharm({ entry: selectedCharm });

    return {
      [NAME]: "Launcher",
      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-toolbar dense sticky>
              <div slot="start">
                <ct-button
                  id="new-chat-btn"
                  onClick={createChatRecipe({
                    selectedCharm,
                    charmsList,
                    allCharms: combined as unknown as any,
                  })}
                >
                  Create New Chat
                  <ct-kbd>⌘N</ct-kbd>
                </ct-button>
              </div>
            </ct-toolbar>

            {/* Keyboard shortcuts */}
            <ct-keybind
              name="new-chat-meta-n"
              meta
              key="n"
              preventDefault
              onct-keybind={createChatRecipe({
                selectedCharm,
                charmsList,
                allCharms: combined as unknown as any,
              })}
            />
            <ct-keybind
              name="new-chat-ctrl-n"
              ctrl
              key="n"
              preventDefault
              onct-keybind={createChatRecipe({
                selectedCharm,
                charmsList,
                allCharms: combined as unknown as any,
              })}
            />
          </div>
          <ct-autolayout tabNames={["Chat", "Tools"]}>
            {
              selected.chat // workaround: CT-987
            }
            {
              selected.note // workaround: CT-987
            }

            <aside slot="left">
              <div>
                <h3>Chat List</h3>
              </div>
              <div>
                {charmsList.map((charmEntry, i) => (
                  <div>
                    index={i} chat ID: {charmEntry.local_id}
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
            </aside>

            <aside slot="right">
              {ifElse(
                selected,
                <>
                  <div>
                    <label>Backlinks</label>
                    <ct-vstack>
                      {selected?.backlinks?.map((
                        charm: MentionableCharm,
                      ) => (
                        <ct-button
                          onClick={handleCharmLinkClicked({ charm })}
                        >
                          {charm[NAME]}
                        </ct-button>
                      ))}
                    </ct-vstack>
                  </div>
                  <details>
                    <summary>Mentioned Charms</summary>
                    <ct-vstack>
                      {selected?.mentioned?.map((
                        charm: MentionableCharm,
                      ) => (
                        <ct-button
                          onClick={handleCharmLinkClicked({ charm })}
                        >
                          {charm[NAME]}
                        </ct-button>
                      ))}
                    </ct-vstack>
                  </details>
                </>,
                null,
              )}
            </aside>
          </ct-autolayout>
        </ct-screen>
      ),
      selectedCharm,
      charmsList,
    };
  },
);
