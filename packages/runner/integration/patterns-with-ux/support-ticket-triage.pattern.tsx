/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type Priority = "low" | "medium" | "high" | "urgent";

interface TicketInput {
  id?: string;
  subject?: string;
  queue?: string;
  priority?: string;
  hoursRemaining?: number;
  assignedTo?: string | null;
}

interface TicketRecord {
  id: string;
  subject: string;
  queue: string;
  priority: Priority;
  hoursRemaining: number;
  assignedTo: string | null;
}

interface QueueSummary {
  queue: string;
  label: string;
  openCount: number;
  assignedCount: number;
  unassignedCount: number;
  criticalCount: number;
  countdowns: number[];
  nearestHours: number;
}

interface SupportTicketArgs {
  tickets: Default<TicketInput[], typeof defaultTickets>;
}

interface TriageEvent {
  id?: string;
  action?: "assign" | "escalate";
  assignee?: string | null;
  priority?: string;
  reduceBy?: number;
  escalate?: boolean;
}

const priorityOrder: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const priorityTargets: Record<Priority, number> = {
  urgent: 2,
  high: 4,
  medium: 12,
  low: 24,
};

const defaultTickets: TicketRecord[] = [
  {
    id: "billing-portal-login",
    subject: "Portal login fails",
    queue: "billing",
    priority: "medium",
    hoursRemaining: 12,
    assignedTo: "Jordan Lee",
  },
  {
    id: "billing-refund-delay",
    subject: "Refund delayed",
    queue: "billing",
    priority: "low",
    hoursRemaining: 24,
    assignedTo: null,
  },
  {
    id: "tech-sync-failure",
    subject: "Background sync failure",
    queue: "technical",
    priority: "high",
    hoursRemaining: 4,
    assignedTo: "Taylor Fox",
  },
  {
    id: "tech-mobile-crash",
    subject: "Mobile app crash on load",
    queue: "technical",
    priority: "medium",
    hoursRemaining: 10,
    assignedTo: null,
  },
];

const criticalRank = priorityOrder["high"];

const triageTicket = handler(
  (
    event: TriageEvent | undefined,
    context: {
      store: Cell<TicketRecord[]>;
      baseTickets: Cell<TicketRecord[]>;
      history: Cell<string[]>;
      escalations: Cell<number>;
    },
  ) => {
    const ticketId = normalizeLookupId(event?.id);
    if (!ticketId) return;

    const storedRecords = context.store.get();
    const baseRecords = context.baseTickets.get();
    const current = Array.isArray(storedRecords) && storedRecords.length > 0
      ? storedRecords.map(cloneTicket)
      : Array.isArray(baseRecords)
      ? baseRecords.map(cloneTicket)
      : [];
    if (current.length === 0) return;

    const index = current.findIndex((entry) => entry.id === ticketId);
    if (index === -1) return;

    const ticket = cloneTicket(current[index]);
    const queueLabel = formatQueueLabel(ticket.queue);
    const messages: string[] = [];
    let didChange = false;

    const hasAssignee = event !== undefined && "assignee" in event;
    const shouldAssign = event?.action === "assign" || hasAssignee;

    if (shouldAssign) {
      const assignee = normalizeAssignee(event?.assignee, ticket.assignedTo);
      if (assignee !== ticket.assignedTo) {
        ticket.assignedTo = assignee;
        didChange = true;
        if (assignee) {
          messages.push(
            `Assigned ${assignee} to ${queueLabel} ticket ${ticket.id}`,
          );
        } else {
          messages.push(
            `Unassigned ${queueLabel} ticket ${ticket.id}`,
          );
        }
      }
    }

    const shouldEscalate = event?.action === "escalate" ||
      event?.escalate === true;
    if (shouldEscalate) {
      const eventPriority = resolvePriority(event?.priority);
      const desiredPriority = selectDesiredPriority(
        ticket.priority,
        eventPriority,
      );
      if (desiredPriority !== ticket.priority) {
        ticket.priority = desiredPriority;
        const baseHours = Math.max(1, Math.round(ticket.hoursRemaining));
        const target = priorityTargets[desiredPriority];
        const reduceBy = typeof event?.reduceBy === "number"
          ? Math.max(0, Math.round(event.reduceBy))
          : 0;
        const limited = Math.min(baseHours, target);
        const updated = Math.max(1, limited - reduceBy);
        ticket.hoursRemaining = updated;
        didChange = true;
        const priorityLabel = formatPriorityLabel(desiredPriority);
        const messageParts = [
          "Escalated",
          `${queueLabel} ticket ${ticket.id}`,
          `to ${priorityLabel} (${updated}h SLA)`,
        ];
        messages.push(messageParts.join(" "));
        const currentEscalations = context.escalations.get();
        const nextEscalations = typeof currentEscalations === "number"
          ? currentEscalations + 1
          : 1;
        context.escalations.set(nextEscalations);
      }
    }

    if (!didChange) return;

    current[index] = ticket;
    current.sort(sortTickets);
    context.store.set(current.map(cloneTicket));

    if (messages.length > 0) {
      const history = context.history.get();
      const nextHistory = Array.isArray(history)
        ? [...history, ...messages]
        : [...messages];
      context.history.set(nextHistory);
    }
  },
);

export const supportTicketTriageUx = recipe<SupportTicketArgs>(
  "Support Ticket Triage (UX)",
  ({ tickets }) => {
    const sanitizedTickets = lift(sanitizeTickets)(tickets);

    const ticketStore = cell<TicketRecord[]>([]);
    const history = cell<string[]>([]);
    const escalations = cell(0);

    const normalizedTickets = lift((input: {
      stored: TicketRecord[];
      base: TicketRecord[];
    }) => {
      const stored = Array.isArray(input.stored) ? input.stored : [];
      if (stored.length > 0) {
        const cloned = stored.map(cloneTicket);
        cloned.sort(sortTickets);
        return cloned;
      }
      const base = Array.isArray(input.base) ? input.base : [];
      const cloned = base.map(cloneTicket);
      cloned.sort(sortTickets);
      return cloned;
    })({
      stored: ticketStore,
      base: sanitizedTickets,
    });

    const ticketsView = lift((entries: TicketRecord[]) =>
      entries.map(cloneTicket)
    )(normalizedTickets);

    const queueSummaries = lift(buildQueueSummaries)(normalizedTickets);

    const queueAlerts = lift((summaries: QueueSummary[]) => {
      return summaries.map((summary) => {
        const base = `${summary.label}: ${summary.nearestHours}h SLA`;
        if (summary.criticalCount > 0) {
          return `${base} (${summary.criticalCount} critical)`;
        }
        return `${base} (stable)`;
      });
    })(queueSummaries);

    const totalOpen = lift((summaries: QueueSummary[]) =>
      summaries.reduce((sum, summary) => sum + summary.openCount, 0)
    )(queueSummaries);

    const totalUnassigned = lift((summaries: QueueSummary[]) =>
      summaries.reduce((sum, summary) => sum + summary.unassignedCount, 0)
    )(queueSummaries);

    const escalationCount = lift((value: number | undefined) =>
      typeof value === "number" && value > 0 ? value : 0
    )(escalations);

    const historyView = lift((entries: string[] | undefined) =>
      Array.isArray(entries) ? [...entries] : []
    )(history);

    // UI form fields
    const ticketIdField = cell<string>("");
    const assigneeField = cell<string>("");
    const escalatePriorityField = cell<string>("");

    // UI handlers
    const uiAssignTicket = handler<
      unknown,
      {
        ticketId: Cell<string>;
        assignee: Cell<string>;
        store: Cell<TicketRecord[]>;
        baseTickets: Cell<TicketRecord[]>;
        history: Cell<string[]>;
        escalations: Cell<number>;
      }
    >((_event, { ticketId, assignee, store, baseTickets, history }) => {
      const idStr = ticketId.get();
      const assigneeStr = assignee.get();

      if (typeof idStr !== "string" || idStr.trim() === "") {
        return;
      }

      const id = idStr.trim();

      const storedRecords = store.get();
      const baseRecords = baseTickets.get();
      const current = Array.isArray(storedRecords) && storedRecords.length > 0
        ? storedRecords.map(cloneTicket)
        : Array.isArray(baseRecords)
        ? baseRecords.map(cloneTicket)
        : [];

      if (current.length === 0) return;

      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) return;

      const ticket = cloneTicket(current[index]);
      const queueLabel = formatQueueLabel(ticket.queue);

      const newAssignee = typeof assigneeStr === "string" &&
          assigneeStr.trim() !== ""
        ? assigneeStr.trim()
        : null;

      if (newAssignee === ticket.assignedTo) return;

      ticket.assignedTo = newAssignee;
      current[index] = ticket;
      current.sort(sortTickets);
      store.set(current.map(cloneTicket));

      const message = newAssignee
        ? `Assigned ${newAssignee} to ${queueLabel} ticket ${ticket.id}`
        : `Unassigned ${queueLabel} ticket ${ticket.id}`;

      const hist = history.get();
      const nextHist = Array.isArray(hist) ? [...hist, message] : [message];
      history.set(nextHist);

      ticketId.set("");
      assignee.set("");
    })({
      ticketId: ticketIdField,
      assignee: assigneeField,
      store: ticketStore,
      baseTickets: sanitizedTickets,
      history,
      escalations,
    });

    const uiEscalateTicket = handler<
      unknown,
      {
        ticketId: Cell<string>;
        priorityField: Cell<string>;
        store: Cell<TicketRecord[]>;
        baseTickets: Cell<TicketRecord[]>;
        history: Cell<string[]>;
        escalations: Cell<number>;
      }
    >(
      (
        _event,
        { ticketId, priorityField, store, baseTickets, history, escalations },
      ) => {
        const idStr = ticketId.get();

        if (typeof idStr !== "string" || idStr.trim() === "") {
          return;
        }

        const id = idStr.trim();

        const storedRecords = store.get();
        const baseRecords = baseTickets.get();
        const current = Array.isArray(storedRecords) &&
            storedRecords.length > 0
          ? storedRecords.map(cloneTicket)
          : Array.isArray(baseRecords)
          ? baseRecords.map(cloneTicket)
          : [];

        if (current.length === 0) return;

        const index = current.findIndex((entry) => entry.id === id);
        if (index === -1) return;

        const ticket = cloneTicket(current[index]);
        const queueLabel = formatQueueLabel(ticket.queue);

        const prioStr = priorityField.get();
        const eventPriority = typeof prioStr === "string" &&
            prioStr.trim() !== ""
          ? resolvePriority(prioStr.trim())
          : null;

        const desiredPriority = selectDesiredPriority(
          ticket.priority,
          eventPriority,
        );

        if (desiredPriority === ticket.priority) return;

        ticket.priority = desiredPriority;
        const baseHours = Math.max(1, Math.round(ticket.hoursRemaining));
        const target = priorityTargets[desiredPriority];
        const limited = Math.min(baseHours, target);
        const updated = Math.max(1, limited);
        ticket.hoursRemaining = updated;

        current[index] = ticket;
        current.sort(sortTickets);
        store.set(current.map(cloneTicket));

        const priorityLabel = formatPriorityLabel(desiredPriority);
        const message =
          `Escalated ${queueLabel} ticket ${ticket.id} to ${priorityLabel} (${updated}h SLA)`;

        const hist = history.get();
        const nextHist = Array.isArray(hist) ? [...hist, message] : [message];
        history.set(nextHist);

        const currentEscalations = escalations.get();
        const nextEscalations = typeof currentEscalations === "number"
          ? currentEscalations + 1
          : 1;
        escalations.set(nextEscalations);

        ticketId.set("");
        priorityField.set("");
      },
    )({
      ticketId: ticketIdField,
      priorityField: escalatePriorityField,
      store: ticketStore,
      baseTickets: sanitizedTickets,
      history,
      escalations,
    });

    // Name for the charm
    const name = str`Triage: ${totalOpen} open / ${totalUnassigned} unassigned`;

    // UI rendering with h()
    const queueCardsDisplay = lift((summaries: QueueSummary[]) => {
      const cards = [];
      for (const summary of summaries) {
        const statusColor = summary.criticalCount > 0 ? "#dc2626" : "#10b981";
        const statusBg = summary.criticalCount > 0 ? "#fecaca" : "#d1fae5";
        const statusText = summary.criticalCount > 0
          ? summary.criticalCount + " CRITICAL"
          : "STABLE";

        cards.push(
          h(
            "div",
            {
              style: "background: white; border: 2px solid " + statusColor +
                "; border-radius: 8px; padding: 16px;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;",
              },
              h(
                "h3",
                {
                  style: "margin: 0; color: #1e293b; font-size: 1.125rem;",
                },
                summary.label,
              ),
              h(
                "span",
                {
                  style: "background: " + statusBg + "; color: " +
                    statusColor +
                    "; padding: 4px 12px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;",
                },
                statusText,
              ),
            ),
            h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 12px;",
              },
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; margin-bottom: 4px;",
                  },
                  "Open",
                ),
                h(
                  "div",
                  {
                    style:
                      "font-size: 1.5rem; font-weight: 700; color: #1e293b;",
                  },
                  String(summary.openCount),
                ),
              ),
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; margin-bottom: 4px;",
                  },
                  "Unassigned",
                ),
                h(
                  "div",
                  {
                    style:
                      "font-size: 1.5rem; font-weight: 700; color: #1e293b;",
                  },
                  String(summary.unassignedCount),
                ),
              ),
            ),
            h(
              "div",
              {
                style:
                  "background: #f1f5f9; padding: 8px 12px; border-radius: 6px;",
              },
              h(
                "div",
                {
                  style:
                    "font-size: 0.75rem; color: #475569; margin-bottom: 4px;",
                },
                "Nearest SLA Deadline",
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 1.25rem; font-weight: 700; color: #0f172a;",
                },
                String(summary.nearestHours) + "h",
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;",
        },
        ...cards,
      );
    })(queueSummaries);

    const ticketsDisplay = lift((tickets: TicketRecord[]) => {
      const cards = [];

      for (const ticket of tickets) {
        let priorityColor = "#94a3b8";
        let priorityBg = "#f1f5f9";
        if (ticket.priority === "urgent") {
          priorityColor = "#dc2626";
          priorityBg = "#fee2e2";
        } else if (ticket.priority === "high") {
          priorityColor = "#ea580c";
          priorityBg = "#fed7aa";
        } else if (ticket.priority === "medium") {
          priorityColor = "#ca8a04";
          priorityBg = "#fef3c7";
        }

        const slaColor = ticket.hoursRemaining <= 4 ? "#dc2626" : "#475569";

        cards.push(
          h(
            "div",
            {
              style: "background: white; border-left: 4px solid " +
                priorityColor +
                "; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; border-radius: 6px; padding: 16px;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;",
              },
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style:
                      "font-weight: 700; color: #1e293b; font-size: 1rem; margin-bottom: 4px;",
                  },
                  ticket.subject,
                ),
                h(
                  "div",
                  {
                    style:
                      "font-family: monospace; font-size: 0.75rem; color: #64748b;",
                  },
                  ticket.id,
                ),
              ),
              h(
                "span",
                {
                  style: "background: " + priorityBg + "; color: " +
                    priorityColor +
                    "; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase;",
                },
                ticket.priority,
              ),
            ),
            h(
              "div",
              {
                style: "display: flex; gap: 16px; margin-top: 12px;",
              },
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; margin-bottom: 2px;",
                  },
                  "Queue",
                ),
                h(
                  "div",
                  {
                    style:
                      "font-weight: 600; color: #1e293b; font-size: 0.875rem;",
                  },
                  formatQueueLabel(ticket.queue),
                ),
              ),
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; margin-bottom: 2px;",
                  },
                  "SLA",
                ),
                h(
                  "div",
                  {
                    style: "font-weight: 700; color: " + slaColor +
                      "; font-size: 0.875rem;",
                  },
                  String(ticket.hoursRemaining) + "h",
                ),
              ),
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; margin-bottom: 2px;",
                  },
                  "Assigned",
                ),
                h(
                  "div",
                  {
                    style: "font-weight: 600; color: " +
                      (ticket.assignedTo ? "#10b981" : "#94a3b8") +
                      "; font-size: 0.875rem;",
                  },
                  ticket.assignedTo ? ticket.assignedTo : "Unassigned",
                ),
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        {
          style: "display: flex; flex-direction: column; gap: 12px;",
        },
        ...cards,
      );
    })(ticketsView);

    const historyDisplay = lift((entries: string[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return h(
          "div",
          {
            style:
              "color: #94a3b8; font-style: italic; text-align: center; padding: 16px;",
          },
          "No triage actions yet",
        );
      }

      const items = [];
      const reversed = entries.slice().reverse();
      const display = reversed.slice(0, 8);

      for (const entry of display) {
        items.push(
          h(
            "div",
            {
              style:
                "background: #f8fafc; border-left: 3px solid #3b82f6; padding: 10px 12px; border-radius: 4px; font-size: 0.875rem; color: #334155;",
            },
            entry,
          ),
        );
      }

      return h(
        "div",
        {
          style: "display: flex; flex-direction: column; gap: 8px;",
        },
        ...items,
      );
    })(historyView);

    const ui = (
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f8fafc;">
        <div style="background: linear-gradient(135deg, #3b82f6 0%, #1e40af 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; font-size: 2rem;">
            Support Ticket Triage
          </h1>
          <p style="margin: 0; opacity: 0.95; font-size: 1rem;">
            Manage support queues, assign tickets, and escalate priorities
          </p>
        </div>

        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px;">
          <div style="background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); color: white; padding: 20px; border-radius: 8px;">
            <div style="font-size: 0.875rem; opacity: 0.95; margin-bottom: 8px;">
              Total Open
            </div>
            <div style="font-size: 2.5rem; font-weight: 700;">
              {totalOpen}
            </div>
          </div>
          <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 20px; border-radius: 8px;">
            <div style="font-size: 0.875rem; opacity: 0.95; margin-bottom: 8px;">
              Unassigned
            </div>
            <div style="font-size: 2.5rem; font-weight: 700;">
              {totalUnassigned}
            </div>
          </div>
          <div style="background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); color: white; padding: 20px; border-radius: 8px;">
            <div style="font-size: 0.875rem; opacity: 0.95; margin-bottom: 8px;">
              Escalations
            </div>
            <div style="font-size: 2.5rem; font-weight: 700;">
              {escalationCount}
            </div>
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 1.5rem;">
            Queue Overview
          </h2>
          {queueCardsDisplay}
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px; border: 2px solid #e2e8f0; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 1.25rem;">
            Triage Actions
          </h2>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
            <div>
              <h3 style="margin: 0 0 12px 0; color: #475569; font-size: 1rem;">
                Assign Ticket
              </h3>
              <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px; font-size: 0.875rem;">
                  Ticket ID
                </label>
                <ct-input
                  $value={ticketIdField}
                  placeholder="e.g., billing-portal-login"
                  style="width: 100%;"
                />
              </div>
              <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px; font-size: 0.875rem;">
                  Assignee (leave empty to unassign)
                </label>
                <ct-input
                  $value={assigneeField}
                  placeholder="e.g., Jordan Lee"
                  style="width: 100%;"
                />
              </div>
              <ct-button onClick={uiAssignTicket} style="width: 100%;">
                Assign / Unassign
              </ct-button>
            </div>

            <div>
              <h3 style="margin: 0 0 12px 0; color: #475569; font-size: 1rem;">
                Escalate Ticket
              </h3>
              <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px; font-size: 0.875rem;">
                  Ticket ID
                </label>
                <ct-input
                  $value={ticketIdField}
                  placeholder="e.g., tech-mobile-crash"
                  style="width: 100%;"
                />
              </div>
              <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 600; color: #475569; margin-bottom: 4px; font-size: 0.875rem;">
                  Target Priority (optional)
                </label>
                <ct-input
                  $value={escalatePriorityField}
                  placeholder="urgent, high, medium, or low"
                  style="width: 100%;"
                />
              </div>
              <ct-button onClick={uiEscalateTicket} style="width: 100%;">
                Escalate
              </ct-button>
            </div>
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 1.5rem;">
            Active Tickets
          </h2>
          {ticketsDisplay}
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px; border: 2px solid #e2e8f0;">
          <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 1.25rem;">
            Recent Activity
          </h2>
          {historyDisplay}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      tickets: ticketsView,
      queueSummaries,
      queueAlerts,
      escalationCount,
      history: historyView,
      controls: {
        triage: triageTicket({
          store: ticketStore,
          baseTickets: sanitizedTickets,
          history,
          escalations,
        }),
      },
    };
  },
);

function sanitizeTickets(value: unknown): TicketRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    return defaultTickets.map(cloneTicket);
  }
  const inputs = value as (TicketInput | undefined)[];
  const used = new Set<string>();
  const sanitized: TicketRecord[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const fallback = defaultTickets[index % defaultTickets.length];
    sanitized.push(sanitizeTicketEntry(inputs[index], fallback, used));
  }
  if (sanitized.length === 0) {
    return defaultTickets.map(cloneTicket);
  }
  sanitized.sort(sortTickets);
  return sanitized;
}

function sanitizeTicketEntry(
  entry: TicketInput | undefined,
  fallback: TicketRecord,
  used: Set<string>,
): TicketRecord {
  const subject = normalizeSubject(entry?.subject, fallback.subject);
  const queue = normalizeQueue(entry?.queue, fallback.queue);
  const priority = normalizePriority(entry?.priority, fallback.priority);
  const idSource = typeof entry?.id === "string" && entry.id.trim().length > 0
    ? entry.id
    : `${queue}-${subject}`;
  const baseId = slugify(idSource);
  const candidateId = baseId.length > 0
    ? baseId
    : slugify(`${queue}-${fallback.id}`);
  const id = ensureUnique(candidateId, used);
  const assignedTo = normalizeAssignee(entry?.assignedTo, fallback.assignedTo);
  const hoursRemaining = normalizeHours(
    entry?.hoursRemaining,
    fallback.hoursRemaining,
    priority,
  );
  return {
    id,
    subject,
    queue,
    priority,
    hoursRemaining,
    assignedTo,
  };
}

function buildQueueSummaries(records: TicketRecord[]): QueueSummary[] {
  const bucketMap = new Map<string, QueueSummary>();
  for (const record of records) {
    const key = record.queue;
    const bucket = bucketMap.get(key) ?? {
      queue: key,
      label: formatQueueLabel(key),
      openCount: 0,
      assignedCount: 0,
      unassignedCount: 0,
      criticalCount: 0,
      countdowns: [],
      nearestHours: 0,
    };
    bucket.openCount += 1;
    if (record.assignedTo && record.assignedTo.length > 0) {
      bucket.assignedCount += 1;
    }
    const hours = Math.max(1, Math.round(record.hoursRemaining));
    bucket.countdowns.push(hours);
    if (priorityOrder[record.priority] <= criticalRank) {
      bucket.criticalCount += 1;
    }
    bucketMap.set(key, bucket);
  }
  const summaries: QueueSummary[] = [];
  for (const bucket of bucketMap.values()) {
    bucket.countdowns.sort((left, right) => left - right);
    bucket.nearestHours = bucket.countdowns[0] ?? 0;
    bucket.unassignedCount = bucket.openCount - bucket.assignedCount;
    summaries.push({
      ...bucket,
      countdowns: [...bucket.countdowns],
    });
  }
  summaries.sort((left, right) => left.queue.localeCompare(right.queue));
  return summaries;
}

function sortTickets(left: TicketRecord, right: TicketRecord): number {
  const queueDiff = left.queue.localeCompare(right.queue);
  if (queueDiff !== 0) return queueDiff;
  const priorityDiff = priorityOrder[left.priority] -
    priorityOrder[right.priority];
  if (priorityDiff !== 0) return priorityDiff;
  const hourDiff = left.hoursRemaining - right.hoursRemaining;
  if (hourDiff !== 0) return hourDiff;
  return left.id.localeCompare(right.id);
}

function cloneTicket(ticket: TicketRecord): TicketRecord {
  return {
    id: ticket.id,
    subject: ticket.subject,
    queue: ticket.queue,
    priority: ticket.priority,
    hoursRemaining: ticket.hoursRemaining,
    assignedTo: ticket.assignedTo ?? null,
  };
}

function normalizeSubject(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
}

function normalizeQueue(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) {
      return trimmed.replace(/[^a-z0-9-]+/g, "-");
    }
  }
  return fallback;
}

function normalizePriority(value: unknown, fallback: Priority): Priority {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (isPriority(lowered)) {
      return lowered;
    }
  }
  return fallback;
}

function normalizeAssignee(
  value: unknown,
  fallback: string | null,
): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
    return null;
  }
  if (value === null) return null;
  return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
}

function normalizeHours(
  value: unknown,
  fallback: number,
  priority: Priority,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof fallback === "number" && Number.isFinite(fallback)) {
    return Math.max(1, Math.round(fallback));
  }
  return priorityTargets[priority];
}

function normalizeLookupId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function ensureUnique(value: string, used: Set<string>): string {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPriority(value: string): value is Priority {
  return value === "low" || value === "medium" || value === "high" ||
    value === "urgent";
}

function resolvePriority(value: string | undefined): Priority | null {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (isPriority(lowered)) return lowered;
  }
  return null;
}

function selectDesiredPriority(
  current: Priority,
  desired: Priority | null,
): Priority {
  if (desired && priorityOrder[desired] < priorityOrder[current]) {
    return desired;
  }
  return escalatePriority(current);
}

function escalatePriority(priority: Priority): Priority {
  switch (priority) {
    case "low":
      return "medium";
    case "medium":
      return "high";
    case "high":
      return "urgent";
    default:
      return "urgent";
  }
}

function formatQueueLabel(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPriorityLabel(priority: Priority): string {
  return priority[0].toUpperCase() + priority.slice(1);
}
