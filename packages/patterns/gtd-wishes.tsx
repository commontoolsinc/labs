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

interface Directive {
  id: string;
  target: string;
  text: string;
  createdAt: string;
  status: string;
  response: string;
  assignedTo: string;
  noteUrl: string;
}

interface UserAction {
  type: string;
  target?: string;
  text?: string;
  ts: string;
}

interface WishesInput {
  directives: Writable<Default<Directive[], []>>;
}

interface WishesOutput {
  [NAME]: string;
  [UI]: VNode;
  userActions: UserAction[];
}

// ===== Apple-style Design Tokens =====

const font =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif";

const color = {
  label: "#1d1d1f",
  secondaryLabel: "#86868b",
  tertiaryLabel: "#aeaeb2",
  separator: "rgba(60, 60, 67, 0.12)",
  fillPrimary: "rgba(120, 120, 128, 0.08)",
  background: "#ffffff",
  secondaryBg: "#f5f5f7",
  blue: "#007aff",
  green: "#34c759",
  orange: "#ff9500",
  indigo: "#5856d6",
};

// ===== Pattern =====

const GTDWishes = pattern<WishesInput, WishesOutput>(({ directives }) => {
  const commandDraft = Writable.of<string>("");
  const userActions = Writable.of<UserAction[]>([]);

  const sendCommand = action(() => {
    const text = commandDraft.get().trim();
    if (!text) return;
    const now = new Date().toISOString();
    userActions.set([
      ...userActions.get(),
      { type: "directive", target: "system", text: "Command: " + text, ts: now },
    ]);
    commandDraft.set("");
  });

  return {
    [NAME]: "GTD Wishes",
    userActions,
    [UI]: computed(() => {
      const dirs: Directive[] = [...(directives.get() || [])].filter(
        (d: Directive) => d && d.id,
      );
      const pending = dirs.filter((d: Directive) => d.status === "pending");

      return (
        <div
          style={{
            fontFamily: font,
            maxWidth: "600px",
            margin: "0 auto",
            padding: "20px 16px",
            background: color.background,
            minHeight: "100vh",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "20px",
            }}
          >
            <div
              style={{
                fontSize: "28px",
                fontWeight: "700",
                color: color.label,
                letterSpacing: "-0.5px",
              }}
            >
              GTD Wishes
            </div>
            {pending.length > 0 ? (
              <div
                style={{
                  fontSize: "13px",
                  fontWeight: "600",
                  color: color.orange,
                  padding: "4px 12px",
                  borderRadius: "100px",
                  background: "rgba(255, 149, 0, 0.12)",
                }}
              >
                {pending.length} pending
              </div>
            ) : null}
          </div>

          {/* Command Input */}
          <div
            style={{
              background: color.secondaryBg,
              borderRadius: "12px",
              padding: "12px",
              marginBottom: "24px",
            }}
          >
            <ct-textarea
              $value={commandDraft}
              placeholder="Type a command..."
              rows={2}
              style={{
                width: "100%",
                borderRadius: "10px",
                fontSize: "14px",
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: "8px",
              }}
            >
              <div
                onClick={sendCommand}
                style={{
                  padding: "8px 16px",
                  borderRadius: "100px",
                  fontSize: "13px",
                  fontWeight: "600",
                  background: color.indigo,
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Send
              </div>
            </div>
          </div>

          {/* Directive Feed */}
          <div
            style={{
              fontSize: "11px",
              fontWeight: "600",
              color: color.secondaryLabel,
              textTransform: "uppercase" as const,
              letterSpacing: "0.5px",
              marginBottom: "8px",
            }}
          >
            Directives ({dirs.length})
          </div>

          {dirs.length === 0 ? (
            <div
              style={{
                fontSize: "14px",
                color: color.tertiaryLabel,
                padding: "24px 0",
                textAlign: "center" as const,
              }}
            >
              No directives yet
            </div>
          ) : null}

          {dirs.map((d: Directive) => {
            const statusColor =
              d.status === "pending"
                ? color.orange
                : d.status === "assigned"
                  ? color.blue
                  : color.green;
            const statusBg =
              d.status === "pending"
                ? "rgba(255, 149, 0, 0.12)"
                : d.status === "assigned"
                  ? "rgba(0, 122, 255, 0.12)"
                  : "rgba(52, 199, 89, 0.12)";

            return (
              <div
                style={{
                  padding: "10px 0",
                  borderBottom: "0.5px solid " + color.separator,
                }}
              >
                {/* Top row: ID, text, status, agent */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: "600",
                      color: color.tertiaryLabel,
                      minWidth: "42px",
                      flexShrink: "0",
                    }}
                  >
                    {d.id}
                  </span>
                  <span
                    style={{
                      fontSize: "13px",
                      color: color.label,
                      flex: "1",
                      overflow: "hidden" as const,
                      textOverflow: "ellipsis" as const,
                      whiteSpace: "nowrap" as const,
                    }}
                  >
                    {d.text}
                  </span>
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: "600",
                      color: statusColor,
                      padding: "2px 8px",
                      borderRadius: "100px",
                      background: statusBg,
                      flexShrink: "0",
                    }}
                  >
                    {d.status}
                  </span>
                  {d.assignedTo ? (
                    <span
                      style={{
                        fontSize: "10px",
                        color: color.secondaryLabel,
                        padding: "1px 6px",
                        borderRadius: "100px",
                        background: color.fillPrimary,
                        flexShrink: "0",
                      }}
                    >
                      {d.assignedTo}
                    </span>
                  ) : null}
                  {d.noteUrl ? (
                    <a
                      href={d.noteUrl}
                      target="_blank"
                      style={{
                        textDecoration: "none",
                        fontSize: "16px",
                        flexShrink: "0",
                        cursor: "pointer",
                      }}
                    >
                      {"📎"}
                    </a>
                  ) : null}
                </div>

                {/* Response (for done directives) */}
                {d.response ? (
                  <div
                    style={{
                      fontSize: "12px",
                      color: color.secondaryLabel,
                      marginTop: "4px",
                      marginLeft: "50px",
                      lineHeight: "1.4",
                    }}
                  >
                    {d.response}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      );
    }),
  };
});

export default GTDWishes;
