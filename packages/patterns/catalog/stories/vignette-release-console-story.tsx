/// <cts-enable />
import { action, NAME, pattern, UI, type VNode, Writable } from "commontools";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VignetteReleaseConsoleInput {}
interface VignetteReleaseConsoleOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const deployData = [
  { hour: "09", success: 3 },
  { hour: "10", success: 5 },
  { hour: "11", success: 4 },
  { hour: "12", success: 6 },
  { hour: "13", success: 8 },
  { hour: "14", success: 7 },
];

export default pattern<
  VignetteReleaseConsoleInput,
  VignetteReleaseConsoleOutput
>(
  () => {
    const mode = Writable.of<"normal" | "maintenance">("normal");
    const paused = Writable.of(false);
    const open = Writable.of(false);

    const openModal = action(() => open.set(true));
    const closeModal = action(() => open.set(false));

    return {
      [NAME]: "Vignette: Release Console",
      [UI]: (
        <div style={{ padding: "1rem" }}>
          <ct-vstack gap="3">
            <ct-toolbar>
              <ct-heading slot="start" level={5}>Release Console</ct-heading>
              <ct-hstack slot="end" gap="2">
                <ct-badge variant={paused.get() ? "destructive" : "secondary"}>
                  {paused.get() ? "Paused" : "Healthy"}
                </ct-badge>
                <ct-button variant="secondary" size="sm" onClick={openModal}>
                  Publish
                </ct-button>
              </ct-hstack>
            </ct-toolbar>

            <ct-alert
              variant={mode.get() === "maintenance" ? "warning" : "info"}
              dismissible
            >
              <span slot="title">
                {mode.get() === "maintenance"
                  ? "Maintenance mode enabled"
                  : "Deploy pipeline active"}
              </span>
              <span slot="description">
                {mode.get() === "maintenance"
                  ? "Writes are restricted while we apply schema migrations."
                  : "All release checks are passing for this environment."}
              </span>
            </ct-alert>

            <ct-grid columns="3" gap="4">
              <ct-card>
                <ct-vstack gap="1">
                  <span style="font-size: 12px; color: #64748b;">
                    Pass Rate
                  </span>
                  <ct-heading level={4}>98.2%</ct-heading>
                </ct-vstack>
              </ct-card>
              <ct-card>
                <ct-vstack gap="1">
                  <span style="font-size: 12px; color: #64748b;">
                    Mean Build Time
                  </span>
                  <ct-heading level={4}>6m 14s</ct-heading>
                </ct-vstack>
              </ct-card>
              <ct-card>
                <ct-vstack gap="1">
                  <span style="font-size: 12px; color: #64748b;">
                    Queued Jobs
                  </span>
                  <ct-heading level={4}>12</ct-heading>
                </ct-vstack>
              </ct-card>
            </ct-grid>

            <ct-card>
              <ct-vstack gap="2">
                <ct-hstack justify="between" align="center">
                  <ct-heading level={5}>Deploy Throughput</ct-heading>
                  <ct-copy-button
                    text="release --env staging --approve"
                    variant="ghost"
                  >
                    Copy command
                  </ct-copy-button>
                </ct-hstack>
                <ct-chart height={180} xAxis yAxis>
                  <ct-line-mark
                    data={deployData}
                    x="hour"
                    y="success"
                    color="#0ea5e9"
                    label="Successful deploys"
                  />
                </ct-chart>
              </ct-vstack>
            </ct-card>

            <ct-modal $open={open} dismissable size="md">
              <div slot="header">
                <ct-heading level={4}>Confirm Release</ct-heading>
              </div>
              <ct-vstack gap="2">
                <span>
                  Ready to publish build `2026.03.19.4` to production?
                </span>
                <ct-checkbox $checked={paused}>
                  Pause background jobs
                </ct-checkbox>
              </ct-vstack>
              <div slot="footer">
                <ct-hstack justify="end" gap="2">
                  <ct-button variant="secondary" onClick={closeModal}>
                    Cancel
                  </ct-button>
                  <ct-button variant="primary" onClick={closeModal}>
                    Ship
                  </ct-button>
                </ct-hstack>
              </div>
            </ct-modal>
          </ct-vstack>
        </div>
      ),
      controls: (
        <Controls>
          <>
            <SelectControl
              label="mode"
              description="Environment state banner"
              defaultValue="normal"
              value={mode}
              items={[
                { label: "Normal", value: "normal" },
                { label: "Maintenance", value: "maintenance" },
              ]}
            />
            <SwitchControl
              label="paused"
              description="Pause background workers"
              defaultValue="false"
              checked={paused}
            />
          </>
        </Controls>
      ),
    };
  },
);
