/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type ChannelId = "email" | "sms" | "push" | "digest";

type Frequency = "immediate" | "hourly" | "daily" | "weekly";

interface ChannelPreference {
  channel: ChannelId;
  enabled: boolean;
  frequency: Frequency;
}

type ChannelPreferenceInput = Partial<ChannelPreference> & {
  channel?: string;
  frequency?: string;
};

const channelOrder: readonly ChannelId[] = [
  "email",
  "sms",
  "push",
  "digest",
];

const channelLabels: Record<ChannelId, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
  digest: "Digest",
};

const frequencyDetails: Record<Frequency, { label: string; window: string }> = {
  immediate: {
    label: "Immediate alerts",
    window: "sent instantly",
  },
  hourly: {
    label: "Hourly updates",
    window: "top of every hour",
  },
  daily: {
    label: "Daily summary",
    window: "08:00 local time",
  },
  weekly: {
    label: "Weekly digest",
    window: "Mondays 09:00",
  },
};

const defaultPreferences: ChannelPreference[] = [
  { channel: "email", enabled: true, frequency: "daily" },
  { channel: "sms", enabled: false, frequency: "weekly" },
  { channel: "push", enabled: true, frequency: "immediate" },
  { channel: "digest", enabled: true, frequency: "daily" },
];

interface NotificationPreferenceArgs {
  channels: Default<ChannelPreferenceInput[], typeof defaultPreferences>;
}

interface ConfigureChannelEvent {
  channel?: string;
  enabled?: boolean;
  frequency?: string;
}

const resolveChannelId = (value: unknown): ChannelId | null => {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return channelOrder.find((channel) => channel === lower) ?? null;
};

const sanitizeFrequency = (
  value: unknown,
  fallback: Frequency,
): Frequency => {
  if (typeof value !== "string") return fallback;
  const lower = value.toLowerCase() as Frequency;
  return lower in frequencyDetails ? lower : fallback;
};

const sanitizePreferenceList = (
  value: readonly ChannelPreferenceInput[] | undefined,
): ChannelPreference[] => {
  const base = new Map<ChannelId, ChannelPreference>();
  for (const entry of defaultPreferences) {
    base.set(entry.channel, { ...entry });
  }

  if (Array.isArray(value)) {
    for (const candidate of value) {
      const channel = resolveChannelId(candidate?.channel);
      if (!channel) continue;
      const previous = base.get(channel) ?? {
        channel,
        enabled: true,
        frequency: "daily" as Frequency,
      };
      const enabled = typeof candidate?.enabled === "boolean"
        ? candidate.enabled
        : previous.enabled;
      const frequency = sanitizeFrequency(
        candidate?.frequency,
        previous.frequency,
      );
      base.set(channel, { channel, enabled, frequency });
    }
  }

  return channelOrder.map((channel) => {
    const preference = base.get(channel);
    return preference ? { ...preference } : {
      channel,
      enabled: false,
      frequency: "daily",
    };
  });
};

const buildScheduleMap = (
  entries: readonly ChannelPreference[],
): Record<ChannelId, string> => {
  const result = {} as Record<ChannelId, string>;
  for (const preference of entries) {
    if (!preference.enabled) {
      result[preference.channel] = "paused";
      continue;
    }
    const detail = frequencyDetails[preference.frequency];
    result[preference.channel] = `${detail.label} (${detail.window})`;
  }
  return result;
};

const formatActiveSummary = (
  entries: readonly ChannelPreference[],
): string => {
  const active = entries.filter((entry) => entry.enabled);
  if (active.length === 0) return "No active channels";
  const pieces = active.map((entry) => {
    const label = channelLabels[entry.channel];
    const detail = frequencyDetails[entry.frequency];
    return `${label} ${detail.label.toLowerCase()}`;
  });
  const noun = active.length === 1 ? "channel" : "channels";
  return `${active.length} active ${noun}: ${pieces.join(", ")}`;
};

const configureChannel = handler(
  (
    event: ConfigureChannelEvent | undefined,
    context: {
      channels: Cell<ChannelPreferenceInput[]>;
      lastChange: Cell<string>;
      history: Cell<string[]>;
      sequence: Cell<number>;
    },
  ) => {
    const channel = resolveChannelId(event?.channel);
    if (!channel) return;

    const current = sanitizePreferenceList(context.channels.get());
    const existing = current.find((entry) => entry.channel === channel);
    if (!existing) return;

    const enabled = typeof event?.enabled === "boolean"
      ? event.enabled
      : existing.enabled;
    const frequency = sanitizeFrequency(event?.frequency, existing.frequency);

    const updated = current.map((entry) =>
      entry.channel === channel ? { channel, enabled, frequency } : entry
    );
    context.channels.set(updated);

    const detail = frequencyDetails[frequency];
    const summary = enabled
      ? `${channelLabels[channel]} ${detail.label} (${detail.window})`
      : `${channelLabels[channel]} paused`;
    context.lastChange.set(summary);

    const previous = context.history.get() ?? [];
    const appended = [...previous, summary];
    const trimmed = appended.length > 5 ? appended.slice(-5) : appended;
    context.history.set(trimmed);

    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

export const notificationPreferencesUx = recipe<NotificationPreferenceArgs>(
  "Notification Preferences",
  ({ channels }) => {
    const lastChange = cell("Preferences loaded");
    const history = cell<string[]>(["Preferences loaded"]);
    const sequence = cell(0);

    const channelList = lift(sanitizePreferenceList)(channels);
    const scheduleMap = lift(buildScheduleMap)(channelList);

    const summaryBase = lift(formatActiveSummary)(channelList);
    const scheduleSummary = str`Notification schedules — ${summaryBase}`;

    const activeCount = lift((entries: readonly ChannelPreference[]) =>
      entries.filter((entry) => entry.enabled).length
    )(channelList);

    const configure = configureChannel({
      channels,
      lastChange,
      history,
      sequence,
    });

    const channelField = cell<string>("");
    const frequencyField = cell<string>("");

    const toggleChannel = handler<
      unknown,
      {
        channelField: Cell<string>;
        channels: Cell<ChannelPreferenceInput[]>;
        lastChange: Cell<string>;
        history: Cell<string[]>;
        sequence: Cell<number>;
      }
    >((_event, context) => {
      const channelInput = context.channelField.get();
      if (typeof channelInput !== "string" || channelInput.trim() === "") {
        return;
      }
      const channel = resolveChannelId(channelInput.trim());
      if (!channel) return;

      const current = sanitizePreferenceList(context.channels.get());
      const existing = current.find((entry) => entry.channel === channel);
      if (!existing) return;

      const enabled = !existing.enabled;
      const frequency = existing.frequency;

      const updated = current.map((entry) =>
        entry.channel === channel ? { channel, enabled, frequency } : entry
      );
      context.channels.set(updated);

      const detail = frequencyDetails[frequency];
      const summary = enabled
        ? `${channelLabels[channel]} ${detail.label} (${detail.window})`
        : `${channelLabels[channel]} paused`;
      context.lastChange.set(summary);

      const previous = context.history.get() ?? [];
      const appended = [...previous, summary];
      const trimmed = appended.length > 5 ? appended.slice(-5) : appended;
      context.history.set(trimmed);

      const seq = (context.sequence.get() ?? 0) + 1;
      context.sequence.set(seq);

      context.channelField.set("");
    });

    const updateFrequency = handler<
      unknown,
      {
        channelField: Cell<string>;
        frequencyField: Cell<string>;
        channels: Cell<ChannelPreferenceInput[]>;
        lastChange: Cell<string>;
        history: Cell<string[]>;
        sequence: Cell<number>;
      }
    >((_event, context) => {
      const channelInput = context.channelField.get();
      const frequencyInput = context.frequencyField.get();

      if (
        typeof channelInput !== "string" || channelInput.trim() === "" ||
        typeof frequencyInput !== "string" || frequencyInput.trim() === ""
      ) {
        return;
      }

      const channel = resolveChannelId(channelInput.trim());
      if (!channel) return;

      const current = sanitizePreferenceList(context.channels.get());
      const existing = current.find((entry) => entry.channel === channel);
      if (!existing) return;

      const frequency = sanitizeFrequency(
        frequencyInput.trim(),
        existing.frequency,
      );
      const enabled = existing.enabled;

      const updated = current.map((entry) =>
        entry.channel === channel ? { channel, enabled, frequency } : entry
      );
      context.channels.set(updated);

      const detail = frequencyDetails[frequency];
      const summary = enabled
        ? `${channelLabels[channel]} ${detail.label} (${detail.window})`
        : `${channelLabels[channel]} paused`;
      context.lastChange.set(summary);

      const previous = context.history.get() ?? [];
      const appended = [...previous, summary];
      const trimmed = appended.length > 5 ? appended.slice(-5) : appended;
      context.history.set(trimmed);

      const seq = (context.sequence.get() ?? 0) + 1;
      context.sequence.set(seq);

      context.channelField.set("");
      context.frequencyField.set("");
    });

    const name = str`Notification Settings`;

    const channelCards = lift((entries: readonly ChannelPreference[]) => {
      const cards = [];
      for (const pref of entries) {
        const label = channelLabels[pref.channel];
        const detail = frequencyDetails[pref.frequency];

        const statusColor = pref.enabled ? "#10b981" : "#6b7280";
        const bgColor = pref.enabled ? "#ecfdf5" : "#f3f4f6";
        const borderColor = pref.enabled ? "#10b981" : "#d1d5db";

        const statusDot = h(
          "span",
          {
            style: "display: inline-block; width: 8px; height: 8px; " +
              "border-radius: 50%; margin-right: 8px; background: " +
              statusColor + ";",
          },
        );

        const statusText = h(
          "span",
          {
            style: "font-weight: 600; color: " + statusColor + ";",
          },
          pref.enabled ? "Active" : "Paused",
        );

        const header = h(
          "div",
          {
            style: "display: flex; align-items: center; margin-bottom: 8px;",
          },
          statusDot,
          statusText,
        );

        const channelTitle = h(
          "h3",
          {
            style: "margin: 0 0 4px 0; font-size: 1.25rem; font-weight: 700; " +
              "color: #1f2937;",
          },
          label,
        );

        const frequencyLabel = h(
          "div",
          {
            style: "font-size: 0.875rem; color: #4b5563; margin-bottom: 4px;",
          },
          detail.label,
        );

        const windowLabel = h(
          "div",
          {
            style: "font-size: 0.75rem; color: #6b7280;",
          },
          detail.window,
        );

        const card = h(
          "div",
          {
            style: "background: " + bgColor + "; border: 2px solid " +
              borderColor + "; border-radius: 8px; padding: 16px; " +
              "transition: all 0.2s;",
          },
          header,
          channelTitle,
          frequencyLabel,
          windowLabel,
        );

        cards.push(card);
      }

      return h(
        "div",
        {
          style: "display: grid; grid-template-columns: repeat(auto-fill, " +
            "minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px;",
        },
        ...cards,
      );
    })(channelList);

    const historySection = lift((hist: string[]) => {
      if (!Array.isArray(hist) || hist.length === 0) {
        return h(
          "div",
          { style: "color: #6b7280; font-style: italic;" },
          "No activity yet",
        );
      }

      const reversed = hist.slice().reverse();
      const items = [];

      for (let i = 0; i < Math.min(reversed.length, 5); i++) {
        const entry = reversed[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#f9fafb";

        const item = h(
          "div",
          {
            style: "padding: 8px 12px; background: " + bgColor +
              "; border-left: 3px solid #6366f1; font-size: 0.875rem; " +
              "color: #374151;",
          },
          entry,
        );
        items.push(item);
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column;" },
        ...items,
      );
    })(history);

    const ui = (
      <div
        style={{
          maxWidth: "900px",
          margin: "0 auto",
          padding: "24px",
          fontFamily: "system-ui, sans-serif",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "12px",
            padding: "32px",
            boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
          }}
        >
          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "2rem",
              fontWeight: "800",
              color: "#1f2937",
            }}
          >
            Notification Settings
          </h1>

          <div
            style={{
              fontSize: "1rem",
              color: "#6b7280",
              marginBottom: "24px",
              paddingBottom: "16px",
              borderBottom: "2px solid #e5e7eb",
            }}
          >
            {scheduleSummary}
          </div>

          {channelCards}

          <div
            style={{
              marginTop: "32px",
              padding: "20px",
              background: "#f9fafb",
              borderRadius: "8px",
              border: "1px solid #e5e7eb",
            }}
          >
            <h2
              style={{
                margin: "0 0 16px 0",
                fontSize: "1.125rem",
                fontWeight: "700",
                color: "#374151",
              }}
            >
              Configure Channels
            </h2>

            <div style={{ marginBottom: "16px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "600",
                  color: "#4b5563",
                  marginBottom: "6px",
                }}
              >
                Channel (email, sms, push, digest):
              </label>
              <ct-input
                $value={channelField}
                placeholder="e.g., email"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                  fontSize: "0.875rem",
                }}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
                marginBottom: "16px",
              }}
            >
              <ct-button
                onClick={toggleChannel({
                  channelField,
                  channels,
                  lastChange,
                  history,
                  sequence,
                })}
                style={{
                  padding: "10px 16px",
                  background: "#6366f1",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Toggle On/Off
              </ct-button>
            </div>

            <div style={{ marginBottom: "16px", marginTop: "24px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "600",
                  color: "#4b5563",
                  marginBottom: "6px",
                }}
              >
                Frequency (immediate, hourly, daily, weekly):
              </label>
              <ct-input
                $value={frequencyField}
                placeholder="e.g., daily"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                  fontSize: "0.875rem",
                }}
              />
            </div>

            <ct-button
              onClick={updateFrequency({
                channelField,
                frequencyField,
                channels,
                lastChange,
                history,
                sequence,
              })}
              style={{
                padding: "10px 16px",
                background: "#10b981",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontWeight: "600",
                cursor: "pointer",
                width: "100%",
              }}
            >
              Update Frequency
            </ct-button>
          </div>

          <div style={{ marginTop: "24px" }}>
            <h2
              style={{
                margin: "0 0 12px 0",
                fontSize: "1.125rem",
                fontWeight: "700",
                color: "#374151",
              }}
            >
              Recent Activity
            </h2>
            {historySection}
          </div>
        </div>
      </div>
    );

    return {
      channels,
      channelList,
      scheduleMap,
      scheduleSummary,
      activeCount,
      lastChange,
      history,
      configureChannel: configure,
      [NAME]: name,
      [UI]: ui,
    };
  },
);
