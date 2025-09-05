/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  navigateTo,
  OpaqueRef,
  recipe,
  UI,
} from "commontools";
import Chat from "./chat.tsx";

// Store cells outside the recipe state to avoid circular references
const chatCells = new Map<string, any>();

type ChatData = {
  id: string;  // Add ID to track the cell
  title: string;
  chatMessages: any[];
  createdAt: string;
};

type ChatLauncherInput = {
  title: Default<string, "Chat Launcher">;
  chatDataList: Default<ChatData[], []>;  // Store chat data for rehydration
};

type ChatLauncherOutput = {
  title: string;
  chatDataList: ChatData[];
};

const handleNewChat = handler<
  unknown,
  { chatDataList: Cell<ChatData[]> }
>((_, { chatDataList }) => {
  console.log("[ChatLauncher] New chat button clicked");

  // Create data for the new chat
  const timestamp = new Date().toISOString();
  const chatTitle = `Chat ${timestamp}`;
  const chatId = Math.random().toString(36).substring(7);
  
  console.log(`[ChatLauncher] Creating new chat with title: ${chatTitle}, id: ${chatId}`);

  // Create a cell for the chat messages that will persist
  const messagesCell = cell([]);
  
  // Store the cell in the external Map
  chatCells.set(chatId, messagesCell);

  // Store the data for later rehydration (without the cell)
  const chatData: ChatData = {
    id: chatId,
    title: chatTitle,
    chatMessages: [],  // Store empty array, actual data is in the cell
    createdAt: timestamp,
  };
  
  chatDataList.push(chatData);
  
  console.log("[ChatLauncher] Chat data stored. Creating and navigating to new chat...");

  // Create the chat instance with the cell
  const newChatInstance = Chat({
    title: chatTitle,
    chat: messagesCell as any,
  });

  // Navigate to the new chat
  return navigateTo(newChatInstance);
});



const handleOpenChat = handler<
  unknown,
  { chatData: ChatData }
>((_, { chatData }) => {
  console.log(`[ChatLauncher] Opening existing chat with id: ${chatData.id}`);
  
  // Get the cell from the Map, or create a new one if it doesn't exist
  let messagesCell = chatCells.get(chatData.id);
  if (!messagesCell) {
    console.log("[ChatLauncher] Cell not found, creating new one");
    messagesCell = cell([]);
    chatCells.set(chatData.id, messagesCell);
  }
  
  // Rehydrate the chat with the stored cell reference
  const chatInstance = Chat({
    title: chatData.title,
    chat: messagesCell as any,  // Pass the same cell reference
  });
  
  return navigateTo(chatInstance);
});

export default recipe<ChatLauncherInput, ChatLauncherOutput>(
  "Chat Launcher",
  ({ title, chatDataList }) => {
    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <h2 slot="header">{title}</h2>

          <ct-vstack gap="md" style="padding: 1rem;">
            <ct-button
              onClick={handleNewChat({ chatDataList })}
              variant="primary"
            >
              New chat
            </ct-button>
            
            {/* Render the list of chats */}
            {chatDataList.length > 0 ? (
              <ct-vstack gap="sm" style="width: 100%;">
                <h3 style="margin: 0.5rem 0; font-size: 1.1rem;">
                  Recent Chats ({chatDataList.length})
                </h3>
                <ct-vstack gap="sm">
                  {chatDataList.map((chatData, index) => (
                    <ct-card
                      style="padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px;"
                    >
                      <ct-hstack gap="sm" style="align-items: center; justify-content: space-between;">
                        <ct-vstack gap="xs" style="flex: 1;">
                          <div style="font-weight: 500; color: #333;">
                            {chatData.title}
                          </div>
                          <div style="font-size: 0.85rem; color: #666;">
                            Created: {chatData.createdAt}
                          </div>
                        </ct-vstack>
                        <ct-button
                          onClick={handleOpenChat({ chatData })}
                          variant="secondary"
                          size="sm"
                        >
                          Open
                        </ct-button>
                      </ct-hstack>
                    </ct-card>
                  ))}
                </ct-vstack>
              </ct-vstack>
            ) : (
              <div style="color: #666; font-size: 0.9em; text-align: center; padding: 1rem;">
                No chats yet. Click "New chat" to start.
              </div>
            )}
          </ct-vstack>
        </ct-screen>
      ),
      title,
      chatDataList,
    };
  },
);
