/// <cts-enable />
import { computed, pattern, UI } from "commontools";

interface Reaction {
  emoji: string;
}

interface Message {
  id: string;
  reactions?: Reaction[];
}

interface Input {
  messages: Message[];
}

export default pattern<Input>(({ messages }) => {
  return {
    [UI]: (
      <div>
        {messages.map((msg) => {
          const messageReactions = computed(() => (msg.reactions) || []);
          return (
            <div>
              {messageReactions.map((reaction) => (
                <button data-msg-id={msg.id}>{reaction.emoji}</button>
              ))}
            </div>
          );
        })}
      </div>
    ),
  };
});
