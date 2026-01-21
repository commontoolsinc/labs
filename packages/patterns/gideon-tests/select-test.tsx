/// <cts-enable />
import { Default, NAME, pattern, UI, Writable } from "commontools";

type Status = "want" | "reading" | "finished";

// Test pattern for ct-select and ct-input components
// Tests three scenarios:
// 1. Local Writable.of (local state)
// 2. Writable<Default<...>> as input (writable with default)
// 3. Plain Default<...> as input (read-only with default)

interface Input {
  // Writable input with default
  writableStatus?: Writable<Default<Status, "want">>;
  writableText?: Writable<Default<string, "hello">>;
  // Plain default input (read-only)
  plainStatus?: Default<Status, "reading">;
  plainText?: Default<string, "world">;
}

interface Output {
  [NAME]: string;
  writableStatus: Status;
  writableText: string;
  plainStatus: Status;
  plainText: string;
  localStatus: Status;
  localText: string;
}

export default pattern<Input, Output>(
  ({ writableStatus, writableText, plainStatus, plainText }) => {
    // Local Writable created in pattern body
    const localStatus = Writable.of<Status>("want");
    const localText = Writable.of<string>("local text");

    return {
      [NAME]: "Select Test",
      [UI]: (
        <ct-screen>
          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="4" style="padding: 1rem;">
              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={4}>Test 1: Local Writable.of</ct-heading>
                  <p>Local Writable created in pattern body</p>
                  <ct-select
                    $value={localStatus}
                    items={[
                      { label: "Want to read", value: "want" },
                      { label: "Reading", value: "reading" },
                      { label: "Finished", value: "finished" },
                    ]}
                  />
                  <p>Select value: {localStatus}</p>
                  <ct-input $value={localText} placeholder="Local text..." />
                  <p>Input value: {localText}</p>
                </ct-vstack>
              </ct-card>

              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={4}>
                    Test 2: Writable&lt;Default&lt;...&gt;&gt; Input
                  </ct-heading>
                  <p>Input field with Writable wrapper</p>
                  <ct-select
                    $value={writableStatus}
                    items={[
                      { label: "Want to read", value: "want" },
                      { label: "Reading", value: "reading" },
                      { label: "Finished", value: "finished" },
                    ]}
                  />
                  <p>Select value: {writableStatus}</p>
                  <ct-input
                    $value={writableText}
                    placeholder="Writable text..."
                  />
                  <p>Input value: {writableText}</p>
                </ct-vstack>
              </ct-card>

              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={4}>
                    Test 3: Plain Default&lt;...&gt; Input
                  </ct-heading>
                  <p>Input field WITHOUT Writable wrapper (read-only)</p>
                  <ct-select
                    $value={plainStatus}
                    items={[
                      { label: "Want to read", value: "want" },
                      { label: "Reading", value: "reading" },
                      { label: "Finished", value: "finished" },
                    ]}
                  />
                  <p>Select value: {plainStatus}</p>
                  <ct-input $value={plainText} placeholder="Plain text..." />
                  <p>Input value: {plainText}</p>
                </ct-vstack>
              </ct-card>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      writableStatus,
      writableText,
      plainStatus,
      plainText,
      localStatus,
      localText,
    };
  },
);
