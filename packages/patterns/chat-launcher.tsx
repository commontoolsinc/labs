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
              </li>
            ))}
          </ul>,
        )}
      </div>
    ),
    chatsCell,
  };
});
