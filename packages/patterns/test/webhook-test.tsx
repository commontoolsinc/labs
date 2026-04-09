import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====

interface WebhookConfig {
  url: string;
  secret: string;
}

interface WebhookPatternInput {
  webhookConfig: Writable<Default<WebhookConfig | null, null>>;
}

interface WebhookPatternOutput {
  [NAME]: string;
  [UI]: VNode;
  webhookInbox: Stream<unknown>;
  webhookConfig: WebhookConfig | null;
  lastEvent: unknown;
}

// ===== Handler =====

const onWebhookEvent = handler<
  unknown,
  { lastEvent: Writable<unknown> }
>((event, { lastEvent }) => {
  lastEvent.set(event);
});

// ===== Pattern =====

const WebhookTest = pattern<WebhookPatternInput, WebhookPatternOutput>(
  ({ webhookConfig }) => {
    const lastEvent = Writable.of(null as unknown);
    const webhookInbox = onWebhookEvent({ lastEvent });

    const inboxDisplay = computed(() => {
      const val = lastEvent.get();
      if (val == null) return "No events received yet.";
      return JSON.stringify(val, null, 2);
    });

    return {
      [NAME]: "Webhook Test Pattern",
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>Webhook Test</cf-heading>
          </cf-vstack>

          <cf-vstack gap="3" style="padding: 1.5rem;">
            <cf-card>
              <cf-vstack gap="2">
                <div style={{ fontWeight: "600", fontSize: "1rem" }}>
                  Webhook Integration
                </div>
                <div
                  style={{
                    color: "var(--cf-color-gray-500)",
                    fontSize: "0.875rem",
                  }}
                >
                  Click "Create Webhook" to register a new endpoint. The URL and
                  secret will be stored in the config cell below.
                </div>
                <cf-webhook
                  name="Test Webhook"
                  $inbox={webhookInbox}
                  $config={webhookConfig}
                />
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <div style={{ fontWeight: "600", fontSize: "1rem" }}>
                  Last Received Event
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    fontFamily: "monospace",
                    background: "var(--cf-color-gray-100, #f3f4f6)",
                    padding: "0.5rem",
                    borderRadius: "0.25rem",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {inboxDisplay}
                </div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      webhookInbox,
      webhookConfig,
      lastEvent,
    };
  },
);

export default WebhookTest;
