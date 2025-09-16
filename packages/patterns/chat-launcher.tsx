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

interface ChatEntry {
  charm: any;
  timestamp: string;
  label: string;
}

const createChatsCell = lift(
  {
    type: "object",
    properties: {
      isInitialized: { type: "boolean", default: false, asCell: true },
      storedCellRef: { type: "object", asCell: true },
    },
  },
  undefined,
  ({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
      const newCellRef = createCell(undefined, "chatsList");
      newCellRef.set([]);
      storedCellRef.set(newCellRef);
      isInitialized.set(true);
      return {
        chatsCell: newCellRef,
      };
    }
    return {
      chatsCell: storedCellRef,
    };
  },
);

const addChatAndNavigate = lift(
  {
    type: "object",
    properties: {
      chatEntry: { type: "object" },
      chatsCell: { type: "array", asCell: true },
      isInitialized: { type: "boolean", asCell: true },
    },
  },
  undefined,
  ({ chatEntry, chatsCell, isInitialized }) => {
    if (!isInitialized.get()) {
      if (chatsCell) {
        chatsCell.push(chatEntry);
        isInitialized.set(true);
        return navigateTo(chatEntry.charm);
      }
    }
    return undefined;
  },
);

const newChat = handler<unknown, { chatsCell: Cell<ChatEntry[]> }>(
  (_, { chatsCell }) => {
    const isInitialized = cell(false);

    const charm = Chat({
      messages: [],
      tools: undefined,
    });

    const timestamp = new Date().toISOString();

    const chatEntry: ChatEntry = {
      charm,
      timestamp,
      label: timestamp,
    };

    return addChatAndNavigate({ chatEntry, chatsCell, isInitialized });
  },
);

const goToChat = handler<unknown, { charm: any }>(
  (_, { charm }) => {
    return navigateTo(charm);
  },
);

const removeCharmFromCell = lift(
  {
    type: "object",
    properties: {
      charmToRemove: { type: "object", asCell: true },
      chatsCell: { type: "array", asCell: true },
      isInitialized: { type: "boolean", default: false, asCell: true },
    },
  },
  undefined,
  ({ charmToRemove, chatsCell, isInitialized }) => {
    console.log("removeCharmFromCell lift called");
    console.log("removeCharmFromCell - charmToRemove:", charmToRemove);
    console.log("removeCharmFromCell - chatsCell:", chatsCell);
    console.log("removeCharmFromCell - isInitialized:", isInitialized);
    if (!isInitialized.get()) {
      if (chatsCell && charmToRemove) {
        const current = chatsCell.get() || [];
        const charmToRemoveValue = charmToRemove.get(); // Extract the actual charm from the Cell
        console.log(
          "charmToRemoveValue extracted from cell:",
          charmToRemoveValue,
        );
        const updated = current.filter((entry: ChatEntry) => {
          try {
            // Use stringify comparison since charm objects are wrapped in Proxies
            console.log("Comparing entry.charm:", entry.charm);
            console.log(
              "Comparing with charmToRemoveValue:",
              charmToRemoveValue,
            );
            const entryStr = JSON.stringify(entry.charm);
            const removeStr = JSON.stringify(charmToRemoveValue);
            console.log(
              "entry.charm stringified (first 100):",
              entryStr?.substring(0, 100),
            );
            console.log(
              "charmToRemoveValue stringified (first 100):",
              removeStr?.substring(0, 100),
            );
            const result = entryStr !== removeStr;
            console.log(
              "Filter returning:",
              result,
              "(true means keep, false means remove)",
            );
            return result;
          } catch (e) {
            // Fallback to direct comparison if stringify fails
            console.log("Stringify failed, using direct comparison. Error:", e);
            return entry.charm !== charmToRemoveValue;
          }
        });
        chatsCell.set(updated);
        isInitialized.set(true);
      }
    }
    return undefined;
  },
);

const removeChat = handler<
  unknown,
  { charm: Cell<any>; chatsCell: Cell<ChatEntry[]> }
>(
  (_, { charm, chatsCell }) => {
    console.log("removeChat handler called with charm:", charm);
    console.log("removeChat handler called with chatsCell:", chatsCell);
    const isInitialized = cell(false);
    return removeCharmFromCell({
      charmToRemove: charm,
      chatsCell,
      isInitialized,
    });
  },
);

export default recipe("Chat Launcher", () => {
  const { chatsCell } = createChatsCell({
    isInitialized: cell(false),
    storedCellRef: cell(),
  });

  return {
    [NAME]: "Chat Launcher",
    [UI]: (
      <div>
        <h2>Chats</h2>

        <ct-button onClick={newChat({ chatsCell })}>
          New chat
        </ct-button>

        {ifElse(
          !chatsCell?.length,
          <div>No chats yet</div>,
          <ul>
            {chatsCell.map((entry: ChatEntry, index: number) => (
              <li>
                <ct-button onClick={goToChat({ charm: entry.charm })}>
                  {entry.label}
                </ct-button>
                <ct-button
                  onClick={removeChat({ charm: entry.charm, chatsCell })}
                >
                  Remove
                </ct-button>
              </li>
            ))}
          </ul>,
        )}
      </div>
    ),
    chatsCell,
  };
});
