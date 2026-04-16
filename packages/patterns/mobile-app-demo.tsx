import { action, computed, NAME, pattern, UI, Writable } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface MobileAppDemoInput {}
interface MobileAppDemoOutput {
  [NAME]: string;
  [UI]: unknown;
}

const tabContent: Record<
  string,
  { heading: string; items: { title: string; detail: string; meta: string }[] }
> = {
  home: {
    heading: "Home",
    items: [
      {
        title: "Schedule vet appointment",
        detail: "Pet care",
        meta: "Needs action",
      },
      {
        title: "Prepare slides for all-hands",
        detail: "Work",
        meta: "In progress",
      },
      {
        title: "Draft pattern implementation",
        detail: "Fabric",
        meta: "Ready",
      },
      { title: "Triage partner threads", detail: "Comms", meta: "Fresh" },
      { title: "Review design feedback", detail: "Design", meta: "Pending" },
    ],
  },
  search: {
    heading: "Search",
    items: [
      {
        title: "Navigation shell feedback",
        detail: "3 results",
        meta: "Thread",
      },
      { title: "Pattern deploy notes", detail: "7 results", meta: "Document" },
      { title: "Mobile home surface", detail: "12 results", meta: "Project" },
    ],
  },
  inbox: {
    heading: "Inbox",
    items: [
      {
        title: "Design review moved to Friday",
        detail: "From: Alex",
        meta: "2h ago",
      },
      {
        title: "Pattern deploy notes ready",
        detail: "From: Sam",
        meta: "4h ago",
      },
      {
        title: "New comments from research team",
        detail: "From: Jordan",
        meta: "Yesterday",
      },
      {
        title: "Fabric sync: nav shell feedback",
        detail: "From: Chris",
        meta: "Yesterday",
      },
    ],
  },
  profile: {
    heading: "Profile",
    items: [
      { title: "Edit display name", detail: "Settings", meta: "Account" },
      { title: "Notification preferences", detail: "Settings", meta: "Alerts" },
      { title: "Connected apps", detail: "2 active", meta: "Integrations" },
    ],
  },
};

export default pattern<MobileAppDemoInput, MobileAppDemoOutput>(() => {
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
    [NAME]: "Mobile App Demo",
    [UI]: (
      <cf-screen>
        <div
          style={{
            height: "100%",
            background: "#f0f2f7",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "20px 20px 8px",
              fontSize: "22px",
              fontWeight: "700",
              color: "#1a1a2e",
              flexShrink: "0",
            }}
          >
            {computed(() =>
              (tabContent[activeTab.get()] ?? tabContent.home).heading
            )}
          </div>

          {/* Scrollable card list */}
          <div
            style={{
              flex: "1",
              overflowY: "auto",
              padding: "0 16px 100px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              boxSizing: "border-box",
            }}
          >
            {computed(() =>
              (tabContent[activeTab.get()] ?? tabContent.home).items.map((
                item: { title: string; detail: string; meta: string },
              ) => (
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
                    {item.title}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      color: "#8e94a8",
                    }}
                  >
                    <span>{item.detail}</span>
                    <span>{item.meta}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Tab bar with action */}
          <cf-tab-bar $value={activeTab} variant="inset">
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
      </cf-screen>
    ),
  };
});
