/// <cts-enable />
/**
 * Occurrence Tracker Module - Track timestamped events
 *
 * A composable pattern for tracking when things happen (medication, baby feedings,
 * exercise, etc.). Shows last occurrence, stats, and expandable history.
 * Works standalone or embedded in Record containers.
 */
import {
  Cell,
  computed,
  type Default,
  handler,
  NAME,
  recipe,
  UI,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "occurrence-tracker",
  label: "Occurrence Tracker",
  icon: "\u{1F4CD}", // pushpin
  allowMultiple: true,
  schema: {
    label: { type: "string", description: "What is being tracked" },
    occurrences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "string", format: "date-time" },
          note: { type: "string" },
        },
      },
      description: "Timestamped occurrence events",
    },
  },
  fieldMapping: ["occurrences", "events", "logs", "tracking"],
};

// ===== Types =====
interface Occurrence {
  timestamp: string; // ISO 8601
  note: Default<string, "">;
}

export interface OccurrenceTrackerInput {
  label: Default<string, "">;
  occurrences: Cell<Default<Occurrence[], []>>;
}

// ===== Helper Functions =====

function formatRelativeTime(timestamp: string): string {
  if (!timestamp) return "";
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

function formatAbsoluteTime(timestamp: string): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatHistoryTime(timestamp: string): string {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  return (
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }) +
    ", " +
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
  );
}

function formatFrequency(avgMs: number | null): string {
  if (avgMs === null) return "Not enough data";
  const hours = avgMs / 3600000;
  if (hours >= 24) return `~${(hours / 24).toFixed(1)} days`;
  if (hours >= 1) return `~${hours.toFixed(1)} hours`;
  const minutes = hours * 60;
  if (minutes < 1) return "< 1 minute";
  return `~${Math.round(minutes)} minutes`;
}

function getSortedOccurrences(list: readonly Occurrence[]): Occurrence[] {
  return [...list].sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function calculateAverageFrequency(sorted: readonly Occurrence[]): number | null {
  if (sorted.length < 2) return null;

  let totalMs = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    totalMs +=
      new Date(sorted[i].timestamp).getTime() -
      new Date(sorted[i + 1].timestamp).getTime();
  }
  return totalMs / (sorted.length - 1);
}

// ===== Handlers =====

const recordNow = handler<unknown, { occurrences: Cell<Occurrence[]> }>(
  (_, { occurrences }) => {
    occurrences.push({
      timestamp: new Date().toISOString(),
      note: "",
    });
  },
);

const deleteOccurrence = handler<
  unknown,
  { occurrences: Cell<Occurrence[]>; timestamp: string }
>((_, { occurrences, timestamp }) => {
  const current = occurrences.get() || [];
  const index = current.findIndex((o) => o.timestamp === timestamp);
  if (index >= 0) {
    occurrences.set(current.toSpliced(index, 1));
  }
});

// ===== The Pattern =====
export const OccurrenceTrackerModule = recipe<
  OccurrenceTrackerInput,
  OccurrenceTrackerInput
>("OccurrenceTrackerModule", ({ label, occurrences }) => {
  // Local UI state: track whether history is expanded
  const historyOpen = Cell.of(false);

  // Computed: total count
  const totalCount = computed(() => (occurrences.get() || []).length);

  // Computed: most recent occurrence
  const lastOccurrence = computed(() => {
    const list = occurrences.get() || [];
    const sorted = getSortedOccurrences(list);
    return sorted.length > 0 ? sorted[0] : null;
  });

  // Computed: average frequency
  const averageFrequency = computed(() => {
    const list = occurrences.get() || [];
    const sorted = getSortedOccurrences(list);
    return calculateAverageFrequency(sorted);
  });

  // Computed: display name for NAME
  const displayName = computed(() => {
    const count = (occurrences.get() || []).length;
    const labelText = label || "Occurrences";
    return `${MODULE_METADATA.icon} ${labelText}: ${count}`;
  });

  return {
    [NAME]: displayName,
    [UI]: (
      <ct-vstack gap="3">
        {/* Label input */}
        <ct-input
          $value={label}
          placeholder="What are you tracking? (e.g., Headache, Coffee)"
          style={{
            fontWeight: "500",
          }}
        />

        {/* Big Record Button */}
        <ct-button
          variant="primary"
          onClick={recordNow({ occurrences })}
          style={{
            fontSize: "1.25rem",
            padding: "1rem",
            width: "100%",
          }}
        >
          Record Now
        </ct-button>

        {/* Last occurrence display */}
        {computed(() => {
          const list = occurrences.get() || [];
          const sorted = getSortedOccurrences(list);
          const last = sorted.length > 0 ? sorted[0] : null;
          if (!last) {
            return (
              <span
                style={{
                  textAlign: "center",
                  color: "var(--ct-color-gray-400)",
                  padding: "1rem 0",
                }}
              >
                No occurrences recorded yet
              </span>
            );
          }
          return (
            <ct-vstack
              gap="1"
              style={{
                textAlign: "center",
                padding: "0.5rem 0",
              }}
            >
              <span
                style={{
                  fontSize: "0.875rem",
                  color: "var(--ct-color-gray-500)",
                }}
              >
                Last recorded:
              </span>
              <span
                style={{
                  fontSize: "1.125rem",
                  fontWeight: "500",
                }}
              >
                {formatRelativeTime(last.timestamp)} ·{" "}
                {formatAbsoluteTime(last.timestamp)}
              </span>
              {/* Note for last occurrence */}
              <ct-input
                value={last.note || ""}
                placeholder="Add note..."
                style={{
                  fontSize: "0.875rem",
                  marginTop: "0.5rem",
                }}
                onct-input={(e: { detail?: { value?: string } }) => {
                  const newNote = e.detail?.value?.trim() || "";
                  const current = occurrences.get() || [];
                  const idx = current.findIndex(
                    (o) => o.timestamp === last.timestamp,
                  );
                  if (idx >= 0) {
                    const updated = [...current];
                    updated[idx] = { ...updated[idx], note: newNote };
                    occurrences.set(updated);
                  }
                }}
              />
            </ct-vstack>
          );
        })}

        {/* Stats Section */}
        <ct-hstack
          gap="4"
          style="justify-content: space-around; padding: 0.75rem; background: var(--ct-color-gray-50); border-radius: 8px;"
        >
          <ct-vstack
            gap="0"
            style="align-items: center;"
          >
            <span
              style={{
                fontSize: "1.5rem",
                fontWeight: "600",
              }}
            >
              {totalCount}
            </span>
            <span
              style={{
                fontSize: "0.75rem",
                color: "var(--ct-color-gray-500)",
              }}
            >
              Total
            </span>
          </ct-vstack>
          <ct-vstack
            gap="0"
            style="align-items: center;"
          >
            <span
              style={{
                fontSize: "1rem",
                fontWeight: "500",
              }}
            >
              {computed(() => {
                const list = occurrences.get() || [];
                const sorted = getSortedOccurrences(list);
                return formatFrequency(calculateAverageFrequency(sorted));
              })}
            </span>
            <span
              style={{
                fontSize: "0.75rem",
                color: "var(--ct-color-gray-500)",
              }}
            >
              Avg frequency
            </span>
          </ct-vstack>
        </ct-hstack>

        {/* Expandable History */}
        {computed(() => {
          const count = (occurrences.get() || []).length;
          if (count === 0) return null;
          return (
            <details
              open={historyOpen.get()}
              onClick={() => {
                // Toggle on next tick after native behavior
                setTimeout(() => {
                  historyOpen.set(!historyOpen.get());
                }, 0);
              }}
              style="margin-top: 0.5rem;"
            >
              <summary style="cursor: pointer; font-size: 0.875rem; color: var(--ct-color-gray-600); padding: 0.5rem 0;">
                History ({count})
              </summary>
              <ct-vstack gap="1" style="margin-top: 0.5rem; max-height: 400px; overflow-y: auto;">
                {getSortedOccurrences(occurrences.get() || []).map((occ: Occurrence) => (
                  <ct-hstack
                    gap="2"
                    style="padding: 0.5rem; background: var(--ct-color-gray-50); border-radius: 6px; align-items: center;"
                  >
                    <ct-vstack gap="0" style="flex: 1;">
                      <span style="font-size: 0.875rem;">
                        {formatRelativeTime(occ.timestamp)} ·{" "}
                        {formatHistoryTime(occ.timestamp)}
                      </span>
                      <ct-input
                        value={occ.note || ""}
                        placeholder="Add note..."
                        style="font-size: 0.75rem; margin-top: 0.25rem; flex: 1;"
                        onct-input={(e: { detail?: { value?: string } }) => {
                          const newNote = e.detail?.value?.trim() || "";
                          const current = occurrences.get() || [];
                          const idx = current.findIndex((o) => o.timestamp === occ.timestamp);
                          if (idx >= 0) {
                            const updated = [...current];
                            updated[idx] = { ...updated[idx], note: newNote };
                            occurrences.set(updated);
                          }
                        }}
                      />
                    </ct-vstack>
                    <ct-button
                      variant="ghost"
                      onClick={deleteOccurrence({ occurrences, timestamp: occ.timestamp })}
                      style="padding: 0.25rem 0.5rem; font-size: 1rem; color: var(--ct-color-gray-400); min-width: auto;"
                      title="Delete"
                    >
                      ×
                    </ct-button>
                  </ct-hstack>
                ))}
              </ct-vstack>
            </details>
          );
        })}
      </ct-vstack>
    ),
    label,
    occurrences,
  };
});

export default OccurrenceTrackerModule;
