/// <cts-enable />
import {
  Cell,
  cell,
  createCell,
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
      indexToRemove: { type: "number" },
      chatsCell: { type: "array", asCell: true },
      isInitialized: { type: "boolean", default: false, asCell: true },
    },
  },
  undefined,
  ({ indexToRemove, chatsCell, isInitialized }) => {
    if (!isInitialized.get()) {
      if (chatsCell && indexToRemove !== undefined) {
        const current = chatsCell.get() || [];
        const newArray = [
          ...current.slice(0, indexToRemove),
          ...current.slice(indexToRemove + 1),
        ];
        chatsCell.set(newArray);
        isInitialized.set(true);
      }
    }
    return undefined;
  },
);

const removeChat = handler<
  unknown,
  { index: number; chatsCell: Cell<ChatEntry[]> }
>(
  (_, { index, chatsCell }) => {
    const isInitialized = cell(false);
    return removeCharmFromCell({
      indexToRemove: index,
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
                  onClick={removeChat({ index, chatsCell })}
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
