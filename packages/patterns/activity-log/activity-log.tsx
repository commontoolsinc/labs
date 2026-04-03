/// <cts-enable />
import {
  action,
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

/**
 * A piece that can be mentioned via wiki-links.
 * Mirrors the shape used in notes/schemas.tsx.
 */
interface MentionablePiece {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
}

export interface ActivityEvent {
  id: string;
  timestamp: string; // ISO 8601
  agent: string;
  action: string; // short verb phrase e.g. "deployed", "populated"
  pieceName?: string;
  pieceRef?: MentionablePiece;
  note?: string;
}

interface ActivityLogInput {
  events?: Writable<Default<ActivityEvent[], []>>;
  mentioned?: Writable<Default<MentionablePiece[], []>>;
}

interface ActivityLogOutput {
  [NAME]: string;
  [UI]: VNode;
  logEvent: unknown;
  clearLog: unknown;
  summary: string;
}

// ===== Module-scope Handlers =====

const logEventHandler = handler<
  Omit<ActivityEvent, "id" | "timestamp">,
  { events: Writable<ActivityEvent[]>; mentioned: Writable<MentionablePiece[]> }
>((args, { events, mentioned }) => {
  events.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`,
    timestamp: new Date().toISOString(),
    ...args,
  });
  if (args.pieceRef) mentioned.push(args.pieceRef);
});

const clearLogHandler = handler<
  unknown,
  { events: Writable<ActivityEvent[]> }
>((_, { events }) => events.set([]));

// ===== Pattern =====

export default pattern<ActivityLogInput, ActivityLogOutput>(
  ({ events, mentioned }) => {
    // Bind handlers
    const logEvent = logEventHandler({ events, mentioned });
    const clearLog = clearLogHandler({ events });

    // Filter state — local, use action not handler
    const filterAgent = Writable.of<string | null>(null);
    const setFilter = action(({ agent }: { agent: string | null }) =>
      filterAgent.set(agent)
    );

    // Derived values
    const agents = computed(() => [
      ...new Set(
        events.get().filter(Boolean).map((e: ActivityEvent) => e.agent),
      ),
    ]);
    const filtered = computed(() => {
      const all = events.get().filter(Boolean) as ActivityEvent[];
      return filterAgent.get()
        ? all.filter((e) => e.agent === filterAgent.get())
        : all;
    });

    const summary = computed(() => {
      const all = events.get().filter(Boolean) as ActivityEvent[];
      if (!all.length) return "No activity logged.";
      return all
        .slice(-20)
        .map((e: ActivityEvent) => {
          const ts = new Date(e.timestamp).toLocaleString();
          const parts = [`[${ts}]`, `${e.agent}:`, e.action];
          if (e.pieceName) parts.push(e.pieceName);
          if (e.note) parts.push(`— ${e.note}`);
          return parts.join(" ");
        })
        .join("\n");
    });

    return {
      [NAME]: computed(() => `Activity Log (${events.get().length})`),
      [UI]: (
        <ct-screen>
          <ct-hstack
            slot="header"
            gap="2"
            style="padding: 0.75rem 1rem; align-items: center;"
          >
            <ct-label style="font-weight: 600; flex: 1;">Activity Log</ct-label>
            <ct-button variant="ghost" size="sm" onClick={clearLog}>
              Clear
            </ct-button>
          </ct-hstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="3" style="padding: 0.75rem 1rem;">
              {/* Agent filter chips */}
              <ct-hstack gap="1" style="flex-wrap: wrap;">
                <ct-button
                  variant={filterAgent.get() === null ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setFilter.send({ agent: null })}
                >
                  All
                </ct-button>
                {agents.map((agent: string) => (
                  <ct-button
                    variant={filterAgent.get() === agent ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setFilter.send({ agent })}
                  >
                    {agent}
                  </ct-button>
                ))}
              </ct-hstack>

              {/* Event list */}
              {filtered.map((event: ActivityEvent) => (
                <ct-hstack
                  gap="2"
                  style="align-items: flex-start; border-bottom: 1px solid var(--ct-color-gray-100); padding-bottom: 0.5rem;"
                >
                  <ct-vstack gap="0" style="flex: 1; min-width: 0;">
                    <ct-hstack
                      gap="2"
                      style="align-items: center; flex-wrap: wrap;"
                    >
                      <ct-badge>{event.agent}</ct-badge>
                      <ct-label style="font-weight: 500;">
                        {event.action}
                      </ct-label>
                      {event.pieceName
                        ? (
                          <ct-label style="color: var(--ct-color-gray-500);">
                            {event.pieceName}
                          </ct-label>
                        )
                        : null}
                      {event.pieceRef
                        ? <ct-cell-link $cell={event.pieceRef} />
                        : null}
                    </ct-hstack>
                    {event.note
                      ? (
                        <ct-label style="color: var(--ct-color-gray-600); font-size: 0.875em;">
                          {event.note}
                        </ct-label>
                      )
                      : null}
                  </ct-vstack>
                  <ct-label style="color: var(--ct-color-gray-400); font-size: 0.75em; white-space: nowrap; flex-shrink: 0;">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </ct-label>
                </ct-hstack>
              ))}

              {computed(() =>
                filtered.length === 0
                  ? (
                    <ct-label style="color: var(--ct-color-gray-400); text-align: center; padding: 2rem 0;">
                      No events yet
                    </ct-label>
                  )
                  : null
              )}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      logEvent,
      clearLog,
      summary,
    };
  },
);
