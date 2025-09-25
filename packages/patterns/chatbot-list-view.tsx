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
  theme?: {
    accentColor: Default<string, "#3b82f6">;
    fontFace: Default<string, "system-ui, -apple-system, sans-serif">;
    borderRadius: Default<string, "0.5rem">;
  };
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
  ({ selectedCharm, charmsList, allCharms, theme }) => {
    logCharmsList({ charmsList });

    const combined = combineLists({
      allCharms: allCharms as unknown as any[],
      charmsList,
    });

    const selected = getSelectedCharm({ entry: selectedCharm });

    const localTheme = theme ?? {
      accentColor: cell("#3b82f6"),
      fontFace: cell("system-ui, -apple-system, sans-serif"),
      borderRadius: cell("0.5rem"),
    };

    const selected = getSelectedCharm({ entry: selectedCharm });

    return {
      [NAME]: "Launcher",
      [UI]: (
        <ct-theme theme={localTheme as any}>
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
                    <ct-kbd>alt+N</ct-kbd>
                  </ct-button>
                </div>
              </ct-toolbar>

              {/* Keyboard shortcuts */}
              <ct-keybind
                code="KeyN"
                alt
                preventDefault
                onct-keybind={createChatRecipe({
                  selectedCharm,
                  charmsList,
                  allCharms: combined as unknown as any,
                })}
              />
            </div>
            <ct-autolayout
              leftOpen
              rightOpen={false}
              tabNames={["Chat", "Tools"]}
            >
              {selected.chat}
              {selected.note}

              <aside slot="left">
                <div>
                  <ct-heading level={3}>Chat List</ct-heading>
                </div>
                <div role="list">
                  {charmsList.map((charmEntry) => (
                    <ct-list-item
                      onct-activate={selectCharm({
                        selectedCharm,
                        charm: charmEntry.charm,
                      })}
                    >
                      <span>{charmEntry.charm[NAME]}</span>
                      <span slot="meta">{charmEntry.local_id}</span>
                    </ct-list-item>
                  ))}
                </div>
              </aside>

              <aside slot="right">
                {ifElse(
                  selected,
                  <>
                    <div>
                      <ct-heading level={4}>Backlinks</ct-heading>
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
                    <ct-collapsible>
                      <ct-heading slot="trigger" level={5} no-margin>
                        Mentioned Charms
                      </ct-heading>
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
                    </ct-collapsible>
                  </>,
                  null,
                )}
                <ct-collapsible>
                  <ct-heading slot="trigger" level={5} no-margin>
                    Theme
                  </ct-heading>
                  <ct-vstack style="padding: 0.5rem 0; gap: 0.5rem;">
                    <ct-vstack>
                      <ct-text>Font Family</ct-text>
                      <ct-select
                        items={[
                          {
                            label: "System",
                            value: "system-ui, -apple-system, sans-serif",
                          },
                          {
                            label: "Monospace",
                            value: "ui-monospace, Consolas, monospace",
                          },
                          {
                            label: "Serif",
                            value: "Georgia, Times, serif",
                          },
                          {
                            label: "Sans Serif",
                            value: "Arial, Helvetica, sans-serif",
                          },
                        ]}
                        $value={localTheme.fontFace}
                      />
                    </ct-vstack>

                    <ct-vstack>
                      <ct-text>Accent Color</ct-text>
                      <ct-select
                        items={[
                          { label: "Blue", value: "#3b82f6" },
                          { label: "Purple", value: "#8b5cf6" },
                          { label: "Green", value: "#10b981" },
                          { label: "Red", value: "#ef4444" },
                          { label: "Orange", value: "#f97316" },
                          { label: "Pink", value: "#ec4899" },
                          { label: "Indigo", value: "#6366f1" },
                          { label: "Teal", value: "#14b8a6" },
                        ]}
                        $value={localTheme.accentColor}
                      />
                    </ct-vstack>

                    <ct-vstack>
                      <ct-text>Border Radius</ct-text>
                      <ct-select
                        items={[
                          { label: "None", value: "0px" },
                          { label: "Small", value: "0.25rem" },
                          { label: "Medium", value: "0.5rem" },
                          { label: "Large", value: "0.75rem" },
                          { label: "Extra Large", value: "1rem" },
                          { label: "Rounded", value: "1.5rem" },
                        ]}
                        $value={localTheme.borderRadius}
                      />
                    </ct-vstack>
                  </ct-vstack>
                </ct-collapsible>
              </aside>
            </ct-autolayout>
          </ct-screen>
        </ct-theme>
      ),
      selectedCharm,
      charmsList,
    };
  },
);
