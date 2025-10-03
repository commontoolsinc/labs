/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
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

interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  timestamp: number;
  snippet: string;
}

type EmailEvent = Partial<EmailMessage>;

interface ThreadSummary {
  threadId: string;
  subject: string;
  snippet: string;
  latestTimestamp: number;
  messageCount: number;
  senders: string[];
  messages: EmailMessage[];
}

interface EmailInboxArgs {
  messages: Default<EmailMessage[], []>;
  activeThreadId: Default<string | null, null>;
}

function normalizeMessage(
  input: EmailEvent,
  fallbackIndex: number,
): EmailMessage {
  const threadId =
    typeof input.threadId === "string" && input.threadId.length > 0
      ? input.threadId
      : `thread-${fallbackIndex}`;
  const timestamp = typeof input.timestamp === "number"
    ? input.timestamp
    : fallbackIndex;
  const subject = typeof input.subject === "string" && input.subject.length > 0
    ? input.subject
    : `Conversation ${threadId}`;
  const sender = typeof input.sender === "string" && input.sender.length > 0
    ? input.sender
    : "unknown";
  const snippet = typeof input.snippet === "string" ? input.snippet : "";
  const id = typeof input.id === "string" && input.id.length > 0
    ? input.id
    : `message-${fallbackIndex}`;

  return {
    id,
    threadId,
    subject,
    sender,
    timestamp,
    snippet,
  };
}

const receiveEmail = handler(
  (
    event: EmailEvent | undefined,
    context: {
      messages: Cell<EmailMessage[]>;
      threadActivity: Cell<string[]>;
      activeThreadId: Cell<string | null>;
    },
  ) => {
    const existing = context.messages.get();
    const currentMessages = Array.isArray(existing) ? existing : [];
    const index = currentMessages.length + 1;
    const message = normalizeMessage(event ?? {}, index);
    const nextMessages = [...currentMessages, message];
    context.messages.set(nextMessages);

    const activity = context.threadActivity.get();
    const currentActivity = Array.isArray(activity) ? activity : [];
    context.threadActivity.set([
      ...currentActivity,
      `${message.threadId}:${message.timestamp}`,
    ]);

    const active = context.activeThreadId.get();
    if (typeof active !== "string" || active.length === 0) {
      context.activeThreadId.set(message.threadId);
      return;
    }

    const latestForActive = nextMessages.reduce(
      (max, entry) =>
        entry.threadId === active ? Math.max(max, entry.timestamp) : max,
      Number.NEGATIVE_INFINITY,
    );
    if (message.timestamp >= latestForActive) {
      context.activeThreadId.set(message.threadId);
    }
  },
);

const selectThread = handler(
  (
    _event: undefined,
    context: {
      threadIdField: Cell<string>;
      activeThreadId: Cell<string | null>;
    },
  ) => {
    const threadId = context.threadIdField.get();
    if (typeof threadId === "string" && threadId.trim() !== "") {
      context.activeThreadId.set(threadId.trim());
      context.threadIdField.set("");
    }
  },
);

const addEmailFromUI = handler(
  (
    _event: undefined,
    context: {
      idField: Cell<string>;
      threadIdField: Cell<string>;
      subjectField: Cell<string>;
      senderField: Cell<string>;
      snippetField: Cell<string>;
      messages: Cell<EmailMessage[]>;
      threadActivity: Cell<string[]>;
      activeThreadId: Cell<string | null>;
    },
  ) => {
    const id = context.idField.get();
    const threadId = context.threadIdField.get();
    const subject = context.subjectField.get();
    const sender = context.senderField.get();
    const snippet = context.snippetField.get();

    if (
      typeof threadId !== "string" || threadId.trim() === "" ||
      typeof sender !== "string" || sender.trim() === ""
    ) {
      return;
    }

    const existing = context.messages.get();
    const currentMessages = Array.isArray(existing) ? existing : [];
    const index = currentMessages.length + 1;

    const message = normalizeMessage(
      { id, threadId, subject, sender, snippet, timestamp: Date.now() },
      index,
    );

    const nextMessages = [...currentMessages, message];
    context.messages.set(nextMessages);

    const activity = context.threadActivity.get();
    const currentActivity = Array.isArray(activity) ? activity : [];
    context.threadActivity.set([
      ...currentActivity,
      `${message.threadId}:${message.timestamp}`,
    ]);

    const active = context.activeThreadId.get();
    if (typeof active !== "string" || active.length === 0) {
      context.activeThreadId.set(message.threadId);
    } else {
      const latestForActive = nextMessages.reduce(
        (max, entry) =>
          entry.threadId === active ? Math.max(max, entry.timestamp) : max,
        Number.NEGATIVE_INFINITY,
      );
      if (message.timestamp >= latestForActive) {
        context.activeThreadId.set(message.threadId);
      }
    }

    context.idField.set("");
    context.threadIdField.set("");
    context.subjectField.set("");
    context.senderField.set("");
    context.snippetField.set("");
  },
);

export const emailInboxThreading = recipe<EmailInboxArgs>(
  "Email Inbox Threading",
  ({ messages, activeThreadId }) => {
    const threadActivity = cell<string[]>([]);

    const sanitizedMessages = lift(
      (value: EmailMessage[] | undefined): EmailMessage[] => {
        if (!Array.isArray(value)) return [];
        return value.map((item, index) => normalizeMessage(item, index + 1));
      },
    )(messages);

    const threads = derive(
      sanitizedMessages,
      (collection): ThreadSummary[] => {
        const groups = new Map<string, ThreadSummary>();
        for (const entry of collection) {
          const existing = groups.get(entry.threadId);
          if (existing) {
            const updatedMessages = [...existing.messages, entry];
            const latestTimestamp = entry.timestamp > existing.latestTimestamp
              ? entry.timestamp
              : existing.latestTimestamp;
            groups.set(entry.threadId, {
              threadId: entry.threadId,
              subject: entry.timestamp >= existing.latestTimestamp
                ? entry.subject
                : existing.subject,
              snippet: entry.timestamp >= existing.latestTimestamp
                ? entry.snippet
                : existing.snippet,
              latestTimestamp,
              messageCount: updatedMessages.length,
              senders: Array.from(new Set([...existing.senders, entry.sender])),
              messages: updatedMessages.sort(
                (a, b) => a.timestamp - b.timestamp,
              ),
            });
          } else {
            groups.set(entry.threadId, {
              threadId: entry.threadId,
              subject: entry.subject,
              snippet: entry.snippet,
              latestTimestamp: entry.timestamp,
              messageCount: 1,
              senders: [entry.sender],
              messages: [entry],
            });
          }
        }

        return Array.from(groups.values()).sort(
          (a, b) => b.latestTimestamp - a.latestTimestamp,
        );
      },
    );

    const threadCount = lift((items: ThreadSummary[]) => items.length)(threads);
    const orderedThreadIds = derive(
      threads,
      (items) => items.map((item) => item.threadId),
    );
    const topThread = derive(
      threads,
      (items) => items.length > 0 ? items[0] : null,
    );
    const topThreadLabel = lift(
      (thread: ThreadSummary | null): string => {
        if (!thread) return "Inbox empty";
        return `${thread.subject} (${thread.messageCount})`;
      },
    )(topThread);
    const activeThreadView = lift(
      (value: string | null | undefined): string | null =>
        typeof value === "string" && value.length > 0 ? value : null,
    )(activeThreadId);
    const activeThreadSummary = lift(
      (
        input: { threads: ThreadSummary[]; active: string | null },
      ): ThreadSummary | null => {
        if (!input.active) return null;
        return input.threads.find((item) => item.threadId === input.active) ??
          null;
      },
    )({ threads, active: activeThreadView });

    const idField = cell("");
    const threadIdFieldForEmail = cell("");
    const subjectField = cell("");
    const senderField = cell("");
    const snippetField = cell("");

    const threadSelectField = cell("");

    const name = lift(
      (count: number): string =>
        count === 0
          ? "Empty Inbox"
          : `Inbox (${count} thread${count === 1 ? "" : "s"})`,
    )(threadCount);

    const threadsUI = lift(
      (input: {
        threads: ThreadSummary[];
        activeThread: ThreadSummary | null;
      }) => {
        const threadsElements = [];
        for (const thread of input.threads) {
          const isActive = input.activeThread?.threadId === thread.threadId;
          const bgColor = isActive ? "#e0f2fe" : "#ffffff";
          const borderColor = isActive ? "#0ea5e9" : "#e2e8f0";
          const borderWidth = isActive ? "2px" : "1px";

          const sendersText = thread.senders.length > 3
            ? thread.senders.slice(0, 3).join(", ") + "..."
            : thread.senders.join(", ");

          const threadCard = h(
            "div",
            {
              style: "padding: 12px; border: " + borderWidth + " solid " +
                borderColor +
                "; border-radius: 8px; margin-bottom: 8px; background: " +
                bgColor + "; cursor: pointer;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: start; margin-bottom: 6px;",
              },
              h(
                "div",
                { style: "font-weight: 600; color: #1e293b; flex: 1;" },
                thread.subject,
              ),
              h(
                "div",
                {
                  style:
                    "background: #3b82f6; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; margin-left: 8px;",
                },
                String(thread.messageCount),
              ),
            ),
            h(
              "div",
              {
                style:
                  "font-size: 13px; color: #64748b; margin-bottom: 4px; font-weight: 500;",
              },
              sendersText,
            ),
            h(
              "div",
              { style: "font-size: 13px; color: #64748b; line-height: 1.4;" },
              thread.snippet || "(No preview)",
            ),
          );

          threadsElements.push(threadCard);
        }

        const threadsList = input.threads.length === 0
          ? h(
            "div",
            {
              style:
                "padding: 40px 20px; text-align: center; color: #94a3b8; font-size: 14px;",
            },
            "No messages yet",
          )
          : h("div", {}, ...threadsElements);

        const activeThreadView = input.activeThread
          ? (() => {
            const messagesElements = [];
            for (const msg of input.activeThread.messages) {
              const msgCard = h(
                "div",
                {
                  style:
                    "padding: 12px; background: #f8fafc; border-left: 3px solid #3b82f6; margin-bottom: 10px; border-radius: 4px;",
                },
                h(
                  "div",
                  {
                    style:
                      "display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;",
                  },
                  h(
                    "div",
                    { style: "font-weight: 600; color: #1e293b;" },
                    msg.sender,
                  ),
                  h(
                    "div",
                    {
                      style:
                        "font-size: 11px; color: #94a3b8; font-family: monospace;",
                    },
                    new Date(msg.timestamp).toLocaleString(),
                  ),
                ),
                h(
                  "div",
                  { style: "color: #475569; line-height: 1.5;" },
                  msg.snippet || "(No content)",
                ),
              );
              messagesElements.push(msgCard);
            }

            return h(
              "div",
              {},
              h(
                "div",
                {
                  style:
                    "background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 16px; border-radius: 8px; margin-bottom: 16px;",
                },
                h(
                  "div",
                  {
                    style:
                      "font-size: 18px; font-weight: 600; margin-bottom: 4px;",
                  },
                  input.activeThread.subject,
                ),
                h(
                  "div",
                  { style: "font-size: 13px; opacity: 0.9;" },
                  String(input.activeThread.messageCount) + " message" +
                    (input.activeThread.messageCount === 1 ? "" : "s") +
                    " • " + input.activeThread.senders.join(", "),
                ),
              ),
              h(
                "div",
                { style: "max-height: 400px; overflow-y: auto;" },
                ...messagesElements,
              ),
            );
          })()
          : h(
            "div",
            {
              style:
                "padding: 40px 20px; text-align: center; color: #94a3b8; font-size: 14px;",
            },
            "Select a thread to view messages",
          );

        return h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: 1fr 1.5fr; gap: 24px;",
          },
          h(
            "div",
            {},
            h(
              "div",
              {
                style:
                  "font-size: 16px; font-weight: 600; color: #1e293b; margin-bottom: 12px;",
              },
              "Threads",
            ),
            h(
              "div",
              { style: "max-height: 500px; overflow-y: auto;" },
              threadsList,
            ),
          ),
          h(
            "div",
            {},
            h(
              "div",
              {
                style:
                  "font-size: 16px; font-weight: 600; color: #1e293b; margin-bottom: 12px;",
              },
              "Thread Details",
            ),
            activeThreadView,
          ),
        );
      },
    )({ threads, activeThread: activeThreadSummary });

    const ui = (
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
          <div style="font-size: 28px; font-weight: 700; margin-bottom: 8px;">
            📧 Email Inbox
          </div>
          <div style="font-size: 16px; opacity: 0.9;">
            {threadCount} thread{lift((c: number) => c === 1 ? "" : "s")(
              threadCount,
            )}
          </div>
        </div>
        {threadsUI}
        <div style="background: #f8fafc; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-top: 24px;">
          <div style="font-size: 16px; font-weight: 600; color: #1e293b; margin-bottom: 16px;">
            Add New Email
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
            <div>
              <label style="display: block; font-size: 13px; font-weight: 500; color: #64748b; margin-bottom: 4px;">
                Thread ID
              </label>
              <ct-input
                $value={threadIdFieldForEmail}
                placeholder="e.g., thread-1"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 13px; font-weight: 500; color: #64748b; margin-bottom: 4px;">
                Sender
              </label>
              <ct-input
                $value={senderField}
                placeholder="e.g., alice@example.com"
                style="width: 100%;"
              />
            </div>
          </div>
          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 13px; font-weight: 500; color: #64748b; margin-bottom: 4px;">
              Subject
            </label>
            <ct-input
              $value={subjectField}
              placeholder="Email subject"
              style="width: 100%;"
            />
          </div>
          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 13px; font-weight: 500; color: #64748b; margin-bottom: 4px;">
              Message
            </label>
            <ct-input
              $value={snippetField}
              placeholder="Message content"
              style="width: 100%;"
            />
          </div>
          <ct-button
            onClick={addEmailFromUI({
              idField,
              threadIdField: threadIdFieldForEmail,
              subjectField,
              senderField,
              snippetField,
              messages,
              threadActivity,
              activeThreadId,
            })}
          >
            Send Email
          </ct-button>
        </div>
      </div>
    );

    return {
      messages,
      sanitizedMessages,
      threads,
      orderedThreadIds,
      threadCount,
      topThread,
      topThreadLabel,
      activeThreadId,
      activeThreadView,
      activeThreadSummary,
      threadActivity,
      summary: str`${threadCount} threads`,
      topThreadStatus: str`Top thread: ${topThreadLabel}`,
      receive: receiveEmail({
        messages,
        threadActivity,
        activeThreadId,
      }),
      [NAME]: name,
      [UI]: ui,
    };
  },
);
