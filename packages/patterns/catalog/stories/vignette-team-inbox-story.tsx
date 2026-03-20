/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VignetteTeamInboxInput {}
interface VignetteTeamInboxOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

type Priority = "low" | "medium" | "high";

type InboxItem = {
  title: string;
  owner: string;
  status: "todo" | "in-progress" | "blocked";
  priority: Priority;
};

const allItems: InboxItem[] = [
  {
    title: "Refine mobile nav states",
    owner: "Sam",
    status: "in-progress",
    priority: "high",
  },
  {
    title: "Document ct-tabs keyboard behavior",
    owner: "Alex",
    status: "todo",
    priority: "medium",
  },
  {
    title: "Audit color tokens for contrast",
    owner: "Jordan",
    status: "blocked",
    priority: "high",
  },
  {
    title: "Polish empty states for cards",
    owner: "Chris",
    status: "todo",
    priority: "low",
  },
];

const rowGridTemplate =
  "minmax(360px, 2.5fr) minmax(120px, 1fr) minmax(140px, 1fr) minmax(110px, auto)";

function getVisibleItems(filter: "all" | "focus"): InboxItem[] {
  if (filter === "focus") {
    return allItems.filter((item) => item.priority === "high");
  }
  return allItems;
}

function getBadgeVariant(
  priority: Priority,
): "destructive" | "secondary" | "outline" {
  switch (priority) {
    case "high":
      return "destructive";
    case "medium":
      return "secondary";
    default:
      return "outline";
  }
}

export default pattern<VignetteTeamInboxInput, VignetteTeamInboxOutput>(() => {
  const compact = Writable.of(false);
  const filter = Writable.of<"all" | "focus">("all");

  return {
    [NAME]: "Vignette: Team Inbox",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <ct-card>
          <ct-vstack gap="3">
            <ct-toolbar>
              <ct-hstack
                slot="start"
                gap="2"
                align="center"
                style="min-height: 44px;"
              >
                <ct-heading level={5} style="margin: 0; line-height: 1;">
                  Team Inbox
                </ct-heading>
                <span style="position: relative; top: -1px;">
                  <ct-badge variant="secondary">4 Active</ct-badge>
                </span>
              </ct-hstack>
              <ct-hstack
                slot="end"
                gap="2"
                align="center"
                style="min-height: 44px;"
              >
                <ct-button variant="ghost" size="sm">New Task</ct-button>
                <ct-button variant="primary" size="sm">Review Queue</ct-button>
              </ct-hstack>
            </ct-toolbar>

            <ct-hstack gap="2" align="center" wrap>
              <span style="font-size: 12px; color: #64748b;">Focus:</span>
              <ct-select
                $value={filter}
                items={[
                  { label: "All items", value: "all" },
                  { label: "High priority", value: "focus" },
                ]}
              />
              <ct-badge variant="outline">Design System Sprint</ct-badge>
              <ct-badge variant="outline">Catalog Stories</ct-badge>
            </ct-hstack>

            <ct-vstack gap="1">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: rowGridTemplate,
                  gap: "12px",
                  padding: "0 10px",
                  alignItems: "center",
                  fontSize: "12px",
                  fontWeight: "700",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: "#64748b",
                }}
              >
                <span>Task</span>
                <span>Owner</span>
                <span>Status</span>
                <span style={{ textAlign: "right" }}>Priority</span>
              </div>

              {getVisibleItems(filter.get()).map((item) => (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: rowGridTemplate,
                    gap: "12px",
                    alignItems: "center",
                    padding: "12px 10px",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    backgroundColor: "#ffffff",
                  }}
                >
                  <span style={{ fontWeight: "600" }}>{item.title}</span>
                  <span style={{ color: "#475569" }}>{item.owner}</span>
                  <span>
                    <ct-badge variant="outline">{item.status}</ct-badge>
                  </span>
                  <span style={{ display: "flex", justifyContent: "flex-end" }}>
                    <ct-badge variant={getBadgeVariant(item.priority)}>
                      {item.priority}
                    </ct-badge>
                  </span>
                </div>
              ))}
            </ct-vstack>

            <ct-vstack gap="1">
              <ct-hstack justify="between" align="center">
                <span style="font-size: 12px; color: #64748b;">
                  Sprint completion
                </span>
                <span style="font-size: 12px; color: #475569;">68%</span>
              </ct-hstack>
              <ct-progress value={68} max={100} indeterminate={compact} />
            </ct-vstack>
          </ct-vstack>
        </ct-card>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="filter"
            description="Quick filter for the inbox rows"
            defaultValue="all"
            value={filter}
            items={[
              { label: "All items", value: "all" },
              { label: "High priority", value: "focus" },
            ]}
          />
          <SwitchControl
            label="compact"
            description="Use indeterminate progress bar animation"
            defaultValue="false"
            checked={compact}
          />
        </>
      </Controls>
    ),
  };
});
