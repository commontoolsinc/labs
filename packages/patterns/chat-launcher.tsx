/// <cts-enable />
import { Default, h, handler, NAME, recipe, UI } from "commontools";

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
  console.log("New chat button clicked");
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
