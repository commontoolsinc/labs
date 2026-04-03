/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface VignetteFitnessStoryInput {}
interface VignetteFitnessStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const phoneFrame = {
  width: "375px",
  height: "720px",
  borderRadius: "40px",
  overflow: "hidden",
  boxShadow:
    "0 25px 60px rgba(0,0,0,0.3), 0 0 0 2px rgba(255,255,255,0.1), inset 0 0 0 1px rgba(255,255,255,0.05)",
  flexShrink: "0",
  position: "relative" as const,
};

const phoneScreen = {
  width: "100%",
  height: "100%",
  overflow: "auto",
  position: "relative" as const,
};

export default pattern<VignetteFitnessStoryInput, VignetteFitnessStoryOutput>(
  () => {
    const fitnessTheme = {
      fontFamily: "'Courier New', 'Courier', monospace",
      borderRadius: "0px",
      density: "compact" as const,
      colorScheme: "dark" as const,
      colors: {
        primary: "#00ff41",
        primaryForeground: "#000000",
        secondary: "#333333",
        secondaryForeground: "#00ff41",
        background: "#0a0a0a",
        surface: "#141414",
        surfaceHover: "#1a1a1a",
        text: "#e0e0e0",
        textMuted: "#666666",
        border: "#222222",
        borderMuted: "#1a1a1a",
        accent: "#ff003c",
        accentForeground: "#ffffff",
        success: "#00ff41",
        successForeground: "#000000",
        error: "#ff003c",
        errorForeground: "#ffffff",
        warning: "#ffaa00",
        warningForeground: "#000000",
      },
    };

    return {
      [NAME]: "Vignette: Fitness Tracker",
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
            <ct-theme theme={fitnessTheme}>
              <div
                style={{
                  ...phoneScreen,
                  background: "#0a0a0a",
                  fontFamily: "'Courier New', monospace",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* Status bar */}
                <div
                  style={{
                    padding: "16px 24px 8px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    color: "#666",
                    fontSize: "10px",
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                  }}
                >
                  <span>09:41</span>
                  <span style={{ color: "#00ff41" }}>● ACTIVE</span>
                </div>

                {/* Header */}
                <div style={{ padding: "8px 24px 16px" }}>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#888",
                      letterSpacing: "0.3em",
                      textTransform: "uppercase",
                      marginBottom: "4px",
                    }}
                  >
                    DAILY_LOG
                  </div>
                  <div
                    style={{
                      fontSize: "42px",
                      fontWeight: "900",
                      color: "#00ff41",
                      lineHeight: "1",
                      fontFamily: "'Courier New', monospace",
                    }}
                  >
                    8,247
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#888",
                      letterSpacing: "0.2em",
                      marginTop: "4px",
                    }}
                  >
                    STEPS // 67% OF TARGET
                  </div>
                </div>

                <ct-separator />

                {/* Stats grid */}
                <div style={{ padding: "16px 24px" }}>
                  <ct-grid columns="2" gap="2">
                    <ct-card>
                      <div style={{ padding: "4px 0" }}>
                        <div
                          style={{
                            fontSize: "9px",
                            color: "#888",
                            letterSpacing: "0.2em",
                            marginBottom: "8px",
                          }}
                        >
                          KCAL_BURN
                        </div>
                        <div
                          style={{
                            fontSize: "28px",
                            fontWeight: "900",
                            color: "#ff003c",
                            lineHeight: "1",
                          }}
                        >
                          412
                        </div>
                        <ct-progress value={68} style={{ marginTop: "8px" }} />
                      </div>
                    </ct-card>
                    <ct-card>
                      <div style={{ padding: "4px 0" }}>
                        <div
                          style={{
                            fontSize: "9px",
                            color: "#888",
                            letterSpacing: "0.2em",
                            marginBottom: "8px",
                          }}
                        >
                          HEART_BPM
                        </div>
                        <div
                          style={{
                            fontSize: "28px",
                            fontWeight: "900",
                            color: "#e0e0e0",
                            lineHeight: "1",
                          }}
                        >
                          72
                        </div>
                        <div
                          style={{
                            fontSize: "9px",
                            color: "#00ff41",
                            marginTop: "8px",
                          }}
                        >
                          ▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂
                        </div>
                      </div>
                    </ct-card>
                    <ct-card>
                      <div style={{ padding: "4px 0" }}>
                        <div
                          style={{
                            fontSize: "9px",
                            color: "#888",
                            letterSpacing: "0.2em",
                            marginBottom: "8px",
                          }}
                        >
                          DISTANCE
                        </div>
                        <div
                          style={{
                            fontSize: "28px",
                            fontWeight: "900",
                            color: "#e0e0e0",
                            lineHeight: "1",
                          }}
                        >
                          5.3
                        </div>
                        <div style={{ fontSize: "9px", color: "#888" }}>KM</div>
                      </div>
                    </ct-card>
                    <ct-card>
                      <div style={{ padding: "4px 0" }}>
                        <div
                          style={{
                            fontSize: "9px",
                            color: "#888",
                            letterSpacing: "0.2em",
                            marginBottom: "8px",
                          }}
                        >
                          ACTIVE_MIN
                        </div>
                        <div
                          style={{
                            fontSize: "28px",
                            fontWeight: "900",
                            color: "#ffaa00",
                            lineHeight: "1",
                          }}
                        >
                          47
                        </div>
                        <ct-progress value={78} style={{ marginTop: "8px" }} />
                      </div>
                    </ct-card>
                  </ct-grid>
                </div>

                {/* Activity list */}
                <div style={{ padding: "0 24px", flex: "1" }}>
                  <div
                    style={{
                      fontSize: "9px",
                      color: "#888",
                      letterSpacing: "0.3em",
                      marginBottom: "12px",
                    }}
                  >
                    RECENT_ACTIVITY
                  </div>

                  <ct-vstack gap="1">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 0",
                        borderBottom: "1px solid #333",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            color: "#e0e0e0",
                            fontSize: "12px",
                            fontWeight: "700",
                          }}
                        >
                          MORNING RUN
                        </div>
                        <div style={{ color: "#888", fontSize: "10px" }}>
                          07:15
                        </div>
                      </div>
                      <ct-badge variant="outline">3.2 KM</ct-badge>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 0",
                        borderBottom: "1px solid #333",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            color: "#e0e0e0",
                            fontSize: "12px",
                            fontWeight: "700",
                          }}
                        >
                          STRENGTH
                        </div>
                        <div style={{ color: "#888", fontSize: "10px" }}>
                          08:30
                        </div>
                      </div>
                      <ct-badge variant="outline">45 MIN</ct-badge>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 0",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            color: "#e0e0e0",
                            fontSize: "12px",
                            fontWeight: "700",
                          }}
                        >
                          WALK
                        </div>
                        <div style={{ color: "#888", fontSize: "10px" }}>
                          12:00
                        </div>
                      </div>
                      <ct-badge variant="outline">2.1 KM</ct-badge>
                    </div>
                  </ct-vstack>
                </div>

                {/* Bottom action */}
                <div style={{ padding: "16px 24px 32px" }}>
                  <ct-button
                    variant="default"
                    style={{ width: "100%", fontWeight: "900" }}
                  >
                    + START_SESSION
                  </ct-button>
                </div>
              </div>
            </ct-theme>
          </div>
        </div>
      ),
      controls: (
        <div
          style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}
        >
          Brutalist fitness tracker vignette. Dark theme, monospace Courier
          typography, zero border-radius, neon green primary with red accents.
          Demonstrates ct-theme, ct-card, ct-grid, ct-progress, ct-badge,
          ct-vstack, ct-separator, ct-button.
        </div>
      ),
    };
  },
);
