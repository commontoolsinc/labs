/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  derive,
  handler,
  llmDialog,
  NAME,
  recipe,
  UI,
  wish,
} from "commontools";
import { type MentionableCharm } from "./backlinks-index.tsx";

const closeFab = handler<any, { fabExpanded: Cell<boolean> }>(
  (_, { fabExpanded }) => {
    fabExpanded.set(false);
  },
);

const sendMessage = handler<
  {
    detail: {
      text: string;
      attachments: any[];
      mentions: any[];
      message: string;
    };
  },
  {
    addMessage: any;
  }
>((event, { addMessage }) => {
  const { text } = event.detail;

  addMessage.send({
    role: "user",
    content: text,
  });
});

export default recipe(
  "FAB Test Minimal",
  (_) => {
    const fabExpanded = cell(false);
    const messages = cell<BuiltInLLMMessage[]>([]);
    const mentionable = derive<MentionableCharm[], MentionableCharm[]>(
      wish<MentionableCharm[]>("#mentionable"),
      (c) => c,
    );

    const { addMessage, cancelGeneration, pending } = llmDialog({
      system: "You are a helpful assistant.",
      messages,
      model: cell("anthropic:claude-sonnet-4-5"),
    });

    return {
      [NAME]: "FAB Test Minimal",
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header">
            <ct-heading level={4}>Minimal FAB Integration Test</ct-heading>
          </ct-vstack>

          <ct-vstack flex padding="large" gap="normal">
            <ct-label>
              Click the FAB in the bottom-right corner to start chatting!
            </ct-label>
            <ct-label>Press Escape to close it.</ct-label>
          </ct-vstack>

          <ct-fab
            $expanded={fabExpanded}
            variant="primary"
            position="bottom-right"
            onct-fab-backdrop-click={closeFab({ fabExpanded })}
            onct-fab-escape={closeFab({ fabExpanded })}
          >
            <ct-omnibox
              $messages={messages}
              pending={pending}
              $mentionable={mentionable}
              onct-send={sendMessage({ addMessage })}
              onct-stop={cancelGeneration}
            />
          </ct-fab>
        </ct-screen>
      ),
    };
  },
);
