/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, Writable } from "commontools";
import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VignetteTodoListInput {}
interface VignetteTodoListOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<VignetteTodoListInput, VignetteTodoListOutput>(() => {
  const showCompleted = Writable.of(true);
  const one = Writable.of(true);
  const two = Writable.of(false);
  const three = Writable.of(false);
  const four = Writable.of(true);

  const completedCount = computed(
    () =>
      Number(one.get()) +
      Number(two.get()) +
      Number(three.get()) +
      Number(four.get()),
  );
  const completion = computed(
    () =>
      Math.round(
        ((Number(one.get()) +
          Number(two.get()) +
          Number(three.get()) +
          Number(four.get())) /
          4) * 100,
      ),
  );

  return {
    [NAME]: "Vignette: Todo List",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <ct-card>
          <ct-vstack gap="3">
            <ct-toolbar>
              <ct-hstack slot="start" gap="2" align="center">
                <ct-heading level={5} style="margin: 0;">Today</ct-heading>
                <ct-badge variant="secondary">{completedCount}/4 done</ct-badge>
              </ct-hstack>
              <ct-hstack slot="end" gap="2" align="center">
                <ct-button variant="ghost" size="sm">Clear done</ct-button>
                <ct-button variant="primary" size="sm">Add task</ct-button>
              </ct-hstack>
            </ct-toolbar>

            <ct-vstack gap="2">
              {(showCompleted.get() || !one.get())
                ? (
                  <ct-card>
                    <ct-hstack align="center" justify="between">
                      <ct-checkbox $checked={one}>
                        Capture notes from yesterday
                      </ct-checkbox>
                      <ct-badge variant="outline">research</ct-badge>
                    </ct-hstack>
                  </ct-card>
                )
                : null}

              {(showCompleted.get() || !two.get())
                ? (
                  <ct-card>
                    <ct-hstack align="center" justify="between">
                      <ct-checkbox $checked={two}>
                        Refine daily review template
                      </ct-checkbox>
                      <ct-badge variant="secondary">writing</ct-badge>
                    </ct-hstack>
                  </ct-card>
                )
                : null}

              {(showCompleted.get() || !three.get())
                ? (
                  <ct-card>
                    <ct-hstack align="center" justify="between">
                      <ct-checkbox $checked={three}>
                        Link unresolved ideas to source notes
                      </ct-checkbox>
                      <ct-badge variant="destructive">priority</ct-badge>
                    </ct-hstack>
                  </ct-card>
                )
                : null}

              {(showCompleted.get() || !four.get())
                ? (
                  <ct-card>
                    <ct-hstack align="center" justify="between">
                      <ct-checkbox $checked={four}>
                        Archive stale inbox items
                      </ct-checkbox>
                      <ct-badge variant="outline">admin</ct-badge>
                    </ct-hstack>
                  </ct-card>
                )
                : null}
            </ct-vstack>

            <ct-vstack gap="1">
              <ct-hstack justify="between" align="center">
                <span style="font-size: 12px; color: #64748b;">Completion</span>
                <span style="font-size: 12px; color: #475569;">
                  {completion}%
                </span>
              </ct-hstack>
              <ct-progress value={completion} max={100} />
            </ct-vstack>
          </ct-vstack>
        </ct-card>
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="showCompleted"
          description="Show tasks that are already done"
          defaultValue="true"
          checked={showCompleted}
        />
      </Controls>
    ),
  };
});
