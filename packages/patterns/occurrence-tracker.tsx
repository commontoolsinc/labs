/// <cts-enable />
/**
 * Occurrence Tracker Module - Track timestamped events
 *
 * A composable pattern for tracking when things happen (medication, baby feedings,
 * exercise, etc.). Shows last occurrence, stats, and expandable history.
 * Works standalone or embedded in Record containers.
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  lift,
  NAME,
  recipe,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "occurrence-tracker",
  label: "Occurrence Tracker",
  icon: "📍", // pushpin
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
  occurrences: Writable<Default<Occurrence[], []>>;
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
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function calculateAverageFrequency(
  sorted: readonly Occurrence[],
): number | null {
  if (sorted.length < 2) return null;

  let totalMs = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    totalMs += new Date(sorted[i].timestamp).getTime() -
      new Date(sorted[i + 1].timestamp).getTime();
  }
  return totalMs / (sorted.length - 1);
}

// Lifted helper for frequency display
const formatFrequencyFromList = lift((list: Occurrence[]): string => {
  const sorted = getSortedOccurrences(list || []);
  return formatFrequency(calculateAverageFrequency(sorted));
});

// ===== Handlers =====

// TODO(future): Replace Date.now()/new Date() with proper time service when available.
// Date.now() will be blocked in patterns in the future. The wish({ query: "#now" }) mechanism
// only captures time once at pattern creation, so it doesn't work for fresh timestamps
// in handlers. When a handler-compatible time service is available (e.g., clock builtin
// or transaction timestamp), update these handlers to use it instead.

const recordNow = handler<unknown, { occurrences: Writable<Occurrence[]> }>(
  (_, { occurrences }) => {
    occurrences.push({
      timestamp: new Date().toISOString(),
      note: "",
    });
  },
);

const deleteOccurrence = handler<
  unknown,
  { occurrences: Writable<Occurrence[]>; timestamp: string }
>((_, { occurrences, timestamp }) => {
  const current = occurrences.get() || [];
  const index = current.findIndex((o) => o.timestamp === timestamp);
  if (index >= 0) {
    occurrences.set(current.toSpliced(index, 1));
  }
});

// ===== LLM-Callable Handlers =====

const handleRecordNow = handler<
  { note?: string; result?: Writable<unknown> },
  { occurrences: Writable<Occurrence[]>; label: string }
>(({ note, result }, { occurrences, label }) => {
  const timestamp = new Date().toISOString();

  occurrences.push({
    timestamp,
    note: note?.trim() || "",
  });

  const totalCount = (occurrences.get() || []).length;

  if (result) {
    result.set({
      success: true,
      timestamp,
      totalCount,
      label: label || "Occurrences",
      message: `Recorded occurrence${note ? ` with note: "${note}"` : ""}`,
    });
  }
});

const handleGetStats = handler<
  { result?: Writable<unknown> },
  { occurrences: Writable<Occurrence[]>; label: string }
>(({ result }, { occurrences, label }) => {
  const list = occurrences.get() || [];
  const sorted = getSortedOccurrences(list);
  const totalCount = list.length;
  const lastOcc = sorted.length > 0 ? sorted[0] : null;
  const avgMs = calculateAverageFrequency(sorted);

  if (result) {
    result.set({
      label: label || "Occurrences",
      totalCount,
      lastOccurrence: lastOcc
        ? {
          timestamp: lastOcc.timestamp,
          relativeTime: formatRelativeTime(lastOcc.timestamp),
          note: lastOcc.note || null,
        }
        : null,
      averageFrequency: avgMs !== null
        ? {
          milliseconds: avgMs,
          humanReadable: formatFrequency(avgMs),
        }
        : null,
    });
  }
});

const handleGetOccurrences = handler<
  { limit?: number; result?: Writable<unknown> },
  { occurrences: Writable<Occurrence[]>; label: string }
>(({ limit, result }, { occurrences, label }) => {
  const list = occurrences.get() || [];
  const sorted = getSortedOccurrences(list);
  const limitedList = limit && limit > 0 ? sorted.slice(0, limit) : sorted;

  if (result) {
    result.set({
      label: label || "Occurrences",
      totalCount: list.length,
      returnedCount: limitedList.length,
      occurrences: limitedList.map((occ, index) => ({
        index,
        timestamp: occ.timestamp,
        relativeTime: formatRelativeTime(occ.timestamp),
        absoluteTime: formatHistoryTime(occ.timestamp),
        note: occ.note || null,
      })),
    });
  }
});

const handleDeleteOccurrence = handler<
  { timestamp: string; result?: Writable<unknown> },
  { occurrences: Writable<Occurrence[]> }
>(({ timestamp, result }, { occurrences }) => {
  if (!timestamp) {
    if (result) {
      result.set({ success: false, error: "timestamp parameter is required" });
    }
    return;
  }

  const current = occurrences.get() || [];
  const index = current.findIndex((o) => o.timestamp === timestamp);

  if (index < 0) {
    if (result) {
      result.set({
        success: false,
        error: `No occurrence found with timestamp: ${timestamp}`,
        remainingCount: current.length,
      });
    }
    return;
  }

  occurrences.set(current.toSpliced(index, 1));

  if (result) {
    result.set({
      success: true,
      deletedTimestamp: timestamp,
      remainingCount: current.length - 1,
    });
  }
});

// ===== The Pattern =====
export const OccurrenceTrackerModule = recipe<
  OccurrenceTrackerInput,
  OccurrenceTrackerInput
>("OccurrenceTrackerModule", ({ label, occurrences }) => {
  // Computed: total count
  const totalCount = computed(() => (occurrences.get() || []).length);

  // Computed: has any occurrences
  const hasOccurrences = computed(() => (occurrences.get() || []).length > 0);

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

        {/* Stats Section - using component attributes for layout */}
        <ct-hstack
          gap="4"
          justify="around"
          style={{
            padding: "0.75rem",
            background: "var(--ct-color-gray-50)",
            borderRadius: "8px",
          }}
        >
          <ct-vstack gap="0" align="center">
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
          <ct-vstack gap="0" align="center">
            <span
              style={{
                fontSize: "1rem",
                fontWeight: "500",
              }}
            >
              {formatFrequencyFromList(occurrences)}
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

        {/* Expandable History - using ifElse to preserve details state */}
        {ifElse(
          hasOccurrences,
          <details style={{ marginTop: "0.5rem" }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: "0.875rem",
                color: "var(--ct-color-gray-600)",
                padding: "0.5rem 0",
              }}
            >
              History ({totalCount})
            </summary>
            <ct-vstack
              gap="1"
              style={{
                marginTop: "0.5rem",
                maxHeight: "400px",
                overflowY: "auto",
              }}
            >
              {occurrences.map((occ) => (
                <ct-hstack
                  gap="2"
                  align="center"
                  style={{
                    padding: "0.5rem",
                    background: "var(--ct-color-gray-50)",
                    borderRadius: "6px",
                  }}
                >
                  <ct-vstack gap="0" style={{ flex: "1" }}>
                    <span style={{ fontSize: "0.875rem" }}>
                      {computed(() =>
                        `${formatRelativeTime(occ.timestamp)} · ${
                          formatHistoryTime(occ.timestamp)
                        }`
                      )}
                    </span>
                    <ct-input
                      $value={occ.note}
                      placeholder="Add note..."
                      style={{
                        fontSize: "0.75rem",
                        marginTop: "0.25rem",
                        flex: "1",
                      }}
                    />
                  </ct-vstack>
                  <ct-button
                    variant="ghost"
                    onClick={deleteOccurrence({
                      occurrences,
                      timestamp: occ.timestamp,
                    })}
                    style={{
                      padding: "0.25rem 0.5rem",
                      fontSize: "1rem",
                      color: "var(--ct-color-gray-400)",
                      minWidth: "auto",
                    }}
                    title="Delete"
                  >
                    ×
                  </ct-button>
                </ct-hstack>
              ))}
            </ct-vstack>
          </details>,
          null,
        )}
      </ct-vstack>
    ),
    label,
    occurrences,
    // LLM-callable handlers for Omnibot
    recordNow: handleRecordNow({ occurrences, label }),
    getStats: handleGetStats({ occurrences, label }),
    getOccurrences: handleGetOccurrences({ occurrences, label }),
    deleteOccurrence: handleDeleteOccurrence({ occurrences }),
  };
});

export default OccurrenceTrackerModule;
