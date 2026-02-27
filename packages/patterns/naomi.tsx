/// <cts-enable />
import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

type AppStatus =
  | "not-started"
  | "in-progress"
  | "submitted"
  | "accepted"
  | "waitlisted"
  | "deferred"
  | "rejected";

interface CollegeApp {
  school: string;
  status: AppStatus;
}

interface NaomiInput {
  apps: Writable<Default<CollegeApp[], []>>;
  notes: Writable<Default<string, "">>;
}

interface NaomiOutput {
  [NAME]: string;
  [UI]: VNode;
  apps: CollegeApp[];
  notes: string;
}

// ===== Constants =====

const font =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif";

const SCHOOLS = [
  "Northwestern",
  "UChicago",
  "Brown",
  "Georgetown",
  "Columbia",
  "NYU",
  "UCLA",
  "UC Berkeley",
];

const STATUSES: AppStatus[] = [
  "not-started",
  "in-progress",
  "submitted",
  "accepted",
  "waitlisted",
  "deferred",
  "rejected",
];

const STATUS_LABELS: Record<AppStatus, string> = {
  "not-started": "Not Started",
  "in-progress": "In Progress",
  submitted: "Submitted",
  accepted: "Accepted ✓",
  waitlisted: "Waitlisted",
  deferred: "Deferred",
  rejected: "Rejected",
};

const STATUS_STYLE: Record<AppStatus, { color: string; bg: string }> = {
  "not-started": { color: "#aeaeb2", bg: "rgba(174,174,178,0.15)" },
  "in-progress": { color: "#ff9500", bg: "rgba(255,149,0,0.12)" },
  submitted: { color: "#007aff", bg: "rgba(0,122,255,0.12)" },
  accepted: { color: "#34c759", bg: "rgba(52,199,89,0.14)" },
  waitlisted: { color: "#5856d6", bg: "rgba(88,86,214,0.12)" },
  deferred: { color: "#ff6b35", bg: "rgba(255,107,53,0.12)" },
  rejected: { color: "#ff3b30", bg: "rgba(255,59,48,0.10)" },
};

const DEFAULT_APPS: CollegeApp[] = SCHOOLS.map((school) => ({
  school,
  status: "not-started" as AppStatus,
}));

// ===== Pattern =====

const NaomiPattern = pattern<NaomiInput, NaomiOutput>(({ apps, notes }) => {
  // One cycle-status action per school (fixed list, safe to pre-create).
  // On first interaction, seeds the persisted apps cell with defaults.
  const cycleActions = SCHOOLS.map((_, i) =>
    action(() => {
      const stored = apps.get();
      const current = stored.length > 0 ? stored : DEFAULT_APPS;
      const item = current[i];
      if (!item) return;
      const nextIdx = (STATUSES.indexOf(item.status) + 1) % STATUSES.length;
      const updated = [...current];
      updated[i] = { ...item, status: STATUSES[nextIdx] };
      apps.set(updated);
    }),
  );

  return {
    [NAME]: "Naomi",
    apps,
    notes,
    [UI]: computed(() => {
      const stored = apps.get();
      // Show seeded defaults on first load (before any click)
      const appList = stored.length > 0 ? stored : DEFAULT_APPS;

      const accepted = appList.filter((a) => a.status === "accepted").length;
      const submitted = appList.filter((a) => a.status === "submitted").length;
      const inProgress = appList.filter(
        (a) => a.status === "in-progress",
      ).length;
      const waitlisted = appList.filter(
        (a) => a.status === "waitlisted",
      ).length;
      const deferred = appList.filter((a) => a.status === "deferred").length;
      const anyStats =
        accepted + submitted + inProgress + waitlisted + deferred > 0;

      return (
        <div
          style={{
            fontFamily: font,
            maxWidth: "480px",
            margin: "0 auto",
            padding: "28px 18px 40px",
            background: "#ffffff",
            minHeight: "100vh",
          }}
        >
          {/* Header */}
          <div style={{ marginBottom: "6px" }}>
            <div
              style={{
                fontSize: "30px",
                fontWeight: "700",
                color: "#1d1d1f",
                letterSpacing: "-0.5px",
              }}
            >
              Naomi
            </div>
            <div
              style={{
                fontSize: "13px",
                color: "#86868b",
                marginTop: "3px",
              }}
            >
              Born Dec 4, 2008 · Class of 2026
            </div>
          </div>

          {/* Divider */}
          <div
            style={{
              height: "0.5px",
              background: "rgba(60,60,67,0.15)",
              margin: "16px 0",
            }}
          />

          {/* Stats row */}
          {anyStats ? (
            <div
              style={{
                display: "flex",
                gap: "8px",
                flexWrap: "wrap" as const,
                marginBottom: "20px",
              }}
            >
              {accepted > 0 ? (
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: "600",
                    color: "#34c759",
                    padding: "4px 11px",
                    borderRadius: "100px",
                    background: "rgba(52,199,89,0.12)",
                  }}
                >
                  {accepted} Accepted
                </div>
              ) : null}
              {submitted > 0 ? (
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: "600",
                    color: "#007aff",
                    padding: "4px 11px",
                    borderRadius: "100px",
                    background: "rgba(0,122,255,0.10)",
                  }}
                >
                  {submitted} Submitted
                </div>
              ) : null}
              {waitlisted > 0 ? (
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: "600",
                    color: "#5856d6",
                    padding: "4px 11px",
                    borderRadius: "100px",
                    background: "rgba(88,86,214,0.10)",
                  }}
                >
                  {waitlisted} Waitlisted
                </div>
              ) : null}
              {deferred > 0 ? (
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: "600",
                    color: "#ff6b35",
                    padding: "4px 11px",
                    borderRadius: "100px",
                    background: "rgba(255,107,53,0.10)",
                  }}
                >
                  {deferred} Deferred
                </div>
              ) : null}
              {inProgress > 0 ? (
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: "600",
                    color: "#ff9500",
                    padding: "4px 11px",
                    borderRadius: "100px",
                    background: "rgba(255,149,0,0.10)",
                  }}
                >
                  {inProgress} In Progress
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Section label */}
          <div
            style={{
              fontSize: "11px",
              fontWeight: "600",
              color: "#86868b",
              textTransform: "uppercase" as const,
              letterSpacing: "0.6px",
              marginBottom: "8px",
            }}
          >
            College Applications · tap status to update
          </div>

          {/* College list */}
          <div
            style={{
              borderRadius: "12px",
              overflow: "hidden" as const,
              border: "0.5px solid rgba(60,60,67,0.18)",
              marginBottom: "28px",
            }}
          >
            {appList.map((app: CollegeApp, i: number) => {
              const st =
                STATUS_STYLE[app.status] || STATUS_STYLE["not-started"];
              const isLast = i === appList.length - 1;
              return (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "13px 14px",
                    background: "#ffffff",
                    borderBottom: isLast
                      ? "none"
                      : "0.5px solid rgba(60,60,67,0.12)",
                  }}
                >
                  <div
                    style={{
                      flex: "1",
                      fontSize: "15px",
                      fontWeight: "500",
                      color: "#1d1d1f",
                    }}
                  >
                    {app.school}
                  </div>
                  <div
                    onClick={cycleActions[i]}
                    style={{
                      fontSize: "11px",
                      fontWeight: "600",
                      color: st.color,
                      padding: "5px 11px",
                      borderRadius: "100px",
                      background: st.bg,
                      cursor: "pointer",
                      userSelect: "none" as const,
                      flexShrink: "0",
                    }}
                  >
                    {STATUS_LABELS[app.status]}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Notes */}
          <div
            style={{
              fontSize: "11px",
              fontWeight: "600",
              color: "#86868b",
              textTransform: "uppercase" as const,
              letterSpacing: "0.6px",
              marginBottom: "8px",
            }}
          >
            Notes
          </div>
          <ct-textarea
            $value={notes}
            placeholder="Notes, conversations, deadlines, financial aid thoughts..."
            rows={6}
            style="width: 100%; border-radius: 10px; font-size: 14px; line-height: 1.5;"
          />

          {/* Footer */}
          <div
            style={{
              marginTop: "28px",
              fontSize: "11px",
              color: "#c7c7cc",
              textAlign: "center" as const,
            }}
          >
            529 · College Process · Health · Driver's License
          </div>
        </div>
      );
    }),
  };
});

export default NaomiPattern;
