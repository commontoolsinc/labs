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

type ChangeStatus = "blocked" | "unblocked";

const slotCatalog = [
  "09:00-10:00",
  "10:00-11:00",
  "11:00-12:00",
  "13:00-14:00",
  "14:00-15:00",
  "15:00-16:00",
  "16:00-17:00",
] as const;

type SlotId = (typeof slotCatalog)[number];

type SlotInput = string | { start?: string; end?: string };

type ParticipantInput = Partial<ParticipantAvailability> & {
  slots?: SlotInput[];
};

interface ParticipantAvailability {
  name: string;
  slots: SlotId[];
}

interface AvailabilityChange {
  slot: SlotId;
  status: ChangeStatus;
}

interface ModifyAvailabilityEvent {
  slot?: SlotInput;
  action?: "block" | "unblock" | "toggle";
}

interface CalendarAvailabilityArgs {
  participants: Default<
    ParticipantInput[],
    typeof defaultParticipants
  >;
  blocked: Default<SlotInput[], []>;
}

const slotOrder = new Map<string, number>(
  slotCatalog.map((slot, index) => [slot, index]),
);

const slotSet = new Set<string>(slotCatalog);
const emptySlotFallback: readonly SlotId[] = [] as const;

const defaultParticipants: ParticipantAvailability[] = [
  {
    name: "Alex Rivera",
    slots: ["09:00-10:00", "13:00-14:00", "15:00-16:00"],
  },
  {
    name: "Blair Chen",
    slots: ["10:00-11:00", "13:00-14:00", "15:00-16:00"],
  },
  {
    name: "Casey Morgan",
    slots: ["13:00-14:00", "15:00-16:00", "16:00-17:00"],
  },
];

const parseSlotString = (value: string): SlotId | null => {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/,
  );
  if (!match) return null;
  const startHour = Number(match[1]);
  const endHour = Number(match[3]);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) {
    return null;
  }
  const start = `${String(startHour).padStart(2, "0")}:${match[2]}`;
  const end = `${String(endHour).padStart(2, "0")}:${match[4]}`;
  const candidate = `${start}-${end}`;
  return slotSet.has(candidate) ? candidate as SlotId : null;
};

const normalizeSlot = (input: SlotInput | undefined): SlotId | null => {
  if (typeof input === "string") {
    return parseSlotString(input);
  }
  if (input && typeof input === "object") {
    const start = typeof input.start === "string" ? input.start : "";
    const end = typeof input.end === "string" ? input.end : "";
    return parseSlotString(`${start}-${end}`);
  }
  return null;
};

const sanitizeSlotList = (
  value: unknown,
  fallback: readonly SlotId[],
): SlotId[] => {
  const entries = Array.isArray(value) ? value : [];
  const sanitized: SlotId[] = [];
  for (const entry of entries) {
    const slot = normalizeSlot(entry as SlotInput);
    if (!slot || sanitized.includes(slot)) continue;
    sanitized.push(slot);
  }
  if (sanitized.length === 0) {
    return [...fallback];
  }
  sanitized.sort((left, right) => {
    const leftIndex = slotOrder.get(left) ?? slotCatalog.length;
    const rightIndex = slotOrder.get(right) ?? slotCatalog.length;
    return leftIndex - rightIndex;
  });
  return sanitized;
};

const sanitizeName = (
  value: unknown,
  fallback: string,
  index: number,
): string => {
  if (typeof value !== "string") {
    return fallback || `Participant ${index + 1}`;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback || `Participant ${index + 1}`;
  }
  return trimmed.slice(0, 48);
};

const cloneDefaults = (): ParticipantAvailability[] => {
  return defaultParticipants.map((entry) => ({
    name: entry.name,
    slots: [...entry.slots],
  }));
};

const sanitizeParticipants = (
  value: readonly ParticipantInput[] | undefined,
): ParticipantAvailability[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return cloneDefaults();
  }
  const sanitized: ParticipantAvailability[] = [];
  let index = 0;
  for (const entry of value) {
    const fallback = defaultParticipants[index] ?? defaultParticipants[0];
    const name = sanitizeName(
      entry?.name,
      fallback?.name ?? `Participant ${index + 1}`,
      index,
    );
    const fallbackSlots = fallback ? fallback.slots : slotCatalog;
    const slots = sanitizeSlotList(entry?.slots, fallbackSlots);
    sanitized.push({ name, slots });
    index += 1;
  }
  return sanitized.length > 0 ? sanitized : cloneDefaults();
};

const sanitizeBlocked = (value: unknown): SlotId[] => {
  return sanitizeSlotList(value, emptySlotFallback);
};

const computeSharedAvailability = (
  participants: readonly ParticipantAvailability[],
  blocked: readonly SlotId[],
): SlotId[] => {
  if (participants.length === 0) {
    return [];
  }
  const shared = new Set<SlotId>(participants[0]?.slots ?? []);
  for (let index = 1; index < participants.length; index += 1) {
    const entry = participants[index];
    const slots = new Set<SlotId>(entry?.slots ?? []);
    for (const slot of [...shared]) {
      if (!slots.has(slot)) {
        shared.delete(slot);
      }
    }
  }
  const blockedSet = new Set<SlotId>(blocked);
  const result: SlotId[] = [];
  for (const slot of slotCatalog) {
    if (shared.has(slot) && !blockedSet.has(slot)) {
      result.push(slot);
    }
  }
  return result;
};

const recordHistoryEntry = (
  history: Cell<string[]>,
  entry: string,
): void => {
  const current = history.get();
  const list = Array.isArray(current) ? [...current] : [];
  list.push(entry);
  history.set(list.slice(-12));
};

const modifySharedAvailability = handler(
  (
    event: ModifyAvailabilityEvent | undefined,
    context: {
      blocked: Cell<SlotInput[]>;
      history: Cell<string[]>;
      latestChange: Cell<AvailabilityChange | null>;
    },
  ) => {
    const slot = normalizeSlot(event?.slot);
    if (!slot) {
      return;
    }
    const action = event?.action ?? "block";
    const existing = sanitizeBlocked(context.blocked.get());
    const blockedSet = new Set<SlotId>(existing);
    let status: ChangeStatus | null = null;
    if (action === "block") {
      if (!blockedSet.has(slot)) {
        blockedSet.add(slot);
        status = "blocked";
      }
    } else if (action === "unblock") {
      if (blockedSet.delete(slot)) {
        status = "unblocked";
      }
    } else {
      if (blockedSet.has(slot)) {
        blockedSet.delete(slot);
        status = "unblocked";
      } else {
        blockedSet.add(slot);
        status = "blocked";
      }
    }
    if (!status) {
      return;
    }
    const next = slotCatalog.filter((value) => blockedSet.has(value));
    context.blocked.set([...next]);
    recordHistoryEntry(context.history, `${status} ${slot}`);
    const change: AvailabilityChange = { slot, status };
    context.latestChange.set(change);
  },
);

/**
 * Pattern computing shared availability windows across participants while
 * reacting to block edits in real time for offline scheduling flows.
 */
export const calendarAvailabilityUx = recipe<CalendarAvailabilityArgs>(
  "Calendar Availability (UX)",
  ({ participants, blocked }) => {
    const history = cell<string[]>([]);
    const latestChange = cell<AvailabilityChange | null>(null);

    const participantsView = lift(sanitizeParticipants)(participants);
    const blockedView = lift(sanitizeBlocked)(blocked);
    const sharedAvailability = lift(
      (
        input: { participants: ParticipantAvailability[]; blocked: SlotId[] },
      ): SlotId[] => {
        return computeSharedAvailability(input.participants, input.blocked);
      },
    )({ participants: participantsView, blocked: blockedView });

    const sharedLabel = lift((slots: readonly SlotId[]) => {
      if (!Array.isArray(slots) || slots.length === 0) {
        return "none";
      }
      return slots.join(", ");
    })(sharedAvailability);

    const nextAvailableSlot = lift((slots: readonly SlotId[]) => {
      return Array.isArray(slots) && slots.length > 0 ? slots[0] : "none";
    })(sharedAvailability);

    const freeSlotCount = lift((slots: readonly SlotId[]) => {
      return Array.isArray(slots) ? slots.length : 0;
    })(sharedAvailability);

    const historyView = lift((entries: string[] | undefined) => {
      return Array.isArray(entries) ? [...entries] : [];
    })(history);

    const latestChangeView = lift(
      (entry: AvailabilityChange | null | undefined) => {
        return entry ? { ...entry } : null;
      },
    )(latestChange);

    const sharedSummary = str`Shared slots: ${sharedLabel}`;
    const nextSlotSummary = str`Next slot: ${nextAvailableSlot}`;

    const updateAvailability = modifySharedAvailability({
      blocked,
      history,
      latestChange,
    });

    const slotGridView = lift((
      { slots, blocked }: { slots: SlotId[]; blocked: SlotId[] },
    ) => {
      const blockedSet = new Set(blocked);
      const sharedSet = new Set(slots);

      const slotElements = slotCatalog.map((slot) => {
        const isBlocked = blockedSet.has(slot);
        const isShared = sharedSet.has(slot);
        let bgColor = "#f1f5f9";
        let textColor = "#94a3b8";
        let borderColor = "#e2e8f0";
        let icon = "○";

        if (isBlocked) {
          bgColor = "#fee2e2";
          textColor = "#991b1b";
          borderColor = "#ef4444";
          icon = "✕";
        } else if (isShared) {
          bgColor = "#d1fae5";
          textColor = "#065f46";
          borderColor = "#10b981";
          icon = "✓";
        }

        const cardStyle = "padding: 0.75rem; border: 2px solid " +
          borderColor + "; border-radius: 0.5rem; background: " +
          bgColor + "; color: " + textColor +
          "; font-weight: 500; font-size: 0.85rem; text-align: center;";

        return (
          <div
            key={"slot-" + slot}
            style={cardStyle}
          >
            {slot} {icon}
          </div>
        );
      });

      return (
        <div style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 0.5rem;
          ">
          {slotElements}
        </div>
      );
    })({ slots: sharedAvailability, blocked: blockedView });

    const name = str`Calendar (${freeSlotCount} slots)`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Calendar Availability
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Find shared meeting times
                </h2>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.85rem; color: #475569;">
                    Shared availability
                  </span>
                  <strong style="font-size: 1.5rem; color: #10b981;">
                    {freeSlotCount}{" "}
                    {lift((count: number) => count === 1 ? "slot" : "slots")(
                      freeSlotCount,
                    )}
                  </strong>
                </div>

                <div style="
                    font-size: 0.85rem;
                    color: #64748b;
                  ">
                  Next available:{" "}
                  <strong style="color: #0f172a;">
                    {nextAvailableSlot}
                  </strong>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Participants
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              {lift((participants: ParticipantAvailability[]) => {
                if (
                  !Array.isArray(participants) || participants.length === 0
                ) {
                  return (
                    <div style="color: #64748b; font-size: 0.85rem;">
                      No participants
                    </div>
                  );
                }
                const elements = participants.map((participant, idx) => {
                  const bgColor = idx === 0
                    ? "#dbeafe"
                    : idx === 1
                    ? "#fce7f3"
                    : "#fef3c7";
                  const borderColor = idx === 0
                    ? "#3b82f6"
                    : idx === 1
                    ? "#ec4899"
                    : "#f59e0b";
                  const participantName = participant?.name || "Unknown";
                  const slots = Array.isArray(participant?.slots)
                    ? participant.slots
                    : [];
                  const slotCount = String(slots.length);
                  const slotText = slots.join(", ");

                  return (
                    <div
                      key={"participant-" + String(idx)}
                      style={"background: " + bgColor +
                        "; border-left: 3px solid " +
                        borderColor +
                        "; padding: 0.75rem; border-radius: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem;"}
                    >
                      <div style="display: flex; justify-content: space-between; align-items: baseline;">
                        <strong style="color: #0f172a; font-size: 0.95rem;">
                          {participantName}
                        </strong>
                        <span style="color: #475569; font-size: 0.8rem;">
                          {slotCount} {slots.length === 1 ? "slot" : "slots"}
                        </span>
                      </div>
                      <div style="color: #475569; font-size: 0.8rem;">
                        {slotText}
                      </div>
                    </div>
                  );
                });
                return (
                  <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    {elements}
                  </div>
                );
              })(participantsView)}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Block time slots
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {slotGridView}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Activity log
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {lift((entries: string[]) => {
                if (!Array.isArray(entries) || entries.length === 0) {
                  return (
                    <div style="color: #94a3b8; font-size: 0.85rem; font-style: italic;">
                      No activity yet
                    </div>
                  );
                }

                const reversed = entries.slice().reverse();
                const logElements = reversed.map((entry, idx) => {
                  const isBlocked = entry.includes("blocked");
                  const badgeColor = isBlocked ? "#fee2e2" : "#d1fae5";
                  const badgeText = isBlocked ? "#991b1b" : "#065f46";

                  return (
                    <div
                      key={"log-" + String(idx)}
                      style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; background: #f8fafc; border-radius: 0.5rem;"
                    >
                      <span
                        style={"display: inline-block; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; font-weight: 500; background: " +
                          badgeColor + "; color: " + badgeText + ";"}
                      >
                        {entry}
                      </span>
                    </div>
                  );
                });

                return (
                  <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    {logElements}
                  </div>
                );
              })(historyView)}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {sharedSummary}
          </div>
        </div>
      ),
      participants,
      participantsView,
      blocked,
      blockedView,
      sharedAvailability,
      sharedLabel,
      sharedSummary,
      nextAvailableSlot,
      nextSlotSummary,
      freeSlotCount,
      actionHistory: historyView,
      latestChange: latestChangeView,
      controls: {
        updateAvailability,
      },
    };
  },
);

export default calendarAvailabilityUx;
