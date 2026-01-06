/// <cts-enable />
import {
  Cell, Writable,
  computed,
  Default,
  handler,
  ID,
  ifElse,
  lift,
  NAME,
  navigateTo,
  OpaqueRef,
  pattern,
  toSchema,
  UI,
  wish,
} from "commontools";

import Chat from "./chatbot-note-composed.tsx";
import { ListItem } from "../system/common-tools.tsx";

import { type MentionableCharm } from "../system/backlinks-index.tsx";
type CharmEntry = {
  [ID]: string; // randomId is a string
  local_id: string; // same as ID but easier to access
  charm: any;
};

type Input = {
  selectedCharm: Default<{ charm: any }, { charm: undefined }>;
  charmsList: Default<CharmEntry[], []>;
  theme?: {
    accentColor: Writable<Default<string, "#3b82f6">>;
    fontFace: Writable<Default<string, "system-ui, -apple-system, sans-serif">>;
    borderRadius: Writable<Default<string, "0.5rem">>;
  };
};

type Output = {
  selectedCharm: Default<{ charm: any }, { charm: undefined }>;
  // Expose a mentionable list aggregated from local chat entries
  // Returned as an opaque ref to an array (not a Cell), suitable for
  // upstream aggregators that read exported mentionables.
  mentionable?: MentionableCharm[];
};

const removeChat = handler<
  unknown,
  {
    charmsList: Writable<CharmEntry[]>;
    id: string;
    selectedCharm: Writable<Default<{ charm: any }, { charm: undefined }>>;
  }
>(
  (
    _,
    { charmsList, id, selectedCharm },
  ) => {
    const list = charmsList.get();
    const index = list.findIndex((entry) => entry.local_id === id);
    if (index === -1) return;

    const removed = list[index];
    const next = [...list];
    next.splice(index, 1);
    charmsList.set(next);

    // If we removed the currently selected charm, choose a new selection.
    const current = selectedCharm.get();
    if (current?.charm === removed.charm) {
      const replacement = next[index] ?? next[index - 1];
      if (replacement) {
        selectedCharm.set({ charm: replacement.charm });
      } else {
        selectedCharm.set({ charm: undefined as unknown as any });
      }
    }
  },
);

// this will be called whenever charm or selectedCharm changes
// pass isInitialized to make sure we dont call this each time
// we change selectedCharm, otherwise creates a loop
const storeCharm = lift(
  toSchema<{
    charm: any;
    selectedCharm: Writable<Default<{ charm: any }, { charm: undefined }>>;
    charmsList: Writable<CharmEntry[]>;
    allCharms: Writable<MentionableCharm[]>;
    theme?: {
      accentColor: Default<string, "#3b82f6">;
      fontFace: Default<string, "system-ui, -apple-system, sans-serif">;
      borderRadius: Default<string, "0.5rem">;
    };
    isInitialized: Writable<boolean>;
  }>(),
  undefined,
  ({ charm, selectedCharm, charmsList, isInitialized, allCharms: _ }) => { // Not including `allCharms` is a compile error...
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

const populateChatList = lift(
  toSchema<{
    charmsList: CharmEntry[];
    allCharms: Writable<any[]>;
    selectedCharm: Writable<{ charm: any }>;
  }>(),
  undefined,
  (
    { charmsList, allCharms, selectedCharm },
  ) => {
    if (charmsList.length === 0) {
      const isInitialized = Cell.of(false);
      return storeCharm({
        charm: Chat({
          title: "New Chat",
          messages: [],
        }),
        selectedCharm,
        charmsList,
        allCharms,
        isInitialized: isInitialized as unknown as Writable<boolean>,
      });
    }

    return charmsList;
  },
);

const createChatRecipe = handler<
  unknown,
  {
    selectedCharm: Writable<{ charm: any }>;
    charmsList: Writable<CharmEntry[]>;
    allCharms: Writable<MentionableCharm[]>;
  }
>(
  (_, { selectedCharm, charmsList, allCharms }) => {
    const isInitialized = Cell.of(false);

    const charm = Chat({
      title: "New Chat",
      messages: [],
    });
    // store the charm ref in a cell (pass isInitialized to prevent recursive calls)
    return storeCharm({
      charm,
      selectedCharm,
      charmsList: charmsList as unknown as OpaqueRef<CharmEntry[]>,
      allCharms,
      isInitialized: isInitialized as unknown as Writable<boolean>,
    });
  },
);

const selectCharm = handler<
  unknown,
  { selectedCharm: Writable<{ charm: any }>; charm: any }
>(
  (_, { selectedCharm, charm }) => {
    console.log("selectCharm: updating selectedCharm to ", charm);
    selectedCharm.set({ charm });
    return selectedCharm;
  },
);

const logCharmsList = lift<
  { charmsList: Writable<CharmEntry[]> },
  Writable<CharmEntry[]>
>(
  ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
  },
);

const _handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Writable<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

const _merge = lift(
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
    list: ListItem[];
  } | undefined
>(
  ({ entry }) => {
    return entry?.charm;
  },
);

const getCharmName = lift(({ charm }: { charm: any }) => {
  return charm?.[NAME] || "Unknown";
});

const extractLocalMentionable = lift<
  { list: CharmEntry[] },
  MentionableCharm[]
>(({ list }) => {
  const out: MentionableCharm[] = [];
  for (const entry of list) {
    const c = entry.charm;
    out.push(c.chat);
  }
  return out;
});

// create the named cell inside the pattern body, so we do it just once
export default pattern<Input, Output>(
  ({ selectedCharm, charmsList, theme }) => {
    const wishedCharms = wish<MentionableCharm[]>("#allCharms");
    const allCharms = computed(() => wishedCharms ?? []);
    logCharmsList({ charmsList: charmsList as unknown as Writable<CharmEntry[]> });

    populateChatList({
      selectedCharm: selectedCharm as unknown as Writable<
        Pick<CharmEntry, "charm">
      >,
      charmsList,
      allCharms,
    });

    const selected = getSelectedCharm({ entry: selectedCharm });

    // Aggregate mentionables from the local charms list so that this
    // container exposes its child chat charms as mention targets.
    const localMentionable = extractLocalMentionable({ list: charmsList });

    const localTheme = theme ?? {
      accentColor: Cell.of("#3b82f6"),
      fontFace: Cell.of("system-ui, -apple-system, sans-serif"),
      borderRadius: Cell.of("0.5rem"),
    };

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
                      allCharms,
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
                  allCharms,
                })}
              />
            </div>
            <ct-autolayout
              leftOpen
              rightOpen={false}
            >
              {/* workaround: this seems to correctly start the sub-recipes on a refresh while directly rendering does not */}
              {/* this should be fixed after the builder-refactor (DX1) */}
              <ct-screen>
                <ct-render $cell={selected.chat} />
              </ct-screen>

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
                      <span>{getCharmName({ charm: charmEntry.charm })}</span>
                      <span slot="meta">{charmEntry.local_id}</span>
                      <ct-button
                        slot="actions"
                        size="sm"
                        title="Delete Chat"
                        variant="destructive"
                        onClick={removeChat({
                          charmsList: charmsList as unknown as OpaqueRef<
                            CharmEntry[]
                          >,
                          id: charmEntry.local_id,
                          selectedCharm: selectedCharm as unknown as OpaqueRef<
                            Default<{ charm: any }, { charm: undefined }>
                          >,
                        })}
                      >
                        🗑️
                      </ct-button>
                    </ct-list-item>
                  ))}
                </div>
              </aside>

              <aside slot="right">
                {ifElse(
                  selected,
                  <>
                    <ct-ct-collapsible>
                      <ct-heading slot="trigger" level={5} no-margin>
                        List
                      </ct-heading>
                      <ct-list $value={selected.list} />
                    </ct-ct-collapsible>
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
      // Expose the aggregated mentionables for parent-level indexing.
      mentionable: localMentionable,
    };
  },
);
