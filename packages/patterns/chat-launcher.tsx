/// <cts-enable />
import { Default, h, handler, NAME, navigateTo, recipe, UI } from "commontools";
import Chat from "./chat.tsx";

type ChatLauncherInput = {
  title: Default<string, "Chat Launcher">;
};

type ChatLauncherOutput = {
  title: string;
};

const handleNewChat = handler<
  unknown,
  Record<string, never>
>((_, __) => {
  console.log("[ChatLauncher] New chat button clicked");

  // Create a new chat instance with default values
  const chatTitle = `Chat ${new Date().toISOString()}`;
  console.log(`[ChatLauncher] Creating new chat with title: ${chatTitle}`);

  const newChatInstance = Chat({
    title: chatTitle,
    chat: [],
  });

  console.log("[ChatLauncher] Chat instance created, navigating...");

  // Navigate to the new chat
  return navigateTo(newChatInstance);
});

export default recipe<ChatLauncherInput, ChatLauncherOutput>(
  "Chat Launcher",
  ({ title }) => {
    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <h2 slot="header">{title}</h2>

          <ct-vstack gap="md" style="padding: 1rem;">
            <ct-button
              onClick={handleNewChat({})}
              variant="primary"
            >
              New chat
            </ct-button>
          </ct-vstack>
        </ct-screen>
      ),
      title,
    };
  },
);
