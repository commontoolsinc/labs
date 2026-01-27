/// <cts-enable />
import { NAME, pattern, UI, Writable } from "commontools";

/**
 * Reproduction case for ct-select not displaying initial values from backend.
 *
 * Bug: When a ct-select is bound to a cell via $value, the dropdown would show
 * the placeholder "-" instead of the actual cell value on initial page load.
 * The value was present in the cell, but the component's onChange callback
 * wasn't being called when the subscription received backend updates.
 *
 * Root cause: CellController._setupCellSubscription() only called
 * host.requestUpdate() when cell values changed, but didn't call the onChange
 * callback. Components like ct-select rely on onChange to sync their DOM state.
 *
 * Fix: In cell-controller.ts, the subscription callback now calls onChange
 * when the cell value changes from the backend.
 *
 * To test:
 * 1. Deploy this pattern with `charm new`
 * 2. Use CLI to set values: echo '"video"' | ct charm set --charm ID type ...
 * 3. Refresh the page - the dropdown should show "🎬 Video", not "-"
 * 4. The "Current value" text should also display "video"
 */

interface Output {
  [NAME]: string;
  type: string;
  status: string;
}

export default pattern<Record<string, never>, Output>(() => {
  const type = Writable.of<string>("article");
  const status = Writable.of<string>("want");

  return {
    [NAME]: "Select Initial Value Repro",
    [UI]: (
      <ct-screen>
        <ct-vstack gap="4" style="padding: 1rem;">
          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>Type Select</ct-heading>
              <ct-select
                $value={type}
                items={[
                  { label: "📄 Article", value: "article" },
                  { label: "📚 Book", value: "book" },
                  { label: "📑 Paper", value: "paper" },
                  { label: "🎬 Video", value: "video" },
                ]}
              />
              <p>
                <strong>Current value:</strong> {type}
              </p>
            </ct-vstack>
          </ct-card>

          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>Status Select</ct-heading>
              <ct-select
                $value={status}
                items={[
                  { label: "Want to read", value: "want" },
                  { label: "Reading", value: "reading" },
                  { label: "Finished", value: "finished" },
                  { label: "Abandoned", value: "abandoned" },
                ]}
              />
              <p>
                <strong>Current value:</strong> {status}
              </p>
            </ct-vstack>
          </ct-card>

          <p style="color: gray; font-size: 0.875rem;">
            If either dropdown shows "-" instead of its value on page load, the
            bug is present. Both dropdowns should show their selected values
            immediately.
          </p>
        </ct-vstack>
      </ct-screen>
    ),
    type,
    status,
  };
});
