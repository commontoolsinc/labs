/// <cts-enable />
import {
  BuiltInLLMMessage,
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

interface LLMTestInput {
  title: Default<string, "who knows">;
  chat: Default<BuiltInLLMMessage[], []>;
}

// we'll use default just like chat-user-sessions
// and the main recipe will create this by default
// and we'll only track its title!!!
// and we'll ONLY REMEMBER ONE TO START
type MainRecipeInput = {
  title: Default<string, "">;
  chat: Default<BuiltInLLMMessage[], []>;
}

const createChat = handler<
  unknown,
  {
    title: Default<string, "">,
    chat: Default<BuiltInLLMMessage[], []>;
  }
>((_, { title, chat }) => {
  console.log("[ChatLauncher] New chat button clicked, title=", JSON.stringify(title), " chat=", JSON.stringify(chat));

  // Create the chat instance with a fresh cell
  const newChatInstance = Chat({
    title: title as any,
    chat: chat as any,
  });

  console.log("[ChatLauncher] newChatInstance====", JSON.stringify(newChatInstance));
  // Navigate to the new chat
  return navigateTo(newChatInstance);
});

export default recipe<MainRecipeInput>(
  "Chat Launcher",
  ({ title , chat }) => {
    derive( title, (t) => console.log("title=", t) );

    return {
      [NAME]: {title},
      [UI]: (
          <h2>title is {title}</h2>
          <div>
            <ct-button onClick={createChat({ title, chat })}>
              Generate Chat
            </ct-button>
          </div>
      ),
      title,
      chat,
    };
  },
);
