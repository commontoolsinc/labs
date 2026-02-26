/// <cts-enable />
import { Default, NAME, pattern, UI, type VNode, Writable } from "commontools";

// ===== Types =====

interface WebhookConfig {
  url: string;
  secret: string;
}

interface WebhookPatternInput {
  webhookInbox: Writable<Default<unknown, null>>;
  webhookConfig: Writable<Default<WebhookConfig | null, null>>;
}

interface WebhookPatternOutput {
  [NAME]: string;
  [UI]: VNode;
  webhookConfig: WebhookConfig | null;
  lastEvent: unknown;
}

// ===== JSX type declaration for ct-webhook =====
// ct-webhook is not yet in the global JSX intrinsic elements, so we declare it here.

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ct-webhook": {
        name?: string;
        "$inbox"?: unknown;
        "$config"?: unknown;
        [key: string]: unknown;
      };
    }
  }
}

// ===== Pattern =====

const WebhookTest = pattern<WebhookPatternInput, WebhookPatternOutput>(
  ({ webhookInbox, webhookConfig }) => {
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
                {webhookInbox == null
                  ? (
                    <div
                      style={{
                        color: "var(--ct-color-gray-500)",
                        fontSize: "0.875rem",
                      }}
                    >
                      No events received yet. Create a webhook and send a POST
                      to its URL.
                    </div>
                  )
                  : (
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
                      {JSON.stringify(webhookInbox)}
                    </div>
                  )}
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-screen>
      ),
      webhookConfig,
      // Export the stream value so linked patterns can observe it.
      // The inbox is a stream — each POST delivers the latest payload here.
      lastEvent: webhookInbox,
    };
  },
);

export default WebhookTest;
