/// <cts-enable />
import { handler, NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VignetteSupportDeskInput {}
interface VignetteSupportDeskOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const initialMessages = [
  {
    role: "user",
    content: "Search in the settings view is not returning results.",
  },
  {
    role: "assistant",
    content:
      "I can help with that. Which browser and workspace are you using right now?",
  },
  {
    role: "user",
    content: "Chrome, and I see it in the catalog preview environment.",
  },
  {
    role: "assistant",
    content:
      "Thanks. I am creating a triage note and collecting reproduction details.",
  },
];

const sendMessage = handler<
  CustomEvent<{ text?: string }>,
  { messages: Writable<typeof initialMessages> }
>((event, { messages }) => {
  const text = event?.detail?.text?.trim();
  if (!text) return;
  messages.set([...messages.get(), { role: "user", content: text }]);
});

export default pattern<VignetteSupportDeskInput, VignetteSupportDeskOutput>(
  () => {
    const messages = Writable.of(initialMessages);
    const pending = Writable.of(false);
    const area = Writable.of("catalog");

    return {
      [NAME]: "Vignette: Support Desk",
      [UI]: (
        <div style={{ padding: "1rem" }}>
          <ct-grid columns="2" gap="4">
            <ct-card>
              <ct-vstack gap="3">
                <ct-hstack justify="between" align="center">
                  <ct-heading level={5}>Issue Intake</ct-heading>
                  <ct-badge variant="secondary">P2</ct-badge>
                </ct-hstack>

                <ct-vstack gap="1">
                  <span style="font-size: 12px; color: #64748b;">Customer</span>
                  <ct-input placeholder="Acme Corp" />
                </ct-vstack>

                <ct-vstack gap="1">
                  <span style="font-size: 12px; color: #64748b;">
                    Affected area
                  </span>
                  <ct-select
                    $value={area}
                    items={[
                      { label: "Catalog", value: "catalog" },
                      { label: "Runtime", value: "runtime" },
                      { label: "Auth", value: "auth" },
                    ]}
                  />
                </ct-vstack>

                <ct-vstack gap="1">
                  <span style="font-size: 12px; color: #64748b;">Tags</span>
                  <ct-tags tags={["search", "regression", "chrome"]} />
                </ct-vstack>

                <ct-hstack gap="2">
                  <ct-button variant="secondary">Save Draft</ct-button>
                  <ct-button variant="primary">Escalate</ct-button>
                </ct-hstack>
              </ct-vstack>
            </ct-card>

            <ct-card>
              <ct-vstack gap="2" style="height: 100%;">
                <ct-hstack justify="between" align="center">
                  <ct-heading level={5}>Live Thread</ct-heading>
                  {pending.get() ? <ct-loader size="sm" /> : null}
                </ct-hstack>

                <ct-vscroll style="flex: 1; min-height: 260px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px;">
                  <ct-chat $messages={messages} pending={pending} />
                </ct-vscroll>

                <ct-message-input
                  placeholder="Reply to customer"
                  onct-send={sendMessage({ messages })}
                />
              </ct-vstack>
            </ct-card>
          </ct-grid>
        </div>
      ),
      controls: (
        <Controls>
          <SwitchControl
            label="pending"
            description="Show loading in the conversation thread"
            defaultValue="false"
            checked={pending}
          />
        </Controls>
      ),
    };
  },
);
