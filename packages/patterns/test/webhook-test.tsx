/// <cts-enable />
import {
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

interface WebhookConfig {
  url: string;
  secret: string;
}

interface WebhookPatternInput {
  webhookInbox: Stream<Default<unknown, null>>;
  webhookConfig: Writable<Default<WebhookConfig | null, null>>;
}

interface WebhookPatternOutput {
  [NAME]: string;
  [UI]: VNode;
  webhookConfig: WebhookConfig | null;
  lastEvent: unknown;
}

// ===== Pattern =====

const WebhookTest = pattern<WebhookPatternInput, WebhookPatternOutput>(
  ({ webhookInbox, webhookConfig }) => {
    const inboxDisplay = computed(() => {
      const val = webhookInbox.get();
      if (val == null) return "No events received yet.";
      return JSON.stringify(val, null, 2);
    });

    return {
      [NAME]: "Webhook Test Pattern",
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="1">
            <ct-heading level={4}>Webhook Test</ct-heading>
          </ct-vstack>

          <ct-vstack gap="3" style="padding: 1.5rem;">
            <ct-card>
              <ct-vstack gap="2">
                <div style={{ fontWeight: "600", fontSize: "1rem" }}>
                  Webhook Integration
                </div>
                <div
                  style={{
                    color: "var(--ct-color-gray-500)",
                    fontSize: "0.875rem",
                  }}
                >
                  Click "Create Webhook" to register a new endpoint. The URL and
                  secret will be stored in the config cell below.
                </div>
                <ct-webhook
                  name="Test Webhook"
                  $inbox={webhookInbox}
                  $config={webhookConfig}
                />
              </ct-vstack>
            </ct-card>

            <ct-card>
              <ct-vstack gap="2">
                <div style={{ fontWeight: "600", fontSize: "1rem" }}>
                  Last Received Event
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    fontFamily: "monospace",
                    background: "var(--ct-color-gray-100, #f3f4f6)",
                    padding: "0.5rem",
                    borderRadius: "0.25rem",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {inboxDisplay}
                </div>
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-screen>
      ),
      webhookConfig,
      lastEvent: webhookInbox,
    };
  },
);

export default WebhookTest;
