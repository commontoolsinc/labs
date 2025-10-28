/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  handler,
  llmDialog,
  NAME,
  recipe,
  Stream,
  UI,
  VNode,
  wish,
} from "commontools";
import { type MentionableCharm } from "./backlinks-index.tsx";

type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: any;
  charm?: any;
};

const addAttachment = handler<
  {
    detail: {
      attachment: PromptAttachment;
    };
  },
  {
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>((event, { allAttachments }) => {
  const { attachment } = event.detail;
  const current = allAttachments.get() || [];
  allAttachments.set([...current, attachment]);
});

const removeAttachment = handler<
  {
    detail: {
      id: string;
    };
  },
  {
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>((event, { allAttachments }) => {
  const { id } = event.detail;
  const current = allAttachments.get() || [];
  allAttachments.set(current.filter((a) => a.id !== id));
});

const sendMessage = handler<
  {
    detail: {
      text: string;
      attachments: Array<PromptAttachment>;
      mentions: Array<any>;
      message: string;
    };
  },
  {
    addMessage: Stream<BuiltInLLMMessage>;
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>((event, { addMessage, allAttachments }) => {
  const { text } = event.detail;

  // Build content array from text and attachments
  const contentParts = [{ type: "text" as const, text }];

  // Get current attachments
  const attachments = allAttachments.get() || [];

  // Process attachments
  for (const attachment of attachments) {
    if (attachment.type === "file" && attachment.data) {
      contentParts.push({
        type: "text" as const,
        text: `[Attached file: ${attachment.name}]`,
      });
    } else if (attachment.type === "clipboard" && attachment.data) {
      contentParts.push({
        type: "text" as const,
        text: `\n\n--- Pasted content ---\n${attachment.data}`,
      });
    }
  }

  addMessage.send({
    role: "user",
    content: contentParts,
  });
});

const toggleFab = handler<
  never,
  {
    expanded: Cell<boolean>;
  }
>((_event, { expanded }) => {
  expanded.set(!expanded.get());
});

type FABDemoInput = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
  theme?: any;
};

type FABDemoOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  expanded: boolean;
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
  attachments: Array<PromptAttachment>;
  ui: VNode;
};

export default recipe<FABDemoInput, FABDemoOutput>(
  "FAB Demo",
  ({ messages, theme }) => {
    const model = cell<string>("anthropic:claude-sonnet-4-5");
    const expanded = cell<boolean>(false);
    const allAttachments = cell<Array<PromptAttachment>>([]);
    const mentionable = wish<MentionableCharm[]>("#mentionable");

    const { addMessage, cancelGeneration, pending } = llmDialog({
      system: "You are a helpful assistant.",
      messages,
      model,
    });

    // Close FAB when backdrop clicked or escape pressed
    const closeFab = handler((_: never, { expanded }: { expanded: Cell<boolean> }) => {
      expanded.set(false);
    });

    // Open FAB when in collapsed state (handled by parent)
    const openFab = handler((_: never, { expanded }: { expanded: Cell<boolean> }) => {
      if (!expanded.get()) {
        expanded.set(true);
      }
    });

    return {
      [NAME]: "FAB Demo",
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header">
            <ct-heading level={4}>FAB Demo - Phase 1</ct-heading>
            <ct-label>
              Click the FAB in the bottom-right to start a conversation
            </ct-label>
          </ct-vstack>

          <ct-vstack flex padding="large" gap="normal">
            <ct-label>
              This demo shows the basic morphing FAB with ct-omnibox and
              ct-prompt-input integration.
            </ct-label>
            <ct-label>Features:</ct-label>
            <ct-vstack gap="compact">
              <ct-label>✓ Morphing animation (circle → panel)</ct-label>
              <ct-label>✓ Backdrop overlay with blur</ct-label>
              <ct-label>✓ Click outside or ESC to close</ct-label>
              <ct-label>✓ Controlled state management</ct-label>
              <ct-label>✓ Cell integration for messages</ct-label>
              <ct-label>✓ Event forwarding from ct-prompt-input</ct-label>
            </ct-vstack>
            <ct-separator />
            <ct-label>Phase 2 will add:</ct-label>
            <ct-vstack gap="compact">
              <ct-label>• Notification peek</ct-label>
              <ct-label>• History panel with ct-chat</ct-label>
              <ct-label>• Context pills (tools + attachments)</ct-label>
              <ct-label>• State transitions</ct-label>
            </ct-vstack>
          </ct-vstack>

          {/* FAB component */}
          <ct-fab
            expanded={expanded}
            variant="primary"
            position="bottom-right"
            onct-fab-backdrop-click={closeFab({ expanded })}
            onct-fab-escape={closeFab({ expanded })}
          >
            <ct-omnibox
              $messages={messages}
              pending={pending}
              $mentionable={mentionable}
              onct-send={sendMessage({ addMessage, allAttachments })}
              onct-stop={cancelGeneration}
              onct-attachment-add={addAttachment({ allAttachments })}
              onct-attachment-remove={removeAttachment({ allAttachments })}
            />
          </ct-fab>
        </ct-screen>
      ),
      messages,
      pending,
      expanded,
      addMessage,
      cancelGeneration,
      attachments: allAttachments,
      ui: null as any,
    };
  },
);
