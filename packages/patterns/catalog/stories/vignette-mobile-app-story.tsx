import { action, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface VignetteMobileAppInput {}
interface VignetteMobileAppOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const phoneFrame = {
  width: "375px",
  height: "667px",
  border: "1px solid #d1d5db",
  borderRadius: "24px",
  overflow: "hidden",
  position: "relative" as const,
  background: "#f0f2f7",
  fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  margin: "0 auto",
};

const tasks = [
  {
    title: "Schedule vet appointment",
    category: "Pet care",
    status: "Needs action",
  },
  {
    title: "Prepare slides for all-hands",
    category: "Work",
    status: "In progress",
  },
  {
    title: "Draft pattern implementation",
    category: "Fabric",
    status: "Ready",
  },
  {
    title: "Triage partner threads",
    category: "Comms",
    status: "Fresh",
  },
  {
    title: "Review design feedback",
    category: "Design",
    status: "Pending",
  },
];

export default pattern<VignetteMobileAppInput, VignetteMobileAppOutput>(() => {
  const activeTab = Writable.of("home");
  const sheetOpen = Writable.of(false);
  const toastOpen = Writable.of(false);

  const openSheet = action(() => sheetOpen.set(true));
  const closeSheet = action(() => sheetOpen.set(false));
  const handleCreate = action(() => {
    sheetOpen.set(false);
    toastOpen.set(true);
  });
  const dismissToast = action(() => toastOpen.set(false));

  return {
    [NAME]: "Vignette: Mobile App",
    [UI]: (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100%",
          padding: "40px",
          background:
            "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
        }}
      >
        <div style={phoneFrame}>
          {/* Header */}
          <div
            style={{
              padding: "20px 20px 8px",
              fontSize: "22px",
              fontWeight: "700",
              color: "#1a1a2e",
            }}
          >
            Home
          </div>

          {/* Scrollable card list */}
          <div
            style={{
              overflowY: "auto",
              height: "calc(100% - 60px - 80px)",
              padding: "0 16px 16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              boxSizing: "border-box",
            }}
          >
            {tasks.map((task) => (
              <div
                style={{
                  background: "rgba(255,255,255,0.85)",
                  borderRadius: "14px",
                  padding: "14px 16px",
                  border: "1px solid rgba(0,0,0,0.06)",
                  flexShrink: "0",
                }}
              >
                <div
                  style={{
                    fontSize: "15px",
                    fontWeight: "600",
                    color: "#1a1a2e",
                    marginBottom: "6px",
                  }}
                >
                  {task.title}
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "12px",
                    color: "#8e94a8",
                  }}
                >
                  <span>{task.category}</span>
                  <span>{task.status}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Tab bar with action */}
          <cf-tab-bar
            $value={activeTab}
            variant="inset"
            style="position: absolute;"
          >
            <cf-tab-bar-item value="home" label="Home">
              <span slot="icon">&#127968;</span>
            </cf-tab-bar-item>
            <cf-tab-bar-item value="search" label="Search">
              <span slot="icon">&#128269;</span>
            </cf-tab-bar-item>
            <cf-tab-bar-item value="inbox" label="Inbox">
              <span slot="icon">&#128236;</span>
            </cf-tab-bar-item>
            <cf-tab-bar-item value="profile" label="Profile">
              <span slot="icon">&#128100;</span>
            </cf-tab-bar-item>
            <cf-button
              slot="action"
              variant="primary"
              onClick={openSheet}
              style="border-radius: var(--cf-border-radius-xl, 0.75rem); width: 3.5rem; height: 100%; padding: 0; flex-shrink: 0;"
            >
              &#65291;
            </cf-button>
          </cf-tab-bar>

          {/* Sheet modal for creating */}
          <cf-modal
            $open={sheetOpen}
            presentation="sheet"
            grabber
            detent="half"
            dismissable
          >
            <div slot="header">
              <cf-heading level={5}>New Task</cf-heading>
            </div>
            <cf-vstack gap="3" style="padding: 4px 0;">
              <cf-textarea
                placeholder="What needs to be done?"
                style="min-height: 80px;"
              />
            </cf-vstack>
            <div slot="footer">
              <cf-hstack gap="2" justify="end" style="width: 100%;">
                <cf-button variant="secondary" onClick={closeSheet}>
                  Cancel
                </cf-button>
                <cf-button variant="primary" onClick={handleCreate}>
                  Create
                </cf-button>
              </cf-hstack>
            </div>
          </cf-modal>

          {/* Success toast */}
          <cf-toast-provider position="bottom">
            <cf-toast
              open={toastOpen}
              variant="success"
              duration={4000}
              oncf-toast-dismiss={dismissToast}
            >
              Task created.
              <cf-button
                slot="action"
                variant="ghost"
                style="padding: 2px 8px; font-size: 13px;"
              >
                View
              </cf-button>
            </cf-toast>
          </cf-toast-provider>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        Mobile task manager vignette. Phone-sized frame (375x667px) with dark
        gradient surround. Demonstrates cf-tab-bar (inset + action slot),
        cf-modal (sheet presentation), and cf-toast (success with action)
        working together in a realistic app flow.
      </div>
    ),
  };
});
